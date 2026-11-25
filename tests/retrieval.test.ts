import { test } from "node:test";
import assert from "node:assert/strict";
import { ndcgAt, precisionAt, rPrecision } from "../lib/ir-metrics";
import { availableIn, compatibleRemoteRegions } from "../lib/geo";
import { filterSql } from "../lib/search";
import type { Filters } from "../lib/query-parse";

const rel = new Set(["a", "b"]);

test("nDCG: perfect, partial, and unretrievable relevant items", () => {
  assert.equal(ndcgAt(["a", "b", "x"], rel, 2), 1);
  assert.ok(ndcgAt(["x", "a", "b"], rel, 2) < 1);
  // a third relevant role exists but was never indexed: ideal ranking can't be reached
  assert.ok(ndcgAt(["a", "b"], rel, 3) < 1);
});

test("P@k and R-precision", () => {
  assert.equal(precisionAt(["a", "x", "b"], rel, 10), 0.2);
  assert.equal(rPrecision(["a", "x", "b"], rel, 2), 0.5);
});

const role = (over: object) => ({ remote_policy: "remote", remote_regions: [] as string[], locations: [] as { country_code: string | null }[], ...over });

test("availableIn: remote open there, or an office there; unstated regions never match", () => {
  assert.ok(availableIn(role({ remote_regions: ["EUROPE"] }), "DE"));
  assert.ok(availableIn(role({ remote_regions: ["DE"] }), "EUROPE"));
  assert.ok(availableIn(role({ remote_regions: ["GLOBAL"] }), "US"));
  assert.ok(availableIn(role({ remote_policy: "onsite", locations: [{ country_code: "GB" }] }), "EUROPE"));
  assert.ok(!availableIn(role({ remote_regions: [] }), "US"));
  assert.ok(!availableIn(role({ remote_regions: ["US"] }), "EUROPE"));
  assert.deepEqual(compatibleRemoteRegions("GLOBAL"), ["GLOBAL"]);
});

const empty: Filters = { work_modes: [], regions: [], cities: [], seniority: [], employment_types: [], tech_all: [], tech_any: [], min_salary_usd_year: null, visa_sponsorship: null };

test("filterSql parameterizes every value", () => {
  const params: unknown[] = [];
  const where = filterSql({ ...empty, cities: ["London'; DROP TABLE roles;--"], tech_all: ["go"], regions: ["EUROPE"] }, params);
  assert.ok(where.every((w) => !w.includes("DROP")));
  assert.deepEqual(params[0], ["go"]);
  assert.deepEqual(params[1], ["London'; DROP TABLE roles;--"]);
  assert.equal(filterSql(empty, []).length, 0);
});
