import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import type { GmailMessage, GmailMessagePart } from "@/server/integrations/gmail/gmail.types";

/**
 * In-process fake of the Google endpoints Tracklibute uses:
 *   OIDC discovery · JWKS · token (code + refresh) · revoke · Gmail REST v1
 * Scriptable: per-path failure injection, token expiry/revocation, history expiry.
 * No real Google is ever contacted by the test suite.
 */
export const FAKE_CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
export const FAKE_CLIENT_SECRET = "fake-client-secret";

interface Grant {
  sub: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  scope: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  grantRefreshToken: boolean;
}

interface AccessToken {
  mailbox: string;
  expiresAt: number;
}

export class FakeMailbox {
  messages = new Map<string, GmailMessage>();
  history: Array<{ id: number; added?: string[]; deleted?: string[]; labels?: string[] }> = [];
  historyId = 1000;
  /** History records older than this are "expired" (Gmail returns 404). */
  minHistoryId = 0;
  constructor(readonly address: string) {}

  add(msg: GmailMessage): GmailMessage {
    this.historyId++;
    this.messages.set(msg.id, msg);
    this.history.push({ id: this.historyId, added: [msg.id] });
    return msg;
  }
  remove(id: string): void {
    this.historyId++;
    this.messages.delete(id);
    this.history.push({ id: this.historyId, deleted: [id] });
  }
  relabel(id: string, labelIds: string[]): void {
    const m = this.messages.get(id);
    if (!m) return;
    this.historyId++;
    m.labelIds = labelIds;
    this.history.push({ id: this.historyId, labels: [id] });
  }
  expireHistory(): void {
    this.minHistoryId = this.historyId + 1;
  }
}

export interface Failure {
  path: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

/** Gmail per-method quota costs (mirrors Google's "Usage limits" table). */
function quotaCost(method: string | undefined, path: string): number {
  if (path === "/profile") return 1;
  if (path === "/messages") return 5;
  if (path.startsWith("/messages/")) return 20;
  if (path.startsWith("/threads/")) return 40;
  if (path === "/history") return 2;
  return method ? 0 : 0;
}

export interface TestClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Deterministic virtual clock: sleeping advances time instantly (monotonic). */
export class VirtualClock implements TestClock {
  t = Date.UTC(2026, 9, 15);
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t = Math.max(this.t, this.now() + ms);
    await new Promise((r) => setImmediate(r));
  }
}

export class FakeGoogle {
  /** Per-user quota emulation (null = unlimited). Uses `clock` for the sliding window. */
  quota: { unitsPerWindow: number; windowMs: number } | null = null;
  clock: TestClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  rateLimited = 0;
  private usage = new Map<string, Array<{ t: number; units: number }>>();
  issuer = "";
  gmailBase = "";
  private server!: Server;
  private key!: { privateKey: CryptoKey; jwk: JWK };
  private codes = new Map<string, Grant>();
  private refreshTokens = new Map<string, { mailbox: string; revoked: boolean; scope: string }>();
  private accessTokens = new Map<string, AccessToken>();
  mailboxes = new Map<string, FakeMailbox>();
  failures: Failure[] = [];
  requests: string[] = [];
  revokedTokens: string[] = [];
  accessTokenTtlSeconds = 3600;

  async start(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    this.key = { privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" } };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}`;
    this.gmailBase = `${this.issuer}/gmail/v1`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  mailbox(address: string): FakeMailbox {
    let m = this.mailboxes.get(address);
    if (!m) {
      m = new FakeMailbox(address);
      this.mailboxes.set(address, m);
    }
    return m;
  }

  fail(path: RegExp, status: number, times = 1, body?: unknown, headers?: Record<string, string>): void {
    this.failures.push({ path, status, times, body, headers });
  }

  /** Simulate the user at Google's consent screen: returns the callback URL the browser would hit. */
  authorize(
    authorizationUrl: string,
    identity: { sub: string; email: string; name?: string; emailVerified?: boolean; grantedScope?: string; grantRefreshToken?: boolean },
  ): string {
    const u = new URL(authorizationUrl);
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, {
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      emailVerified: identity.emailVerified ?? true,
      scope: identity.grantedScope ?? u.searchParams.get("scope") ?? "",
      nonce: u.searchParams.get("nonce") ?? "",
      codeChallenge: u.searchParams.get("code_challenge") ?? "",
      redirectUri: u.searchParams.get("redirect_uri") ?? "",
      grantRefreshToken: identity.grantRefreshToken ?? u.searchParams.get("access_type") === "offline",
    });
    const cb = new URL(u.searchParams.get("redirect_uri")!);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", u.searchParams.get("state") ?? "");
    return cb.toString();
  }

  /** Issue tokens directly (for sync tests that skip the consent dance). */
  issueTokens(mailbox: string, opts: { expiresInSeconds?: number } = {}) {
    const access = `at-${randomBytes(12).toString("hex")}`;
    const refresh = `rt-${randomBytes(12).toString("hex")}`;
    const ttl = opts.expiresInSeconds ?? this.accessTokenTtlSeconds;
    this.accessTokens.set(access, { mailbox, expiresAt: Date.now() + ttl * 1000 });
    this.refreshTokens.set(refresh, { mailbox, revoked: false, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + ttl * 1000, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" };
  }

  revokeRefreshToken(token: string): void {
    const r = this.refreshTokens.get(token);
    if (r) r.revoked = true;
  }
  revokeAllFor(mailbox: string): void {
    for (const r of this.refreshTokens.values()) if (r.mailbox === mailbox) r.revoked = true;
    for (const [k, a] of this.accessTokens) if (a.mailbox === mailbox) this.accessTokens.delete(k);
  }
  expireAccessTokens(): void {
    for (const a of this.accessTokens.values()) a.expiresAt = 0;
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private async readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  private async idToken(g: Grant): Promise<string> {
    return new SignJWT({ email: g.email, email_verified: g.emailVerified, name: g.name, nonce: g.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(this.issuer)
      .setAudience(FAKE_CLIENT_ID)
      .setSubject(g.sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(this.key.privateKey);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuer);
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);

    const failure = this.failures.find((f) => f.times > 0 && f.path.test(url.pathname));
    if (failure) {
      failure.times--;
      return this.send(res, failure.status, failure.body ?? { error: { code: failure.status } }, failure.headers);
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return this.send(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/o/oauth2/v2/auth`,
        token_endpoint: `${this.issuer}/token`,
        revocation_endpoint: `${this.issuer}/revoke`,
        jwks_uri: `${this.issuer}/certs`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.pathname === "/certs") return this.send(res, 200, { keys: [this.key.jwk] });
    if (url.pathname === "/token" && req.method === "POST") return this.token(req, res);
    if (url.pathname === "/revoke" && req.method === "POST") {
      const form = await this.readForm(req);
      const t = form.get("token") ?? "";
      this.revokedTokens.push(t);
      this.revokeRefreshToken(t);
      return this.send(res, 200, {});
    }
    if (url.pathname.startsWith("/gmail/v1/users/me/")) return this.gmail(req, res, url);
    return this.send(res, 404, { error: "not_found" });
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.readForm(req);
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent)
      : null;
    const clientId = form.get("client_id") ?? basic?.[0];
    const clientSecret = form.get("client_secret") ?? basic?.[1];
    if (clientId !== FAKE_CLIENT_ID || clientSecret !== FAKE_CLIENT_SECRET) {
      return this.send(res, 401, { error: "invalid_client" });
    }

    if (form.get("grant_type") === "authorization_code") {
      const grant = this.codes.get(form.get("code") ?? "");
      if (!grant) return this.send(res, 400, { error: "invalid_grant" });
      this.codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== grant.codeChallenge) return this.send(res, 400, { error: "invalid_grant", error_description: "pkce" });
      if (form.get("redirect_uri") !== grant.redirectUri) return this.send(res, 400, { error: "redirect_uri_mismatch" });
      const access = `at-${randomBytes(12).toString("hex")}`;
      this.accessTokens.set(access, { mailbox: grant.email, expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000 });
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: "Bearer",
        expires_in: this.accessTokenTtlSeconds,
        scope: grant.scope,
        id_token: await this.idToken(grant),
      };
      if (grant.grantRefreshToken) {
        const refresh = `rt-${randomBytes(12).toString("hex")}`;
        this.refreshTokens.set(refresh, { mailbox: grant.email, revoked: false, scope: grant.scope });
        body.refresh_token = refresh;
      }
      return this.send(res, 200, body);
    }

    if (form.get("grant_type") === "refresh_token") {
      const r = this.refreshTokens.get(form.get("refresh_token") ?? "");
      if (!r || r.revoked) return this.send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const access = `at-${randomBytes(12).toString("hex")}`;
      this.accessTokens.set(access, { mailbox: r.mailbox, expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000 });
      return this.send(res, 200, { access_token: access, token_type: "Bearer", expires_in: this.accessTokenTtlSeconds, scope: r.scope });
    }
    return this.send(res, 400, { error: "unsupported_grant_type" });
  }

  private gmail(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const at = this.accessTokens.get(token);
    if (!at || at.expiresAt <= Date.now()) {
      return this.send(res, 401, { error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } });
    }
    const box = this.mailbox(at.mailbox);
    const path = url.pathname.replace("/gmail/v1/users/me", "");

    if (this.quota) {
      const now = this.clock.now();
      const used = (this.usage.get(box.address) ?? []).filter((u) => u.t > now - this.quota!.windowMs);
      const cost = quotaCost(req.method, path);
      const total = used.reduce((n, u) => n + u.units, 0);
      if (total + cost > this.quota.unitsPerWindow) {
        this.rateLimited++;
        this.usage.set(box.address, used);
        return this.send(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }] } });
      }
      used.push({ t: now, units: cost });
      this.usage.set(box.address, used);
    }

    if (path === "/profile") return this.send(res, 200, { emailAddress: box.address, historyId: String(box.historyId) });

    if (path === "/messages") {
      const after = Number((url.searchParams.get("q") ?? "").match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      const all = [...box.messages.values()]
        .filter((m) => !(m.labelIds ?? []).some((l) => l === "SPAM" || l === "TRASH"))
        .filter((m) => Number(m.internalDate) >= after)
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(offset, offset + max);
      return this.send(res, 200, {
        ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
        ...(offset + max < all.length ? { nextPageToken: String(offset + max) } : {}),
      });
    }

    const msgMatch = path.match(/^\/messages\/([^/]+)$/);
    if (msgMatch) {
      const m = box.messages.get(decodeURIComponent(msgMatch[1]!));
      return m ? this.send(res, 200, m) : this.send(res, 404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
    }

    const threadMatch = path.match(/^\/threads\/([^/]+)$/);
    if (threadMatch) {
      const id = decodeURIComponent(threadMatch[1]!);
      const msgs = [...box.messages.values()].filter((m) => m.threadId === id);
      if (!msgs.length) return this.send(res, 404, { error: { code: 404 } });
      return this.send(res, 200, {
        id,
        historyId: String(box.historyId),
        messages: msgs.map((m) => ({ id: m.id, internalDate: m.internalDate, labelIds: m.labelIds })),
      });
    }

    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (!Number.isFinite(start) || start < box.minHistoryId) {
        return this.send(res, 404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
      }
      const records = box.history.filter((h) => h.id > start);
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const page = records.slice(offset, offset + max);
      return this.send(res, 200, {
        historyId: String(box.historyId),
        ...(page.length
          ? {
              history: page.map((h) => ({
                id: String(h.id),
                ...(h.added ? { messagesAdded: h.added.map((id) => ({ message: { id, threadId: box.messages.get(id)?.threadId } })) } : {}),
                ...(h.deleted ? { messagesDeleted: h.deleted.map((id) => ({ message: { id } })) } : {}),
                ...(h.labels ? { labelsAdded: h.labels.map((id) => ({ message: { id } })) } : {}),
              })),
            }
          : {}),
        ...(offset + max < records.length ? { nextPageToken: String(offset + max) } : {}),
      });
    }
    return this.send(res, 404, { error: { code: 404 } });
  }
}

// ─── Message builders ───────────────────────────────────────────────────────

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

let seq = 0;
export function gmailMessage(input: {
  id?: string;
  threadId: string;
  from: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  date?: Date;
  plain?: string | null;
  html?: string | null;
  labelIds?: string[];
  snippet?: string;
  extraHeaders?: Array<{ name: string; value: string }>;
  payload?: GmailMessagePart;
}): GmailMessage {
  const id = input.id ?? `m${Date.now().toString(36)}${(seq++).toString(36)}`;
  const date = input.date ?? new Date();
  const headers = [
    { name: "From", value: input.from },
    ...(input.to ? [{ name: "To", value: input.to }] : []),
    ...(input.cc ? [{ name: "Cc", value: input.cc }] : []),
    ...(input.bcc ? [{ name: "Bcc", value: input.bcc }] : []),
    ...(input.subject !== undefined ? [{ name: "Subject", value: input.subject }] : []),
    { name: "Date", value: date.toUTCString() },
    { name: "Message-ID", value: `<${id}@mail.test>` },
    ...(input.extraHeaders ?? []),
  ];
  const parts: GmailMessagePart[] = [];
  if (input.plain != null) parts.push({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64(input.plain) } });
  if (input.html != null) parts.push({ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: b64(input.html) } });
  return {
    id,
    threadId: input.threadId,
    labelIds: input.labelIds ?? ["INBOX"],
    snippet: input.snippet ?? (input.plain ?? "").slice(0, 100),
    internalDate: String(date.getTime()),
    payload: input.payload ?? { mimeType: "multipart/alternative", headers, parts },
  };
}
