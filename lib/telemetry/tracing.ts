import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

/**
 * Custom spans for the parts Vercel can't see on its own (Postgres, our pipeline stages).
 * Without a registered SDK (tests, local runs) the OpenTelemetry API is a no-op.
 *
 * Privacy: span attributes are visible to anyone with dashboard access and kept for days. Record
 * sizes, counts and outcomes; never query text, client IPs, credentials or error messages
 * (provider errors can echo request data). Errors are reported by type only.
 */
const tracer = trace.getTracer("hn-jobs");

/**
 * Parent for a span. Inside another span: that span. Otherwise ask the propagators: on Vercel,
 * @vercel/otel's "vercel-runtime" propagator returns the function invocation's span from the
 * request context, so our spans nest under it instead of starting orphan traces (plain functions
 * have no framework that does this). The carrier is empty on purpose: a client-sent `traceparent`
 * must not choose which trace our spans join.
 */
const parentContext = (): Context => {
  const active = context.active();
  return trace.getSpan(active) ? active : propagation.extract(active, {});
};

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, parentContext(), async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      const type = err instanceof Error ? err.name : typeof err;
      span.setAttribute("error.type", type);
      span.setStatus({ code: SpanStatusCode.ERROR, message: type });
      throw err;
    } finally {
      span.end();
    }
  });
}
