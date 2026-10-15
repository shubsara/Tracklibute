import "server-only";

/**
 * Pluggable authentication provider.
 *
 * A provider answers exactly one question: "which user is this, and which
 * organization did the server bind this session to?" It does NOT decide roles
 * or permissions — membership is re-verified against the database on every
 * request in `resolveAuthContext`.
 *
 * Providers (tried in order):
 *  - `session` — database-backed opaque sessions created after Google sign-in
 *  - `dev`     — signed dev tokens; local development and tests only
 */
export interface SessionIdentity {
  readonly provider: "session" | "dev";
  readonly userId: string;
  /** Null until the user has created / been bound to an organization. */
  readonly organizationId: string | null;
  /** HMAC of the opaque session token (session provider only). */
  readonly sessionTokenHash?: string;
}

export interface AuthProvider {
  readonly name: SessionIdentity["provider"];
  authenticate(headers: Headers): Promise<SessionIdentity | null>;
}
