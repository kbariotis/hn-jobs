/**
 * Coarse, non-sensitive failure category for a readiness check: derived only from fixed error
 * codes and known phrases, so the public /readyz response never carries messages, hosts or
 * configuration values.
 */
export type FailureCategory = "not_configured" | "auth" | "network" | "tls" | "schema" | "other";

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);

export function failureCategory(err: unknown): FailureCategory {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (/is not set|No database URL/.test(message)) {
    return "not_configured";
  }
  if (code === "28P01" || code === "28000") {
    return "auth"; // invalid password / authorization
  }
  if (code === "42P01" || code === "3D000") {
    return "schema"; // missing table / database
  }
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return "network";
  }
  if (/certificate|ssl|tls|self[- ]signed/i.test(message)) {
    return "tls";
  }
  if (/timeout|timed out/i.test(message)) {
    return "network";
  }
  return "other";
}
