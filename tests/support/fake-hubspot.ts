import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { TestClock } from "./fake-google";

/**
 * In-process fake of the HubSpot endpoints Tracklibute uses:
 *   OAuth 2026-03 token (code + refresh) · OAuth 2026-03 introspection ·
 *   owners · deal pipelines (2026-09)
 *   deals list · deals search · v4 association batch read · contacts / companies batch read
 * Records every request (method + path) so tests can prove nothing else —
 * in particular no write — is ever sent. Unknown requests get 404 and are
 * recorded in `unexpected`.
 */
export const FAKE_HUBSPOT_CLIENT_ID = "fake-hubspot-client-id";
export const FAKE_HUBSPOT_CLIENT_SECRET = "fake-hubspot-client-secret";
export const HUBSPOT_READ_SCOPES = [
  "oauth",
  "crm.objects.deals.read",
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.owners.read",
];

interface FakeObject {
  id: string;
  properties: Record<string, string | null>;
}
interface FakeDeal extends FakeObject {
  contacts: string[];
  companies: string[];
}

interface Failure {
  path: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

export class FakeHubSpot {
  base = "";
  clock: TestClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  private server!: Server;
  private codes = new Map<string, { hubId: string; scopes: string[]; redirectUri: string }>();
  private refreshTokens = new Map<string, { hubId: string; scopes: string[]; revoked: boolean }>();
  private accessTokens = new Map<string, { hubId: string; scopes: string[]; expiresAt: number }>();
  accessTokenTtlSeconds = 1800;
  /** Introspection scripting: field overrides merged into the response, or a raw malformed body. */
  introspection: { overrides?: Record<string, unknown>; malformed?: boolean } = {};
  /** Token-endpoint scripting: extra fields merged into successful responses. */
  tokenResponseExtra: Record<string, unknown> = {};
  /** Every OAuth form body received (tests assert secrets never appear in URLs). */
  oauthBodies: string[] = [];
  /** Full request URLs (path + query) — tests assert no secret is ever in one. */
  urls: string[] = [];
  /** Every request seen: "METHOD /path". */
  requests: string[] = [];
  /** Requests that matched no emulated endpoint. */
  unexpected: string[] = [];
  failures: Failure[] = [];
  /** Search emulation: page size cap and the result-window cap (HubSpot: 200 / 10,000). */
  searchPageSize = 200;
  searchCap = 10_000;
  /** Rolling-window rate limit emulation (null = unlimited). */
  rateLimit: { perWindow: number; windowMs: number } | null = null;
  rateLimited = 0;
  private hits: number[] = [];
  /** Daily allowance emulation headers (null = header absent). */
  daily: { max: number; remaining: number } | null = null;

  owners: Array<{ id: string; email: string | null; firstName: string | null; lastName: string | null; archived?: boolean }> = [];
  /** Stage metadata as HubSpot returns it; `isClosed: undefined` omits the key. */
  pipelines: Array<{ id: string; label: string; archived?: boolean; stages: Array<{ id: string; label: string; isClosed?: boolean; probability?: number }> }> = [
    {
      id: "default",
      label: "Sales Pipeline",
      stages: [
        { id: "qualified", label: "Qualified", isClosed: false, probability: 0.2 },
        { id: "proposal", label: "Proposal", isClosed: false, probability: 0.6 },
        { id: "closedwon", label: "Closed won", isClosed: true, probability: 1 },
        { id: "closedlost", label: "Closed lost", isClosed: true, probability: 0 },
      ],
    },
  ];
  deals = new Map<string, FakeDeal>();
  contacts = new Map<string, FakeObject>();
  companies = new Map<string, FakeObject>();
  private seq = 1000;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // ─── Arrangement helpers ───────────────────────────────────────────────────

  fail(path: RegExp, status: number, times = 1, body?: unknown, headers?: Record<string, string>): void {
    this.failures.push({ path, status, times, body, headers });
  }

  /** Simulate the admin approving the app: returns the callback URL HubSpot would redirect to. */
  authorize(authorizationUrl: string, opts: { hubId?: string; scopes?: string[] } = {}): string {
    const u = new URL(authorizationUrl);
    const code = `code-${randomBytes(12).toString("hex")}`;
    this.codes.set(code, {
      hubId: opts.hubId ?? "424242",
      scopes: opts.scopes ?? (u.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
      redirectUri: u.searchParams.get("redirect_uri") ?? "",
    });
    const cb = new URL(u.searchParams.get("redirect_uri")!);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", u.searchParams.get("state") ?? "");
    return cb.toString();
  }

  issueTokens(hubId: string, opts: { expiresInSeconds?: number; scopes?: string[] } = {}) {
    const scopes = opts.scopes ?? HUBSPOT_READ_SCOPES;
    const access = `hat-${randomBytes(12).toString("hex")}`;
    const refresh = `hrt-${randomBytes(12).toString("hex")}`;
    const ttl = opts.expiresInSeconds ?? this.accessTokenTtlSeconds;
    this.accessTokens.set(access, { hubId, scopes, expiresAt: Date.now() + ttl * 1000 });
    this.refreshTokens.set(refresh, { hubId, scopes, revoked: false });
    return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ttl * 1000, hubId };
  }

  revokeAll(): void {
    for (const r of this.refreshTokens.values()) r.revoked = true;
    this.accessTokens.clear();
  }
  expireAccessTokens(): void {
    for (const a of this.accessTokens.values()) a.expiresAt = 0;
  }

  addOwner(o: { email: string | null; firstName?: string; lastName?: string }) {
    const owner = { id: String(++this.seq), email: o.email, firstName: o.firstName ?? null, lastName: o.lastName ?? null };
    this.owners.push(owner);
    return owner;
  }
  addContact(email: string | null, extra: Record<string, string> = {}): FakeObject {
    const c = { id: String(++this.seq), properties: { email, firstname: "Pat", lastname: "Buyer", lastmodifieddate: new Date(this.clock.now()).toISOString(), ...extra } };
    this.contacts.set(c.id, c);
    return c;
  }
  addCompany(domain: string | null, name = "Buyer Inc"): FakeObject {
    const c = { id: String(++this.seq), properties: { domain, name, hs_lastmodifieddate: new Date(this.clock.now()).toISOString() } };
    this.companies.set(c.id, c);
    return c;
  }
  addDeal(props: Record<string, string | null>, assoc: { contacts?: string[]; companies?: string[] } = {}): FakeDeal {
    const now = new Date(this.clock.now()).toISOString();
    const d: FakeDeal = {
      id: String(++this.seq),
      properties: { dealname: "Deal", pipeline: "default", dealstage: "qualified", createdate: now, hs_lastmodifieddate: now, ...props },
      contacts: assoc.contacts ?? [],
      companies: assoc.companies ?? [],
    };
    this.deals.set(d.id, d);
    return d;
  }
  /** Edit a deal (bumps hs_lastmodifieddate, like HubSpot). */
  updateDeal(id: string, props: Record<string, string | null>, at = this.clock.now()): void {
    const d = this.deals.get(id)!;
    Object.assign(d.properties, props, { hs_lastmodifieddate: new Date(at).toISOString() });
  }

  /** Requests that are not GETs and not one of the read-only query POSTs (should always be empty). */
  writeRequests(): string[] {
    const readPosts = [
      /^POST \/oauth\/2026-03\/token$/,
      /^POST \/oauth\/2026-03\/token\/introspect$/,
      /^POST \/crm\/v3\/objects\/deals\/search$/,
      /^POST \/crm\/v4\/associations\/deals\/(contacts|companies)\/batch\/read$/,
      /^POST \/crm\/v3\/objects\/(contacts|companies)\/batch\/read$/,
    ];
    return this.requests.filter((r) => !r.startsWith("GET ") && !readPosts.some((p) => p.test(r)));
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private auth(req: IncomingMessage): { hubId: string; scopes: string[] } | null {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const t = this.accessTokens.get(token);
    return t && t.expiresAt > Date.now() ? t : null;
  }

  private rateHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.rateLimit) {
      h["x-hubspot-ratelimit-max"] = String(this.rateLimit.perWindow);
      h["x-hubspot-ratelimit-remaining"] = String(Math.max(0, this.rateLimit.perWindow - this.hits.length));
      h["x-hubspot-ratelimit-interval-milliseconds"] = String(this.rateLimit.windowMs);
    }
    if (this.daily) {
      h["x-hubspot-ratelimit-daily"] = String(this.daily.max);
      h["x-hubspot-ratelimit-daily-remaining"] = String(this.daily.remaining);
    }
    return h;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    const method = req.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    this.urls.push(`${method} ${req.url ?? ""}`);
    const raw = method === "POST" ? await this.readBody(req) : "";
    if (path.startsWith("/oauth/")) this.oauthBodies.push(raw);

    const failure = this.failures.find((f) => f.times > 0 && f.path.test(path));
    if (failure) {
      failure.times--;
      return this.send(res, failure.status, failure.body ?? { status: "error", category: "INJECTED" }, failure.headers);
    }

    // OAuth 2026-03 (RFC 6749 errors + legacy status/message, as documented)
    const oauthError = (status: number, error: string, legacy: string) =>
      this.send(res, status, { error, error_description: "fake error", status: legacy, message: "fake error" });
    if (path.startsWith("/oauth/")) {
      if (url.search) return oauthError(400, "invalid_request", "BAD_REQUEST"); // secrets in URLs are refused
      const form = new URLSearchParams(raw);
      if (form.get("client_id") !== FAKE_HUBSPOT_CLIENT_ID || form.get("client_secret") !== FAKE_HUBSPOT_CLIENT_SECRET) {
        return oauthError(401, "invalid_client", "BAD_CLIENT_ID");
      }
      if (method === "POST" && path === "/oauth/2026-03/token") {
        if (form.get("grant_type") === "authorization_code") {
          const grant = this.codes.get(form.get("code") ?? "");
          if (!grant || grant.redirectUri !== form.get("redirect_uri")) return oauthError(400, "invalid_grant", "BAD_AUTH_CODE");
          this.codes.delete(form.get("code")!);
          const t = this.issueTokens(grant.hubId, { scopes: grant.scopes });
          return this.send(res, 200, {
            token_type: "bearer",
            access_token: t.accessToken,
            refresh_token: t.refreshToken,
            expires_in: this.accessTokenTtlSeconds,
            hub_id: Number(grant.hubId),
            scopes: grant.scopes,
            ...this.tokenResponseExtra,
          });
        }
        if (form.get("grant_type") === "refresh_token") {
          const r = this.refreshTokens.get(form.get("refresh_token") ?? "");
          if (!r || r.revoked) return oauthError(400, "invalid_grant", "BAD_REFRESH_TOKEN");
          const access = `hat-${randomBytes(12).toString("hex")}`;
          this.accessTokens.set(access, { hubId: r.hubId, scopes: r.scopes, expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000 });
          return this.send(res, 200, {
            token_type: "bearer",
            access_token: access,
            refresh_token: form.get("refresh_token"),
            expires_in: this.accessTokenTtlSeconds,
            hub_id: Number(r.hubId),
            scopes: r.scopes,
            ...this.tokenResponseExtra,
          });
        }
        return oauthError(400, "unsupported_grant_type", "BAD_GRANT_TYPE");
      }
      if (method === "POST" && path === "/oauth/2026-03/token/introspect") {
        if (this.introspection.malformed) return this.send(res, 200, { hello: "world" });
        if (form.get("token_type_hint") !== "access_token") return oauthError(400, "invalid_request", "BAD_REQUEST");
        const t = this.accessTokens.get(form.get("token") ?? "");
        if (!t || t.expiresAt <= Date.now()) return this.send(res, 200, { active: false, ...this.introspection.overrides });
        return this.send(res, 200, {
          active: true,
          token: form.get("token"),
          hub_id: Number(t.hubId),
          user_id: 222222,
          client_id: FAKE_HUBSPOT_CLIENT_ID,
          app_id: 1234444,
          user: "admin@buyer.test",
          hub_domain: "portal.hubspot.test",
          scopes: t.scopes,
          signed_access_token: { expiresAt: t.expiresAt, hubId: Number(t.hubId), signature: "sig", isUserLevel: false, isPrivateDistribution: true },
          expires_in: Math.floor((t.expiresAt - Date.now()) / 1000),
          is_private_distribution: true,
          token_use: "access_token",
          token_type: "Bearer",
          ...this.introspection.overrides,
        });
      }
      this.unexpected.push(`${method} ${path}`);
      return this.send(res, 404, { status: "error", category: "OBJECT_NOT_FOUND" });
    }

    // CRM (authenticated)
    const who = this.auth(req);
    if (!who) return this.send(res, 401, { status: "error", category: "EXPIRED_AUTHENTICATION" });

    if (this.rateLimit) {
      const now = this.clock.now();
      this.hits = this.hits.filter((t) => t > now - this.rateLimit!.windowMs);
      if (this.hits.length >= this.rateLimit.perWindow) {
        this.rateLimited++;
        return this.send(res, 429, { status: "error", errorType: "RATE_LIMIT", policyName: "TEN_SECONDLY_ROLLING" }, { "retry-after": "1", ...this.rateHeaders() });
      }
      this.hits.push(now);
    }
    const headers = this.rateHeaders();
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (method === "GET" && path === "/crm/v3/owners") {
      return this.send(res, 200, { results: this.owners.filter((o) => !o.archived) }, headers);
    }
    if (method === "GET" && path === "/crm/pipelines/2026-09/deals") {
      const ts = "2026-01-01T00:00:00Z";
      return this.send(res, 200, {
        results: this.pipelines.map((p, i) => ({
          archived: p.archived ?? false,
          createdAt: ts,
          updatedAt: ts,
          displayOrder: i,
          id: p.id,
          label: p.label,
          stages: p.stages.map((s, j) => ({
            archived: false,
            createdAt: ts,
            updatedAt: ts,
            displayOrder: j,
            id: s.id,
            label: s.label,
            metadata: {
              ...(s.isClosed === undefined ? {} : { isClosed: String(s.isClosed) }),
              ...(s.probability === undefined ? {} : { probability: s.probability.toFixed(1) }),
            },
            writePermissions: "CRM_PERMISSIONS_ENFORCEMENT",
          })),
        })),
      }, headers);
    }
    if (method === "GET" && path === "/crm/v3/objects/contacts") {
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const after = Number(url.searchParams.get("after") ?? "0");
      const all = [...this.contacts.values()];
      const page = all.slice(after, after + limit);
      return this.send(res, 200, {
        results: page.map((c) => ({ ...c, archived: false })),
        ...(after + limit < all.length ? { paging: { next: { after: String(after + limit) } } } : {}),
      }, headers);
    }
    if (method === "GET" && path === "/crm/v3/objects/deals") {
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const after = Number(url.searchParams.get("after") ?? "0");
      const all = [...this.deals.values()];
      const page = all.slice(after, after + limit);
      const withAssoc = (url.searchParams.get("associations") ?? "").split(",");
      return this.send(res, 200, {
        results: page.map((d) => ({
          id: d.id,
          properties: d.properties,
          archived: false,
          ...(withAssoc.includes("contacts")
            ? {
                associations: {
                  contacts: { results: d.contacts.map((id) => ({ id, type: "deal_to_contact" })) },
                  companies: { results: d.companies.map((id) => ({ id, type: "deal_to_company" })) },
                },
              }
            : {}),
        })),
        ...(after + limit < all.length ? { paging: { next: { after: String(after + limit) } } } : {}),
      }, headers);
    }
    if (method === "POST" && path === "/crm/v3/objects/deals/search") {
      const filters = (json.filterGroups as Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>)[0]!.filters;
      const since = Number(filters.find((f) => f.propertyName === "hs_lastmodifieddate" && f.operator === "GTE")!.value);
      const after = Number(json.after ?? "0");
      if (after >= this.searchCap) return this.send(res, 400, { status: "error", category: "VALIDATION_ERROR" });
      const limit = Math.min(Number(json.limit ?? 10), this.searchPageSize);
      const matching = [...this.deals.values()]
        .filter((d) => Date.parse(d.properties.hs_lastmodifieddate ?? "") >= since)
        .sort((a, b) => Date.parse(a.properties.hs_lastmodifieddate!) - Date.parse(b.properties.hs_lastmodifieddate!) || Number(a.id) - Number(b.id));
      const page = matching.slice(after, after + limit);
      return this.send(res, 200, {
        total: matching.length,
        results: page.map((d) => ({ id: d.id, properties: d.properties })),
        ...(after + limit < matching.length ? { paging: { next: { after: String(after + limit) } } } : {}),
      }, headers);
    }
    const assoc = path.match(/^\/crm\/v4\/associations\/deals\/(contacts|companies)\/batch\/read$/);
    if (method === "POST" && assoc) {
      const kind = assoc[1] as "contacts" | "companies";
      const inputs = json.inputs as Array<{ id: string }>;
      return this.send(res, 200, {
        results: inputs
          .filter((i) => this.deals.has(i.id))
          .map((i) => ({ from: { id: i.id }, to: this.deals.get(i.id)![kind].map((id) => ({ toObjectId: Number(id), associationTypes: [] })) })),
      }, headers);
    }
    const batch = path.match(/^\/crm\/v3\/objects\/(contacts|companies)\/batch\/read$/);
    if (method === "POST" && batch) {
      const store = batch[1] === "contacts" ? this.contacts : this.companies;
      const inputs = json.inputs as Array<{ id: string }>;
      return this.send(res, 200, { status: "COMPLETE", results: inputs.flatMap((i) => (store.has(i.id) ? [store.get(i.id)!] : [])) }, headers);
    }

    this.unexpected.push(`${method} ${path}`);
    return this.send(res, 404, { status: "error", category: "OBJECT_NOT_FOUND" });
  }
}
