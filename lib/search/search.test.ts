import { test } from "node:test";
import assert from "node:assert/strict";
import { dropReposts, filterSql, type Hit } from "./search";
import type { Filters } from "./query-parse";

const empty: Filters = {
  work_modes: [],
  regions: [],
  cities: [],
  seniority: [],
  employment_types: [],
  tech_all: [],
  tech_any: [],
  min_salary_usd_year: null,
  visa_sponsorship: null,
};

test("filterSql parameterizes every value", () => {
  const params: unknown[] = [];
  const where = filterSql(
    { ...empty, cities: ["London'; DROP TABLE roles;--"], tech_all: ["go"], regions: ["EUROPE"] },
    params,
  );
  assert.ok(where.every((w) => !w.includes("DROP")));
  assert.deepEqual(params[0], ["go"]);
  assert.deepEqual(params[1], ["London'; DROP TABLE roles;--"]);
  assert.equal(filterSql(empty, []).length, 0);
});

const hit = (id: string, thread: number, company: string | null, title: string | null): Hit => ({
  role_id: id,
  posting_id: 1,
  role_title: title,
  company_name: company,
  thread_id: thread,
  distance: 0,
});

test("dropReposts keeps the newest month's copy of a reposted role, in distance order", () => {
  const out = dropReposts([
    hit("nov-acme", 1, "Acme", "Senior Engineer"), // closest, but reposted in December
    hit("dec-acme", 2, " acme ", "senior  engineer"),
    hit("nov-only", 1, "Globex", "SRE"),
  ]);
  assert.deepEqual(
    out.map((h) => h.role_id),
    ["dec-acme", "nov-only"],
  );
});

test("dropReposts never merges within a thread or without a company and title", () => {
  const out = dropReposts([
    hit("london", 2, "Acme", "Engineer"), // same posting, two offices
    hit("berlin", 2, "Acme", "Engineer"),
    hit("a", 1, null, "Engineer"),
    hit("b", 2, null, "Engineer"),
  ]);
  assert.deepEqual(
    out.map((h) => h.role_id),
    ["london", "berlin", "a", "b"],
  );
});
