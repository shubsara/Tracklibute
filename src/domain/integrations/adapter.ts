import type { IntegrationCapability, IntegrationProviderKey } from "./providers";

/**
 * Contract every provider adapter implements (GmailAdapter, HubSpotAdapter,
 * GoogleCalendarAdapter — each in its own spec).
 *
 * Adapters are the ONLY code allowed to talk to a provider API. They are
 * invoked by server-side services and registered action executors, never by
 * an LLM and never with arbitrary endpoints/methods.
 *
 * Credentials arrive already decrypted from the server-side credential vault
 * and must never be logged, returned to clients, or persisted elsewhere.
 */
export type DecryptedCredentials = Readonly<Record<string, unknown>>;

export interface AuthorizationStart {
  readonly redirectUrl: string;
  /** Opaque CSRF/state value the server persists and verifies on callback. */
  readonly state: string;
}

export interface ConnectionResult {
  readonly externalAccountId: string;
  readonly scopes: readonly string[];
  readonly credentials: DecryptedCredentials;
}

export interface ConnectionHealth {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface IntegrationAdapter {
  readonly provider: IntegrationProviderKey;
  readonly capabilities: readonly IntegrationCapability[];
  readonly requiredScopes: readonly string[];

  beginAuthorization(input: { organizationId: string; redirectUri: string }): Promise<AuthorizationStart>;
  completeAuthorization(input: { code: string; redirectUri: string }): Promise<ConnectionResult>;
  checkConnection(credentials: DecryptedCredentials): Promise<ConnectionHealth>;
}

export class IntegrationNotImplementedError extends Error {
  constructor(provider: IntegrationProviderKey, operation: string) {
    super(`${provider} adapter: "${operation}" is not implemented yet`);
    this.name = "IntegrationNotImplementedError";
  }
}
