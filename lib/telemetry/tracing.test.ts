import { test, after } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withSpan } from "./tracing";

/** Minimal AsyncLocalStorage context manager (what @vercel/otel registers in production). */
class AlsContextManager implements ContextManager {
  private als = new AsyncLocalStorage<Context>();
  active = () => this.als.getStore() ?? ROOT_CONTEXT;
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => fn.apply(thisArg, args));
  }
  bind = <T>(_ctx: Context, target: T) => target;
  enable = () => this;
  disable = () => this;
}

/** Stands in for @vercel/otel's "vercel-runtime" propagator: the invocation's root span. */
const INVOCATION = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
  isRemote: true,
};
const vercelRuntime: TextMapPropagator = {
  inject: () => {},
  extract: (ctx) => trace.setSpanContext(ctx, INVOCATION),
  fields: () => [],
};

const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AlsContextManager());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);
after(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

test("withSpan records attributes and returns the result", async () => {
  exporter.reset();
  const out = await withSpan("unit.ok", { "app.n": 3 }, async (span) => {
    span.setAttribute("app.extra", true);
    return 42;
  });
  assert.equal(out, 42);
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, "unit.ok");
  assert.equal(span.attributes["app.n"], 3);
  assert.equal(span.attributes["app.extra"], true);
});

test("top-level spans join the invocation's trace; nested spans stay under their parent", async () => {
  exporter.reset();
  propagation.setGlobalPropagator(vercelRuntime);
  try {
    await withSpan("outer", {}, () => withSpan("inner", {}, async () => {}));
  } finally {
    propagation.disable();
  }
  const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s]));
  const outer = byName.get("outer")!;
  const inner = byName.get("inner")!;
  assert.equal(outer.spanContext().traceId, INVOCATION.traceId);
  assert.equal(outer.parentSpanContext?.spanId, INVOCATION.spanId);
  assert.equal(inner.spanContext().traceId, INVOCATION.traceId);
  assert.equal(inner.parentSpanContext?.spanId, outer.spanContext().spanId);
});

test("errors are recorded by type only: the message never reaches the span", async () => {
  exporter.reset();
  const secret = "password authentication failed for user neondb_owner";
  await assert.rejects(
    withSpan("unit.fail", {}, async () => {
      throw new TypeError(secret);
    }),
    TypeError,
  );
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.attributes["error.type"], "TypeError");
  assert.equal(span.status.message, "TypeError");
  assert.equal(span.events.length, 0); // no recordException (would carry the message)
  assert.doesNotMatch(JSON.stringify({ a: span.attributes, s: span.status }), /password/);
});
