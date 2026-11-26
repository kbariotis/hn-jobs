/**
 * Boundary helpers for untrusted values: HN post content (via extraction) and user queries.
 */

/** Only http(s) links leave the server. Blocks javascript:/data: URLs from post content. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) {
    return null;
  } // other schemes
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); // "acme.co/jobs" -> https
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    if (u.username || u.password) {
      return null;
    } // "https://good.com@evil.com" style confusion
    if (!u.hostname.includes(".")) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@<>()"']{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
export const safeEmail = (raw: string | null | undefined) =>
  raw && EMAIL.test(raw.trim()) ? raw.trim() : null;

export const MAX_QUERY_CHARS = 200;

// C0 + DEL + C1 control characters.
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Normalize a search query; null if unusable. Control characters out, whitespace collapsed. */
export function cleanQuery(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const q = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (q.length < 2 || q.length > MAX_QUERY_CHARS) {
    return null;
  }
  return q;
}
