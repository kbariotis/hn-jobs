/**
 * Register OpenTelemetry once per process, before the app handles requests.
 * - On Vercel: spans go to Vercel's built-in Tracing (all plans; Hobby needs a sampling rule
 *   in the dashboard, and pauses tracing past its monthly span quota). @vercel/otel also
 *   instruments outgoing fetch (Gemini, Upstash REST) automatically.
 * - Elsewhere (local, VPS): only when an OTLP endpoint is configured
 *   (OTEL_EXPORTER_OTLP_ENDPOINT, plus OTEL_EXPORTER_OTLP_HEADERS for the vendor's key);
 *   otherwise nothing is registered and the API stays a no-op.
 *
 * @vercel/otel is ESM-only and this project compiles to CommonJS, so it must be loaded with a
 * real dynamic import() (tsconfig `module: node16` keeps it; `commonjs` would turn it into
 * require(), which Vercel's runtime rejects with ERR_REQUIRE_ESM). Entry points await
 * `telemetryReady` so even a cold start's first request is traced.
 *
 * Tracing must never take the app down: a failed registration is logged and ignored.
 */
const ON_VERCEL = Boolean(process.env.VERCEL);
const OTLP_CONFIGURED = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

async function register(): Promise<void> {
  if (!ON_VERCEL && !OTLP_CONFIGURED) {
    return;
  }
  try {
    const { registerOTel } = await import("@vercel/otel");
    registerOTel({ serviceName: "hn-jobs" });
  } catch (err) {
    console.error(
      "telemetry: registration failed, continuing without tracing:",
      err instanceof Error ? err.message : err,
    );
  }
}

export const telemetryReady: Promise<void> = register();
