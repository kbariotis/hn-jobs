import { registerOTel } from "@vercel/otel";

/**
 * Register OpenTelemetry once per process, before the app handles requests.
 * - On Vercel: spans go to Vercel's built-in Tracing (all plans; Hobby needs a sampling rule
 *   in the dashboard, and pauses tracing past its monthly span quota). @vercel/otel also
 *   instruments outgoing fetch (Gemini, Upstash REST) automatically.
 * - Elsewhere (local, VPS): only when an OTLP endpoint is configured
 *   (OTEL_EXPORTER_OTLP_ENDPOINT, plus OTEL_EXPORTER_OTLP_HEADERS for the vendor's key);
 *   otherwise nothing is registered and the API stays a no-op.
 */
const ON_VERCEL = Boolean(process.env.VERCEL);
const OTLP_CONFIGURED = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

if (ON_VERCEL || OTLP_CONFIGURED) {
  registerOTel({ serviceName: "hn-jobs" });
}
