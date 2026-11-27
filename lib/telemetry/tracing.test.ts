import { test, after } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withSpan } from "./tracing";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);
after(() => trace.disable());

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
