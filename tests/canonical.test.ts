import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalTech, canonicalRegion, canonicalLocation } from "../lib/canonical";

test("tech: aliases, versions, concepts", () => {
  assert.equal(canonicalTech("Golang"), "go");
  assert.equal(canonicalTech("node.js"), "node");
  assert.equal(canonicalTech("react 19"), "react");
  assert.equal(canonicalTech("react router 7"), "react router");
  assert.equal(canonicalTech("tailwind v4"), "tailwind");
  assert.equal(canonicalTech("qt 6.9"), "qt");
  assert.equal(canonicalTech("c++23"), "c++");
  assert.equal(canonicalTech("c"), "c"); // single-letter languages survive
  assert.equal(canonicalTech("LLMs"), null);
  assert.equal(canonicalTech("saas"), null);
});

test("regions: codes, names, macros, timezones split out", () => {
  assert.deepEqual(canonicalRegion("USA"), { codes: ["US"] });
  assert.deepEqual(canonicalRegion("North America"), { codes: ["US", "CA"] });
  assert.deepEqual(canonicalRegion("Europe"), { codes: ["EUROPE"] });
  assert.deepEqual(canonicalRegion("EU"), { codes: ["EUROPE"] }); // not an ISO country code
  assert.deepEqual(canonicalRegion("UK"), { codes: ["GB"] });
  assert.deepEqual(canonicalRegion("Singapore"), { codes: ["SG"] });
  assert.deepEqual(canonicalRegion("EU time zone"), { codes: [], timezone: "EU time zone" });
  assert.deepEqual(canonicalRegion("CET"), { codes: [], timezone: "CET" });
  assert.deepEqual(canonicalRegion("US-friendly timezones"), { codes: [], timezone: "US-friendly timezones" });
  assert.deepEqual(canonicalRegion("Narnia"), { codes: [], unknown: "Narnia" });
});

test("locations: city abbreviations, country names, UK -> GB", () => {
  assert.deepEqual(canonicalLocation({ city: "NYC", region: "ny", country_code: "USA" }), { city: "New York", region: "NY", country_code: "US" });
  assert.deepEqual(canonicalLocation({ city: "London", region: null, country_code: "UK" }), { city: "London", region: null, country_code: "GB" });
  assert.deepEqual(canonicalLocation({ city: null, region: null, country_code: "Belgium" }), { city: null, region: null, country_code: "BE" });
});

test("protocols are not tech", () => {
  for (const t of ["TCP", "tls", "QUIC"]) assert.equal(canonicalTech(t), null);
  assert.equal(canonicalTech("grpc"), "grpc"); // a framework, not a bare protocol
});
