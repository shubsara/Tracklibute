import "server-only";

import { log } from "@/lib/log";

import { type Clock, type QuotaPacer, realClock } from "../pacing";
import type { HubSpotErrorBody } from "./hubspot.types";

/**
 * Minimal, READ-ONLY HubSpot HTTP client.
 *
 * Every request — OAuth included — passes `assertAllowedHubSpotRequest`, a
 * closed allow-list of (method, path) pairs. The only POSTs are the OAuth
 * token exchange / introspection and read-only query endpoints (search,
 * batch read); any
 * other method or path throws before a network call is made. There is no
 * code path that can create, update or delete a HubSpot record.
 *
 * Rate limits (HubSpot "API usage guidelines"):
 *   · OAuth apps: 110 requests / 10 s per installed account (Search excluded)
 *   · Search: ~4–5 requests / s per account, max 10,000 results per query
 * Two pacers keep us under both. 429s back off (Retry-After, else truncated
 * exponential); a DAILY 429 or a nearly spent daily allowance stops the run.
 * Errors carry endpoint + HTTP status + HubSpot's category code only — never
 * bodies or headers that could echo tokens or CRM data.
 */
export const HUBSPOT_API_BASE_URL = "https://api.hubapi.com";

export type HubSpotEndpoint =
  | "oauth.token"
  | "oauth.introspect"
  | "owners.list"
  | "pipelines.deals"
  | "deals.list"
  | "deals.search"
  | "associations.batchRead"
  | "contacts.batchRead"
  | "companies.batchRead";

interface AllowedRequest {
  endpoint: HubSpotEndpoint;
  method: "GET" | "POST";
  path: RegExp;
}

/** The complete set of HubSpot requests Tracklibute can make. */
export const HUBSPOT_ALLOWED_REQUESTS: readonly AllowedRequest[] = [
  // OAuth 2026-03: every secret travels in the form body, never in the URL.
  { endpoint: "oauth.token", method: "POST", path: /^\/oauth\/2026-03\/token$/ },
  { endpoint: "oauth.introspect", method: "POST", path: /^\/oauth\/2026-03\/token\/introspect$/ },
  { endpoint: "owners.list", method: "GET", path: /^\/crm\/v3\/owners$/ },
  // Pipelines 2026-09 (read): deal pipelines only.
  { endpoint: "pipelines.deals", method: "GET", path: /^\/crm\/pipelines\/2026-09\/deals$/ },
  { endpoint: "deals.list", method: "GET", path: /^\/crm\/v3\/objects\/deals$/ },
  { endpoint: "deals.search", method: "POST", path: /^\/crm\/v3\/objects\/deals\/search$/ },
  { endpoint: "associations.batchRead", method: "POST", path: /^\/crm\/v4\/associations\/deals\/(contacts|companies)\/batch\/read$/ },
  { endpoint: "contacts.batchRead", method: "POST", path: /^\/crm\/v3\/objects\/contacts\/batch\/read$/ },
  { endpoint: "companies.batchRead", method: "POST", path: /^\/crm\/v3\/objects\/companies\/batch\/read$/ },
];

export class HubSpotRequestNotAllowedError extends Error {
  constructor(method: string, path: string) {
    // Never echo the full path (defence in depth against secrets in URLs).
    super(`HubSpot request refused by the read-only allow-list (${method} ${path.split("/").slice(0, 4).join("/")}…)`);
    this.name = "HubSpotRequestNotAllowedError";
  }
}

export function assertAllowedHubSpotRequest(method: string, path: string, endpoint?: HubSpotEndpoint): HubSpotEndpoint {
  const m = method.toUpperCase();
  const hit = HUBSPOT_ALLOWED_REQUESTS.find((r) => r.method === m && r.path.test(path) && (!endpoint || r.endpoint === endpoint));
  if (!hit) throw new HubSpotRequestNotAllowedError(m, path);
  return hit.endpoint;
}

export type HubSpotErrorKind =
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "rate_limited"
  | "daily_limit"
  | "transient"
  | "not_found"
  | "bad_request";

export class HubSpotApiError extends Error {
  constructor(
    readonly kind: HubSpotErrorKind,
    readonly status: number,
    readonly reason: string | null,
    readonly endpoint: HubSpotEndpoint,
  ) {
    super(`HubSpot API ${endpoint} ${kind} (HTTP ${status}${reason ? `, ${reason}` : ""})`);
    this.name = "HubSpotApiError";
  }
}

const RATE_LIMIT_MAX_BACKOFF_MS = 32_000;
const RETRY_AFTER_MAX_MS = 64_000;
/** Stop when less than this share of the daily allowance remains. */
const DAILY_RESERVE_RATIO = 0.05;

export function hubspotBackoffMs(attempt: number, random = Math.random): number {
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, 1000 * 2 ** attempt) + Math.floor(random() * 1000);
}

/** Low-level fetch through the allow-list. Shared by the OAuth module and the client. */
export async function hubspotFetch(
  fetchImpl: typeof fetch,
  baseUrl: string,
  endpoint: HubSpotEndpoint,
  method: "GET" | "POST",
  path: string,
  init: { query?: Record<string, string | undefined>; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  assertAllowedHubSpotRequest(method, path, endpoint);
  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  return fetchImpl(url, { method, headers: { accept: "application/json", ...init.headers }, body: init.body });
}

export interface HubSpotClientOptions {
  baseUrl?: string;
  getAccessToken: (forceRefresh: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** General API pacing (requests / second). */
  pacer?: QuotaPacer;
  /** Search API pacing (requests / second). */
  searchPacer?: QuotaPacer;
  maxRateLimitRetries?: number;
  maxTransientRetries?: number;
}

export class HubSpotClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly maxRateLimitRetries: number;
  private readonly maxTransientRetries: number;
  /** Requests sent by this client (non-secret counters for logs/tests). */
  requestCount = 0;

  constructor(private readonly opts: HubSpotClientOptions) {
    this.baseUrl = (opts.baseUrl ?? HUBSPOT_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? realClock;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 5;
    this.maxTransientRetries = opts.maxTransientRetries ?? 3;
  }

  get<T>(endpoint: HubSpotEndpoint, path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    return this.send(endpoint, "GET", path, { query });
  }

  /** POST for read-only query endpoints only (search / batch read) — enforced by the allow-list. */
  query<T>(endpoint: HubSpotEndpoint, path: string, body: unknown): Promise<T> {
    return this.send(endpoint, "POST", path, { body: JSON.stringify(body) });
  }

  private async send<T>(
    endpoint: HubSpotEndpoint,
    method: "GET" | "POST",
    path: string,
    init: { query?: Record<string, string | undefined>; body?: string },
  ): Promise<T> {
    assertAllowedHubSpotRequest(method, path, endpoint);
    const pacer = endpoint === "deals.search" ? this.opts.searchPacer : this.opts.pacer;
    let refreshed = false;
    let rateLimitAttempts = 0;
    let transientAttempts = 0;
    for (;;) {
      await pacer?.acquire(1);
      let res: Response;
      try {
        const token = await this.opts.getAccessToken(false);
        this.requestCount++;
        res = await hubspotFetch(this.fetchImpl, this.baseUrl, endpoint, method, path, {
          query: init.query,
          body: init.body,
          headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        });
      } catch (err) {
        if (err instanceof HubSpotApiError || transientAttempts >= this.maxTransientRetries || !isNetworkError(err)) throw err;
        await this.clock.sleep(transientBackoff(transientAttempts++));
        continue;
      }

      this.observeRateHeaders(res, pacer);
      if (res.ok) {
        const daily = dailyLow(res);
        const body = (await res.json()) as T;
        if (daily) throw new HubSpotApiError("daily_limit", res.status, "DAILY_RESERVE", endpoint);
        return body;
      }

      const reason = await readReason(res);
      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          await this.opts.getAccessToken(true);
          continue;
        }
        throw new HubSpotApiError("unauthorized", 401, reason, endpoint);
      }
      if (res.status === 429) {
        if (reason === "DAILY") throw new HubSpotApiError("daily_limit", 429, reason, endpoint);
        if (rateLimitAttempts >= this.maxRateLimitRetries) throw new HubSpotApiError("rate_limited", 429, reason, endpoint);
        const delay = retryAfterMs(res) ?? hubspotBackoffMs(rateLimitAttempts);
        rateLimitAttempts++;
        log.warn("hubspot.rate_limited_retry", { endpoint, httpStatus: 429, providerReason: reason, attempt: rateLimitAttempts, delayMs: delay });
        pacer?.pauseUntil(this.clock.now() + delay);
        await this.clock.sleep(delay);
        continue;
      }
      if (res.status >= 500) {
        if (transientAttempts >= this.maxTransientRetries) throw new HubSpotApiError("transient", res.status, reason, endpoint);
        await this.clock.sleep(retryAfterMs(res) ?? transientBackoff(transientAttempts++));
        continue;
      }
      if (res.status === 403) {
        throw new HubSpotApiError(reason === "MISSING_SCOPES" ? "insufficient_scope" : "forbidden", 403, reason, endpoint);
      }
      if (res.status === 404) throw new HubSpotApiError("not_found", 404, reason, endpoint);
      throw new HubSpotApiError("bad_request", res.status, reason, endpoint);
    }
  }

  /** Adaptive pacing: if the rolling window is nearly spent, wait for it to roll over. */
  private observeRateHeaders(res: Response, pacer: QuotaPacer | undefined): void {
    const remaining = Number(res.headers.get("x-hubspot-ratelimit-remaining"));
    const intervalMs = Number(res.headers.get("x-hubspot-ratelimit-interval-milliseconds"));
    if (res.headers.has("x-hubspot-ratelimit-remaining") && Number.isFinite(remaining) && remaining <= 2) {
      pacer?.pauseUntil(this.clock.now() + (Number.isFinite(intervalMs) && intervalMs > 0 ? Math.min(intervalMs, 10_000) : 1_000));
    }
  }
}

function dailyLow(res: Response): boolean {
  const max = Number(res.headers.get("x-hubspot-ratelimit-daily"));
  const remaining = Number(res.headers.get("x-hubspot-ratelimit-daily-remaining"));
  if (!res.headers.has("x-hubspot-ratelimit-daily-remaining") || !Number.isFinite(max) || !Number.isFinite(remaining) || max <= 0) {
    return false;
  }
  return remaining < Math.max(100, max * DAILY_RESERVE_RATIO);
}

function transientBackoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  return Number.isFinite(secs) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, secs * 1000)) : null;
}

/**
 * HubSpot's machine-readable codes only (policyName for 429s, RFC 6749
 * `error` / legacy `status` for OAuth, category for CRM) — never `message` or
 * `error_description` text, which can echo request data.
 */
export async function readReason(res: Response): Promise<string | null> {
  try {
    const e = (await res.json()) as HubSpotErrorBody;
    const policy = typeof e.policyName === "string" ? e.policyName : null;
    const candidates = [
      policy === "DAILY" ? "DAILY" : null,
      e.error,
      e.category,
      e.status !== "error" ? e.status : null,
      e.errorType,
      policy,
    ];
    const hit = candidates.find((r): r is string => typeof r === "string" && /^[A-Za-z_]{1,64}$/.test(r));
    return hit ?? null;
  } catch {
    return null;
  }
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"]);
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && /^fetch failed$/i.test(err.message);
}
