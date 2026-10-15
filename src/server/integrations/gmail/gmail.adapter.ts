import "server-only";

import type { AuthContext } from "@/domain/auth/auth-context";
import {
  type MailboxChangePage,
  MailboxAuthorizationRevokedError,
  MailboxCursorExpiredError,
  MailboxError,
  MailboxRateLimitedError,
  type MailboxSource,
  MailboxUnavailableError,
  type MessageIdPage,
  type NormalizedEmailMessage,
} from "@/domain/email/types";
import type {
  AuthorizationStart,
  ConnectionHealth,
  ConnectionResult,
  DecryptedCredentials,
  IntegrationAdapter,
} from "@/domain/integrations/adapter";
import { INTEGRATION_PROVIDER_INFO } from "@/domain/integrations/providers";
import { getEnv } from "@/lib/env";
import { loadIntegrationCredentials, storeIntegrationCredentials } from "@/server/integrations/integrations.service";

import { GMAIL_API_BASE_URL, GmailApiError, GmailClient } from "./gmail.client";
import { mapGmailMessage } from "./gmail.mapper";
import {
  beginGmailAuthorization,
  exchangeGmailCode,
  GMAIL_READONLY_SCOPE,
  type GmailCredentials,
  needsRefresh,
  parseGmailCredentials,
  refreshGmailCredentials,
} from "./gmail.oauth";
import { markGmailReauthRequired } from "./gmail-reauth";

/** Test-only base URL override (fake Gmail server); ignored outside NODE_ENV=test. */
export function gmailApiBaseUrl(): string {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.GMAIL_API_BASE_URL ? env.GMAIL_API_BASE_URL : GMAIL_API_BASE_URL;
}

/** Translate transport errors into provider-neutral mailbox errors. */
function toMailboxError(err: unknown): unknown {
  if (err instanceof MailboxError || !(err instanceof GmailApiError)) return err;
  switch (err.kind) {
    case "history_expired":
      return new MailboxCursorExpiredError();
    case "unauthorized":
    case "forbidden":
      return new MailboxAuthorizationRevokedError();
    case "rate_limited":
      return new MailboxRateLimitedError();
    case "transient":
      return new MailboxUnavailableError();
    default:
      return new MailboxError(`Gmail returned an unexpected response (HTTP ${err.status})`, "invalid_response");
  }
}

async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toMailboxError(err);
  }
}

/**
 * MailboxSource over the Gmail API. Everything it returns is provider-neutral.
 */
export class GmailMailboxSource implements MailboxSource {
  constructor(private readonly client: GmailClient) {}

  getMailbox(): Promise<{ address: string; cursor: string }> {
    return translate(async () => {
      const p = await this.client.getProfile();
      return { address: p.emailAddress.toLowerCase(), cursor: String(p.historyId) };
    });
  }

  listMessageIdsSince(since: Date, pageToken?: string): Promise<MessageIdPage> {
    return translate(async () => {
      const res = await this.client.listMessages({
        q: `after:${Math.floor(since.getTime() / 1000)}`,
        pageToken,
        maxResults: 100,
      });
      return { ids: (res.messages ?? []).map((m) => m.id), nextPageToken: res.nextPageToken ?? null };
    });
  }

  getMessage(externalMessageId: string): Promise<NormalizedEmailMessage | null> {
    return translate(async () => {
      try {
        return mapGmailMessage(await this.client.getMessage(externalMessageId));
      } catch (err) {
        if (err instanceof GmailApiError && err.kind === "not_found") return null;
        throw err;
      }
    });
  }

  listChangesSince(cursor: string, pageToken?: string): Promise<MailboxChangePage> {
    return translate(async () => {
      const res = await this.client.listHistory({ startHistoryId: cursor, pageToken });
      const changed = new Set<string>();
      const deleted = new Set<string>();
      for (const record of res.history ?? []) {
        const touch = (id: string | undefined) => {
          if (!id) return;
          deleted.delete(id);
          changed.add(id);
        };
        for (const a of record.messagesAdded ?? []) touch(a.message?.id);
        for (const a of record.labelsAdded ?? []) touch(a.message?.id);
        for (const a of record.labelsRemoved ?? []) touch(a.message?.id);
        for (const d of record.messagesDeleted ?? []) {
          if (!d.message?.id) continue;
          changed.delete(d.message.id);
          deleted.add(d.message.id);
        }
      }
      return {
        changed: [...changed],
        deleted: [...deleted],
        nextPageToken: res.nextPageToken ?? null,
        cursor: String(res.historyId ?? cursor),
      };
    });
  }

  /** Thread metadata (ids + last activity) without message content. */
  getThreadMetadata(externalThreadId: string) {
    return translate(async () => {
      const t = await this.client.getThread(externalThreadId);
      const times = (t.messages ?? []).map((m) => Number(m.internalDate)).filter((n) => Number.isFinite(n));
      return {
        externalThreadId: t.id,
        messageIds: (t.messages ?? []).map((m) => m.id),
        lastActivityAt: times.length ? new Date(Math.max(...times)) : null,
      };
    });
  }
}

/**
 * Supplies access tokens for one integration: loads from the vault, refreshes
 * near expiry, persists refreshed credentials (encrypted), and flags
 * REAUTH_REQUIRED when Google rejects the refresh token.
 */
export class GmailTokenProvider {
  private creds: GmailCredentials | undefined;

  constructor(
    private readonly auth: AuthContext,
    private readonly integrationId: string,
    private readonly actor: "USER" | "SYSTEM" = "USER",
  ) {}

  async getAccessToken(forceRefresh: boolean): Promise<string> {
    this.creds ??= parseGmailCredentials(await loadIntegrationCredentials(this.auth, this.integrationId));
    if (!forceRefresh && !needsRefresh(this.creds)) return this.creds.accessToken;
    let next: GmailCredentials;
    try {
      next = await refreshGmailCredentials(this.creds);
    } catch (err) {
      if (err instanceof MailboxAuthorizationRevokedError) {
        await markGmailReauthRequired(this.auth, this.integrationId, { actor: this.actor });
      }
      throw err;
    }
    await storeIntegrationCredentials(this.auth, this.integrationId, { ...next }, {
      tokenExpiresAt: new Date(next.expiresAt),
      audit: false,
    });
    this.creds = next;
    return next.accessToken;
  }
}

export interface GmailSourceOptions {
  actor?: "USER" | "SYSTEM";
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createGmailMailboxSource(
  auth: AuthContext,
  integrationId: string,
  opts: GmailSourceOptions = {},
): GmailMailboxSource {
  const tokens = new GmailTokenProvider(auth, integrationId, opts.actor);
  const client = new GmailClient({
    baseUrl: gmailApiBaseUrl(),
    getAccessToken: (force) => tokens.getAccessToken(force),
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  return new GmailMailboxSource(client);
}

/** IntegrationAdapter implementation for Gmail (the Foundation's adapter contract). */
export class GmailIntegrationAdapter implements IntegrationAdapter {
  readonly provider = "GMAIL" as const;
  readonly capabilities = INTEGRATION_PROVIDER_INFO.GMAIL.capabilities.filter((c) => c === "email.read");
  readonly requiredScopes = [GMAIL_READONLY_SCOPE] as const;

  constructor(private readonly opts: { fetchImpl?: typeof fetch } = {}) {}

  async beginAuthorization(input: { redirectUri: string; loginHint?: string }): Promise<AuthorizationStart> {
    const start = await beginGmailAuthorization(input.loginHint);
    return { redirectUrl: start.url.toString(), state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier };
  }

  async completeAuthorization(input: {
    requestUrl: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<ConnectionResult> {
    const { credentials, scopes } = await exchangeGmailCode(input);
    // The connected mailbox is whatever Gmail says it is — not the sign-in email.
    const client = new GmailClient({
      baseUrl: gmailApiBaseUrl(),
      getAccessToken: async () => credentials.accessToken,
      fetchImpl: this.opts.fetchImpl,
    });
    const profile = await translate(() => client.getProfile());
    return {
      externalAccountId: profile.emailAddress.toLowerCase(),
      scopes,
      credentials: { ...credentials },
      tokenExpiresAt: new Date(credentials.expiresAt),
    };
  }

  async checkConnection(raw: DecryptedCredentials): Promise<ConnectionHealth> {
    const creds = parseGmailCredentials(raw);
    const client = new GmailClient({ baseUrl: gmailApiBaseUrl(), getAccessToken: async () => creds.accessToken });
    try {
      await client.getProfile();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof GmailApiError ? err.kind : "error" };
    }
  }
}
