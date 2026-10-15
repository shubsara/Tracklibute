import "server-only";

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
 * Retries: 429 / rate-limit 403 and 5xx / network errors, with bounded
 * exponential backoff (honours Retry-After). A 401 triggers exactly one
 * forced token refresh. Errors carry only status + reason — never bodies
 * that might echo tokens.
 */
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

export type GmailErrorKind =
  | "unauthorized"
  | "rate_limited"
  | "transient"
  | "not_found"
  | "history_expired"
  | "forbidden"
  | "bad_request";

export class GmailApiError extends Error {
  constructor(
    readonly kind: GmailErrorKind,
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`Gmail API ${kind} (HTTP ${status}${reason ? `, ${reason}` : ""})`);
    this.name = "GmailApiError";
  }
}

export interface GmailClientOptions {
  baseUrl?: string;
  /** Returns a valid access token; `forceRefresh` after a 401. */
  getAccessToken: (forceRefresh: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

export const MESSAGE_FIELDS = "id,threadId,labelIds,snippet,internalDate,historyId,payload";
const HISTORY_FIELDS =
  "history(id,messagesAdded/message(id,threadId,labelIds),messagesDeleted/message(id),labelsAdded/message(id),labelsRemoved/message(id)),historyId,nextPageToken";

export class GmailClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: GmailClientOptions) {
    this.baseUrl = (opts.baseUrl ?? GMAIL_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
  }

  getProfile(): Promise<GmailProfile> {
    return this.get("/users/me/profile", { fields: "emailAddress,historyId" });
  }

  listMessages(input: { q?: string; pageToken?: string; maxResults?: number }): Promise<GmailListMessagesResponse> {
    return this.get("/users/me/messages", {
      q: input.q,
      pageToken: input.pageToken,
      maxResults: String(input.maxResults ?? 100),
      fields: "messages(id,threadId),nextPageToken",
    });
  }

  getMessage(id: string): Promise<GmailMessage> {
    return this.get(`/users/me/messages/${encodeURIComponent(id)}`, { format: "full", fields: MESSAGE_FIELDS });
  }

  getThread(id: string): Promise<GmailThread> {
    return this.get(`/users/me/threads/${encodeURIComponent(id)}`, {
      format: "minimal",
      fields: "id,historyId,messages(id,internalDate,labelIds)",
    });
  }

  listHistory(input: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryResponse> {
    return this.get(
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
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const token = await this.opts.getAccessToken(false);
        res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch (err) {
        if (err instanceof GmailApiError || attempt >= this.maxRetries || !isNetworkError(err)) throw err;
        await this.sleep(backoff(attempt));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const reason = await readReason(res);
      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true;
          await this.opts.getAccessToken(true);
          continue;
        }
        throw new GmailApiError("unauthorized", 401, reason);
      }
      const rateLimited = res.status === 429 || (res.status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason));
      const transient = res.status >= 500;
      if ((rateLimited || transient) && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      if (rateLimited) throw new GmailApiError("rate_limited", res.status, reason);
      if (transient) throw new GmailApiError("transient", res.status, reason);
      if (res.status === 404) throw new GmailApiError(opts.notFoundKind ?? "not_found", 404, reason);
      if (res.status === 403) throw new GmailApiError("forbidden", 403, reason);
      throw new GmailApiError("bad_request", res.status, reason);
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  return Number.isFinite(secs) ? Math.min(30_000, Math.max(0, secs * 1000)) : null;
}

async function readReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as GmailErrorBody;
    return body.error?.errors?.[0]?.reason ?? body.error?.status ?? null;
  } catch {
    return null;
  }
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /fetch failed|ECONN|ETIMEDOUT|socket/i.test(err.message));
}
