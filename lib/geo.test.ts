import { test } from "node:test";
import assert from "node:assert/strict";
import { availableIn, compatibleRemoteRegions } from "./geo";

const role = (over: object) => ({
  remote_policy: "remote",
  remote_regions: [] as string[],
  locations: [] as { country_code: string | null }[],
  ...over,
});

test("availableIn: remote open there, or an office there; unstated regions never match", () => {
  assert.ok(availableIn(role({ remote_regions: ["EUROPE"] }), "DE"));
  assert.ok(availableIn(role({ remote_regions: ["DE"] }), "EUROPE"));
  assert.ok(availableIn(role({ remote_regions: ["GLOBAL"] }), "US"));
  assert.ok(availableIn(role({ remote_policy: "onsite", locations: [{ country_code: "GB" }] }), "EUROPE"));
  assert.ok(!availableIn(role({ remote_regions: [] }), "US"));
  assert.ok(!availableIn(role({ remote_regions: ["US"] }), "EUROPE"));
  assert.deepEqual(compatibleRemoteRegions("GLOBAL"), ["GLOBAL"]);
});
