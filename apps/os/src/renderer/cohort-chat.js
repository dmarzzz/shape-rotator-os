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
import { savePrivateContactEmail } from "./private-contact-submit.mjs";
import { readSupabaseConfig } from "./supabase-config.mjs";
import { loadCalendarIngressConfig } from "./calendar-ingress.mjs";
import { emitConnection, emitContest, emitSelfReport } from "./cohort-emit.mjs";
import { submitContest } from "./supabase-contest.mjs";
import { scanGithubActivity, resolvePersonHandle, summarizeEvents, digestFromEvents } from "./gh-self-report.mjs";

let stylesheetPromise = null;
let controller = null;

const FALLBACK_TRANSCRIPT_TYPES = [
  { key: "weekly_standup", label: "Weekly standup", routePath: "raw_transcripts/weekly_standup", maxTier: "T2", cohortMode: "aggregate_only", publicAllowed: false },
  { key: "office_hours", label: "Office hours", routePath: "raw_transcripts/office_hours", maxTier: "T2", cohortMode: "distilled_readout", publicAllowed: false },
  { key: "salon", label: "Salon", routePath: "raw_transcripts/salon", maxTier: "T3", cohortMode: "distilled_readout", publicAllowed: true },
  { key: "rd_jam", label: "R&D / jam", routePath: "raw_transcripts/rd_jam", maxTier: "T2", cohortMode: "team_call_required", publicAllowed: false },
  { key: "demo_presentation", label: "Demo / presentation", routePath: "raw_transcripts/demo_presentation", maxTier: "T3", cohortMode: "distilled_readout", publicAllowed: true },
  { key: "private_1on1", label: "Private 1:1", routePath: "do_not_publish/private_1on1", maxTier: "T1", cohortMode: "never", publicAllowed: false },
  { key: "user_interview", label: "User interview", routePath: "raw_transcripts/user_interview", maxTier: "T2", cohortMode: "aggregate_only", publicAllowed: false },
  { key: "planning_strategy", label: "Planning / strategy", routePath: "do_not_publish/planning_strategy", maxTier: "T1", cohortMode: "never", publicAllowed: false },
  { key: "leadership_meeting", label: "Leadership meeting", routePath: "do_not_publish/leadership_meeting", maxTier: "T1", cohortMode: "never", publicAllowed: false },
];

const FALLBACK_TRANSCRIPT_CONFIDENCE = [
  { key: "sure", label: "Sure" },
  { key: "best_guess", label: "Best guess" },
  { key: "needs_review", label: "Needs review" },
];

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
  const card  = panel ? panel.querySelector(".cohort-chat-card") : null;
  const tabsEl = panel ? panel.querySelector(".cc-tabs") : null;
  const searchPane = panel ? panel.querySelector("#cc-pane-search") : null;
  const syncPane   = panel ? panel.querySelector("#cc-pane-sync") : null;
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
    // NB: the html.cohort-chat-open class (which drives the gutter + panel) is
    // owned by setDocked() now — it must be toggled with precise timing relative
    // to the window resize so the page doesn't shift. This only does dial state.
    const dial = document.getElementById("cohort-chat-dial");
    if (!dial) return;
    dial.classList.toggle("is-open", isOpen);
    dial.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  const CHAT_ONBOARDED_KEY = "srwk:chat_onboarded_v1";

  // Open/close the dock. The OS window grows to the RIGHT so the panel is ADDED
  // space, not stolen from the content. The catch: the window resize is async and
  // can't be frame-locked to the CSS gutter, which made the page visibly shift.
  // Fix: freeze the page's content width with an explicit body width WHILE the
  // window resizes, then swap that freeze for the real gutter (html.cohort-chat-
  // open) in a single frame — net-zero, so the existing page never moves. The
  // panel has 0 width until the class is on, so it only appears once the window
  // is already wide. Falls back to a plain in-window reflow if the dock IPC isn't
  // available (or the window is maximized and main couldn't grow it).
  const _html = document.documentElement;
  function _dockW() {
    try { return parseInt(getComputedStyle(_html).getPropertyValue("--cc-dock-w-open"), 10) || 0; } catch { return 0; }
  }
  async function setDocked(on) {
    const dock = _dockW();
    const canGrow = !!(window.api && window.api.cohortChatDock && dock);
    if (on) {
      if (!canGrow) { _html.classList.add("cohort-chat-open"); return; }
      document.body.style.width = window.innerWidth + "px";          // freeze content at its current width
      try { await window.api.cohortChatDock(true, dock); } catch {}  // grow the window to the right
      requestAnimationFrame(() => {
        _html.classList.add("cohort-chat-open");                     // real gutter (numerically == the freeze)
        document.body.style.width = "";                              // release in the SAME frame → no shift
      });
    } else {
      if (!canGrow) { _html.classList.remove("cohort-chat-open"); return; }
      document.body.style.width = Math.max(0, window.innerWidth - dock) + "px"; // freeze at the undocked width
      _html.classList.remove("cohort-chat-open");                    // drop gutter (body frozen → no widen)
      try { await window.api.cohortChatDock(false, 0); } catch {}    // shrink the window back
      requestAnimationFrame(() => { document.body.style.width = ""; });
    }
  }

  function open() {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    setChatView(lastView);  // return to the view you collapsed from (lastView starts "ask").
                            // Re-asserting the SAME view skips setChatView's leaving-sync
                            // teardown, so a self-report still running in the background survives.
    syncDial(true);  // dial state only
    setDocked(true);  // grows the window + opens the dock (owns html.cohort-chat-open)
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
    // No local AI connected → show ONLY the setup card: hide the composer so the
    // panel isn't a row of inputs/prompts that silently do nothing. Restored the
    // moment a re-check finds a working CLI.
    if (form) form.hidden = !ready;
    if (tabsEl) tabsEl.hidden = !ready;   // gate the tabs too: not connected → only the connect prompt
    log.querySelectorAll(".cc-card.is-onboard").forEach((el) => el.remove()); // no dupes across re-opens
    if (!ready) {
      // The connect card mounts into the chat log, which the search/sync/transcript
      // views hide via CSS — and we've just hidden the tabs, so the user couldn't
      // switch back. Force the ask view so the only way to connect the AI stays
      // visible when reopening from a non-ask tab.
      setChatView("ask");
      renderOnboarding({ ready: false });
      return true;
    }
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
      card.querySelector("[data-cc-onboard-recheck]").addEventListener("click", async () => { card.remove(); refreshReadiness(); await maybeOnboard(); syncWelcome(); });
    } else {
      card.innerHTML = `
        <div class="cc-card-eyebrow">runs on your own AI</div>
        <div class="cc-card-body">I run on your <b>${esc(detected)}</b> agent — no API key, on your machine. Ask about the cohort, or ask me to <b>update your profile</b>, <b>suggest a connection</b>, or <b>refresh from your recent work</b>. I draft; you approve.</div>
        <div class="cc-card-actions"><button type="button" class="btn ds-ghost" data-cc-onboard-dismiss>Got it</button></div>`;
      card.querySelector("[data-cc-onboard-dismiss]").addEventListener("click", () => { card.remove(); syncWelcome(); });
    }
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    syncWelcome();
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
  // Collapse, not destroy. Clicking « hides the panel and shrinks the window,
  // but leaves all in-panel work running in the background: a streaming chat
  // turn (its output listeners + the local-AI process stay alive), a self-report
  // scan, a transcript upload. Reopening returns you to the same view (see
  // open()) with the result waiting. We deliberately do NOT closeSelfReport()
  // here — that bumps runGen and would drop an in-flight scan's result.
  function close() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    syncDial(false);  // dial state only
    setDocked(false);  // shrinks the window back + closes the dock
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
    if (empty) empty.hidden = true;
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

  // The welcome (example prompts + info) belongs whenever the user hasn't asked
  // anything yet. We hide it — never destroy it — so switching tabs and coming
  // back to "ask" always restores it. A real message or the not-ready setup
  // card takes its place; the mirror offer sits alongside it.
  function syncWelcome() {
    if (!empty) return;
    empty.hidden = !!log.querySelector(".cc-msg, .cc-card.is-onboard");
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
    if (a.action === "submit_private_contact") {
      const details = [a.email, a.telegram].filter(Boolean).join(" · ");
      return `Save private contact for ${a.display_name || a.subject_record_id} — ${details}`;
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
      if (a.action === "submit_private_contact") {
        const o = a.origin || {};
        return savePrivateContactEmail({
          subjectRecordId: a.subject_record_id,
          email: a.email,
          telegram: a.telegram,
          displayName: a.display_name,
          note: a.note,
          proposerRecordId: o.proposer_record_id,
          proposerClaimHash: o.proposer_claim_hash,
          sourceKinds: ["cohort_chat_explicit"],
        });
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
    if (a.action === "submit_private_contact") return "Save privately";
    if (isSelfApply(a)) return "Apply";
    return "Propose";
  }
  function pendingLabel(a) {
    if (a.action === "request_scan") return isGithubScan(a) ? "checking…" : "opening…";
    if (a.action === "submit_private_contact") return "saving privately…";
    return isSelfApply(a) ? "applying…" : "sending…";
  }
  function successMsg(a) {
    if (a.action === "request_scan") return isGithubScan(a) ? "checking your GitHub…" : "opened — pick what to share.";
    if (a.action === "submit_private_contact") return "saved to the private contact intake.";
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
      ["propose_profile_update", "submit_private_contact", "propose_connection", "file_contest", "request_scan"].includes(a.action));
    if (!reviewable.length) return;
    for (const a of reviewable) {
      const card = document.createElement("div");
      card.className = "cc-card";
      const tag = isSelfApply(a) ? "applies now"
        : a.action === "submit_private_contact" ? "private contact"
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

  async function transcriptIntakeOptions() {
    try {
      const res = window.api && window.api.getTranscriptIntakeOptions
        ? await window.api.getTranscriptIntakeOptions()
        : null;
      if (res && res.ok && Array.isArray(res.sessionTypes) && res.sessionTypes.length) {
        return {
          sessionTypes: res.sessionTypes,
          confidenceOptions: Array.isArray(res.confidenceOptions) && res.confidenceOptions.length
            ? res.confidenceOptions
            : FALLBACK_TRANSCRIPT_CONFIDENCE,
        };
      }
    } catch {}
    return { sessionTypes: FALLBACK_TRANSCRIPT_TYPES, confidenceOptions: FALLBACK_TRANSCRIPT_CONFIDENCE };
  }

  function readTranscriptSupabaseConfig() {
    const base = readSupabaseConfig();
    const ingress = loadCalendarIngressConfig();
    return {
      supabaseUrl: ingress.supabaseUrl || base.url,
      supabaseAnonKey: ingress.supabaseAnonKey || base.anonKey,
      accessToken: ingress.accessToken || "",
      orgId: ingress.orgId || "",
      ingestArtifactsUrl: ingress.ingestArtifactsUrl || "",
    };
  }

  async function renderTranscriptUploadCard() {
    const { sessionTypes: types, confidenceOptions } = await transcriptIntakeOptions();
    const config = readTranscriptSupabaseConfig();
    // The transcript view hides the welcome via CSS (data-cc-view="transcript")
    // — don't destroy it, or it can't come back when you return to "ask".
    log.querySelectorAll(".cc-card.is-transcript-intake").forEach((el) => el.remove());

    const ACCEPTED_LABEL = "txt, md, csv, json, doc, docx, pdf, rtf";
    const fmtBytes = (n) => {
      const b = Number(n) || 0;
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
      return `${(b / 1024 / 1024).toFixed(1)} MB`;
    };
    const dropzoneEmptyHtml = `
      <span class="cc-upload-dz-inner">
        <svg class="cc-upload-dz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>
        <span class="cc-upload-dz-lede">Choose a transcript file — or drag it here</span>
        <span class="cc-upload-dz-hint">${ACCEPTED_LABEL}</span>
      </span>`;
    const dropzoneFileHtml = (f) => `
      <span class="cc-upload-file">
        <svg class="cc-upload-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
        <span class="cc-upload-file-meta">
          <span class="cc-upload-file-name">${esc(f.name)}</span>
          <span class="cc-upload-file-sub">${esc(fmtBytes(f.sizeBytes))} · ${esc((f.ext || "").replace(/^\./, "") || "file")}</span>
        </span>
        <span class="cc-upload-file-change">Change</span>
      </span>`;

    const card = document.createElement("div");
    card.className = "cc-card is-transcript-intake";
    card.innerHTML = `
      <div class="cc-card-eyebrow">add transcript</div>
      <button type="button" class="cc-upload-dropzone" data-cc-transcript-dropzone aria-label="choose a transcript file"></button>
      <div class="cc-upload-grid">
        <label class="cc-upload-field">
          <span>type</span>
          <select class="cc-upload-input" data-cc-transcript-type>
            <option value="">Choose transcript type</option>
            ${types.map((type) => `<option value="${esc(type.key)}">${esc(type.label || type.key)}${type.maxTier ? ` / ${esc(type.maxTier)}` : ""}</option>`).join("")}
          </select>
        </label>
        <label class="cc-upload-field">
          <span>confidence</span>
          <div class="cc-upload-slider">
            <div class="cc-upload-slider-ticks">
              ${confidenceOptions.map((opt, index) => `<span class="cc-upload-slider-tick${index === 0 ? " is-on" : ""}">${esc(opt.label || opt.key)}</span>`).join("")}
            </div>
            <input type="range" class="cc-upload-range" data-cc-transcript-confidence min="0" max="${Math.max(0, confidenceOptions.length - 1)}" step="1" value="0" aria-label="type confidence" />
          </div>
        </label>
        <label class="cc-upload-field">
          <span>date</span>
          <input class="cc-upload-input" data-cc-transcript-date type="date" />
        </label>
        <label class="cc-upload-field">
          <span>label</span>
          <input class="cc-upload-input" data-cc-transcript-label type="text" placeholder="session title or file label" autocomplete="off" spellcheck="false" />
        </label>
        <label class="cc-upload-field">
          <span>session id</span>
          <input class="cc-upload-input" data-cc-transcript-session type="text" placeholder="optional" autocomplete="off" spellcheck="false" />
        </label>
        <label class="cc-upload-field cc-upload-field-wide">
          <span>related</span>
          <input class="cc-upload-input" data-cc-transcript-related type="text" placeholder="project, person, topic" autocomplete="off" spellcheck="false" />
        </label>
      </div>
      <div class="cc-upload-route" data-cc-transcript-route></div>
      <details class="cc-upload-connection">
        <summary>Supabase</summary>
        <div class="cc-upload-grid is-connection">
          <label class="cc-upload-field">
            <span>org id</span>
            <input class="cc-upload-input" data-cc-transcript-org type="text" value="${esc(config.orgId || "")}" autocomplete="off" spellcheck="false" />
          </label>
          <label class="cc-upload-field">
            <span>access token</span>
            <input class="cc-upload-input" data-cc-transcript-token type="password" value="${esc(config.accessToken || "")}" autocomplete="off" spellcheck="false" />
          </label>
        </div>
      </details>
      <div class="cc-card-actions">
        <button type="button" class="btn ds-ghost" data-cc-transcript-cancel>Cancel</button>
        <button type="button" class="btn ds-primary" data-cc-transcript-submit disabled>Add transcript</button>
      </div>
      <div class="cc-card-status" data-cc-transcript-status hidden></div>`;

    const dropzone = card.querySelector("[data-cc-transcript-dropzone]");
    const select = card.querySelector("[data-cc-transcript-type]");
    const confidenceRange = card.querySelector("[data-cc-transcript-confidence]");
    const confidenceTicks = Array.from(card.querySelectorAll(".cc-upload-slider-tick"));
    const date = card.querySelector("[data-cc-transcript-date]");
    const label = card.querySelector("[data-cc-transcript-label]");
    const session = card.querySelector("[data-cc-transcript-session]");
    const related = card.querySelector("[data-cc-transcript-related]");
    const org = card.querySelector("[data-cc-transcript-org]");
    const token = card.querySelector("[data-cc-transcript-token]");
    const route = card.querySelector("[data-cc-transcript-route]");
    const submit = card.querySelector("[data-cc-transcript-submit]");
    const cancel = card.querySelector("[data-cc-transcript-cancel]");
    const stat = card.querySelector("[data-cc-transcript-status]");
    let confidence = confidenceOptions[0]?.key || "sure";
    let selectedFile = null;
    let busy = false;

    function setStatus(kind, text) {
      if (!text) { stat.hidden = true; stat.textContent = ""; return; }
      stat.hidden = false;
      stat.className = "cc-card-status" + (kind === "ok" ? " is-ok" : kind === "error" ? " is-error" : "");
      stat.textContent = text;
    }
    function renderDropzone() {
      dropzone.classList.toggle("has-file", !!selectedFile);
      dropzone.innerHTML = selectedFile ? dropzoneFileHtml(selectedFile) : dropzoneEmptyHtml;
    }
    function selectedType() {
      return types.find((type) => type.key === select.value) || null;
    }
    function routeBadges(type) {
      if (!type) return "";
      const badges = [
        type.maxTier ? `<span>${esc(type.maxTier)}</span>` : "",
        type.cohortMode ? `<span>${esc(String(type.cohortMode).replace(/_/g, " "))}</span>` : "",
        `<span>Drive queued</span>`,
      ].filter(Boolean).join("");
      return `
        <div class="cc-upload-route-line"><strong>${esc(type.routePath || "needs_calendar_match")}</strong></div>
        <div class="cc-upload-route-badges">${badges}</div>
        ${type.accessNote ? `<div class="cc-upload-route-note">${esc(type.accessNote)}</div>` : ""}`;
    }
    function syncUploadState() {
      const type = selectedType();
      submit.disabled = busy || !selectedFile || !type;
      route.innerHTML = routeBadges(type);
    }
    function setBusy(on) {
      busy = on;
      for (const el of [dropzone, select, confidenceRange, date, label, session, related, org, token, cancel]) {
        if (el) el.disabled = on;
      }
      syncUploadState();
    }
    function setFile(info) {
      selectedFile = info;
      renderDropzone();
      setStatus("", "");
      syncUploadState();
    }

    // File first: click the dropzone for the native picker, or drag a file onto
    // it. Both resolve to a real path that submit() hands straight to main.
    async function pickFile() {
      if (busy) return;
      if (!window.api || !window.api.pickTranscriptFile) { setStatus("error", "File picker is unavailable in this build."); return; }
      const info = await window.api.pickTranscriptFile();
      if (!info || info.reason === "canceled") return;
      if (info.ok) setFile(info);
      else setStatus("error", info.detail || "Couldn't use that file.");
    }
    async function dropFile(file) {
      if (busy || !file) return;
      const p = window.api && window.api.getDroppedFilePath ? window.api.getDroppedFilePath(file) : "";
      if (!p) { setStatus("error", "Couldn't read that file — use the browse button instead."); return; }
      const info = window.api && window.api.inspectTranscriptFile ? await window.api.inspectTranscriptFile(p) : null;
      if (info && info.ok) setFile(info);
      else setStatus("error", (info && info.detail) || `Unsupported file. Use ${ACCEPTED_LABEL}.`);
    }

    dropzone.addEventListener("click", pickFile);
    dropzone.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!busy) dropzone.classList.add("is-dragover"); });
    dropzone.addEventListener("dragleave", (ev) => { ev.preventDefault(); ev.stopPropagation(); dropzone.classList.remove("is-dragover"); });
    dropzone.addEventListener("drop", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      dropzone.classList.remove("is-dragover");
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      void dropFile(file);
    });

    select.addEventListener("change", syncUploadState);
    if (confidenceRange) {
      confidenceRange.addEventListener("input", () => {
        const idx = Math.min(confidenceOptions.length - 1, Math.max(0, parseInt(confidenceRange.value, 10) || 0));
        const opt = confidenceOptions[idx];
        confidence = opt ? opt.key : "sure";
        confidenceTicks.forEach((t, i) => t.classList.toggle("is-on", i === idx));
      });
    }
    // Date: default to today, and open the native calendar on click anywhere in
    // the field (not just the icon).
    if (date) {
      const d = new Date();
      const z = (n) => String(n).padStart(2, "0");
      date.value = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
      date.addEventListener("click", () => { try { date.showPicker(); } catch {} });
    }
    cancel.addEventListener("click", () => card.remove());
    submit.addEventListener("click", async () => {
      if (!selectedFile) { setStatus("error", "Choose a transcript file first."); return; }
      const type = selectedType();
      if (!type) { setStatus("error", "Choose a transcript type first."); return; }
      if (!window.api || !window.api.submitTranscriptIntake) { setStatus("error", "Transcript intake is unavailable in this build."); return; }
      setBusy(true);
      setStatus("", "uploading…");
      try {
        const currentConfig = readTranscriptSupabaseConfig();
        const res = await window.api.submitTranscriptIntake({
          filePath: selectedFile.filePath,
          sessionType: type.key,
          label: (label.value || "").trim(),
          declaredDate: (date.value || "").trim(),
          relatedText: (related.value || "").trim(),
          sessionId: (session.value || "").trim(),
          confidence,
          supabase: {
            ...currentConfig,
            orgId: (org.value || currentConfig.orgId || "").trim(),
            accessToken: (token.value || currentConfig.accessToken || "").trim(),
          },
        });
        if (res && res.ok) {
          setStatus("ok", res.processingQueued
            ? `queued for processing: ${res.storageRef || type.routePath || "transcript"}`
            : `saved to Supabase: ${res.needsSessionMatch ? "needs session match" : "Drive mirror queued"}`);
          card.classList.add("is-done");
          return;
        }
        const reason = res && (res.detail || res.reason);
        if (res && res.reason === "missing_supabase_config" && Array.isArray(res.missing)) {
          setStatus("error", `staged locally; Supabase needs ${res.missing.join(", ")}.`);
        } else if (res && res.reason === "canceled") {
          setStatus("", "");
        } else {
          setStatus("error", `intake failed: ${reason || "unknown error"}`);
        }
        setBusy(false);
      } catch (error) {
        setStatus("error", `intake failed: ${error?.message || error}`);
        setBusy(false);
      }
    });

    renderDropzone();
    syncUploadState();
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    setTimeout(() => { try { dropzone.focus(); } catch {} }, 30);
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
  // Top tabs: ask ⇄ transcript switch the panel body (via data-cc-view, see the
  // CSS); search opens the global overlay and leaves the view as-is.
  // All tabs are in-panel views now. ask/transcript use the chat log; search/
  // sync each mount their engine into a dedicated pane that data-cc-view
  // reveals (see cohort-chat.css). State is lazy-mounted on first entry.
  let searchMounted = false, searchCtl = null, selfReportMod = null, lastView = "ask";
  let syncMounted = false;   // sync pane is mounted + (maybe) running; re-selecting the tab must not restart the scan

  function setChatView(view) {
    // Leaving sync: stop + clear the in-panel self-report so a late scan
    // result can't write into a hidden pane (it bumps self-report's runGen).
    if (lastView === "sync" && lastView !== view) {
      try { selfReportMod && selfReportMod.closeSelfReport && selfReportMod.closeSelfReport(); } catch {}
      syncMounted = false;   // genuinely left sync → next entry re-mounts (collapse/reopen on the same view keeps it alive)
    }
    if (card) card.dataset.ccView = view;
    if (tabsEl) tabsEl.querySelectorAll(".cc-tab").forEach((t) => {
      const on = t.dataset.ccTab === view;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    // Returning to "ask" restores the welcome when nothing's been asked yet.
    if (view === "ask") syncWelcome();
    lastView = view;
  }

  async function mountSearchPane() {
    if (!searchPane) return;
    if (searchMounted && searchCtl) { try { searchCtl.focus && searchCtl.focus(); } catch {} return; }
    try { const m = await import("./find.js"); searchCtl = m.mountInline(searchPane); searchMounted = true; }
    catch (e) { console.warn("[cohort-chat] search mount failed:", e && e.message); }
  }

  function renderClaimPrompt(pane, kind) {
    pane.innerHTML = "";
    const d = document.createElement("div");
    d.className = "cc-pane-empty";
    d.textContent = kind === "sync"
      ? "Claim your profile first, then I can sync updates from your recent work."
      : "Claim your profile first to review your mirror.";
    pane.appendChild(d);
  }

  async function mountSelfReportPane(pane, kind, opts) {
    if (!pane) return;
    // Already mounted (and possibly mid-run) → re-selecting the tab keeps it, so a
    // one-click sync can't fire redundant local-AI synthesis runs that pile up
    // concurrent CLI processes. Mirrors mountSearchPane's guard.
    if (kind === "sync" && syncMounted) return;
    let surface = null;
    try { surface = await getCohortSurface(); } catch {}
    const me = resolveMyPerson(surface);
    if (!me) { renderClaimPrompt(pane, kind); return; }
    try {
      if (!selfReportMod) selfReportMod = await import("./self-report.js");
      selfReportMod.closeSelfReport();
      await selfReportMod.openSelfReport({ person: me, autoRunPrevious: !!(opts && opts.autoRunPrevious), mount: pane });
      if (kind === "sync") syncMounted = true;
    } catch (e) { console.warn("[cohort-chat] self-report mount failed:", e && e.message); }
  }

  if (tabsEl) tabsEl.querySelectorAll(".cc-tab").forEach((t) => t.addEventListener("click", () => {
    const tab = t.dataset.ccTab;
    setChatView(tab);
    if (tab === "transcript") void renderTranscriptUploadCard();
    else if (tab === "search") void mountSearchPane();
    else if (tab === "sync") void mountSelfReportPane(syncPane, "sync", { autoRunPrevious: true });
    else input.focus();
  }));

  // ── drag-to-resize the dock (clamped min/max, persisted) ──────────────────
  // Dragging the left-edge handle changes --cc-dock-w-open; the panel + gutter
  // follow it and the window resizes in lockstep (so content keeps its place).
  const DOCK_MIN = 360, DOCK_MAX = 720, DOCK_KEY = "srwk:cohort_dock_w";
  const clampDock = (w) => Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(w)));
  const applyDockWidth = (w) => document.documentElement.style.setProperty("--cc-dock-w-open", clampDock(w) + "px");
  (() => { let w = 0; try { w = parseInt(localStorage.getItem(DOCK_KEY), 10) || 0; } catch {} if (w) applyDockWidth(w); })();
  const resizeHandle = panel ? panel.querySelector(".cc-resize") : null;
  if (resizeHandle) {
    let dragging = false, startX = 0, startDock = 400, pendingDock = 400, rafId = 0;
    const pushResize = () => { rafId = 0; try { window.api && window.api.cohortChatResizeDock && window.api.cohortChatResizeDock(pendingDock); } catch {} };
    resizeHandle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startDock = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--cc-dock-w-open"), 10) || 400;
      pendingDock = startDock;
      document.body.classList.add("cc-resizing");
      try { resizeHandle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    resizeHandle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      pendingDock = clampDock(startDock + (startX - e.clientX));   // drag the line LEFT → wider panel
      applyDockWidth(pendingDock);
      if (!rafId) rafId = requestAnimationFrame(pushResize);       // at most one window resize per frame
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("cc-resizing");
      try { resizeHandle.releasePointerCapture(e.pointerId); } catch {}
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      pushResize();
      try { localStorage.setItem(DOCK_KEY, String(pendingDock)); } catch {}
    };
    resizeHandle.addEventListener("pointerup", endDrag);
    resizeHandle.addEventListener("pointercancel", endDrag);
  }

  form.addEventListener("submit", send);
  stopBtn.addEventListener("click", stop);
  // The cogwheel toggles the settings dropdown; clicking outside it (anywhere
  // but the menu or the cogwheel) dismisses it, like any dropdown.
  settingsBtn.addEventListener("click", () => { settingsEl.hidden ? openSettings() : closeSettings(); });
  settingsClose.addEventListener("click", closeSettings);
  document.addEventListener("mousedown", (e) => {
    if (settingsEl.hidden) return;
    if (e.target.closest("#cohort-chat-settings") || e.target.closest("#cohort-chat-settings-btn")) return;
    closeSettings();
  });
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
    showTranscriptUpload() {
      open();
      setChatView("transcript");
      void renderTranscriptUploadCard();
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

// Hard gate: every AI-backed action requires a connected local AI first. When
// none is connected we funnel to the chat panel, which shows ONLY the "set up
// your own AI" prompt (composer hidden) — so the user must connect before they
// can do anything else here. (Global search + the settings/connect path stay
// open; settings is HOW you connect.)
async function cohortAiReady() {
  try { const cfg = await window.api.getCohortChatConfig(); return !!(cfg && cfg.ready); }
  catch { return false; }
}

export async function openCohortUpdates() {
  await warmCohortChat();
  if (!(await cohortAiReady())) return openCohortChat();   // not connected → prompt to connect first
  await openSelfReportForMe({ autoRunPrevious: true });
}

export async function openCohortTranscriptUpload() {
  await warmCohortChat();
  if (!(await cohortAiReady())) return openCohortChat();   // not connected → prompt to connect first
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.showTranscriptUpload();
}

// Toggle for the corner launcher: open when closed, close when open.
export async function toggleCohortChat() {
  await warmCohortChat();
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.isOpen() ? c.close() : c.open();
}
