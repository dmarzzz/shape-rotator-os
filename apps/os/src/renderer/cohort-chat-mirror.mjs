// cohort-chat-mirror.mjs — the chat's opt-in door into "Your Mirror".
//
// The cohort chat is grounded in PUBLIC cohort data and can't read anything
// private on its own. "Refresh my profile from my own recent work" is a different,
// consent-gated flow that already exists: the self-report modal (self-report.js),
// which scans the member's LOCAL sessions + public GitHub and drafts a whitelisted
// delta they review. This module is the thin bridge — it decides WHEN to offer that
// flow from the chat and hands off into it; it never scans or writes anything here.
//
// Two entry points (per docs/your-mirror-receive-and-chat.md §B.5):
//   • a one-time, dismissible first-run OFFER turn (maybeOfferMirror), and
//   • a `/mirror` slash command (parseMirrorCommand) the chat intercepts before
//     sending to the CLI.
// Both end at handToSelfReport → window.__srwkOpenSelfReport, the existing modal's
// real per-source consent gate. Pure decision + copy + thin localStorage IO is
// exported for node tests; the DOM render is injected by the chat controller.

export const MIRROR_OFFER_LS_KEY = "srwk:mirror_offer_state_v1";

// True for a leading `/mirror` (alone or with trailing args) — intercepted so it
// never reaches the CLI as a question.
export function parseMirrorCommand(text) {
  return /^\/mirror(\s|$)/i.test(String(text == null ? "" : text).trim());
}

// Which turn the offer should take, given readiness. Pure.
//   'no-identity' → claim a profile first (we need a record to write to)
//   'no-cli'      → no local AI tool detected (the scan needs one)
//   'ready'       → we can run it
export function resolveMirrorGate({ hasIdentity, ready } = {}) {
  if (!hasIdentity) return "no-identity";
  if (!ready) return "no-cli";
  return "ready";
}

// The bubble copy for each gate. Pure — returns strings the chat renders.
export function mirrorOfferCopy(gate, { handle = "" } = {}) {
  if (gate === "no-identity") {
    return {
      eyebrow: "mirror",
      body: "I can refresh your profile from your own recent work — but first claim your profile so I know which record to update.",
      primary: null,
      secondary: "Got it",
    };
  }
  if (gate === "no-cli") {
    return {
      eyebrow: "mirror",
      body: "I can refresh your profile from your own recent work — that runs your own local AI tool (Claude Code / Codex), but I don't see one on PATH yet. Set it up in settings ⚙, then say /mirror.",
      primary: null,
      secondary: "Got it",
    };
  }
  return {
    eyebrow: "mirror",
    body: "Want me to refresh your profile from your own recent work? I can read what you've been building — your local AI sessions (summarized on this machine) and your public GitHub"
      + (handle ? ` (@${handle})` : "")
      + " — and draft an update. You review and approve every line before anything saves.",
    primary: "Choose what to share →",
    secondary: "Not now",
  };
}

// ── per-record nag state (mirrors identity_onboarding_skipped_v1) ─────────────
function readState(storage) {
  try {
    const raw = storage && storage.getItem(MIRROR_OFFER_LS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
export function wasOffered(recordId, storage) {
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id) return false;
  const e = readState(storage)[id];
  return !!(e && e.offered);
}
export function markOffered(recordId, storage, at = null) {
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id || !storage) return;
  try {
    const all = readState(storage);
    all[id] = { offered: true, at: at || null };
    storage.setItem(MIRROR_OFFER_LS_KEY, JSON.stringify(all));
  } catch { /* private mode — best effort */ }
}

// Decide + (once) show the first-run offer. Returns true if an offer turn was
// rendered. `render(copy, gate)` is injected by the chat controller (DOM lives
// there). `storage` defaults to localStorage. Idempotent per record_id: a member
// is offered at most once; `/mirror` is always available regardless.
export function maybeOfferMirror({ identity, ready, handle = "", storage, render, now = null } = {}) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  const recordId = identity && identity.record_id ? String(identity.record_id) : "";
  // No identity at all → don't nag in chat; the no-identity turn only shows on an
  // explicit /mirror (we still have nothing to key the nag-state on).
  if (!recordId) return false;
  if (wasOffered(recordId, store)) return false;
  const gate = resolveMirrorGate({ hasIdentity: true, ready });
  if (typeof render === "function") render(mirrorOfferCopy(gate, { handle }), gate);
  markOffered(recordId, store, now);
  return true;
}

// Hand off into the existing consent-first self-report modal. Graceful no-op if the
// seam isn't present (e.g. the modal module hasn't loaded). Returns true if routed.
export function handToSelfReport(person, { githubDigest = "", win = (typeof window !== "undefined" ? window : null) } = {}) {
  if (!person || !person.record_id) return false;
  const open = win && win.__srwkOpenSelfReport;
  if (typeof open !== "function") return false;
  try { open({ person, githubDigest }); return true; } catch { return false; }
}
