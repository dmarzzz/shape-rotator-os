// cohort-chat.js — the "chat with the cohort" panel controller.
//
// Streams a conversation with the member's OWN local AI CLI (Claude Code /
// Codex, supervised by apps/os/cohort-chat-node.js), grounded in the
// live cohort surface. The renderer builds the full prompt (cohort context +
// connection edges + history + question) via cohort-chat-context.mjs and pipes
// it to the CLI's stdin through the fg:cohort-chat:* IPC; tokens stream back
// into the assistant bubble. No API key — nothing leaves the box except whatever
// that local agent itself does.

import { loadStylesheetOnce } from "./stylesheet-loader.js";
import { getCohortSurface } from "./cohort-source.js";
import { buildChatPrompt, classifyChatIntent, needsProjectConfirmation } from "./cohort-chat-context.mjs";
import { parseChatActions } from "./cohort-chat-actions.mjs";
import { createChatStream } from "./cohort-chat-stream.mjs";
import { maybeOfferMirror, parseMirrorCommand, handToSelfReport } from "./cohort-chat-mirror.mjs";
import { resolveChatFocus } from "./cohort-chat-focus.mjs";
import { getIdentity } from "./identity.js";
import { getClaimTokenHash } from "./claim-token.mjs";
import { saveProfileProposal } from "./supabase-self-report.mjs";
import { emitConnection, emitContest, emitSelfReport } from "./cohort-emit.mjs";
import { submitContest } from "./supabase-contest.mjs";
import { scanGithubActivity, resolvePersonHandle, summarizeEvents, digestFromEvents } from "./gh-self-report.mjs";

let stylesheetPromise = null;
let controller = null;

function $(id) { return document.getElementById(id); }

// Resolve the member's own person record from their claimed identity + the surface
// (mirrors gh-fork.js::getCurrentGithubHandle). Used to hand off into the mirror.
function resolveMyPerson(surface) {
  const id = getIdentity();
  if (!id || id.kind !== "person") return null;
  const people = (surface && Array.isArray(surface.people)) ? surface.people : [];
  return people.find((p) => p && p.record_id === id.record_id) || null;
}

// The provenance + grounding context handed to parseChatActions: WHO is proposing
// (from the device identity, never the model) and which record_ids actually exist
// (so the model can't propose about invented people).
function buildActionCtx(surface) {
  const id = getIdentity();
  const ids = new Set();
  const teamIds = new Set();
  for (const r of Array.isArray(surface && surface.people) ? surface.people : []) {
    if (r && r.record_id) ids.add(String(r.record_id));
  }
  for (const r of Array.isArray(surface && surface.teams) ? surface.teams : []) {
    if (r && r.record_id) { ids.add(String(r.record_id)); teamIds.add(String(r.record_id)); }
  }
  return {
    proposerRecordId: id && id.record_id ? String(id.record_id) : null,
    proposerClaimHash: getClaimTokenHash() || null,
    knownRecordIds: ids,
    knownTeamIds: teamIds, // the subset that are teams → a team subject uses the award whitelist
  };
}

// The model is told to emit ONE trailing ```json {"actions":[…]} block. Strip it
// (and a bare trailing actions object) from the bubble so the member reads prose,
// not JSON. Pure string surgery — leaves normal answers untouched.
function stripActionBlock(text) {
  let s = String(text == null ? "" : text);
  s = s.replace(/```(?:json)?\s*\{[\s\S]*?"actions"[\s\S]*?\}\s*```\s*$/i, "");
  s = s.replace(/\{\s*"actions"\s*:\s*\[[\s\S]*\]\s*\}\s*$/i, "");
  return s.trim();
}

// Strip ANSI escape / control sequences a CLI may emit.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\r/g, "");
}

export function warmCohortChat() {
  if (!stylesheetPromise) stylesheetPromise = loadStylesheetOnce("renderer/cohort-chat.css");
  return stylesheetPromise;
}

function createController() {
  const panel = $("cohort-chat-panel");
  if (!panel) return null;

  const log         = $("cohort-chat-log");
  const empty       = $("cohort-chat-empty");
  const form        = $("cohort-chat-form");
  const input       = $("cohort-chat-input");
  const sendBtn     = $("cohort-chat-send");
  const stopBtn     = $("cohort-chat-stop");
  const dot         = $("cohort-chat-dot");
  const statusLine  = $("cohort-chat-status-line");
  const preMsg      = $("cohort-chat-pre-message");
  const settingsBtn = $("cohort-chat-settings-btn");
  const settingsEl  = $("cohort-chat-settings");
  const settingsClose = $("cohort-chat-settings-close");
  const cmdInput    = $("cohort-chat-cmd");
  const detectedEl  = $("cohort-chat-detected");
  const saveBtn     = $("cohort-chat-settings-save");
  const settingsStat= $("cohort-chat-settings-status");

  if (!log || !form || !input || !sendBtn || !stopBtn || !dot || !statusLine
    || !preMsg || !settingsBtn || !settingsEl || !settingsClose || !cmdInput
    || !detectedEl || !saveBtn || !settingsStat) {
    return null;
  }

  const history = [];          // [{role:'user'|'assistant', content}]
  let currentRequestId = null;
  let activeRunCard = null;
  let activeRunMeta = null;
  let outputDispose = null;
  let statusDispose = null;
  let activeBubbleBody = null;  // the streaming assistant <div> being filled
  let activeStream = null;      // createChatStream() — parses NDJSON/plain into live text
  let elapsedTimer = null;      // ticks "thinking… Ns" / "writing… Ns" while running
  let stderrBuffer = "";        // the CLI's stderr — surfaced only if it fails
  let pendingActionCtx = null;  // provenance/known-ids for THIS turn's action parse
  let lastQuestion = "";        // the member's question, for a tool-grounded re-ask
  let toolRound = 0;            // bounded self-questioning depth (see MAX_TOOL_ROUNDS)
  const MAX_TOOL_ROUNDS = 1;    // at most one public-tool follow-up per member turn
  let activeFocus = null;       // the project in hand (cohort-chat-focus.mjs) — scopes
  let activeFocusResolution = null;
  let selectedTeamId = "";      //   what's scanned + the team a write targets; the
                                //   member's explicit pick (UI), else named-in-chat/primary

  // Auto-scroll should follow the stream, but never YANK a user who has scrolled
  // up to read earlier output. Check before each chunk grows the log.
  function isPinnedToBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }
  // The diagnostic to show when the CLI produced no answer: prefer its own
  // stderr (e.g. ollama's `model "x" not found`) over a generic message.
  function diagnoseFailure() {
    const err = stripAnsi(stderrBuffer).trim();
    if (err) return err.length > 400 ? "…" + err.slice(-400) : err;
    return "the local AI exited without output — check the command in settings ⚙";
  }

  // Keep the corner dial's open/closed state in sync (gold-arc settle + no pulse)
  // AND broadcast a global "chat is open" signal on <html> so other surfaces (the
  // membrane agenda rail) can make room for the popup. Both open() and close()
  // route through here, so this is the single choke point for the signal.
  function syncDial(isOpen) {
    document.documentElement.classList.toggle("cohort-chat-open", isOpen);
    const dial = document.getElementById("cohort-chat-dial");
    if (!dial) return;
    dial.classList.toggle("is-open", isOpen);
    dial.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  const CHAT_ONBOARDED_KEY = "srwk:chat_onboarded_v1";

  function open() {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    syncDial(true);  // also sets html.cohort-chat-open so the agenda rail makes room
    window.addEventListener("keydown", onKey, true);
    setTimeout(() => input.focus(), 60);
    refreshReadiness();
    void onboardThenOffer();
  }

  // First: if there's no local AI yet, show the setup guide (Claude Code / Codex);
  // once, when ready, a one-line intro. Only offer the mirror when the AI is ready.
  async function onboardThenOffer() {
    const shownSetup = await maybeOnboard();
    if (!shownSetup) void offerMirrorOnce();
  }

  // Returns true when the not-ready SETUP guide was shown (so we skip the mirror).
  async function maybeOnboard() {
    let cfg = null;
    try { cfg = await window.api.getCohortChatConfig(); } catch {}
    const ready = !!(cfg && cfg.ready);
    log.querySelectorAll(".cc-card.is-onboard").forEach((el) => el.remove()); // no dupes across re-opens
    if (!ready) { renderOnboarding({ ready: false }); return true; }
    let onboarded = false;
    try { onboarded = !!localStorage.getItem(CHAT_ONBOARDED_KEY); } catch {}
    if (!onboarded) {
      renderOnboarding({ ready: true, detected: (cfg.available && cfg.available[0]) || "local AI" });
      try { localStorage.setItem(CHAT_ONBOARDED_KEY, "1"); } catch {}
    }
    return false;
  }

  // The onboarding card: the CLI-setup guide when no local AI is found, else a
  // one-line "this runs on your own agent" intro on first ever open.
  function renderOnboarding({ ready, detected }) {
    const card = document.createElement("div");
    card.className = "cc-card is-onboard";
    if (!ready) {
      card.innerHTML = `
        <div class="cc-card-eyebrow">set up your own AI</div>
        <div class="cc-card-body">This chat runs on <b>your own</b> AI agent on this machine — no API key, nothing leaves your computer. Install one:
          <div class="cc-onboard-steps">
            <div><b>Claude Code</b> (Claude Max / Pro): run <code>npm i -g @anthropic-ai/claude-code</code>, then <code>claude</code> once to sign in.</div>
            <div><b>Codex</b> (ChatGPT / OpenAI): install the <code>codex</code> CLI and sign in.</div>
          </div>
          Reopen the chat and it auto-detects it — or set a custom command in&nbsp;⚙.</div>
        <div class="cc-card-actions">
          <button type="button" class="btn ds-ghost" data-cc-onboard-settings>Settings&nbsp;⚙</button>
          <button type="button" class="btn ds-primary" data-cc-onboard-recheck>I installed it — re-check</button>
        </div>`;
      card.querySelector("[data-cc-onboard-settings]").addEventListener("click", openSettings);
      card.querySelector("[data-cc-onboard-recheck]").addEventListener("click", () => { card.remove(); refreshReadiness(); void maybeOnboard(); });
      if (empty && empty.parentNode) empty.remove(); // the setup guide replaces the prompts
    } else {
      card.innerHTML = `
        <div class="cc-card-eyebrow">runs on your own AI</div>
        <div class="cc-card-body">I run on your <b>${esc(detected)}</b> agent — no API key, on your machine. Ask about the cohort, or ask me to <b>update your profile</b>, <b>suggest a connection</b>, or <b>refresh from your recent work</b>. I draft; you approve.</div>
        <div class="cc-card-actions"><button type="button" class="btn ds-ghost" data-cc-onboard-dismiss>Got it</button></div>`;
      card.querySelector("[data-cc-onboard-dismiss]").addEventListener("click", () => card.remove());
    }
    if (empty && empty.parentNode) empty.remove();
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  // First-run, once-ever (per claimed record) offer to refresh the profile from
  // recent work. Idempotent via maybeOfferMirror's localStorage nag-state.
  async function offerMirrorOnce() {
    try {
      const identity = getIdentity();
      if (!identity) return;
      const cfg = await window.api.getCohortChatConfig();
      let surface = null; try { surface = await getCohortSurface(); } catch {}
      const me = resolveMyPerson(surface);
      const handle = me && me.links && me.links.github
        ? String(me.links.github).replace(/^@+/, "").replace(/.*github\.com\//i, "").split(/[/?#]/)[0]
        : "";
      maybeOfferMirror({ identity, ready: !!(cfg && cfg.ready), handle, render: renderMirrorOffer });
    } catch { /* offering is best-effort */ }
  }
  function close() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    syncDial(false);  // also clears html.cohort-chat-open
    window.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    if (!settingsEl.hidden) { closeSettings(); return; }
    close();
  }

  function setStatus(state, line) { dot.dataset.state = state; statusLine.textContent = line; }
  function setPreMsg(msg, kind) {
    preMsg.textContent = msg || "";
    preMsg.className = "cohort-chat-pre-message" + (kind ? ` is-${kind}` : "");
  }

  async function refreshReadiness() {
    try {
      const cfg = await window.api.getCohortChatConfig();
      cmdInput.value = cfg.chatCmd || "";
      detectedEl.textContent = cfg.available && cfg.available.length
        ? `detected on PATH: ${cfg.available.join(", ")}${cfg.resolved ? ` · will run: ${cfg.resolved}` : ""}`
        : "no local AI CLI detected on PATH";
      if (!cfg.ready) {
        // A precise hint (if the config layer supplies one) beats the generic copy.
        setPreMsg(
          cfg.modelHint
            || "No local AI found. Install Claude Code or Codex and make sure it's on PATH (or set a command in settings ⚙).",
          "info");
      } else {
        setPreMsg("");
      }
    } catch (e) {
      setPreMsg(`config check failed: ${e.message}`, "error");
    }
  }

  function appendBubble(role, text) {
    if (empty && empty.parentNode) empty.remove();
    const row = document.createElement("div");
    row.className = `cc-msg is-${role}`;
    const body = document.createElement("div");
    body.className = "cc-msg-body";
    body.textContent = text || "";
    row.appendChild(body);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function scopeName(meta = {}) {
    const focus = meta.focus || activeFocus;
    return focus && focus.teamName ? String(focus.teamName) : "cohort";
  }

  function runPhaseForElapsed(secs, phase) {
    if (phase === "writing") return { id: "writing", label: "writing the answer" };
    if (secs < 4) return { id: "scope", label: `scoping ${scopeName(activeRunMeta)}` };
    if (secs < 12) return { id: "evidence", label: "checking the evidence pack" };
    return { id: "agent", label: "letting the agent go deep" };
  }

  function renderRunCard(meta = {}) {
    if (activeRunCard) activeRunCard.remove();
    activeRunMeta = meta;
    const card = document.createElement("div");
    card.className = "cc-card cc-deep-run";
    const scope = scopeName(meta);
    const route = meta.route === "refresh_update" ? "update"
      : meta.route === "connection" ? "connection"
        : meta.route === "status_lookup" ? "status"
          : "answer";
    card.innerHTML = `
      <div class="cc-deep-top">
        <span class="cc-card-eyebrow">deep run</span>
        <span class="cc-deep-time" data-cc-deep-time>0s</span>
      </div>
      <div class="cc-deep-scope"><span>scope</span><b>${esc(scope)}</b><i>${esc(route)}</i></div>
      <div class="cc-deep-rail" aria-hidden="true">
        <span data-cc-phase="scope"></span>
        <span data-cc-phase="evidence"></span>
        <span data-cc-phase="agent"></span>
        <span data-cc-phase="writing"></span>
      </div>
      <div class="cc-deep-line" data-cc-deep-line>scoping ${esc(scope)}</div>`;
    log.appendChild(card);
    if (isPinnedToBottom()) log.scrollTop = log.scrollHeight;
    activeRunCard = card;
    setRunPhase("scope", 0);
  }

  function setRunPhase(phase, secs = 0) {
    if (!activeRunCard) return;
    activeRunCard.dataset.phase = phase;
    const labels = {
      scope: `scoping ${scopeName(activeRunMeta)}`,
      evidence: "checking the evidence pack",
      agent: "letting the agent go deep",
      writing: "writing the answer",
      done: "done",
      error: "stopped",
    };
    const order = ["scope", "evidence", "agent", "writing"];
    const phaseIdx = order.indexOf(phase);
    for (const el of activeRunCard.querySelectorAll("[data-cc-phase]")) {
      const id = el.getAttribute("data-cc-phase");
      const idx = order.indexOf(id);
      let state = idx < phaseIdx ? "done" : id === phase ? "active" : "pending";
      if (phase === "done") state = "done";
      if (phase === "error") state = "error";
      el.dataset.state = state;
    }
    const line = activeRunCard.querySelector("[data-cc-deep-line]");
    const time = activeRunCard.querySelector("[data-cc-deep-time]");
    if (line) line.textContent = labels[phase] || labels.agent;
    if (time) time.textContent = `${secs}s`;
  }

  function clearRunCard({ error = false } = {}) {
    if (!activeRunCard) return;
    if (error) {
      setRunPhase("error");
      activeRunCard = null;
      activeRunMeta = null;
      return;
    }
    const card = activeRunCard;
    setRunPhase("done");
    activeRunCard = null;
    activeRunMeta = null;
    setTimeout(() => { try { card.remove(); } catch {} }, 650);
  }

  function projectChoiceMessage(focusResolution) {
    const candidates = Array.isArray(focusResolution && focusResolution.candidates)
      ? focusResolution.candidates : [];
    const names = candidates
      .map((t) => `${t.name || t.record_id} (${t.record_id})`)
      .join(", ");
    return names
      ? `Which project should I use for that update? I can scope it to: ${names}. Say the project name and I'll ground the scan/update there.`
      : "Which project should I use for that update? Say the project name and I'll ground the scan/update there.";
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }

  // A github-only scan request: consented + run inline (vs a sessions scan, which
  // opens the consent-first self-report modal). Kept as a helper because the card's
  // copy + CTA + routing all branch on it.
  function isGithubScan(a) {
    return a.action === "request_scan" && a.sources.includes("github") && !a.sources.includes("sessions");
  }

  // A one-line, human-readable summary of a proposed action for the review card.
  function summarizeAction(a) {
    if (a.action === "propose_profile_update") {
      const fields = Object.keys(a.delta).join(", ");
      if (a.subject_type === "team") return `Propose update to the ${a.subject_record_id} project — ${fields}`;
      const who = a.origin && a.origin.is_self ? "your profile" : `${a.subject_record_id}’s profile`;
      return `Propose update to ${who} — ${fields}`;
    }
    if (a.action === "propose_connection") return `Suggest connection — ${a.from_record_id} ↔ ${a.to_record_id}`;
    if (a.action === "file_contest") return `Flag ${a.subject_record_id}’s card — ${a.contest_kind.replace(/_/g, " ")}`;
    if (a.action === "request_scan") {
      if (isGithubScan(a)) {
        const where = activeFocus && activeFocus.repos && activeFocus.repos.length ? ` for ${activeFocus.teamName}` : "";
        return `Check your GitHub${where} to ground this — uses your own gh login (private repos read only for a linked project); only a scrubbed digest is used`;
      }
      return `Read your ${a.sources.join(" + ")} to refresh your profile`;
    }
    return a.action;
  }

  // Execute ONE member-approved action against the existing gated write doors.
  // Returns { ok, error }. Provenance rides from the action's own origin (stamped
  // app-side at parse time), never re-derived from the model.
  async function routeAction(a) {
    try {
      if (a.action === "propose_profile_update") {
        const o = a.origin || {};
        const res = await saveProfileProposal(a.subject_record_id, a.delta, {
          proposerRecordId: o.proposer_record_id,
          proposerClaimHash: o.proposer_claim_hash,
          rationale: a.rationale,
          sourceKinds: ["cohort_chat"],
          subjectType: a.subject_type || "person", // team ⇒ award-evidence whitelist, pending
        });
        // A self-edit auto-approves (live on next refresh) — emit a feed signal so
        // it shows in the activity timeline. A third-party proposal stays pending;
        // the daily review surfaces it, so we don't broadcast it as applied.
        if (res && res.ok && o.is_self) { try { emitSelfReport(a.subject_record_id, Object.keys(a.delta)); } catch {} }
        return res;
      }
      if (a.action === "propose_connection") {
        emitConnection({ fromId: a.from_record_id, toId: a.to_record_id, reason: a.reason });
        return { ok: true };
      }
      if (a.action === "file_contest") {
        const res = await submitContest({
          subjectId: a.subject_record_id, contestKind: a.contest_kind,
          note: a.note, cardKind: a.card_kind, cardId: a.card_id,
        });
        if (res && res.ok) emitContest({ subjectId: a.subject_record_id, contestKind: a.contest_kind, cardKind: a.card_kind, cardId: a.card_id });
        return res || { ok: false, error: "contest_failed" };
      }
      if (a.action === "request_scan") {
        // A github scan the member just approved: run it (private-preferred, scoped)
        // and re-ask once. A sessions scan opens the consent-first self-report modal.
        if (isGithubScan(a)) {
          if (toolRound >= MAX_TOOL_ROUNDS) return { ok: false, error: "already checked this turn" };
          void runGithubFollowup();
          return { ok: true };
        }
        let surface = null; try { surface = await getCohortSurface(); } catch {}
        const me = resolveMyPerson(surface);
        if (!me) return { ok: false, error: "claim your profile first" };
        const ok = handToSelfReport(me);
        return ok ? { ok: true } : { ok: false, error: "mirror unavailable" };
      }
      return { ok: false, error: "unknown_action" };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Is this action a self-edit that auto-applies (vs queued for the daily review)?
  function isSelfApply(a) {
    return a.action === "propose_profile_update" && a.origin && a.origin.is_self;
  }
  // The CTA + the in-flight + the success line, tuned per action so a self-edit
  // reads as a direct "apply" and a proposal about someone else reads as "propose".
  function ctaLabel(a) {
    if (a.action === "request_scan") return isGithubScan(a) ? "Check my GitHub →" : "Choose what to share →";
    if (isSelfApply(a)) return "Apply";
    return "Propose";
  }
  function pendingLabel(a) {
    if (a.action === "request_scan") return isGithubScan(a) ? "checking…" : "opening…";
    return isSelfApply(a) ? "applying…" : "sending…";
  }
  function successMsg(a) {
    if (a.action === "request_scan") return isGithubScan(a) ? "checking your GitHub…" : "opened — pick what to share.";
    if (a.action === "propose_profile_update") return isSelfApply(a)
      ? "✓ updated — live on the next refresh."
      : a.subject_type === "team"
        ? "sent — queued for review (a project update)."
        : "sent — queued for the daily review (it’s about someone else).";
    if (a.action === "propose_connection") return "✓ suggested — added to the activity feed.";
    if (a.action === "file_contest") return "✓ flagged — it’ll be reviewed.";
    return "done.";
  }

  // Render an approve/dismiss card per proposed action. Nothing writes until the
  // member clicks the CTA (request_scan re-asks its own per-source consent).
  function renderActionReview(actions) {
    const reviewable = (actions || []).filter((a) =>
      ["propose_profile_update", "propose_connection", "file_contest", "request_scan"].includes(a.action));
    if (!reviewable.length) return;
    for (const a of reviewable) {
      const card = document.createElement("div");
      card.className = "cc-card";
      const tag = isSelfApply(a) ? "applies now"
        : a.action === "request_scan" ? "needs your ok"
        : "queued for review";
      card.innerHTML = `
        <div class="cc-card-eyebrow">${esc(tag)}</div>
        <div class="cc-card-body">${esc(summarizeAction(a))}</div>
        <div class="cc-card-actions">
          <button type="button" class="btn ds-ghost" data-cc-dismiss>Dismiss</button>
          <button type="button" class="btn ds-primary" data-cc-approve>${esc(ctaLabel(a))}</button>
        </div>
        <div class="cc-card-status" hidden></div>`;
      const approve = card.querySelector("[data-cc-approve]");
      const dismiss = card.querySelector("[data-cc-dismiss]");
      const stat = card.querySelector(".cc-card-status");
      dismiss.addEventListener("click", () => card.remove());
      approve.addEventListener("click", async () => {
        approve.disabled = true; dismiss.disabled = true;
        stat.hidden = false; stat.textContent = pendingLabel(a);
        const res = await routeAction(a);
        if (res && res.ok) {
          stat.textContent = successMsg(a);
          stat.className = "cc-card-status is-ok";
          card.classList.add("is-done");
        } else {
          stat.textContent = (res && res.error) ? `couldn’t apply: ${res.error}` : "couldn’t apply.";
          stat.className = "cc-card-status is-error";
          approve.disabled = false; dismiss.disabled = false;
        }
      });
      log.appendChild(card);
    }
    log.scrollTop = log.scrollHeight;
  }

  // The first-run mirror offer (and /mirror) renders a small card with the offer
  // copy + a primary CTA that opens the consent-first self-report modal.
  function renderMirrorOffer(copy) {
    const card = document.createElement("div");
    card.className = "cc-card is-offer";
    const primary = copy.primary
      ? `<button type="button" class="btn ds-primary" data-cc-offer-go>${esc(copy.primary)}</button>` : "";
    card.innerHTML = `
      <div class="cc-card-eyebrow">${esc(copy.eyebrow)}</div>
      <div class="cc-card-body">${esc(copy.body)}</div>
      <div class="cc-card-actions">
        <button type="button" class="btn ds-ghost" data-cc-offer-dismiss>${esc(copy.secondary || "Not now")}</button>
        ${primary}
      </div>`;
    card.querySelector("[data-cc-offer-dismiss]").addEventListener("click", () => card.remove());
    const go = card.querySelector("[data-cc-offer-go]");
    if (go) go.addEventListener("click", async () => {
      let surface = null; try { surface = await getCohortSurface(); } catch {}
      const me = resolveMyPerson(surface);
      if (me) handToSelfReport(me);
      card.remove();
    });
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  }

  function openSettings() {
    settingsEl.hidden = false;
    settingsEl.setAttribute("aria-hidden", "false");
    settingsStat.textContent = "";
    settingsStat.className = "cohort-chat-settings-status";
    refreshReadiness();
    setTimeout(() => cmdInput.focus(), 60);
  }
  function closeSettings() {
    settingsEl.hidden = true;
    settingsEl.setAttribute("aria-hidden", "true");
  }

  function finishRun(label, failMsg) {
    clearInterval(elapsedTimer); elapsedTimer = null;
    setStatus(failMsg ? "error" : "idle", label || "idle");
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    let parsed = null;
    if (activeBubbleBody) {
      const finalText = activeStream ? activeStream.finalText() : "";
      if (finalText) {
        // The text typed out live; now read any proposed actions out of the full
        // text and show prose WITHOUT the raw json block (the stream already hides it).
        try { parsed = parseChatActions(finalText, pendingActionCtx || {}); } catch { parsed = null; }
        let display = (activeStream && activeStream.display()) || stripActionBlock(finalText);
        // If the model spoke only through ask/note actions, surface their text.
        if (!display && parsed && parsed.actions.length) {
          const said = parsed.actions.find((a) => a.action === "ask" || a.action === "note");
          if (said) display = said.question || said.text || "";
        }
        activeBubbleBody.hidden = false;
        activeBubbleBody.textContent = display || finalText;
        history.push({ role: "assistant", content: display || finalText });
      } else {
        // No answer — show the diagnostic (the CLI's own stderr if we have it).
        activeBubbleBody.hidden = false;
        activeBubbleBody.textContent = failMsg || diagnoseFailure();
        activeBubbleBody.classList.add("is-error");
      }
    }
    clearRunCard({ error: !!failMsg || !!(activeBubbleBody && activeBubbleBody.classList.contains("is-error")) });
    if (failMsg) setPreMsg(failMsg, "error");
    activeBubbleBody = null;
    activeStream = null;
    stderrBuffer = "";
    if (outputDispose) { outputDispose(); outputDispose = null; }
    if (statusDispose) { statusDispose(); statusDispose = null; }
    // Ready for the next prompt — re-focus the input so a follow-up is one keystroke
    // away (history carries, so it stays in context).
    setTimeout(() => { try { input.focus(); } catch {} }, 30);
    if (parsed && parsed.actions.length && !failMsg) {
      // Every proposed action becomes a review card the member must click — nothing
      // reads or writes on its own. A GitHub scan in particular uses the member's own
      // gh login (private repos included), so it is gated behind an explicit click
      // like every other action, never auto-run.
      renderActionReview(parsed.actions);
    }
  }

  async function send(e) {
    if (e) e.preventDefault();
    const q = (input.value || "").trim();
    if (!q) return;
    setPreMsg("");

    // `/mirror` is a command, not a question: route into the consent-first
    // self-report modal and never send it to the CLI (or pollute history).
    if (parseMirrorCommand(q)) {
      input.value = ""; autosize();
      appendBubble("user", q);
      let surf = null; try { surf = await getCohortSurface(); } catch {}
      const me = resolveMyPerson(surf);
      if (me && handToSelfReport(me)) appendBubble("assistant", "Opening your mirror — pick what I may read.");
      else appendBubble("assistant", me ? "The mirror isn’t available right now." : "Claim your profile first, then say /mirror.");
      return;
    }

    appendBubble("user", q);
    history.push({ role: "user", content: q });
    input.value = "";
    autosize();

    let surface = null;
    try { surface = await getCohortSurface(); } catch {}
    if (!surface) { setPreMsg("cohort data isn't loaded yet — try again in a moment.", "error"); return; }

    // Agent mode: the prompt carries the action contract so the model MAY propose
    // changes; pendingActionCtx stamps provenance + bounds the parse to real records.
    lastQuestion = q;
    toolRound = 0;
    pendingActionCtx = buildActionCtx(surface);
    // Resolve the project in hand (explicit pick → named-in-chat → primary team), so
    // the prompt scopes the answer + any team proposal to it and a github scan only
    // reads that project's repos. Never pull in unrelated work.
    activeFocusResolution = resolveChatFocus({ surface, identity: getIdentity(), selectedTeamId, mentioned: q });
    const route = classifyChatIntent(q);
    if (needsProjectConfirmation(route, activeFocusResolution)) {
      activeFocus = null;
      const msg = projectChoiceMessage(activeFocusResolution);
      appendBubble("assistant", msg);
      history.push({ role: "assistant", content: msg });
      setStatus("idle", "idle");
      return;
    }
    activeFocus = activeFocusResolution.focus;
    runTurn(buildChatPrompt({
      surface,
      history: history.slice(0, -1),
      question: q,
      agent: true,
      focus: activeFocus,
      focusResolution: activeFocusResolution,
      route,
    }), { focus: activeFocus, focusResolution: activeFocusResolution, route });
  }

  // Spawn ONE agent turn for a prebuilt prompt: stream stdout into a fresh bubble,
  // finish (parse + review) on exit. Reused by send() and the bounded tool loop.
  async function runTurn(prompt, meta = {}) {
    const requestId = `chat_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    currentRequestId = requestId;

    renderRunCard(meta);
    activeBubbleBody = appendBubble("assistant", "");
    activeBubbleBody.hidden = true;
    activeBubbleBody.classList.add("is-streaming");
    activeStream = createChatStream();
    setStatus("running", "thinking…");
    sendBtn.hidden = true;
    stopBtn.hidden = false;

    // Live elapsed clock so the wait is acknowledged: "thinking… 4s" before the
    // first token, "writing… 9s" once text starts arriving.
    const started = Date.now();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      const phase = runPhaseForElapsed(secs, activeStream && activeStream.phase());
      setRunPhase(phase.id, secs);
      setStatus("running", `${phase.label}... ${secs}s`);
    }, 500);

    if (outputDispose) outputDispose();
    if (statusDispose) statusDispose();
    outputDispose = window.api.onCohortChatOutput((p) => {
      if (p.requestId !== currentRequestId) return;
      if (p.stream === "stderr") { stderrBuffer += p.chunk; return; }
      if (!activeStream) return;
      activeStream.push(p.chunk);
      if (activeBubbleBody) {
        const disp = activeStream.display();
        if (disp) {
          activeBubbleBody.hidden = false;
          activeBubbleBody.textContent = disp; // type it out as deltas arrive
          const secs = Math.round((Date.now() - started) / 1000);
          setRunPhase("writing", secs);
        }
        if (isPinnedToBottom()) log.scrollTop = log.scrollHeight;
      }
    });
    statusDispose = window.api.onCohortChatStatus((s) => {
      if (s.state !== "idle") return;
      if (activeBubbleBody) activeBubbleBody.classList.remove("is-streaming");
      if (s.exitCode === 0 || (activeStream && activeStream.finalText())) {
        finishRun(`done · ${Math.round((s.durationMs || 0) / 1000)}s`);
      } else if (s.signal === "SIGTERM" || s.signal === "SIGKILL") {
        finishRun("stopped");
      } else {
        finishRun(`exited code=${s.exitCode}`);
        setPreMsg("the local AI exited without output — check the command in settings ⚙", "error");
      }
    });

    try {
      const res = await window.api.cohortChatStart({ requestId, prompt });
      if (!res || !res.ok) {
        const msg = res?.detail || res?.reason || "failed to start local AI";
        clearInterval(elapsedTimer); elapsedTimer = null;
        if (activeBubbleBody) activeBubbleBody.classList.remove("is-streaming");
        if (activeBubbleBody) {
          activeBubbleBody.hidden = false;
          activeBubbleBody.textContent = msg;
          activeBubbleBody.classList.add("is-error");
        }
        clearRunCard({ error: true });
        setStatus("error", "failed");
        setPreMsg(msg, "error");
        sendBtn.hidden = false;
        stopBtn.hidden = true;
      }
    } catch (err) {
      const msg = `start threw: ${err.message}`;
      clearInterval(elapsedTimer); elapsedTimer = null;
      if (activeBubbleBody) {
        activeBubbleBody.classList.remove("is-streaming");
        activeBubbleBody.hidden = false;
        activeBubbleBody.textContent = msg;
        activeBubbleBody.classList.add("is-error");
      }
      clearRunCard({ error: true });
      setStatus("error", "failed");
      setPreMsg(msg, "error");
      sendBtn.hidden = false;
      stopBtn.hidden = true;
    }
  }

  // The member approved a GitHub scan (via its review card). Ground the answer in
  // their real recent work, then re-ask once. PRIVATE repos are read only when the
  // focused project has a LINKED repo to scope to — an unscoped private read could
  // pull in unrelated private work, so with no repo link we use the PUBLIC events
  // fetch instead. Either way only a SCRUBBED, repo-scoped digest (commit lines +
  // counts, never diffs/secrets) enters the prompt; dataMode stays public — it's a
  // scrubbed digest of the member's own work, drafted by their own model.
  async function runGithubFollowup() {
    if (toolRound >= MAX_TOOL_ROUNDS) return;
    let surface = null; try { surface = await getCohortSurface(); } catch {}
    const me = resolveMyPerson(surface);
    const handle = me ? resolvePersonHandle(me) : "";
    // We only have a scope when the focused project has at least one linked repo.
    const repos = activeFocus && activeFocus.repos && activeFocus.repos.length ? activeFocus.repos : null;
    const scopeNote = repos ? ` (scoped to ${activeFocus.teamName})` : "";
    appendBubble("assistant", `Checking your GitHub${scopeNote}…`);
    let digest = "";
    let priv = false;
    let privScanned = false; // the authenticated scan actually ran (vs gh missing/unauthed)
    // Private path only when we can scope it; uses the member's OWN gh login and the
    // SAME pure scrubber as the public path. `r.login` is the account actually queried.
    if (repos) {
      try {
        const r = window.api.scanPrivateGithub ? await window.api.scanPrivateGithub({}) : null;
        if (r && r.ok && Array.isArray(r.events)) {
          privScanned = true;
          priv = true;
          digest = digestFromEvents(r.login || handle, summarizeEvents(r.events, { repos }), { sourceLabel: "recent events (incl. private)" });
        }
      } catch {}
    }
    // Public fallback only when the private scan didn't actually run (gh missing/unauthed).
    // If it ran but found nothing on the focused repos, re-fetching public is pointless.
    if (!digest && !privScanned) {
      if (!handle) { appendBubble("assistant", "I don’t see a GitHub handle on your profile to check."); return; }
      try { const r = await scanGithubActivity(handle, { repos: repos || undefined }); digest = (r && r.digest) || ""; } catch {}
    }
    if (!digest) {
      appendBubble("assistant", repos
        ? `No recent GitHub activity on ${activeFocus.teamName} to ground that in.`
        : "No recent public GitHub activity to ground that in.");
      return;
    }
    toolRound += 1;
    pendingActionCtx = buildActionCtx(surface);
    runTurn(buildChatPrompt({
      surface, history: history.slice(-6), question: lastQuestion, agent: true, focus: activeFocus, focusResolution: activeFocusResolution,
      toolResults: `GITHUB ACTIVITY${scopeNote} (${priv ? "incl. private — scrubbed digest" : "public"}):\n${digest}`,
    }), { focus: activeFocus, focusResolution: activeFocusResolution, route: classifyChatIntent(lastQuestion) });
  }

  async function stop() { try { await window.api.cohortChatStop(); } catch {} }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  }

  panel.querySelectorAll("[data-cohort-chat-close]").forEach((el) => el.addEventListener("click", close));
  // Click an example prompt to drop it into the input (delightful discovery of the
  // agentic verbs). Submitting `/mirror` etc. then flows through send() as normal.
  panel.querySelectorAll("[data-cc-eg]").forEach((el) => el.addEventListener("click", () => {
    input.value = el.textContent.trim();
    autosize();
    input.focus();
  }));
  form.addEventListener("submit", send);
  stopBtn.addEventListener("click", stop);
  settingsBtn.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  saveBtn.addEventListener("click", async () => {
    try {
      const res = await window.api.setCohortChatConfig({ chatCmd: cmdInput.value.trim() });
      if (res && res.ok) {
        settingsStat.textContent = "saved.";
        settingsStat.className = "cohort-chat-settings-status is-saved";
        setTimeout(closeSettings, 600);
        refreshReadiness();
      } else {
        settingsStat.textContent = "save failed";
        settingsStat.className = "cohort-chat-settings-status is-error";
      }
    } catch (e) {
      settingsStat.textContent = `save failed: ${e.message}`;
      settingsStat.className = "cohort-chat-settings-status is-error";
    }
  });

  return {
    open,
    close,
    openSettings,
    isOpen: () => !panel.hidden,
    notice(text) {
      open();
      appendBubble("assistant", text);
    },
  };
}

function getController() {
  if (!controller) controller = createController();
  return controller;
}

async function openSelfReportForMe({ autoRunPrevious = false } = {}) {
  let surface = null;
  try { surface = await getCohortSurface(); } catch {}
  const me = resolveMyPerson(surface);
  if (!me) {
    const c = getController();
    if (c) c.notice("Claim your profile first, then I can sync updates against the right cohort record.");
    return false;
  }
  const selfReport = await import("./self-report.js");
  await selfReport.openSelfReport({ person: me, autoRunPrevious });
  return true;
}

export async function openCohortChat() {
  await warmCohortChat();
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.open();
}

export async function openCohortChatSettings() {
  await warmCohortChat();
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.open();
  c.openSettings();
}

export async function openCohortMirror() {
  await warmCohortChat();
  await openSelfReportForMe({ autoRunPrevious: false });
}

export async function openCohortUpdates() {
  await warmCohortChat();
  await openSelfReportForMe({ autoRunPrevious: true });
}

// Toggle for the corner launcher: open when closed, close when open.
export async function toggleCohortChat() {
  await warmCohortChat();
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.isOpen() ? c.close() : c.open();
}
