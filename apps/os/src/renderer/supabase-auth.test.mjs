// Tests for the pure helpers in supabase-auth.mjs — the session-validity checks
// and the gate state machine that decides what boot renders. No Electron / no
// network; run with:  node --test supabase-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSessionValid,
  sessionExpiresSoon,
  sessionEmail,
  parseMembership,
  gateState,
} from "./supabase-auth.mjs";

const NOW = 1_800_000_000; // fixed clock for determinism
const validSession = (over = {}) => ({
  access_token: "tok",
  refresh_token: "ref",
  expires_at: NOW + 3600,
  user: { id: "u1", email: "Member@Example.com" },
  ...over,
});

test("isSessionValid: honors token + future expiry with clock skew", () => {
  assert.equal(isSessionValid(validSession(), NOW), true);
  assert.equal(isSessionValid(null, NOW), false);
  assert.equal(isSessionValid({ expires_at: NOW + 3600 }, NOW), false, "no access_token");
  assert.equal(isSessionValid(validSession({ expires_at: NOW - 1 }), NOW), false, "expired");
  assert.equal(isSessionValid(validSession({ expires_at: NOW + 10 }), NOW), false, "inside 30s skew");
  assert.equal(isSessionValid(validSession({ expires_at: "nope" }), NOW), false, "non-numeric expiry");
});

test("sessionExpiresSoon: true within window or past, false when far out", () => {
  assert.equal(sessionExpiresSoon(validSession({ expires_at: NOW + 3600 }), NOW, 120), false);
  assert.equal(sessionExpiresSoon(validSession({ expires_at: NOW + 60 }), NOW, 120), true);
  assert.equal(sessionExpiresSoon(validSession({ expires_at: NOW - 5 }), NOW, 120), true);
  assert.equal(sessionExpiresSoon({}, NOW, 120), false, "no token → nothing to refresh");
});

test("sessionEmail: lowercased + trimmed, null when absent", () => {
  assert.equal(sessionEmail(validSession()), "member@example.com");
  assert.equal(sessionEmail({ user: {} }), null);
  assert.equal(sessionEmail(null), null);
});

test("parseMembership: reads first row, derives approved + bound", () => {
  assert.equal(parseMembership([]), null);
  assert.equal(parseMembership(null), null);
  const m = parseMembership([{ email: "A@B.com", record_id: "shaw-walters", status: "approved", role: "member" }]);
  assert.equal(m.email, "a@b.com");
  assert.equal(m.approved, true);
  assert.equal(m.bound, true);
  assert.equal(m.record_id, "shaw-walters");
  const pend = parseMembership([{ email: "a@b.com", record_id: null, status: "pending" }]);
  assert.equal(pend.approved, false);
  assert.equal(pend.bound, false);
});

test("gateState: full state machine across the flow", () => {
  const approved = { status: "approved", record_id: "mikeishiring", bound: true };
  // signed out
  assert.equal(gateState({ session: null, membership: null, nowSec: NOW }), "signed_out");
  assert.equal(gateState({ session: validSession({ expires_at: NOW - 1 }), membership: approved, nowSec: NOW }), "signed_out");
  // signed in, no roster row
  assert.equal(gateState({ session: validSession(), membership: null, nowSec: NOW }), "unapproved");
  // explicit states
  assert.equal(gateState({ session: validSession(), membership: { status: "rejected" }, nowSec: NOW }), "rejected");
  assert.equal(gateState({ session: validSession(), membership: { status: "pending" }, nowSec: NOW }), "pending");
  // approved but not yet bound to a record
  assert.equal(gateState({ session: validSession(), membership: { status: "approved", bound: false }, nowSec: NOW }), "needs_binding");
  // fully in
  assert.equal(gateState({ session: validSession(), membership: approved, nowSec: NOW }), "approved");
});
