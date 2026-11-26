import { test } from "node:test";
import assert from "node:assert/strict";
import { filterSql } from "./search";
import type { Filters } from "./query-parse";

const empty: Filters = { work_modes: [], regions: [], cities: [], seniority: [], employment_types: [], tech_all: [], tech_any: [], min_salary_usd_year: null, visa_sponsorship: null };

test("filterSql parameterizes every value", () => {
  const params: unknown[] = [];
  const where = filterSql({ ...empty, cities: ["London'; DROP TABLE roles;--"], tech_all: ["go"], regions: ["EUROPE"] }, params);
  assert.ok(where.every((w) => !w.includes("DROP")));
  assert.deepEqual(params[0], ["go"]);
  assert.deepEqual(params[1], ["London'; DROP TABLE roles;--"]);
  assert.equal(filterSql(empty, []).length, 0);
});
