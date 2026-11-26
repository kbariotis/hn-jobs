import { test } from "node:test";
import assert from "node:assert/strict";
import { isUrlGrounded as url, isEmailGrounded as email, groundRoles } from "./grounding";
import type { Role } from "../schema";

// Synthetic: header-only excerpt, so ".../careers" is NOT in this text. (In the real post

// 46109012 it is — "Join us at beaconai.co/careers" — and the guard correctly allows it.)

const beacon = "Beacon AI | San Carlos, CA | Hybrid (On-Site) | Full-Time | www.beaconai.co";

const ashby = "apply: https://jobs.ashbyhq.com/wire/89e08ab3?utm=x.";

test("rejects invented URL paths", () => {
  assert.equal(url("http://beaconai.co/careers", beacon), false);
});

test("ignores scheme, www and trailing slash", () => {
  assert.equal(url("https://www.beaconai.co/", beacon), true);
});

test("accepts exact URL and URL with query dropped", () => {
  assert.equal(url("https://jobs.ashbyhq.com/wire/89e08ab3?utm=x", ashby), true);
  assert.equal(url("https://jobs.ashbyhq.com/wire/89e08ab3", ashby), true);
});

test("rejects truncated paths (broken links)", () => {
  assert.equal(url("https://jobs.ashbyhq.com/wire/89e", ashby), false);
  assert.equal(url("https://jobs.ashbyhq.com/wire", ashby), false);
});

test("bare inline domains need a word boundary", () => {
  assert.equal(url("https://acme.io", "Apply at acme.io, we're hiring"), true);
  assert.equal(url("https://acme.io", "Apply at acme.iox"), false);
});

test("accepts de-obfuscated emails, rejects invented ones", () => {
  const src = "email me at simon+hn <at> archera <dot> ai";
  assert.equal(email("simon+hn@archera.ai", src), true);
  assert.equal(email("jobs@archera.ai", src), false);
});

test("groundRoles nulls ungrounded fields and reports them", () => {
  const role = { apply_url: "http://beaconai.co/careers", apply_email: null } as Role;
  const { roles, warnings } = groundRoles([role], beacon);
  assert.equal(roles[0].apply_url, null);
  assert.deepEqual(warnings, [
    { role_index: 0, field: "apply_url", value: "http://beaconai.co/careers" },
  ]);
});
