// Pure helpers for the cohort_app JWT — the gated-tier read key.
//
// The app reads the gated T2 views (named transcript evidence, distilled readouts,
// collaboration-contribution insight cards) with a `role: cohort_app` JWT, signed
// HS256 with the Supabase project's JWT secret. See docs/COHORT_KEY_BUILD_INJECT.md.
// This module is the SIGNING + INSPECTION logic only — no env, no I/O, no network —
// so it is unit-testable and reused by mint-cohort-key.mjs + verify-cohort-key.mjs.

import crypto from "node:crypto";

const b64u = (input) => Buffer.from(input).toString("base64url");

const FIVE_YEARS_SECONDS = Math.round(5 * 365.25 * 24 * 3600);

// Mint a long-lived role=cohort_app JWT. Mirrors the claim shape Supabase's Kong
// gateway expects for a custom-role token (iss "supabase", optional project ref);
// PostgREST reads the `role` claim to SET ROLE. Long-lived by default because an
// expired key silently stops T2 reads — rotate by dropping the grant, not by expiry.
export function mintCohortJwt({ secret, ref = "", role = "cohort_app", iat, expSeconds } = {}) {
  if (!secret) throw new Error("JWT secret is required to mint the cohort key");
  const issuedAt = Number.isFinite(iat) ? iat : Math.floor(Date.now() / 1000);
  const exp = issuedAt + (Number.isFinite(expSeconds) ? expSeconds : FIVE_YEARS_SECONDS);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { role, iss: "supabase", iat: issuedAt, exp };
  if (ref) payload.ref = String(ref);
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

// Decode (NOT verify) a JWT's payload. Returns null on anything malformed.
export function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Constant-time HS256 signature check — used by the test to prove a minted key
// validates against its secret (and fails against a wrong one).
export function verifyJwtSignature(jwt, secret) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3 || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const COHORT_KEY_DEFAULT_EXP_SECONDS = FIVE_YEARS_SECONDS;
