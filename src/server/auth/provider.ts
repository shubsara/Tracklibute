import "server-only";

/**
 * Pluggable authentication provider.
 *
 * A provider answers exactly one question: "which user is this, and which
 * organization did the server previously bind this session to?" It does NOT
 * decide roles or permissions — membership is re-verified against the
 * database on every request in `resolveAuthContext`.
 *
 * Foundation ships a development provider. The production provider
 * (Auth.js / Clerk / WorkOS / ...) is chosen in a later spec and only has to
 * implement this interface.
 */
export interface SessionIdentity {
  readonly userId: string;
  readonly organizationId: string;
}

export interface AuthProvider {
  readonly name: string;
  authenticate(headers: Headers): Promise<SessionIdentity | null>;
}
