export const SESSION_COOKIE = "sid";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    // Malformed %-encoding (e.g. a bare "%") must not throw — a bad value simply
    // keeps its raw form and, for sid, harmlessly fails validateSession.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function base(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function serializeSessionCookie(id: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; ${base(secure)}; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${base(secure)}; Max-Age=0`;
}
