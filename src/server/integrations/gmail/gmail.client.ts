import "server-only";

import { log } from "@/lib/log";

import { type Clock, type QuotaPacer, realClock } from "../pacing";

import type {
  GmailErrorBody,
  GmailHistoryResponse,
  GmailListMessagesResponse,
  GmailMessage,
  GmailProfile,
  GmailThread,
} from "./gmail.types";

/**
 * Minimal Gmail REST client (users/me only). Every call sends a `fields`
 * mask so Google returns only what Tracklibute uses.
 *
 * Quota: Google allows 6,000 units/minute/user/project; each method has a
 * unit cost (QUOTA_COST). A shared QuotaPacer spaces requests so a sync stays
 * under that budget instead of bursting into 429s.
 *
 * Retries:
 *  - rate limits (429, rate-limit 403s): truncated exponential backoff per
 *    Google's guidance — 1s, 2s, 4s … capped at 32s, + up to 1s jitter,
 *    honouring Retry-After; the pacer is paused so sibling workers wait too.
 *  - 5xx / network errors: short exponential backoff.
 *  - 401: exactly one forced token refresh.
 * Errors carry only endpoint + HTTP status + Google's reason code — never
 * bodies or headers that might echo tokens.
 */
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

export type GmailEndpoint = "getProfile" | "messages.list" | "messages.get" | "threads.get" | "history.list";

/** Units per call (Google "Usage limits" page, updated 2026-09-10). */
export const QUOTA_COST: Record<GmailEndpoint, number> = {
  getProfile: 1,
  "messages.list": 5,
  "messages.get": 20,
  "threads.get": 40,
  "history.list": 2,
};

export type GmailErrorKind =
  | "unauthorized"
  | "rate_limited"
  | "transient"
  | "not_found"
  | "history_expired"
  | "api_disabled"
  | "insufficient_scope"
  | "forbidden"
  | "bad_request";

export class GmailApiError extends Error {
  constructor(
    readonly kind: GmailErrorKind,
    readonly status: number,
    readonly reason: string | null,
    readonly endpoint: GmailEndpoint,
  ) {
    super(`Gmail API ${endpoint} ${kind} (HTTP ${status}${reason ? `, ${reason}` : ""})`);
    this.name = "GmailApiError";
  }
}

export { type Clock, QuotaPacer, realClock } from "../pacing";

export interface GmailClientOptions {
  baseUrl?: string;
  /** Returns a valid access token; `forceRefresh` after a 401. */
  getAccessToken: (forceRefresh: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** @deprecated use `clock` — kept for tests that only stub sleeping. */
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
  pacer?: QuotaPacer;
  maxRateLimitRetries?: number;
  maxTransientRetries?: number;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED"]);
/** Gmail API not enabled for the Google Cloud project — an admin/config problem, not the user's grant. */
const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
/** The token lacks the required scope — the user must re-consent. */
const INSUFFICIENT_SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const RATE_LIMIT_MAX_BACKOFF_MS = 32_000;
const RETRY_AFTER_MAX_MS = 64_000;

export const MESSAGE_FIELDS = "id,threadId,labelIds,snippet,internalDate,historyId,payload";
const HISTORY_FIELDS =
  "history(id,messagesAdded/message(id,threadId,labelIds),messagesDeleted/message(id),labelsAdded/message(id),labelsRemoved/message(id)),historyId,nextPageToken";

/** Truncated exponential backoff for rate limits: min(2^n s, 32 s) + up to 1 s jitter. */
export function rateLimitBackoffMs(attempt: number, random = Math.random): number {
  return Math.min(RATE_LIMIT_MAX_BACKOFF_MS, 1000 * 2 ** attempt) + Math.floor(random() * 1000);
}

function transientBackoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export class GmailClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly maxRateLimitRetries: number;
  private readonly maxTransientRetries: number;

  constructor(private readonly opts: GmailClientOptions) {
    this.baseUrl = (opts.baseUrl ?? GMAIL_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? (opts.sleep ? { now: () => Date.now(), sleep: opts.sleep } : realClock);
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 5;
    this.maxTransientRetries = opts.maxTransientRetries ?? 3;
  }

  getProfile(): Promise<GmailProfile> {
    return this.get("getProfile", "/users/me/profile", { fields: "emailAddress,historyId" });
  }

  listMessages(input: { q?: string; pageToken?: string; maxResults?: number }): Promise<GmailListMessagesResponse> {
    return this.get("messages.list", "/users/me/messages", {
      q: input.q,
      pageToken: input.pageToken,
      maxResults: String(input.maxResults ?? 100),
      fields: "messages(id,threadId),nextPageToken",
    });
  }

  getMessage(id: string): Promise<GmailMessage> {
    return this.get("messages.get", `/users/me/messages/${encodeURIComponent(id)}`, {
      format: "full",
      fields: MESSAGE_FIELDS,
    });
  }

  getThread(id: string): Promise<GmailThread> {
    return this.get("threads.get", `/users/me/threads/${encodeURIComponent(id)}`, {
      format: "minimal",
      fields: "id,historyId,messages(id,internalDate,labelIds)",
    });
  }

  listHistory(input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryResponse> {
    return this.get(
      "history.list",
      "/users/me/history",
      {
        startHistoryId: input.startHistoryId,
        pageToken: input.pageToken,
        maxResults: "500",
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        fields: HISTORY_FIELDS,
      },
      { notFoundKind: "history_expired" },
    );
  }

  private async get<T>(
    endpoint: GmailEndpoint,
    path: string,
    params: Record<string, string | string[] | undefined>,
    opts: { notFoundKind?: GmailErrorKind } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }

    let refreshed = false;
    let rateLimitAttempts = 0;
    let transientAttempts = 0;
    for (;;) {
      await this.opts.pacer?.acquire(QUOTA_COST[endpoint]);
      let res: Response;
      try {
        const token = await this.opts.getAccessToken(false);
        res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch (err) {
        if (err instanceof GmailApiError || transientAttempts >= this.maxTransientRetries || !isNetworkError(err)) throw err;
        await this.clock.sleep(transientBackoffMs(transientAttempts++));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const reasons = await readReasons(res);
      // The most specific known reason wins; otherwise the first one Google sent.
      const reason =
        reasons.find((r) => RATE_LIMIT_REASONS.has(r) || API_DISABLED_REASONS.has(r) || INSUFFICIENT_SCOPE_REASONS.has(r)) ??
        reasons[0] ??
        null;
      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          await this.opts.getAccessToken(true);
          continue;
        }
        throw new GmailApiError("unauthorized", 401, reason, endpoint);
      }

      const rateLimited = res.status === 429 || (res.status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason));
      if (rateLimited) {
        if (rateLimitAttempts >= this.maxRateLimitRetries) throw new GmailApiError("rate_limited", res.status, reason, endpoint);
        const delay = retryAfterMs(res) ?? rateLimitBackoffMs(rateLimitAttempts);
        rateLimitAttempts++;
        log.warn("gmail.rate_limited_retry", {
          endpoint,
          httpStatus: res.status,
          providerReason: reason,
          attempt: rateLimitAttempts,
          delayMs: delay,
        });
        // Stall every worker sharing this pacer, not just this request.
        this.opts.pacer?.pauseUntil(this.clock.now() + delay);
        await this.clock.sleep(delay);
        continue;
      }
      if (res.status >= 500) {
        if (transientAttempts >= this.maxTransientRetries) throw new GmailApiError("transient", res.status, reason, endpoint);
        await this.clock.sleep(retryAfterMs(res) ?? transientBackoffMs(transientAttempts++));
        continue;
      }
      if (res.status === 404) throw new GmailApiError(opts.notFoundKind ?? "not_found", 404, reason, endpoint);
      if (res.status === 403) {
        if (reason && API_DISABLED_REASONS.has(reason)) throw new GmailApiError("api_disabled", 403, reason, endpoint);
        if (reason && INSUFFICIENT_SCOPE_REASONS.has(reason)) throw new GmailApiError("insufficient_scope", 403, reason, endpoint);
        throw new GmailApiError("forbidden", 403, reason, endpoint);
      }
      throw new GmailApiError("bad_request", res.status, reason, endpoint);
    }
  }
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  return Number.isFinite(secs) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, secs * 1000)) : null;
}

/**
 * Google's machine-readable reason codes only (e.g. "accessNotConfigured",
 * "SERVICE_DISABLED") from errors[].reason, details[].reason and status —
 * never message text, which can echo request data.
 */
async function readReasons(res: Response): Promise<string[]> {
  try {
    const e = ((await res.json()) as GmailErrorBody).error;
    const all = [
      ...(e?.errors ?? []).map((x) => x?.reason),
      ...(e?.details ?? []).map((x) => x?.reason),
      e?.status,
    ];
    return all.filter((r): r is string => typeof r === "string" && /^[A-Za-z_]{1,64}$/.test(r));
  } catch {
    return [];
  }
}

/**
 * Transport-level failures only (fetch rejected). Errors raised by our own
 * token provider (e.g. a revoked grant) must never be retried as "network"
 * errors — note "reconnect" contains "econn", so match exact Node codes.
 */
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"]);
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && /^fetch failed$/i.test(err.message);
}
