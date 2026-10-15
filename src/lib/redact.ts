const SENSITIVE_KEY =
  /token|secret|password|credential|authorization|api[-_]?key|cookie|code[-_]?verifier|^code$|body(text)?$|^snippet$/i;

/**
 * Recursively replace values under sensitive-looking keys. Used for audit
 * metadata and structured logs: these must never hold secrets, OAuth codes,
 * tokens, or email content.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v),
      ]),
    );
  }
  return value;
}
