import { test } from "node:test";
import assert from "node:assert/strict";
import { alignRoles, Scorecard } from "../lib/score";
import type { Role } from "../lib/schema";

const role = (over: Partial<Role>): Role => ({
  company_name: "Acme",
  role_title: "Software Engineer",
  employment_type: "full-time",
  remote_policy: "remote",
  remote_regions: [],
  timezones: [],
  locations: [],
  seniority: null,
  tech_stack: [],
  salary: null,
  visa_sponsorship: null,
  apply_url: null,
  apply_email: null,
  description: "",
  ...over,
});

test("aligns same-title roles by location", () => {
  const gold = [role({ role_title: "Engineering Manager", locations: [{ city: "Bangalore", region: null, country_code: "IN" }] }), role({ role_title: "Engineering Manager", remote_regions: ["SG"] })];
  const pred = [gold[1], gold[0]];
  assert.deepEqual(alignRoles(pred, gold).sort(), [[0, 1], [1, 0]]);
});

test("does not align unrelated titles", () => {
  assert.deepEqual(alignRoles([role({ role_title: "Product Designer" })], [role({ role_title: "Backend Engineer" })]), []);
});

test("perfect prediction scores 100 everywhere", () => {
  const gold = [role({ tech_stack: ["go"], apply_url: "https://acme.io/jobs" })];
  const card = new Scorecard();
  card.add(1, [role({ tech_stack: ["Go"], apply_url: "http://www.acme.io/jobs/" })], gold);
  const s = card.summary();
  assert.equal(s.role_recall, 100);
  assert.ok(Object.values(s.fields).every((v) => v === 100), JSON.stringify(s.fields));
  assert.equal(card.mismatches.length, 0);
});

test("counts missing roles, field errors and set F1", () => {
  const gold = [role({ seniority: "staff", tech_stack: ["go", "k8s"] }), role({ role_title: "Designer" })];
  const card = new Scorecard();
  card.add(1, [role({ seniority: "senior", tech_stack: ["go", "rust"] })], gold);
  const s = card.summary();
  assert.equal(s.role_precision, 100);
  assert.equal(s.role_recall, 50);
  assert.equal(s.fields.seniority, 0);
  assert.equal(s.fields.tech_stack, 50); // p=1/2, r=1/2
  assert.deepEqual(card.mismatches.map((m) => m.field).sort(), ["role(missing)", "seniority", "tech_stack"]);
});

test("empty prediction for a non-job post is correct", () => {
  const card = new Scorecard();
  card.add(1, [], []);
  assert.equal(card.summary().role_count_exact, 100);
  assert.equal(card.mismatches.length, 0);
});

test("plural titles align and list items ignore separators", () => {
  const gold = [role({ role_title: "Founding Software Engineer", tech_stack: ["node.js"] })];
  const card = new Scorecard();
  card.add(1, [role({ role_title: "Founding Software Engineers", tech_stack: ["nodejs"] })], gold);
  assert.equal(card.summary().role_recall, 100);
  assert.equal(card.summary().fields.tech_stack, 100);
});

test("canonicalizes both sides: aliases, versions, region names, city abbreviations", () => {
  const gold = [role({ tech_stack: ["go", "react"], remote_regions: ["US"], locations: [{ city: "New York", region: "NY", country_code: "US" }] })];
  const card = new Scorecard();
  card.add(1, [role({ tech_stack: ["golang", "react 19", "ai"], remote_regions: ["USA"], locations: [{ city: "NYC", region: null, country_code: "us" }] })], gold);
  assert.equal(card.mismatches.length, 0, JSON.stringify(card.mismatches));
});
