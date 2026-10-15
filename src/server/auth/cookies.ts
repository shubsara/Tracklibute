import "server-only";

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; path?: string; sameSite?: "Lax" | "Strict" },
): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${name}=${encodeURIComponent(value)}; Path=${opts.path ?? "/"}; HttpOnly; ` +
    `SameSite=${opts.sameSite ?? "Lax"}; Max-Age=${opts.maxAge}${secure}`
  );
}

export function clearCookie(name: string, path = "/"): string {
  return serializeCookie(name, "", { maxAge: 0, path });
}

/** Bearer token from the Authorization header, if any. */
export function readBearer(headers: Headers): string | null {
  const authz = headers.get("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) return null;
  return authz.slice(7).trim() || null;
}
