// Tests for the pure helpers in supabase-auth.mjs — the session-validity checks
// and the gate state machine that decides what boot renders. No Electron / no
// network; run with:  node --test supabase-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAuthGateEnabled,
  setAuthGateEnabled,
  isSessionValid,
  sessionExpiresSoon,
  sessionEmail,
  parseMembership,
  gateState,
  normalizeMatrixId,
  parseMatrixMembership,
  matrixGateState,
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

// ─── Matrix sign-in path ──────────────────────────────────────────────────────

test("normalizeMatrixId: lowercases, trims, and validates the @local:server shape", () => {
  assert.equal(normalizeMatrixId(" @MikeIsHiring:Matrix.org "), "@mikeishiring:matrix.org");
  assert.equal(normalizeMatrixId("@a:b"), "@a:b");
  assert.equal(normalizeMatrixId("mikeishiring:matrix.org"), null, "no leading @");
  assert.equal(normalizeMatrixId("@nocolon"), null);
  assert.equal(normalizeMatrixId("@:matrix.org"), null, "empty localpart");
  assert.equal(normalizeMatrixId(""), null);
  assert.equal(normalizeMatrixId(null), null);
});

test("parseMatrixMembership: reads first row, derives approved + bound", () => {
  const m = parseMatrixMembership([{
    matrix_id: "@Mike:matrix.org", record_id: "mikeishiring", record_type: "person",
    role: "admin", status: "approved", display_name: "Mike",
  }]);
  assert.equal(m.matrix_id, "@mike:matrix.org");
  assert.equal(m.approved, true);
  assert.equal(m.bound, true);
  assert.equal(m.role, "admin");

  const unbound = parseMatrixMembership([{ matrix_id: "@x:y", status: "approved" }]);
  assert.equal(unbound.approved, true);
  assert.equal(unbound.bound, false);

  assert.equal(parseMatrixMembership([]), null);
  assert.equal(parseMatrixMembership(null), null);
  assert.equal(parseMatrixMembership([{ status: "approved" }]), null, "row without matrix_id");
});

test("matrixGateState: full state machine across the flow", () => {
  const approved = { status: "approved", record_id: "mikeishiring", bound: true };
  assert.equal(matrixGateState({ userId: null, membership: approved }), "signed_out");
  assert.equal(matrixGateState({ userId: "not-a-matrix-id", membership: approved }), "signed_out");
  assert.equal(matrixGateState({ userId: "@m:matrix.org", membership: null }), "unapproved");
  assert.equal(matrixGateState({ userId: "@m:matrix.org", membership: { status: "rejected" } }), "rejected");
  assert.equal(matrixGateState({ userId: "@m:matrix.org", membership: { status: "pending" } }), "pending");
  assert.equal(matrixGateState({ userId: "@m:matrix.org", membership: { status: "approved", bound: false } }), "needs_binding");
  assert.equal(matrixGateState({ userId: "@m:matrix.org", membership: approved }), "approved");
});

test("isAuthGateEnabled: ON by default, '0' is the per-install kill switch", () => {
  const store = (v) => ({ getItem: () => v, setItem() {} });
  assert.equal(isAuthGateEnabled(store(null)), true, "absent flag means ON");
  assert.equal(isAuthGateEnabled(store("1")), true);
  assert.equal(isAuthGateEnabled(store("0")), false, "explicit kill switch");
  assert.equal(isAuthGateEnabled(undefined), true, "no storage at all still gates");

  const written = {};
  const w = { getItem: (k) => written[k] ?? null, setItem: (k, v) => { written[k] = v; } };
  setAuthGateEnabled(false, w);
  assert.equal(isAuthGateEnabled(w), false);
  setAuthGateEnabled(true, w);
  assert.equal(isAuthGateEnabled(w), true);
});
