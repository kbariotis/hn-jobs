import type { Role } from "../schema";

/**
 * Deterministic guards against fabricated values. Model-agnostic: runs on every
 * extraction regardless of provider, so a plausible-looking fake apply link
 * can never reach the index.
 */

// "HTTPS://www.Foo.co/careers/" -> "foo.co/careers"
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[)\].,;:!?'"]+$/, "") // trailing punctuation from prose
    .replace(/\/+$/, "");
}

// Every URL-ish token in the source, normalized.
function sourceUrls(text: string): string[] {
  const tokens = text.match(/(?:[a-z]+:\/\/|www\.)[^\s<>"]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"]*/gi) ?? [];
  return tokens.map(normalizeUrl);
}

// Same URL, or the same URL minus its query/fragment (dropping ?utm=… still works;
// cutting a path short does not).
const sameUrl = (source: string, target: string) =>
  source === target ||
  (source.startsWith(target) && "?#".includes(source[target.length]) && !target.endsWith("/"));

export function isUrlGrounded(url: string, text: string): boolean {
  const target = normalizeUrl(url);
  if (!target || !target.includes(".")) return false;
  if (sourceUrls(text).some((s) => sameUrl(s, target))) return true;
  // Bare domain written inline, e.g. "Apply at foo.co" (no scheme, www or path).
  return new RegExp(`(^|[\\s(|,])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s),.;|])`, "i").test(text);
}

// Accepts de-obfuscated emails ("simon+hn <at> archera <dot> ai" -> simon+hn@archera.ai)
// as long as the local part and every domain label appear in the post.
export function isEmailGrounded(email: string, text: string): boolean {
  const lower = text.toLowerCase();
  const e = email.trim().toLowerCase();
  if (lower.includes(e)) return true;
  const [local, domain] = e.split("@");
  if (!local || !domain) return false;
  return lower.includes(local) && domain.split(".").every((label) => lower.includes(label));
}

export type GroundingWarning = { role_index: number; field: string; value: string };

/** Null out ungrounded fields and report what was dropped. */
export function groundRoles(
  roles: Role[],
  text: string
): { roles: Role[]; warnings: GroundingWarning[] } {
  const warnings: GroundingWarning[] = [];
  const grounded = roles.map((role, role_index) => {
    const out = { ...role };
    if (out.apply_url && !isUrlGrounded(out.apply_url, text)) {
      warnings.push({ role_index, field: "apply_url", value: out.apply_url });
      out.apply_url = null;
    }
    if (out.apply_email && !isEmailGrounded(out.apply_email, text)) {
      warnings.push({ role_index, field: "apply_email", value: out.apply_email });
      out.apply_email = null;
    }
    return out;
  });
  return { roles: grounded, warnings };
}
