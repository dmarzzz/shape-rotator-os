// auth-gate.js — the visible front door for the "required sign-in + approval"
// model. On by default (isAuthGateEnabled), this mounts a full-screen overlay
// above everything that walks the user through: sign in with Google or Matrix →
// (if approved + bound) admit sealed to their cohort record → (if approved but
// UNBOUND) pick your person/team record and seal to it → (if not on the roster)
// request access.
//
// Design intent: it is an OVERLAY, not a rewrite of boot()'s control flow — boot
// finishes behind it, and the overlay covers the app until the user is approved.
// That keeps a gate bug from bricking the app (set srwk:auth_gate_enabled to "0"
// to escape) while the real write-side enforcement lands server-side in Phase 2.
// See docs/design/google-auth-gate.md.

import {
  isAuthGateEnabled,
  getSession,
  signInWithGoogle,
  signOut,
  onAuthChanged,
  fetchMyMembership,
  requestAccess,
  requestMatrixBinding,
  gateState,
  sessionEmail,
  getMatrixIdentity,
  fetchMatrixMembership,
  matrixGateState,
  signInWithMatrixBrowser,
  onMatrixChanged,
} from "./supabase-auth.mjs";

let _overlay = null;
let _unsub = null;
let _unsubMatrix = null;
let _session = null;
let _membership = null;
let _matrixUserId = null;
let _matrixMembership = null;
let _matrixBusy = false;
let _requestSent = false;
let _signInError = "";
// ── seal picker state (needs_binding) ──
let _bindRecords = null;      // [{ kind, record_id, name, key }] from the cohort surface
let _bindLoading = false;
let _bindFilter = "";
let _bindSelectedKey = null;
let _bindManual = false;      // fall back to the free-text request card
let _sealBusy = false;
// ── preview demo driver (?agDemo=…) — render-states only, see mount ──
let _demo = null;

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
      display: flex; flex-direction: column; gap: 16px;
      background: var(--ds-surface-2, #16131f);
      border: 1px solid var(--ds-border, #2a2636);
      border-radius: 16px; padding: 30px;
      box-shadow: 0 24px 80px rgba(0,0,0,.5);
    }
    #auth-gate .ag-brand-row { display: flex; align-items: center; gap: 12px; }
    #auth-gate .ag-mark { flex: none; width: 30px; height: 30px; border-radius: 8px;
      background: conic-gradient(from 210deg, #ff7a3d, #ff5063, #6ea8fe, #ff7a3d); }
    #auth-gate .ag-brand {
      font-family: var(--ds-font-mono, ui-monospace, monospace);
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.2em;
      text-transform: uppercase; color: var(--ds-ink-3, #726c80);
    }
    #auth-gate h1 { margin: 2px 0 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
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
    #auth-gate .ag-btn:disabled { opacity: 0.45; cursor: default; }
    #auth-gate .ag-btn:disabled:hover { border-color: var(--ds-border-strong, #39344c); }
    #auth-gate .ag-btn-primary { background: var(--ds-accent, #ff7a3d); color: #12100a; border-color: transparent; }
    #auth-gate .ag-btn-primary:hover:not(:disabled) { background: var(--ds-accent-hover, #ff8f5c); }
    #auth-gate .ag-btn-primary:disabled:hover { border-color: transparent; }
    #auth-gate .ag-mx {
      font-family: var(--ds-font-mono, ui-monospace, monospace);
      font-weight: 700; font-size: 14px; color: var(--ds-ink-2, #a49eb0);
    }
    #auth-gate .ag-or {
      display: flex; align-items: center; gap: 10px; margin: -4px 0;
      color: var(--ds-ink-3, #726c80); font-size: 10.5px;
      letter-spacing: 0.14em; text-transform: uppercase;
    }
    #auth-gate .ag-or::before, #auth-gate .ag-or::after {
      content: ""; height: 1px; flex: 1; background: var(--ds-border, #2a2636);
    }
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
    /* ── seal picker (needs_binding) ── */
    #auth-gate .ag-picklist {
      display: flex; flex-direction: column; gap: 2px;
      max-height: 236px; overflow-y: auto;
      border: 1px solid var(--ds-border, #2a2636); border-radius: 10px;
      padding: 4px; background: var(--ds-surface-1, #0b0a12);
      scrollbar-width: thin;
    }
    #auth-gate .ag-pick {
      display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
      padding: 8px 10px; border: 0; border-radius: 7px;
      background: transparent; color: var(--ds-ink-1, #ece7dd);
      font-size: 14px; text-align: left; width: 100%;
    }
    #auth-gate .ag-pick:hover { background: var(--ds-surface-3, #1e1a2b); }
    #auth-gate .ag-pick.is-selected { background: var(--ds-accent, #ff7a3d); color: #12100a; }
    #auth-gate .ag-pick-kind {
      flex: none; font-family: var(--ds-font-mono, ui-monospace, monospace);
      font-size: 10.5px; letter-spacing: 0.06em; color: var(--ds-ink-3, #726c80);
    }
    #auth-gate .ag-pick.is-selected .ag-pick-kind { color: rgba(18,16,10,0.7); }
    #auth-gate .ag-pick-empty { padding: 14px 10px; color: var(--ds-ink-3, #726c80); font-size: 13px; }
    @media (prefers-reduced-motion: no-preference) { #auth-gate .ag-mark { animation: ag-spin 24s linear infinite; } }
    @keyframes ag-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`;

const BRAND_ROW = `<div class="ag-brand-row"><div class="ag-mark" aria-hidden="true"></div><div class="ag-brand">Shape Rotator · operating system</div></div>`;

// ── seal picker data — the cohort surface's people + teams ──────────────────
async function loadBindRecords() {
  if (_bindRecords || _bindLoading) return;
  _bindLoading = true;
  try {
    const { getCohortSurface } = await import("./cohort-source.js");
    const surface = await getCohortSurface();
    const people = (surface?.people || []).map((p) => ({ kind: "person", record_id: p.record_id, name: p.name || p.record_id }));
    const teams = (surface?.teams || []).map((t) => ({ kind: "team", record_id: t.record_id, name: t.name || t.record_id }));
    _bindRecords = [...people, ...teams]
      .filter((r) => r.record_id)
      .map((r) => ({ ...r, key: `${r.kind}:${r.record_id}` }));
  } catch {
    _bindRecords = [];
  }
  _bindLoading = false;
  updateBindList();
}

// The verified credential we're sealing (email local-part / matrix local-part) —
// used to bubble likely-you records to the top of the untouched list.
function bindHint() {
  const email = sessionEmail(_session);
  const raw = email ? email.split("@")[0] : (_matrixUserId ? _matrixUserId.slice(1).split(":")[0] : "");
  return String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function bindList() {
  const all = _bindRecords || [];
  const q = _bindFilter.trim().toLowerCase();
  const filtered = q
    ? all.filter((r) => r.name.toLowerCase().includes(q) || r.record_id.toLowerCase().includes(q))
    : all;
  const hint = q ? "" : bindHint();
  const likely = (r) => {
    if (!hint) return 1;
    const n = (r.record_id + r.name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    return n.includes(hint) || (hint.length > 3 && hint.includes(r.record_id.toLowerCase().replace(/[^a-z0-9]+/g, ""))) ? 0 : 1;
  };
  return [...filtered].sort((a, b) =>
    likely(a) - likely(b)
    || (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === "person" ? -1 : 1)));
}

function bindListHtml() {
  if (!_bindRecords) return `<div class="ag-pick-empty">loading the roster…</div>`;
  const rows = bindList();
  if (!rows.length) return `<div class="ag-pick-empty">no matches — try fewer letters, or use "can't find yourself?" below.</div>`;
  return rows.map((r) => `
    <button class="ag-pick${r.key === _bindSelectedKey ? " is-selected" : ""}" data-ag-pick="${esc(r.key)}" role="option" aria-selected="${r.key === _bindSelectedKey ? "true" : "false"}">
      <span>${esc(r.name)}</span><span class="ag-pick-kind">${r.kind}</span>
    </button>`).join("");
}

// Refresh only the list + seal button so typing in the search box never loses
// focus to a whole-card innerHTML rebuild.
function updateBindList() {
  if (!_overlay) return;
  const list = _overlay.querySelector("[data-ag-list]");
  if (list) list.innerHTML = bindListHtml();
  const sealBtn = _overlay.querySelector("[data-ag=seal]");
  if (sealBtn) {
    const rec = (_bindRecords || []).find((r) => r.key === _bindSelectedKey);
    sealBtn.disabled = !rec || _sealBusy;
    sealBtn.textContent = _sealBusy ? "sealing…" : (rec ? `Seal to ${rec.name}` : "Seal to your record");
  }
}

function renderBindPicker(card, credential) {
  card.innerHTML = `
    ${BRAND_ROW}
    <h1>You're in — who are you?</h1>
    <p><span class="ag-email">${esc(credential)}</span> is approved but not linked to a cohort record yet. Pick yourself — or your team — and the app seals your work to it.</p>
    <input type="search" data-ag-filter placeholder="search people and teams…" aria-label="search cohort records" autocomplete="off" spellcheck="false" />
    <div class="ag-picklist" data-ag-list role="listbox" aria-label="cohort records"></div>
    <button class="ag-btn ag-btn-primary" data-ag="seal" disabled>Seal to your record</button>
    ${_signInError ? `<div class="ag-err">${esc(_signInError)}</div>` : ""}
    <div class="ag-row">
      <button class="ag-link" data-ag="bind-manual">can't find yourself?</button>
      <button class="ag-link" data-ag="signout">use a different account</button>
    </div>`;
  const filter = card.querySelector("[data-ag-filter]");
  if (filter) {
    filter.value = _bindFilter;
    filter.addEventListener("input", () => { _bindFilter = filter.value; updateBindList(); });
  }
  updateBindList();
  if (!_bindRecords) loadBindRecords();
}

function render() {
  if (!_overlay) return;
  const state = gateState({ session: _session, membership: _membership });
  const mState = matrixGateState({ userId: _matrixUserId, membership: _matrixMembership });
  const email = sessionEmail(_session);
  const card = _overlay.querySelector(".ag-card");
  if (!card) return;

  // Approved-but-unbound (either credential) → the seal picker. This is the
  // "we have your email/matrix but no record link" path: the user selects
  // their person or team once and the app seals to it.
  const needsBinding = state === "needs_binding" || (state === "signed_out" && mState === "needs_binding");
  if (needsBinding && !_bindManual) {
    renderBindPicker(card, state === "needs_binding" ? email : _matrixUserId);
    return;
  }

  // The Matrix-credential manual fallback must reach the request card below,
  // not the sign-in card — a Matrix member has no Google session, so plain
  // signed_out would swallow it.
  if (state === "signed_out" && !needsBinding) {
    // Matrix is the second front door: a chat session verified by main's OAuth
    // maps to the roster mirror (app_matrix_members). An approved+bound match
    // admits in refreshMatrix() before this card ever renders; approved+unbound
    // took the picker branch above. Here we only offer the sign-ins and explain
    // a signed-in-but-unlisted (or still-pending) Matrix account.
    const matrixNote = _matrixUserId
      ? `<p class="ag-help">Matrix account <strong>${esc(_matrixUserId)}</strong> ${mState === "pending" ? "is awaiting an organizer's approval" : "isn't on the roster"} — continue with Google, or ping the contact below.</p>`
      : "";
    const matrixButton = _matrixBusy
      ? `<div class="ag-ok">opening your browser for Matrix sign-in — approve there, this finishes on its own…</div>`
      : `<button class="ag-btn" data-ag="matrix-signin"><span class="ag-mx" aria-hidden="true">[m]</span><span>Continue with Matrix</span></button>`;
    card.innerHTML = `
      ${BRAND_ROW}
      <h1>Sign in</h1>
      <p>Use the account you were invited with — we'll match you to your cohort record, or let you pick it once.</p>
      <button class="ag-btn ag-btn-primary" data-ag="signin">${GOOGLE_G}<span>Continue with Google</span></button>
      ${_matrixUserId ? "" : `<div class="ag-or"><span>or</span></div>${matrixButton}`}
      ${matrixNote}
      ${_signInError ? `<div class="ag-err">${esc(_signInError)}</div>` : ""}
      <p class="ag-help">Trouble signing in? Ping <strong>@mikeishiring:mtrx.shaperotator.xyz</strong> in Matrix.</p>`;
    return;
  }
  if (state === "rejected") {
    card.innerHTML = `
      ${BRAND_ROW}
      <h1>Access declined</h1>
      <p>You're signed in as <span class="ag-email">${esc(email)}</span>, but this account was declined. If that's a mistake, reach an organizer.</p>
      <div class="ag-row"><button class="ag-link" data-ag="signout">use a different account</button></div>`;
    return;
  }
  // unapproved / pending funnel to "request access"
  if (_requestSent) {
    card.innerHTML = `
      ${BRAND_ROW}
      <h1>Request sent</h1>
      <p>Thanks — an organizer will review access for <span class="ag-email">${esc(email || _matrixUserId)}</span> and you'll get in once approved. You can close the app; we'll remember you.</p>
      <div class="ag-row"><button class="ag-link" data-ag="signout">use a different account</button></div>`;
    return;
  }
  const bindingNote = needsBinding
    ? "You're approved — tell us which cohort record is you and an organizer will link it."
    : "You're signed in, but not yet on the roster. Tell us who you are and an organizer will approve access.";
  card.innerHTML = `
    ${BRAND_ROW}
    <h1>Request access</h1>
    <p>${bindingNote}</p>
    <p style="font-size:13px">Signed in as <span class="ag-email">${esc(email || _matrixUserId)}</span></p>
    <textarea data-ag="msg" placeholder="Your name, team/project, and anything that helps us place you (e.g. your GitHub handle)."></textarea>
    <button class="ag-btn ag-btn-primary" data-ag="request">Request access</button>
    ${_signInError ? `<div class="ag-err">${esc(_signInError)}</div>` : ""}
    <div class="ag-row">
      ${needsBinding ? `<button class="ag-link" data-ag="bind-back">back to the picker</button>` : "<span></span>"}
      <button class="ag-link" data-ag="signout">use a different account</button>
    </div>`;
}

async function refreshMembership() {
  _membership = _session ? await fetchMyMembership(_session) : null;
  const state = gateState({ session: _session, membership: _membership });
  if (state === "approved") { admit(_membership); return; }
  render();
}

// Matrix flavor of refreshMembership: the chat session (verified in main via
// real OAuth) maps to app_matrix_members. Approved + bound admits exactly like
// Google; approved + unbound renders the seal picker; anything else just
// re-renders with the account noted.
async function refreshMatrix() {
  if (!_overlay) return;
  _matrixUserId = await getMatrixIdentity();
  _matrixMembership = _matrixUserId ? await fetchMatrixMembership(_matrixUserId) : null;
  if (!_overlay) return; // admitted via Google while we were fetching
  if (matrixGateState({ userId: _matrixUserId, membership: _matrixMembership }) === "approved") {
    admit(_matrixMembership);
    return;
  }
  render();
}

function admit(membership) {
  // Bind the app's local identity to the verified record so the rest of the app
  // knows who the user is, then drop the overlay.
  try {
    if (membership && membership.record_id) {
      import("./identity.js").then(({ setIdentity }) => {
        try { setIdentity({ kind: membership.record_type || "person", record_id: membership.record_id, display_name: membership.display_name || membership.record_id }); } catch {}
      }).catch(() => {});
    }
  } catch {}
  teardown();
}

// The seal: local identity claim NOW (the user is approved — the record link is
// metadata), plus a best-effort structured binding request so an organizer can
// make it stick server-side in app_members / app_matrix_members.
async function sealTo(rec) {
  if (!rec || _sealBusy) return;
  _sealBusy = true;
  updateBindList();
  try {
    const { setIdentity } = await import("./identity.js");
    setIdentity({ kind: rec.kind, record_id: rec.record_id, display_name: rec.name });
  } catch {}
  if (!_demo) {
    try {
      const message = `self-sealed in-app to ${rec.kind} "${rec.record_id}" (${rec.name}) — please bind this on the roster`;
      if (_session) await requestAccess({ requested_record_id: rec.record_id, message }, _session);
      else if (_matrixUserId) await requestMatrixBinding({ matrixId: _matrixUserId, requested_record_id: rec.record_id, display_name: rec.name, message });
    } catch {}
  }
  _sealBusy = false;
  teardown();
}

function teardown() {
  try { _unsub && _unsub(); } catch {}
  _unsub = null;
  try { _unsubMatrix && _unsubMatrix(); } catch {}
  _unsubMatrix = null;
  if (_overlay) { try { _overlay.remove(); } catch {} _overlay = null; }
}

function onClick(e) {
  const pick = e.target.closest("[data-ag-pick]");
  if (pick) {
    _bindSelectedKey = pick.dataset.agPick;
    updateBindList();
    return;
  }
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
  } else if (action === "matrix-signin") {
    _signInError = "";
    _matrixBusy = true;
    render();
    signInWithMatrixBrowser().then((r) => {
      _matrixBusy = false;
      if (!r || r.ok === false) {
        _signInError = (r && r.error) || "Couldn't open Matrix sign-in.";
        render();
        return;
      }
      refreshMatrix();
    });
  } else if (action === "seal") {
    const rec = (_bindRecords || []).find((r) => r.key === _bindSelectedKey);
    sealTo(rec);
  } else if (action === "bind-manual") {
    _bindManual = true;
    render();
  } else if (action === "bind-back") {
    _bindManual = false;
    _signInError = "";
    render();
  } else if (action === "signout") {
    signOut().then(() => {
      _session = null; _membership = null; _requestSent = false;
      _bindManual = false; _bindSelectedKey = null; _bindFilter = "";
      render();
    });
  } else if (action === "request") {
    const msg = _overlay.querySelector("[data-ag=msg]");
    const message = msg ? msg.value.trim() : "";
    btn.disabled = true;
    // Matrix members carry no Supabase JWT — their request rides the anon-key
    // flavor keyed on the verified matrix id instead.
    const req = _session
      ? requestAccess({ message }, _session)
      : requestMatrixBinding({ matrixId: _matrixUserId, message });
    req.then((r) => {
      if (r && r.ok) { _requestSent = true; _signInError = ""; }
      else { _signInError = (r && r.error) || "Couldn't send the request — try again."; btn.disabled = false; }
      render();
    });
  }
}

// Preview/screenshot driver — ?agDemo=<state> renders a gate state without any
// live credentials (signedout | binding | binding-matrix | pending | rejected).
// Render-states only: the gate is client-side UX (server enforcement is Phase 2),
// and the kill switch already exists, so this exposes nothing new.
function readDemo() {
  try { return new URLSearchParams(location.search).get("agDemo"); } catch { return null; }
}
function applyDemo(demo) {
  const fakeSession = { access_token: "demo", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { email: "demo@shaperotator.xyz" } };
  if (demo === "binding") {
    _session = fakeSession;
    _membership = { email: "demo@shaperotator.xyz", record_id: null, record_type: "person", role: "member", status: "approved", display_name: null, approved: true, bound: false };
  } else if (demo === "binding-matrix") {
    _matrixUserId = "@demo:matrix.org";
    _matrixMembership = { matrix_id: "@demo:matrix.org", record_id: null, record_type: "person", role: "member", status: "approved", display_name: null, approved: true, bound: false };
  } else if (demo === "pending") {
    _session = fakeSession;
    _membership = { email: "demo@shaperotator.xyz", record_id: null, record_type: "person", role: "member", status: "pending", display_name: null, approved: false, bound: false };
  } else if (demo === "rejected") {
    _session = fakeSession;
    _membership = { email: "demo@shaperotator.xyz", record_id: null, record_type: "person", role: "member", status: "rejected", display_name: null, approved: false, bound: false };
  }
  // "signedout" (or anything else) leaves everything null.
  render();
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

  _demo = readDemo();
  if (_demo) { applyDemo(_demo); return true; }

  // React to sign-in / refresh / sign-out coming from main.
  _unsub = onAuthChanged((session) => {
    _session = session || null;
    _requestSent = false;
    if (_session) refreshMembership();
    else render();
  });
  // Matrix session changes (chat sign-in completing counts as a front-door
  // credential too — "sign into chat, you're synced to your record").
  _unsubMatrix = onMatrixChanged(() => { refreshMatrix(); });

  _session = await getSession();
  if (_session) await refreshMembership();
  else render();
  // A pre-existing chat session admits without any clicks. Runs after the
  // Google check so an already-admitted overlay isn't double-processed.
  if (_overlay) await refreshMatrix();
  return true;
}
