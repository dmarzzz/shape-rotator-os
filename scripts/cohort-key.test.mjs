import { test } from "node:test";
import assert from "node:assert/strict";
import { mintCohortJwt, decodeJwtPayload, verifyJwtSignature, COHORT_KEY_DEFAULT_EXP_SECONDS } from "./lib/cohort-key.mjs";

test("mintCohortJwt produces a verifiable role=cohort_app HS256 JWT", () => {
  const secret = "test-jwt-secret-not-real";
  const jwt = mintCohortJwt({ secret, ref: "txjntzwksiluvqcpccpc", iat: 1000, expSeconds: 3600 });
  assert.equal(jwt.split(".").length, 3);
  assert.ok(verifyJwtSignature(jwt, secret), "signs with its own secret");
  assert.ok(!verifyJwtSignature(jwt, "a-different-secret"), "rejects a wrong secret");
  const p = decodeJwtPayload(jwt);
  assert.equal(p.role, "cohort_app");
  assert.equal(p.iss, "supabase");
  assert.equal(p.ref, "txjntzwksiluvqcpccpc");
  assert.equal(p.iat, 1000);
  assert.equal(p.exp, 4600);
});

test("mintCohortJwt defaults to a long-lived key and omits ref when absent", () => {
  const jwt = mintCohortJwt({ secret: "s", iat: 0 });
  const p = decodeJwtPayload(jwt);
  assert.equal(p.exp, COHORT_KEY_DEFAULT_EXP_SECONDS);
  assert.equal(Object.prototype.hasOwnProperty.call(p, "ref"), false);
});

test("mintCohortJwt requires a secret", () => {
  assert.throws(() => mintCohortJwt({ secret: "" }), /secret is required/);
  assert.throws(() => mintCohortJwt({}), /secret is required/);
});

test("decodeJwtPayload / verifyJwtSignature handle garbage safely", () => {
  assert.equal(decodeJwtPayload(""), null);
  assert.equal(decodeJwtPayload("xxx"), null);
  assert.equal(decodeJwtPayload(null), null);
  assert.equal(verifyJwtSignature("xxx", "s"), false);
  assert.equal(verifyJwtSignature("a.b.c", ""), false);
});
