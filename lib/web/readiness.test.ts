import { test } from "node:test";
import assert from "node:assert/strict";
import { failureCategory } from "./readiness";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

test("failureCategory maps errors to fixed categories, never to their text", () => {
  assert.equal(
    failureCategory(new Error("DATABASE_URL is not set (see .env.example).")),
    "not_configured",
  );
  assert.equal(
    failureCategory(pgError("28P01", "password authentication failed for user x")),
    "auth",
  );
  assert.equal(failureCategory(pgError("42P01", 'relation "roles" does not exist')), "schema");
  assert.equal(
    failureCategory(pgError("ENOTFOUND", "getaddrinfo ENOTFOUND host.example")),
    "network",
  );
  assert.equal(failureCategory(new Error("self-signed certificate in certificate chain")), "tls");
  assert.equal(
    failureCategory(new Error("Connection terminated due to connection timeout")),
    "network",
  );
  assert.equal(
    failureCategory(new Error("No database URL is set (DATABASE_URL, …)")),
    "not_configured",
  );
  assert.equal(failureCategory(new Error("something else")), "other");
});
