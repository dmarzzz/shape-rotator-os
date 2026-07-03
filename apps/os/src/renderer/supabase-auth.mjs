// supabase-auth.mjs — Google sign-in gate + approval, client side.
//
// The app's identity was a local, unverified localStorage claim (identity.js):
// anyone could pick anyone, and writes rode the public anon key. This module is
// the front half of the "required Google gate + approval" model
// (docs/design/google-auth-gate.md): sign in with Google (Supabase Auth), check
// the VERIFIED email against the app_members roster, and either admit the user
// (bound to their cohort record) or route them to request access.
//
// The OAuth dance itself runs in the MAIN process (main.js) over the existing
// sros:// deep-link + safeStorage plumbing, exposed here as window.api.auth. The
// pure helpers below (session validity + the gate state machine) carry no Electron
// dependency so they are unit-tested in supabase-auth.test.mjs.
//
// Rollout is behind isAuthGateEnabled(): OFF until the Supabase redirect URL +
// admin seed are in place, so current users are never locked out mid-migration.

import { fetchAnon, postAnonRow, setAmbientBearer } from "./supabase-anon-write.mjs";

// localStorage "1" flips the boot gate on. Kept a soft per-install switch (not a
// build flag) so the gate can be lit the moment the infra steps are done, and
// killed instantly if anything is wrong, without a re-release.
export const AUTH_GATE_FLAG = "srwk:auth_gate_enabled";

export function isAuthGateEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem?.(AUTH_GATE_FLAG) === "1"; } catch { return false; }
}
export function setAuthGateEnabled(on, storage = globalThis.localStorage) {
  try {
    if (on) storage?.setItem?.(AUTH_GATE_FLAG, "1");
    else storage?.removeItem?.(AUTH_GATE_FLAG);
  } catch {}
}

// ─── pure helpers (no Electron; unit-tested) ─────────────────────────────────

const CLOCK_SKEW_SEC = 30;

export function nowSeconds() { return Math.floor(Date.now() / 1000); }

// A session is a Supabase token bundle: { access_token, refresh_token,
// expires_at (unix seconds), token_type, user: { id, email, ... } }.
export function isSessionValid(session, nowSec = nowSeconds()) {
  if (!session || typeof session !== "object" || !session.access_token) return false;
  const exp = Number(session.expires_at);
  if (!Number.isFinite(exp)) return false;
  return exp > nowSec + CLOCK_SKEW_SEC;
}

// True when the access token is within `windowSec` of expiry (or already past) —
// the main process refreshes proactively so a write never races a 401.
export function sessionExpiresSoon(session, nowSec = nowSeconds(), windowSec = 120) {
  if (!session || !session.access_token) return false;
  const exp = Number(session.expires_at);
  if (!Number.isFinite(exp)) return true;
  return exp <= nowSec + windowSec;
}

export function sessionEmail(session) {
  return session && session.user && session.user.email
    ? String(session.user.email).toLowerCase().trim()
    : null;
}

// Normalize an app_my_membership read into the shape the gate + app consume.
export function parseMembership(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object" || !row.email) return null;
  return {
    email: String(row.email).toLowerCase().trim(),
    record_id: row.record_id || null,
    record_type: row.record_type || "person",
    role: row.role || "member",
    status: row.status || "pending",
    display_name: row.display_name || null,
    approved: row.status === "approved",
    bound: !!row.record_id,
  };
}

// The gate state machine — the single source of truth for what boot renders:
//   signed_out     → show the "sign in with Google" screen
//   unapproved     → signed in, no roster row → request-access screen
//   rejected       → signed in, explicitly rejected
//   pending        → request filed, awaiting an admin
//   needs_binding  → approved but no record_id yet → pick-your-record once
//   approved       → let them into the app
export function gateState({ session, membership, nowSec = nowSeconds() } = {}) {
  if (!isSessionValid(session, nowSec)) return "signed_out";
  if (!membership) return "unapproved";
  if (membership.status === "rejected") return "rejected";
  if (membership.status !== "approved") return "pending";
  if (!membership.bound) return "needs_binding";
  return "approved";
}

// ─── runtime (Electron bridge; see preload.js window.api.auth) ───────────────

function bridge() {
  return (typeof window !== "undefined" && window.api && window.api.auth) || null;
}

// Returns the persisted session (decrypted in main), or null. Main refreshes it
// if it's near expiry before handing it back.
export async function getSession() {
  const b = bridge();
  if (!b || typeof b.getSession !== "function") return null;
  try { return (await b.getSession()) || null; } catch { return null; }
}

// Opens the system browser to Google consent (main builds the Supabase authorize
// URL with redirect_to=sros://auth-callback). Resolves { ok } when the browser is
// launched; the actual session arrives asynchronously via onAuthChanged.
export async function signInWithGoogle() {
  const b = bridge();
  if (!b || typeof b.signIn !== "function") return { ok: false, error: "auth unavailable in this build" };
  try { return (await b.signIn()) || { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
}

export async function signOut() {
  const b = bridge();
  if (!b || typeof b.signOut !== "function") return;
  try { await b.signOut(); } catch {}
}

// Subscribe to session changes (sign-in completes, refresh, sign-out). Returns an
// unsubscribe fn. Fires with the new session or null.
export function onAuthChanged(cb) {
  const b = bridge();
  if (!b || typeof b.onSession !== "function" || typeof cb !== "function") return () => {};
  try { return b.onSession(cb) || (() => {}); } catch { return () => {}; }
}

// Read the caller's own membership row (RLS returns exactly their row) using their
// JWT as the bearer over the existing anon-read primitive. null if unconfigured /
// not signed in / no row.
export async function fetchMyMembership(session) {
  if (!isSessionValid(session)) return null;
  const { rows, source } = await fetchAnon(
    "app_my_membership?select=email,record_id,record_type,role,status,display_name,approved_at",
    { bearer: session.access_token },
  );
  if (source !== "supabase") return null;
  return parseMembership(rows);
}

// Keep the shared write bearer (supabase-anon-write) in lockstep with the
// current session. Supabase writes use the Google sign-in app session while the
// user is signed in, then revert to the anon key on sign-out/expiry. Idempotent:
// safe to call once at boot regardless of whether the gate is enabled.
let _bearerSyncInstalled = false;
export async function installAuthBearerSync() {
  if (_bearerSyncInstalled) return () => {};
  _bearerSyncInstalled = true;
  const apply = (session) => setAmbientBearer(isSessionValid(session) ? session.access_token : null);
  const unsub = onAuthChanged(apply);
  apply(await getSession());
  return () => { _bearerSyncInstalled = false; try { unsub(); } catch {} };
}

// File a join request for an un-approved (or unbound) signed-in user — the missing
// "reach a human to be approved" path. Writes under the user's JWT so RLS ties the
// row to their verified email.
export async function requestAccess({ display_name, requested_record_id, message } = {}, session) {
  if (!isSessionValid(session)) return { ok: false, error: "not signed in" };
  const email = sessionEmail(session);
  if (!email) return { ok: false, error: "no email on session" };
  return postAnonRow("app_access_requests", {
    email,
    display_name: display_name || (session.user && session.user.user_metadata && session.user.user_metadata.full_name) || null,
    requested_record_id: requested_record_id || null,
    message: message || null,
  }, { bearer: session.access_token });
}
