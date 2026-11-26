import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHttpUrl, safeEmail, cleanQuery } from "./safe";

test("safeHttpUrl: http(s) only, bare domains upgraded, tricks rejected", () => {
  assert.equal(safeHttpUrl("https://acme.co/jobs"), "https://acme.co/jobs");
  assert.equal(safeHttpUrl("acme.co/careers"), "https://acme.co/careers");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("JaVaScRiPt:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,<script>"), null);
  assert.equal(safeHttpUrl("https://good.com@evil.com/"), null);
  assert.equal(safeHttpUrl("localhost"), null);
  assert.equal(safeHttpUrl(null), null);
});

test("safeEmail and cleanQuery", () => {
  assert.equal(safeEmail("jane@acme.com"), "jane@acme.com");
  assert.equal(safeEmail("<script>@x.com"), null);
  assert.equal(cleanQuery("  remote\n\trust  "), "remote rust");
  assert.equal(cleanQuery("a"), null);
  assert.equal(cleanQuery("x".repeat(201)), null);
});
