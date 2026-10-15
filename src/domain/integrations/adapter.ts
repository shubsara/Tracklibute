import type { IntegrationCapability, IntegrationProviderKey } from "./providers";

/**
 * Contract every provider adapter implements (GmailAdapter now; HubSpot and
 * Google Calendar adapters in their own specs).
 *
 * Adapters are the ONLY code allowed to talk to a provider API. They are
 * invoked by server-side services and registered action executors, never by
 * an LLM and never with arbitrary endpoints/methods.
 *
 * Credentials cross this boundary only between the adapter and the
 * server-side credential vault. They must never be logged, returned to
 * clients, or persisted elsewhere.
 */
export type DecryptedCredentials = Readonly<Record<string, unknown>>;

/** An OAuth authorization request; the caller persists state/nonce/verifier server-side (signed cookie). */
export interface AuthorizationStart {
  readonly redirectUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface ConnectionResult {
  readonly externalAccountId: string;
  readonly scopes: readonly string[];
  readonly credentials: DecryptedCredentials;
  readonly tokenExpiresAt: Date | null;
}

export interface ConnectionHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface IntegrationAdapter {
  readonly provider: IntegrationProviderKey;
  readonly capabilities: readonly IntegrationCapability[];
  readonly requiredScopes: readonly string[];

  beginAuthorization(input: { redirectUri: string; loginHint?: string }): Promise<AuthorizationStart>;
  completeAuthorization(input: {
    requestUrl: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<ConnectionResult>;
  checkConnection(credentials: DecryptedCredentials): Promise<ConnectionHealth>;
}

export class IntegrationNotImplementedError extends Error {
  constructor(provider: IntegrationProviderKey, operation: string) {
    super(`${provider} adapter: "${operation}" is not implemented yet`);
    this.name = "IntegrationNotImplementedError";
  }
}
