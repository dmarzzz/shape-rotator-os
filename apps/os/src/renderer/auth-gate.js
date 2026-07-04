// auth-gate.js — the visible front door for the "required Google gate + approval"
// model. When the gate flag is on (isAuthGateEnabled), this mounts a full-screen
// overlay above everything that walks the user through: sign in with Google →
// (if approved) bind to their cohort record and dismiss → (if not) request access.
//
// Design intent: it is an OVERLAY, not a rewrite of boot()'s control flow — boot
// finishes behind it, and the overlay covers the app until the user is approved.
// That keeps a gate bug from bricking the app (clear srwk:auth_gate_enabled to
// escape) while the real write-side enforcement lands server-side in Phase 2.
//
// Flag is OFF by default; nothing here runs until the Supabase redirect URL is
// configured and an admin flips the flag on. See docs/design/google-auth-gate.md.

import {
  isAuthGateEnabled,
  getSession,
  signInWithGoogle,
  signOut,
  onAuthChanged,
  fetchMyMembership,
  requestAccess,
  gateState,
  sessionEmail,
} from "./supabase-auth.mjs";

let _overlay = null;
let _unsub = null;
let _session = null;
let _membership = null;
let _requestSent = false;
let _signInError = "";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function injectStyles() {
  if (document.getElementById("auth-gate-style")) return;
  const style = document.createElement("style");
  style.id = "auth-gate-style";
  // Scoped under #auth-gate; leans on the always-on --ds-* tokens with quiet
  // fallbacks so it renders even before the design-system sheet is parsed.
  style.textContent = `
    #auth-gate {
      position: fixed; inset: 0; z-index: 10000;
      display: grid; place-items: center; padding: 24px;
      background: var(--ds-surface-1, #0b0a12);
      color: var(--ds-ink-1, #ece7dd);
      font-family: var(--ds-font-ui, system-ui, sans-serif);
      -webkit-font-smoothing: antialiased;
    }
    #auth-gate .ag-card {
      width: min(440px, 100%);
      display: flex; flex-direction: column; gap: 18px;
      background: var(--ds-surface-2, #16131f);
      border: 1px solid var(--ds-border, #2a2636);
      border-radius: 16px; padding: 32px 30px;
      box-shadow: 0 24px 80px rgba(0,0,0,.5);
    }
    #auth-gate .ag-mark { width: 34px; height: 34px; border-radius: 8px;
      background: conic-gradient(from 210deg, #ff7a3d, #ff5063, #6ea8fe, #ff7a3d); }
    #auth-gate h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
    #auth-gate p { margin: 0; color: var(--ds-ink-2, #a49eb0); font-size: 14.5px; line-height: 1.55; }
    #auth-gate .ag-email { color: var(--ds-ink-1, #ece7dd); font-weight: 600; }
    #auth-gate button { font: inherit; cursor: pointer; }
    #auth-gate .ag-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      height: var(--ds-control-h, 42px); padding: 0 18px; border-radius: 10px;
      border: 1px solid var(--ds-border-strong, #39344c);
      background: var(--ds-surface-3, #1e1a2b); color: var(--ds-ink-1, #ece7dd);
      font-size: 15px; font-weight: 600; width: 100%;
    }
    #auth-gate .ag-btn:hover { border-color: var(--ds-accent, #ff7a3d); }
    #auth-gate .ag-btn:focus-visible { outline: 2px solid var(--ds-focus, #ff7a3d); outline-offset: 2px; }
    #auth-gate .ag-btn-primary { background: var(--ds-accent, #ff7a3d); color: #12100a; border-color: transparent; }
    #auth-gate .ag-btn-primary:hover { background: var(--ds-accent-hover, #ff8f5c); }
    #auth-gate textarea {
      width: 100%; min-height: 84px; resize: vertical; font: inherit; font-size: 14px;
      padding: 10px 12px; border-radius: 10px; color: var(--ds-ink-1, #ece7dd);
      background: var(--ds-surface-1, #0b0a12); border: 1px solid var(--ds-border, #2a2636);
    }
    #auth-gate textarea:focus-visible { outline: 2px solid var(--ds-focus, #ff7a3d); outline-offset: 1px; }
    #auth-gate .ag-row { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    #auth-gate .ag-link { background: none; border: none; color: var(--ds-ink-3, #726c80); font-size: 12.5px; text-decoration: underline; padding: 0; }
    #auth-gate .ag-link:hover { color: var(--ds-ink-2, #a49eb0); }
    #auth-gate .ag-help { margin: 0; color: var(--ds-ink-3, #726c80); font-size: 12.5px; }
    #auth-gate .ag-help strong { color: var(--ds-ink-2, #a49eb0); font-weight: 600; }
    #auth-gate .ag-err { color: var(--ds-danger, #ff5063); font-size: 13px; }
    #auth-gate .ag-ok { color: var(--ds-accent, #ff7a3d); font-size: 13.5px; }
    @media (prefers-reduced-motion: no-preference) { #auth-gate .ag-mark { animation: ag-spin 24s linear infinite; } }
    @keyframes ag-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`;

function render() {
  if (!_overlay) return;
  const state = gateState({ session: _session, membership: _membership });
  const email = sessionEmail(_session);
  const card = _overlay.querySelector(".ag-card");
  if (!card) return;

  if (state === "signed_out") {
    card.innerHTML = `
      <div class="ag-mark" aria-hidden="true"></div>
      <h1>Sign in to Shape Rotator</h1>
      <p>Access is by Google sign-in. Use the email you were invited with — we'll match you to your cohort record.</p>
      <button class="ag-btn ag-btn-primary" data-ag="signin">${GOOGLE_G}<span>Continue with Google</span></button>
      ${_signInError ? `<div class="ag-err">${esc(_signInError)}</div>` : ""}
      <p class="ag-help">Trouble signing in? Ping <strong>@mikeishiring:mtrx.shaperotator.xyz</strong> in Matrix.</p>`;
    return;
  }
  if (state === "rejected") {
    card.innerHTML = `
      <div class="ag-mark" aria-hidden="true"></div>
      <h1>Access declined</h1>
      <p>You're signed in as <span class="ag-email">${esc(email)}</span>, but this account was declined. If that's a mistake, reach an organizer.</p>
      <div class="ag-row"><button class="ag-link" data-ag="signout">use a different account</button></div>`;
    return;
  }
  // unapproved / pending / needs_binding all funnel to "request access"
  if (_requestSent) {
    card.innerHTML = `
      <div class="ag-mark" aria-hidden="true"></div>
      <h1>Request sent</h1>
      <p>Thanks — an organizer will review access for <span class="ag-email">${esc(email)}</span> and you'll get in once approved. You can close the app; we'll remember you.</p>
      <div class="ag-row"><button class="ag-link" data-ag="signout">use a different account</button></div>`;
    return;
  }
  const bindingNote = state === "needs_binding"
    ? "You're approved — tell us which cohort record is you and an organizer will link it."
    : "You're signed in, but not yet on the roster. Tell us who you are and an organizer will approve access.";
  card.innerHTML = `
    <div class="ag-mark" aria-hidden="true"></div>
    <h1>Request access</h1>
    <p>${bindingNote}</p>
    <p style="font-size:13px">Signed in as <span class="ag-email">${esc(email)}</span></p>
    <textarea data-ag="msg" placeholder="Your name, team/project, and anything that helps us place you (e.g. your GitHub handle)."></textarea>
    <button class="ag-btn ag-btn-primary" data-ag="request">Request access</button>
    ${_signInError ? `<div class="ag-err">${esc(_signInError)}</div>` : ""}
    <div class="ag-row"><button class="ag-link" data-ag="signout">use a different account</button></div>`;
}

async function refreshMembership() {
  _membership = _session ? await fetchMyMembership(_session) : null;
  const state = gateState({ session: _session, membership: _membership });
  if (state === "approved") { admit(); return; }
  render();
}

function admit() {
  // Bind the app's local identity to the verified record so the rest of the app
  // knows who the user is, then drop the overlay.
  try {
    if (_membership && _membership.record_id) {
      import("./identity.js").then(({ setIdentity }) => {
        try { setIdentity({ kind: _membership.record_type || "person", record_id: _membership.record_id, display_name: _membership.display_name || _membership.record_id }); } catch {}
      }).catch(() => {});
    }
  } catch {}
  teardown();
}

function teardown() {
  try { _unsub && _unsub(); } catch {}
  _unsub = null;
  if (_overlay) { try { _overlay.remove(); } catch {} _overlay = null; }
}

function onClick(e) {
  const btn = e.target.closest("[data-ag]");
  if (!btn) return;
  const action = btn.dataset.ag;
  if (action === "signin") {
    _signInError = "";
    btn.disabled = true;
    signInWithGoogle().then((r) => {
      if (!r || r.ok === false) { _signInError = (r && r.error) || "Couldn't open Google sign-in."; render(); }
      // On success the browser opens; the session arrives via onAuthChanged.
    });
  } else if (action === "signout") {
    signOut().then(() => { _session = null; _membership = null; _requestSent = false; render(); });
  } else if (action === "request") {
    const msg = _overlay.querySelector("[data-ag=msg]");
    const message = msg ? msg.value.trim() : "";
    btn.disabled = true;
    requestAccess({ message }, _session).then((r) => {
      if (r && r.ok) { _requestSent = true; _signInError = ""; }
      else { _signInError = (r && r.error) || "Couldn't send the request — try again."; btn.disabled = false; }
      render();
    });
  }
}

export async function mountAuthGateIfEnabled() {
  if (!isAuthGateEnabled()) return false;
  if (_overlay) return true;
  injectStyles();
  _overlay = document.createElement("div");
  _overlay.id = "auth-gate";
  _overlay.setAttribute("role", "dialog");
  _overlay.setAttribute("aria-modal", "true");
  _overlay.innerHTML = `<div class="ag-card" role="document"></div>`;
  _overlay.addEventListener("click", onClick);
  document.body.appendChild(_overlay);

  // React to sign-in / refresh / sign-out coming from main.
  _unsub = onAuthChanged((session) => {
    _session = session || null;
    _requestSent = false;
    if (_session) refreshMembership();
    else render();
  });

  _session = await getSession();
  if (_session) await refreshMembership();
  else render();
  return true;
}
