// self-report.js — the consent-first "update from my recent work" modal.
//
// The INPUT side of "Your Mirror": with explicit, per-source permission it scans
// the member's real signal (their LOCAL Claude/Codex sessions, kept on-machine;
// their GitHub activity, private only through their own gh login and scoped to a
// linked project repo) and drafts a profile update. The member
// reviews the proposed change and sends the whitelisted delta to Supabase. Own
// profile updates auto-approve server-side and are overlaid back into the live
// cohort surface. Nothing is scanned without opt-in; nothing is written without
// an explicit click.
//
// The synth brain (prompt + safe JSON parse/whitelist/merge) is self-report-synth.mjs;
// the local scan + local-CLI run happen in main (window.api.selfReport*).

import {
  SELF_REPORT_FIELDS,
  buildSelfReportPrompt,
  parseSelfReportDelta,
  sanitizeDelta,
  sanitizeUsefulness,
  mergeDelta,
  assessSelfReportCoverage,
} from "./self-report-synth.mjs";
import { loadStylesheetOnce } from "./stylesheet-loader.js";
import { scanGithubActivity, resolvePersonHandle, summarizeEvents, digestFromEvents } from "./gh-self-report.mjs";
import { saveSelfReportUpdate, saveProfileProposal } from "./supabase-self-report.mjs";
import { emitSelfReport } from "./cohort-emit.mjs";
import { getAppContext } from "./app-context.mjs";
import { getClaimTokenHash } from "./claim-token.mjs";
import { getCohortSurface, refreshCohortFromGithub } from "./cohort-source.js";
import { focusForTeam } from "./cohort-chat-focus.mjs";
import { sanitizeTeamFields } from "./cohort-chat-actions.mjs";
import {
  coerceAutoUpdateChoices,
  getAutoUpdateChoices,
  rememberAutoUpdateChoices,
} from "./self-report-autoupdate.mjs";
import {
  MANUAL_SELF_REPORT_QUESTIONS,
  buildManualAgentPrompt,
  buildManualSelfReportDelta,
  buildManualUsefulness,
  parseManualAgentDraft,
} from "./self-report-manual.mjs";

// Expose the entry on a global so the cohort-chat bot's opt-in flow can route into
// it: window.__srwkOpenSelfReport?.({ person, githubDigest }) — a graceful no-op
// until the chat + mirror branches merge. Mirrors the window.__srwkOpenProfile
// convention. (openSelfReport is a hoisted function declaration below.)
if (typeof window !== "undefined") window.__srwkOpenSelfReport = openSelfReport;

let stylesheetPromise = null;
function ensureStylesheet() {
  if (!stylesheetPromise) stylesheetPromise = loadStylesheetOnce("renderer/self-report.css");
  return stylesheetPromise;
}

const FIELD_LABELS = {
  comm_style: "communication style",
  contribute_interests: "contribution interests",
  now: "now",
  weekly_intention: "weekly intention",
  availability_pref: "availability",
  skills: "skills",
  skill_areas: "skill areas",
  seeking: "seeking",
  offering: "offering",
  go_to_them_for: "go to them for",
  recurring_themes: "recurring themes",
  working_style: "working style",
  best_contexts: "best contexts",
  prior_work: "prior work",
  traction: "traction",
  prior_shipping: "prior shipping",
  success_dimensions: "success dimensions",
  journey: "journey",
};
const SELF_REPORT_LOOKBACK_DAYS = 7;
const fieldLabel = (k) => FIELD_LABELS[k] || k;
const asText = (v) => {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") {
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return String(v == null ? "" : v);
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s == null ? "" : s);
  return d.innerHTML;
}

function teamFocusForPerson(person, surface) {
  if (!person || !person.team || !surface || !Array.isArray(surface.teams)) return null;
  const team = surface.teams.find((t) => t && String(t.record_id) === String(person.team));
  return focusForTeam(team, { person });
}

function compactText(value, max = 260) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trim()}...` : s;
}

function compactList(value, limit = 6) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return arr.map((item) => compactText(item, 180)).filter(Boolean).slice(0, limit);
}

function addDigestLine(lines, label, value, limit = 6) {
  if (Array.isArray(value)) {
    const list = compactList(value, limit);
    if (list.length) lines.push(`- ${label}: ${list.join("; ")}`);
    return;
  }
  const text = compactText(value);
  if (text) lines.push(`- ${label}: ${text}`);
}

function resolveSurfacePerson(person, surface) {
  const id = person && person.record_id ? String(person.record_id) : "";
  if (!id || !surface || !Array.isArray(surface.people)) return person;
  return surface.people.find((p) => p && String(p.record_id) === id) || person;
}

function resolveSurfaceTeam(person, surface) {
  const teamId = person && person.team ? String(person.team) : "";
  if (!teamId || !surface || !Array.isArray(surface.teams)) return null;
  return surface.teams.find((t) => t && String(t.record_id) === teamId) || null;
}

function eventMeta(ev) {
  const value = ev && ev.value && typeof ev.value === "object" ? ev.value : {};
  const bits = [];
  if (ev && ev.field) bits.push(`field ${ev.field}`);
  if (Array.isArray(value.fields) && value.fields.length) bits.push(`fields ${value.fields.slice(0, 8).join(", ")}`);
  if (value.mode) bits.push(`mode ${compactText(value.mode, 80)}`);
  if (value.timeline_anchor) bits.push(`anchor ${compactText(value.timeline_anchor, 80)}`);
  if (value.coverage_status) bits.push(`coverage ${compactText(value.coverage_status, 80)}`);
  if (Array.isArray(value.source_kinds) && value.source_kinds.length) bits.push(`sources ${value.source_kinds.slice(0, 8).join(", ")}`);
  if (Array.isArray(value.with_whom) && value.with_whom.length) bits.push(`with ${value.with_whom.slice(0, 6).join(", ")}`);
  return bits.join("; ");
}

function timelineLine(item) {
  const parts = [];
  if (item && item.date) parts.push(String(item.date).slice(0, 10));
  if (item && item.type) parts.push(String(item.type));
  if (item && item.title) parts.push(compactText(item.title, 90));
  const head = parts.filter(Boolean).join(" | ");
  const detail = compactText(item && item.detail, 180);
  return head ? `- ${head}${detail ? `: ${detail}` : ""}` : "";
}

function buildAppUnderstandingDigest(person, surface = null) {
  const current = resolveSurfacePerson(person, surface) || person || {};
  const team = resolveSurfaceTeam(current, surface);
  const focus = teamFocusForPerson(current, surface);
  const lines = [];
  lines.push(`Subject: ${compactText(current.name || current.record_id || "this member", 120)} (${compactText(current.record_id || "unknown", 120)})`);
  addDigestLine(lines, "current team", team ? `${team.name || team.record_id} (${team.record_id})` : current.team);
  addDigestLine(lines, "current comm_style", current.comm_style);
  addDigestLine(lines, "current contribute_interests", current.contribute_interests);
  addDigestLine(lines, "current now", current.now);
  addDigestLine(lines, "current weekly_intention", current.weekly_intention);
  addDigestLine(lines, "current availability_pref", current.availability_pref);
  addDigestLine(lines, "current skill_areas", current.skill_areas);
  addDigestLine(lines, "current skills", current.skills);
  addDigestLine(lines, "current seeking", current.seeking);
  addDigestLine(lines, "current offering", current.offering);
  addDigestLine(lines, "current go_to_them_for", current.go_to_them_for);
  addDigestLine(lines, "current recurring_themes", current.recurring_themes);
  addDigestLine(lines, "current working_style", current.working_style);
  addDigestLine(lines, "current best_contexts", current.best_contexts);
  addDigestLine(lines, "existing prior_work to preserve", current.prior_work);
  if (focus && Array.isArray(focus.repos) && focus.repos.length) addDigestLine(lines, "linked repo scope", focus.repos, 4);

  if (team) {
    addDigestLine(lines, "team focus", team.focus);
    addDigestLine(lines, "team now", team.now);
    addDigestLine(lines, "team traction", team.traction);
    addDigestLine(lines, "team prior_shipping", team.prior_shipping);
    addDigestLine(lines, "team seeking", team.seeking);
    addDigestLine(lines, "team offering", team.offering);
    if (team.journey && typeof team.journey === "object") {
      addDigestLine(lines, "team stage", team.journey.stage != null ? `stage ${team.journey.stage}; bottleneck ${team.journey.primary_bottleneck || "unknown"}; confidence ${team.journey.confidence || "unknown"}` : "");
      addDigestLine(lines, "team next milestone", team.journey.next_milestone);
    }
  }

  const ids = new Set([current.record_id, current.team, team && team.record_id].filter(Boolean).map(String));
  const events = Array.isArray(surface && surface.cohort_events) ? surface.cohort_events : [];
  const recentEvents = events
    .filter((ev) => ev && (ids.has(String(ev.record_id || "")) || ids.has(String(ev.actor || ""))))
    .slice(0, 6)
    .map((ev) => {
      const when = ev.created_at ? String(ev.created_at).slice(0, 10) : "recent";
      const meta = eventMeta(ev);
      return `- ${when} ${ev.event_type || "event"}${meta ? ` (${meta})` : ""}`;
    });
  if (recentEvents.length) lines.push("Recent app timeline/provenance signals:\n" + recentEvents.join("\n"));

  const whatsNew = Array.isArray(surface && surface.whats_new) ? surface.whats_new : [];
  const relevantNews = whatsNew
    .filter((item) => item && item.nav && ids.has(String(item.nav.recordId || "")))
    .slice(0, 5)
    .map((item) => `- ${String(item.date || "").slice(0, 10) || "recent"} ${compactText(item.kind || "update", 40)}: ${compactText(item.label || "", 120)}${item.meta ? ` (${compactText(item.meta, 120)})` : ""}`);
  if (relevantNews.length) lines.push("Relevant whats_new items:\n" + relevantNews.join("\n"));

  const personTimeline = surface && surface.person_timeline && current.record_id ? surface.person_timeline[current.record_id] : [];
  const teamTimeline = surface && surface.team_timeline && team && team.record_id ? surface.team_timeline[team.record_id] : [];
  const anchors = [...(Array.isArray(personTimeline) ? personTimeline : []), ...(Array.isArray(teamTimeline) ? teamTimeline : [])]
    .map(timelineLine)
    .filter(Boolean)
    .slice(0, 8);
  if (anchors.length) lines.push("Known timeline anchors (do not rewrite/backdate; use only to orient current update):\n" + anchors.join("\n"));

  return lines.join("\n").slice(0, 6000);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractSelfReportProposal(delta) {
  const src = isPlainObject(delta) ? delta : {};
  const personDelta = isPlainObject(src.person) ? src.person : {};
  const legacyPerson = {};
  for (const field of Object.keys(SELF_REPORT_FIELDS)) {
    if (field in src) legacyPerson[field] = src[field];
  }
  const teamDelta = isPlainObject(src.team)
    ? src.team
    : (isPlainObject(src.project) ? src.project : {});
  return {
    personDelta: { ...legacyPerson, ...personDelta },
    teamDelta,
    usefulness: sanitizeUsefulness(src.usefulness),
    question: typeof src.question === "string" ? src.question.trim() : "",
  };
}

function sameValue(a, b) {
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
  catch { return String(a ?? "") === String(b ?? ""); }
}

function cleanList(value) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return arr.map((item) => compactText(item, 180)).filter(Boolean);
}

function mergeUniqueList(existing, proposed, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const item of [...cleanList(existing), ...cleanList(proposed)]) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeTeamDelta(team = {}, cleanDelta = {}) {
  const merged = {};
  const changed = [];
  for (const [key, val] of Object.entries(cleanDelta || {})) {
    let nextVal = val;
    if (key === "prior_shipping") nextVal = mergeUniqueList(team ? team[key] : undefined, val);
    else if (key === "journey" && isPlainObject(val)) nextVal = { ...(team && isPlainObject(team.journey) ? team.journey : {}), ...val };
    if (!sameValue(team ? team[key] : undefined, nextVal)) {
      merged[key] = key === "journey" ? val : nextVal;
      changed.push(key);
    }
  }
  return { merged, changed };
}

function teamCoverageStatus(changed = []) {
  const set = new Set((Array.isArray(changed) ? changed : []).map(String));
  if (set.has("traction") && set.has("prior_shipping") && set.has("journey")) return "broad";
  if (set.size >= 2) return "focused";
  return set.size ? "thin" : "none";
}

const USEFULNESS_LABELS = {
  findability: "findability",
  collaboration: "collaboration",
  current_state: "current state",
  proof_history: "proof/history",
  project_evidence: "project evidence",
  timeline: "timeline",
  review_readiness: "review readiness",
};
const USEFULNESS_STATUS_LABELS = {
  improved: "improved",
  unchanged: "unchanged",
  needs_answer: "needs answer",
  no_evidence: "no evidence",
  queued_review: "queued review",
  auto_applied: "auto-applied",
  current_state_refresh: "current refresh",
};
const ACTION_LABELS = {
  ask_member: "ask member",
  queue_project_evidence: "queue project evidence",
  suggest_connections: "suggest connections",
  create_ask: "create ask",
  flag_stale_app_understanding: "flag stale understanding",
};

function buildUsefulnessReport(raw = {}, { changed = [], teamChanged = [], coverage = null, projectStatus = "none", hasQuestion = false } = {}) {
  const areas = { ...(raw && raw.areas ? raw.areas : {}) };
  const changedSet = new Set((Array.isArray(changed) ? changed : []).map(String));
  const teamSet = new Set((Array.isArray(teamChanged) ? teamChanged : []).map(String));
  const any = changedSet.size || teamSet.size;
  if (!areas.findability && ["skills", "skill_areas", "go_to_them_for", "recurring_themes", "best_contexts"].some((f) => changedSet.has(f))) areas.findability = "improved";
  if (!areas.collaboration && ["seeking", "offering", "contribute_interests", "comm_style", "availability_pref"].some((f) => changedSet.has(f))) areas.collaboration = "improved";
  if (!areas.current_state && ["now", "weekly_intention", "working_style"].some((f) => changedSet.has(f))) areas.current_state = "improved";
  if (!areas.proof_history && (changedSet.has("prior_work") || teamSet.has("prior_shipping"))) areas.proof_history = "improved";
  if (!areas.project_evidence && teamSet.size) areas.project_evidence = projectStatus === "broad" ? "queued_review" : "needs_answer";
  if (!areas.timeline && any) areas.timeline = "current_state_refresh";
  if (!areas.review_readiness && any) areas.review_readiness = teamSet.size ? "queued_review" : "auto_applied";
  if (coverage && coverage.missingEmptyDurableFields && coverage.missingEmptyDurableFields.length) {
    if (!areas.findability) areas.findability = "needs_answer";
    if (!areas.proof_history) areas.proof_history = "needs_answer";
  }
  const missing = Array.isArray(raw.missing_evidence) ? raw.missing_evidence.slice(0, 8) : [];
  const suggested = new Set(Array.isArray(raw.suggested_actions) ? raw.suggested_actions : []);
  if (hasQuestion) suggested.add("ask_member");
  if (teamSet.size) suggested.add("queue_project_evidence");
  if (areas.collaboration === "improved" || areas.findability === "improved") suggested.add("suggest_connections");
  return {
    areas,
    missing_evidence: missing,
    suggested_actions: [...suggested].slice(0, 6),
  };
}

function renderUsefulnessHtml(report) {
  const entries = Object.entries((report && report.areas) || {}).filter(([, status]) => status);
  const missing = Array.isArray(report && report.missing_evidence) ? report.missing_evidence : [];
  const actions = Array.isArray(report && report.suggested_actions) ? report.suggested_actions : [];
  if (!entries.length && !missing.length && !actions.length) return "";
  const areaHtml = entries.length ? `
    <div class="selfrep-health-grid">
      ${entries.map(([area, status]) => `<span><b>${esc(USEFULNESS_LABELS[area] || area)}</b>${esc(USEFULNESS_STATUS_LABELS[status] || status)}</span>`).join("")}
    </div>` : "";
  const missingHtml = missing.length ? `<p><b>missing evidence</b> ${esc(missing.join("; "))}</p>` : "";
  const actionsHtml = actions.length ? `<p><b>suggested actions</b> ${esc(actions.map((a) => ACTION_LABELS[a] || a).join(", "))}</p>` : "";
  return `
    <section class="selfrep-health">
      <h3>app usefulness</h3>
      ${areaHtml}
      ${missingHtml}
      ${actionsHtml}
    </section>`;
}

async function collectGithubDigest(person, githubFallback = "", { surface = null } = {}) {
  const handle = resolvePersonHandle(person);
  if (!surface) {
    try { surface = await getCohortSurface(); } catch {}
  }
  const focus = teamFocusForPerson(person, surface);
  const repos = focus && Array.isArray(focus.repos) && focus.repos.length ? focus.repos : null;
  const sourceNotes = [];
  let privateScanRan = false;

  if (repos && window.api?.scanPrivateGithub) {
    try {
      const privateScan = await window.api.scanPrivateGithub({ maxEvents: 100 });
      if (privateScan && privateScan.ok && Array.isArray(privateScan.events)) {
        privateScanRan = true;
        const summary = summarizeEvents(privateScan.events, { repos });
        const digest = digestFromEvents(
          privateScan.login || handle,
          summary,
          { sourceLabel: `recent events for ${focus.teamName} (incl. private via gh)` },
        );
        sourceNotes.push(`GitHub: checked ${plural(repos.length, "linked repo")} for ${focus.teamName} with your gh login.`);
        if (digest) return { digest, sourceKind: "github_private", sourceNotes };
        sourceNotes.push("GitHub: no recent events found on the linked repo scope.");
      } else if (privateScan && privateScan.reason) {
        sourceNotes.push(`GitHub: private gh scan unavailable (${privateScan.reason}); using public events if available.`);
      }
    } catch {
      sourceNotes.push("GitHub: private gh scan failed; using public events if available.");
    }
  } else if (repos) {
    sourceNotes.push("GitHub: linked repo found, but private gh scan is not available in this build.");
  }

  if (!privateScanRan) {
    if (handle) {
      const gh = await safeCall(() => scanGithubActivity(handle, { repos: repos || undefined }));
      if (gh && gh.ok && gh.digest) {
        sourceNotes.push(repos
          ? `GitHub: used public events scoped to ${focus.teamName}.`
          : "GitHub: used public events only.");
        return { digest: gh.digest, sourceKind: "github", sourceNotes };
      }
    }
    if (githubFallback && githubFallback.trim()) {
      sourceNotes.push("GitHub: used existing public profile signal fallback.");
      return { digest: githubFallback, sourceKind: "github", sourceNotes };
    }
  }

  if (githubFallback && githubFallback.trim()) {
    sourceNotes.push("GitHub: used existing public profile signal fallback.");
    return { digest: githubFallback, sourceKind: "github", sourceNotes };
  }

  return { digest: "", sourceKind: "", sourceNotes };
}

let host = null;
let inlineHost = false; // true when rendered into a provided container (the chat panel), not a body overlay
let busyTimer = null;
let runGen = 0; // bumped on close; a long async pass captures it and drops a stale result
function clearBusyTimer() { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } }
function onKey(e) { if (e.key === "Escape") closeSelfReport(); }

export function closeSelfReport() {
  runGen += 1;
  clearBusyTimer();
  if (host) {
    if (inlineHost) host.innerHTML = "";  // the panel owns the node — just clear it, never remove
    else host.remove();
    host = null;
  }
  inlineHost = false;
  document.removeEventListener("keydown", onKey);
}

// Pass `mount` to render INSIDE that element (the chat panel's sync/mirror view)
// instead of a full-screen body overlay — no backdrop, no global Escape (the
// panel owns close). All step renderers just set host.innerHTML, so they work
// unchanged either way.
export async function openSelfReport({ person, githubDigest = "", autoRunPrevious = false, sourceChoices = null, mount = null, mode = "" } = {}) {
  if (!person || !person.record_id) return;
  await ensureStylesheet();
  closeSelfReport();
  if (mount) {
    inlineHost = true;
    host = mount;
    host.innerHTML = "";
  } else {
    host = document.createElement("div");
    host.className = "selfrep-overlay";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    document.body.appendChild(host);
    document.addEventListener("keydown", onKey);
    // Click the backdrop (not the card) to dismiss.
    host.addEventListener("mousedown", (e) => { if (e.target === host) closeSelfReport(); });
  }
  if (mode === "manual") {
    await renderManualDraft(person);
    return;
  }
  const previous = coerceAutoUpdateChoices(sourceChoices) || getAutoUpdateChoices(person.record_id);
  if (autoRunPrevious && previous) {
    runSelfReport(person, {
      useSessions: previous.useSessions,
      useGithub: previous.useGithub,
      githubFallback: githubDigest,
    });
    return;
  }
  renderConsent(person, githubDigest);
}

function card(inner) {
  return `<div class="selfrep-card">${inner}</div>`;
}

// ── Step 1 — consent ────────────────────────────────────────────────────────
function renderConsent(person, githubFallback) {
  const handle = resolvePersonHandle(person);
  const hasGithub = !!handle || !!(githubFallback && githubFallback.trim());
  const remembered = getAutoUpdateChoices(person.record_id);
  const rememberedSessions = !!(remembered && remembered.useSessions);
  const rememberedGithub = !!(remembered && remembered.useGithub);
  const ghSmall = handle
    ? `Reads recent GitHub activity for <b>@${esc(handle)}</b>. If you are signed into <code>gh</code> and your project has a linked repo, it can include private repo events for that repo; otherwise public events only. No token is stored.`
    : (githubFallback ? "Uses the public commit/release signal already on your profile." : "No public GitHub handle on your profile yet.");
  host.innerHTML = card(`
    <header class="selfrep-head">
      <span class="selfrep-eyebrow">update from this week's work</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button>
    </header>
    <p class="selfrep-lede">I can draft an update to your profile from this week's work — you review and approve every change. Pick what I may read:</p>
    <label class="selfrep-consent">
      <input type="checkbox" data-sr-sessions ${rememberedSessions ? "checked" : ""}>
      <span>
        <b>My local AI sessions this week</b>
        <small>Reads your Claude Code / Codex logs <em>on this machine</em>, scrubbed into a short summary. Raw content never leaves your computer.</small>
      </span>
    </label>
    <label class="selfrep-consent${hasGithub ? "" : " is-disabled"}">
      <input type="checkbox" data-sr-github ${hasGithub ? (remembered ? (rememberedGithub ? "checked" : "") : "checked") : "disabled"}>
      <span>
        <b>My GitHub activity</b>
        <small>${ghSmall}</small>
      </span>
    </label>
    <label class="selfrep-consent selfrep-remember">
      <input type="checkbox" data-sr-remember ${remembered ? "checked" : ""}>
      <span>
        <b>Remember for Updates shortcut</b>
        <small>The chat dial's Updates quadrant may rerun only the sources checked above. Uncheck this to clear the shortcut.</small>
      </span>
    </label>
    <button type="button" class="selfrep-consent selfrep-manual-choice" data-sr-manual>
      <span class="selfrep-manual-mark" aria-hidden="true"></span>
      <span>
        <b>I'll type my own update</b>
        <small>No scan. Answer a few questions, preview the changed fields, then send only what you approve to Supabase.</small>
      </span>
    </button>
    <div class="selfrep-actions">
      <button type="button" class="selfrep-btn selfrep-ghost" data-sr-close>cancel</button>
      <button type="button" class="selfrep-btn selfrep-primary" data-sr-run disabled>scan &amp; draft</button>
    </div>
    <p class="selfrep-foot">Runs your own local AI tool — no API key, nothing uploaded.</p>
  `);
  const sessions = host.querySelector("[data-sr-sessions]");
  const github = host.querySelector("[data-sr-github]");
  const remember = host.querySelector("[data-sr-remember]");
  const run = host.querySelector("[data-sr-run]");
  const refresh = () => { run.disabled = !(sessions.checked || (github && github.checked)); };
  sessions.addEventListener("change", refresh);
  if (github) github.addEventListener("change", refresh);
  refresh();
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
  const manual = host.querySelector("[data-sr-manual]");
  if (manual) manual.addEventListener("click", () => { void renderManualDraft(person, githubFallback); });
  run.addEventListener("click", () => {
    const choices = {
      useSessions: sessions.checked,
      useGithub: !!(github && github.checked),
    };
    if (remember && remember.checked) rememberAutoUpdateChoices(person.record_id, choices);
    else rememberAutoUpdateChoices(person.record_id, null);
    runSelfReport(person, {
      ...choices,
      githubFallback,
    });
  });
}

// ── Step 1b — no-scan manual draft ───────────────────────────────────────────
async function renderManualDraft(person, githubFallback = "") {
  let surface = null;
  try { surface = await getCohortSurface(); } catch {}
  const currentPerson = resolveSurfacePerson(person, surface) || person;
  const agentPrompt = buildManualAgentPrompt({ person: currentPerson });
  const rows = MANUAL_SELF_REPORT_QUESTIONS.map((q) => `
    <label class="selfrep-manual-field">
      <span>
        <b>${esc(q.label)}</b>
        <small>${esc(q.hint)}</small>
      </span>
      <textarea data-sr-manual-field="${esc(q.field)}" rows="${q.type === "list" ? "3" : "2"}" placeholder="${esc(q.placeholder || "")}" spellcheck="true"></textarea>
    </label>`).join("");
  host.innerHTML = card(`
    <header class="selfrep-head">
      <span class="selfrep-eyebrow">type your own update</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">âœ•</button>
    </header>
    <p class="selfrep-lede">No scan runs here. Answer only what you want the cohort profile to know; empty answers are ignored.</p>
    <section class="selfrep-agent-prompt">
      <div class="selfrep-agent-copy">
        <b>Have your agent draft it</b>
        <small>Copy this prompt to your own agent, then paste its JSON here to fill the answers.</small>
      </div>
      <button type="button" class="selfrep-btn selfrep-ghost selfrep-copy-prompt" data-sr-agent-copy>copy agent prompt</button>
      <details class="selfrep-agent-paste">
        <summary>paste agent JSON</summary>
        <textarea data-sr-agent-json rows="5" placeholder='{"person":{"now":"...","seeking":["..."]}}' spellcheck="false"></textarea>
        <div class="selfrep-agent-fill-row">
          <button type="button" class="selfrep-btn selfrep-ghost" data-sr-agent-fill>fill answers</button>
          <span data-sr-agent-status></span>
        </div>
      </details>
    </section>
    <div class="selfrep-manual-grid">${rows}</div>
    <div class="selfrep-actions">
      <button type="button" class="selfrep-btn selfrep-ghost" data-sr-manual-back>back</button>
      <button type="button" class="selfrep-btn selfrep-primary" data-sr-manual-preview disabled>preview update</button>
    </div>
    <p class="selfrep-foot" data-sr-manual-status>Person fields update your public profile after you approve the preview.</p>
  `);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
  const fields = Array.from(host.querySelectorAll("[data-sr-manual-field]"));
  const preview = host.querySelector("[data-sr-manual-preview]");
  const status = host.querySelector("[data-sr-manual-status]");
  const agentStatus = host.querySelector("[data-sr-agent-status]");
  const setManualStatus = (kind, text) => {
    if (!status) return;
    status.textContent = text || "";
    status.className = "selfrep-foot" + (kind === "error" ? " is-error" : "");
  };
  const setAgentStatus = (kind, text) => {
    if (!agentStatus) return;
    agentStatus.textContent = text || "";
    agentStatus.className = kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : "";
  };
  const readAnswers = () => {
    const answers = {};
    for (const el of fields) answers[el.getAttribute("data-sr-manual-field")] = el.value || "";
    return answers;
  };
  const syncManualState = () => {
    if (preview) preview.disabled = !fields.some((el) => String(el.value || "").trim());
    setManualStatus("", "Person fields update your public profile after you approve the preview.");
  };
  for (const el of fields) el.addEventListener("input", syncManualState);
  const copyAgent = host.querySelector("[data-sr-agent-copy]");
  if (copyAgent) copyAgent.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(agentPrompt);
      else {
        const tmp = document.createElement("textarea");
        tmp.value = agentPrompt;
        tmp.setAttribute("readonly", "");
        tmp.style.position = "fixed";
        tmp.style.left = "-9999px";
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand("copy");
        tmp.remove();
      }
      setAgentStatus("ok", "copied");
    } catch {
      setAgentStatus("error", "copy failed");
    }
  });
  const fillAgent = host.querySelector("[data-sr-agent-fill]");
  if (fillAgent) fillAgent.addEventListener("click", () => {
    const raw = ((host.querySelector("[data-sr-agent-json]") || {}).value || "").trim();
    const parsed = parseManualAgentDraft(raw);
    if (!parsed.ok) {
      setAgentStatus("error", parsed.error === "empty_delta" ? "no allowed fields found" : "paste the JSON your agent returned");
      return;
    }
    for (const el of fields) {
      const key = el.getAttribute("data-sr-manual-field");
      if (key in parsed.answers) el.value = parsed.answers[key];
    }
    syncManualState();
    setAgentStatus("ok", "filled");
  });
  const back = host.querySelector("[data-sr-manual-back]");
  if (back) back.addEventListener("click", () => renderConsent(currentPerson, githubFallback));
  if (preview) preview.addEventListener("click", () => {
    const cleanDelta = buildManualSelfReportDelta(readAnswers());
    if (!Object.keys(cleanDelta).length) {
      setManualStatus("error", "Nothing to preview yet. Add one answer first.");
      return;
    }
    const { merged, changed } = mergeDelta(currentPerson, cleanDelta);
    if (!changed.length) {
      setManualStatus("error", "Those answers already match the current profile.");
      return;
    }
    const changedDelta = {};
    for (const key of changed) changedDelta[key] = merged[key];
    renderReview(currentPerson, {
      merged,
      changed,
      team: null,
      teamMerged: {},
      teamChanged: [],
      usefulness: buildManualUsefulness(changedDelta),
      question: "",
      digests: {
        sourceNotes: ["Manual: you typed this update. No scans ran."],
        sourceKinds: ["manual_self_report"],
      },
    });
  });
  syncManualState();
  setTimeout(() => { try { fields[0] && fields[0].focus(); } catch {} }, 30);
}

// ── Step 2 — scan + synthesize ────────────────────────────────────────────────
function renderBusy(message) {
  clearBusyTimer();
  host.innerHTML = card(`
    <header class="selfrep-head"><span class="selfrep-eyebrow">working…</span></header>
    <div class="selfrep-busy"><span class="selfrep-spinner" aria-hidden="true"></span><span data-sr-status>${esc(message)}</span></div>
    <p class="selfrep-foot" data-sr-elapsed>your own local AI is working — local runs can take 10–60s.</p>
  `);
  // Router lesson: never look frozen — the local CLI is slow, so show a live timer.
  const start = Date.now();
  busyTimer = setInterval(() => {
    const el = host && host.querySelector("[data-sr-elapsed]");
    if (!el) return clearBusyTimer();
    el.textContent = `your own local AI is working — ${Math.round((Date.now() - start) / 1000)}s (local runs can take 10–60s).`;
  }, 1000);
}
function setBusy(message) {
  const el = host && host.querySelector("[data-sr-status]");
  if (el) el.textContent = message;
}
function renderError(message) {
  clearBusyTimer();
  if (!host) return; // an async pass finished after the modal was closed
  host.innerHTML = card(`
    <header class="selfrep-head"><span class="selfrep-eyebrow">couldn’t draft an update</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button></header>
    <p class="selfrep-lede">${esc(message)}</p>
    <div class="selfrep-actions"><button type="button" class="selfrep-btn selfrep-primary" data-sr-close>close</button></div>
  `);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
}

function renderSuccess(fields = [], teamFields = []) {
  clearBusyTimer();
  if (!host) return;
  const fieldText = fields.length ? fields.map(fieldLabel).join(", ") : "your profile";
  const teamText = teamFields.length ? ` Project evidence (${teamFields.map(fieldLabel).join(", ")}) was queued for review.` : "";
  const mainText = fields.length ? `Updated ${esc(fieldText)} through Supabase.` : "Queued the project evidence proposal.";
  const settleText = teamFields.length
    ? (fields.length ? " Profile fields should appear after refresh; project evidence applies after review." : " It will affect the team record after review.")
    : " It should appear in the app after the live refresh settles.";
  host.innerHTML = card(`
    <header class="selfrep-head"><span class="selfrep-eyebrow">sent to the cohort record</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button></header>
    <p class="selfrep-lede">${mainText}${esc(teamText)}${settleText}</p>
    <div class="selfrep-actions"><button type="button" class="selfrep-btn selfrep-primary" data-sr-close>done</button></div>
  `);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
}

// One synthesis pass by the member's own AI. When `answer` is given it's a refine
// pass (the answer to the AI's previous question folds in). Returns
// { ok, merged, changed, question } or { ok:false, error }.
async function synthesize(person, digests, answer = "") {
  setBusy(answer ? "sharpening with your answer…" : "drafting an update with your local AI…");
  const prompt = buildSelfReportPrompt({
    person,
    sessionDigest: digests.sessionDigest,
    githubDigest: digests.githubDigest,
    appContextDigest: digests.appContextDigest,
    answer,
  });
  const synth = await safeCall(() => window.api?.selfReportSynthesize?.({ prompt }));
  if (!synth || !synth.ok) {
    return {
      ok: false,
      error: synth && synth.reason === "no_local_ai_cli"
        ? "No local AI tool found. Install Claude Code or Codex (or set the command in chat settings)."
        : "Your local AI tool didn’t return a draft. Try again.",
    };
  }
  const parsed = parseSelfReportDelta(synth.stdout || "");
  if (!parsed.ok) return { ok: false, error: "Couldn’t read a clean update from the AI’s reply. Try again." };
  // The AI's follow-up question rides alongside the delta; sanitize drops it from
  // the writable fields (it's interview, not a profile value).
  const proposal = extractSelfReportProposal(parsed.delta);
  const question = proposal.question;
  const { merged, changed } = mergeDelta(person, sanitizeDelta(proposal.personDelta));
  const team = digests && digests.team ? digests.team : null;
  const teamState = team
    ? mergeTeamDelta(team, sanitizeTeamFields(proposal.teamDelta))
    : { merged: {}, changed: [] };
  return {
    ok: true,
    merged,
    changed,
    team,
    teamMerged: teamState.merged,
    teamChanged: teamState.changed,
    usefulness: proposal.usefulness,
    question,
  };
}

async function runSelfReport(person, { useSessions, useGithub, githubFallback }) {
  renderBusy("reading your recent work…");
  let surface = null;
  try { surface = await getCohortSurface(); } catch {}
  const currentPerson = resolveSurfacePerson(person, surface) || person;
  const currentTeam = resolveSurfaceTeam(currentPerson, surface);
  const appContextDigest = buildAppUnderstandingDigest(currentPerson, surface);
  let sessionDigest = "";
  const sourceNotes = [];
  if (appContextDigest) sourceNotes.push("App: used current profile, team focus, and recent timeline as correction context.");
  if (useSessions) {
    const scan = await safeCall(() => window.api?.selfReportScan?.({ days: SELF_REPORT_LOOKBACK_DAYS }));
    if (!scan || !scan.ok) return renderError("Scanning your local sessions isn’t available on this build yet.");
    sessionDigest = scan.digest || "";
    if (sessionDigest) sourceNotes.push(`Sessions: read ${plural(scan.fileCount || 0, "recent local session")} on this machine.`);
  }
  let githubDigest = "";
  let githubSourceKind = "";
  if (useGithub) {
    setBusy("reading your recent GitHub activity...");
    const gh = await collectGithubDigest(currentPerson, githubFallback || "", { surface });
    githubDigest = gh.digest || "";
    githubSourceKind = gh.sourceKind || "";
    for (const note of gh.sourceNotes || []) sourceNotes.push(note);
  }
  if (!sessionDigest && !githubDigest) {
    return renderError("No recent activity found to read. Try again after some work, or update your profile by hand.");
  }
  const digests = { sessionDigest, githubDigest, githubSourceKind, appContextDigest, sourceNotes, team: currentTeam };
  const res = await synthesize(currentPerson, digests, "");
  if (!res.ok) return renderError(res.error);
  if (!res.changed.length && !(res.teamChanged && res.teamChanged.length)) {
    return renderError("Your profile already matches your recent work — nothing to update. 🎉");
  }
  renderReview(currentPerson, { ...res, digests });
}

// ── Step 3 — review → optional interview refine → send/apply ──────────
function diffRows(base, draft, changed) {
  return (Array.isArray(changed) ? changed : []).map((k) => `
    <div class="selfrep-diff">
      <div class="selfrep-diff-k">${esc(fieldLabel(k))}</div>
      <div class="selfrep-diff-was">${esc(asText(base && base[k]) || "â€”")}</div>
      <div class="selfrep-diff-arrow" aria-hidden="true">â†’</div>
      <div class="selfrep-diff-new">${esc(asText(draft && draft[k]))}</div>
    </div>`).join("");
}

function renderReview(person, state) {
  clearBusyTimer();
  if (!host) return; // an async pass finished after the modal was closed
  const { merged, changed, team, teamMerged = {}, teamChanged = [], usefulness = {}, question, digests } = state;
  const rows = changed.map((k) => `
    <div class="selfrep-diff">
      <div class="selfrep-diff-k">${esc(fieldLabel(k))}</div>
      <div class="selfrep-diff-was">${esc(asText(person[k]) || "—")}</div>
      <div class="selfrep-diff-arrow" aria-hidden="true">→</div>
      <div class="selfrep-diff-new">${esc(asText(merged[k]))}</div>
    </div>`).join("");
  const coverage = assessSelfReportCoverage(person, changed);
  const missing = coverage.missingEmptyFields.map(fieldLabel).join(", ");
  const teamRows = diffRows(team || {}, teamMerged, teamChanged);
  const totalChanged = changed.length + teamChanged.length;
  const profileCoverageHtml = changed.length ? (coverage.status === "broad" ? "" : `
    <div class="selfrep-coverage is-${coverage.status}">
      <b>${coverage.status === "thin" ? "Thin profile update" : "Focused profile update"}</b>
      <span>${coverage.changedCount} profile field${coverage.changedCount === 1 ? "" : "s"} changed across ${coverage.areaCount} area${coverage.areaCount === 1 ? "" : "s"}${missing ? `; still empty: ${esc(missing)}` : ""}. Use refine if collaboration style, shipped work, or asks changed too.</span>
    </div>`) : "";
  const projectStatus = teamCoverageStatus(teamChanged);
  const projectCoverageHtml = teamChanged.length && projectStatus !== "broad" ? `
    <div class="selfrep-coverage is-${projectStatus}">
      <b>${projectStatus === "thin" ? "Thin project update" : "Focused project update"}</b>
      <span>${teamChanged.length} project evidence field${teamChanged.length === 1 ? "" : "s"} changed. Strong project updates usually cover traction, shipping, and journey.</span>
    </div>` : "";
  const usefulnessReport = buildUsefulnessReport(usefulness, {
    changed,
    teamChanged,
    coverage,
    projectStatus,
    hasQuestion: !!question,
  });
  const usefulnessHtml = renderUsefulnessHtml(usefulnessReport);
  const personSection = changed.length ? `
    <section class="selfrep-section">
      <h3>person profile <small>auto-approved</small></h3>
      <div class="selfrep-diffs">${rows}</div>
    </section>` : "";
  const teamSection = teamChanged.length ? `
    <section class="selfrep-section">
      <h3>project evidence <small>queued for review${team && team.name ? ` - ${esc(team.name)}` : ""}</small></h3>
      <div class="selfrep-diffs">${teamRows}</div>
    </section>` : "";
  const sourceNotes = Array.isArray(digests && digests.sourceNotes) ? digests.sourceNotes : [];
  const sourceHtml = sourceNotes.length ? `
    <div class="selfrep-sources">${sourceNotes.map((note) => `<span>${esc(note)}</span>`).join("")}</div>` : "";
  // Router-style: the member's AI asks ONE question to sharpen; answering it runs a
  // refine pass. Optional — they can send the reviewed delta as-is.
  const refine = question ? `
    <div class="selfrep-refine">
      <p class="selfrep-q">${esc(question)}</p>
      <textarea data-sr-answer placeholder="answer to sharpen it (optional)…"></textarea>
      <button type="button" class="selfrep-btn selfrep-ghost selfrep-refine-btn" data-sr-refine>refine with my answer ↻</button>
    </div>` : "";
  host.innerHTML = card(`
    <header class="selfrep-head"><span class="selfrep-eyebrow">proposed update · ${totalChanged} field${totalChanged === 1 ? "" : "s"}</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button></header>
    <p class="selfrep-lede">Drafted from this week's work by your own AI. Person fields update your public profile; project evidence goes to review before it changes the team record.</p>
    ${sourceHtml}
    ${usefulnessHtml}
    ${profileCoverageHtml}
    ${projectCoverageHtml}
    ${personSection}
    ${teamSection}
    ${refine}
    <div class="selfrep-actions">
      <button type="button" class="selfrep-btn selfrep-ghost" data-sr-close>discard</button>
      <button type="button" class="selfrep-btn selfrep-primary" data-sr-apply>send update</button>
    </div>
    <p class="selfrep-foot" data-sr-send-status></p>
  `);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
  let applied = false;
  host.querySelector("[data-sr-apply]").addEventListener("click", async () => {
    if (applied) return; // guard a double-click → duplicate inbox rows + double editor open
    applied = true;
    const applyBtn = host.querySelector("[data-sr-apply]");
    const statusEl = host.querySelector("[data-sr-send-status]");
    if (applyBtn) applyBtn.disabled = true;
    if (statusEl) statusEl.textContent = "sending to Supabase...";
    const directSourceKinds = Array.isArray(digests && digests.sourceKinds) && digests.sourceKinds.length
      ? digests.sourceKinds.slice(0, 8).map(String)
      : [
        digests.appContextDigest ? "app_context" : "",
        digests.sessionDigest ? "sessions" : "",
        digests.githubDigest ? (digests.githubSourceKind || "github") : "",
      ].filter(Boolean);
    let ctx = {};
    try { ctx = await getAppContext(); } catch {}
    const claimHash = getClaimTokenHash();
    if (changed.length) {
      const direct = await saveSelfReportUpdate(person.record_id, merged, {
        question: question || "",
        sourceKinds: directSourceKinds,
        appVersion: ctx.appVersion,
        platform: ctx.platform,
        proposerClaimHash: claimHash,
      });
      if (!direct || !direct.ok) {
        applied = false;
        if (applyBtn) applyBtn.disabled = false;
        if (statusEl) statusEl.textContent = direct && direct.error === "unconfigured"
          ? "Supabase is not configured in this build."
          : `couldn't send profile update: ${direct && direct.error ? direct.error : "try again"}`;
        return;
      }
    }
    if (teamChanged.length && team && team.record_id) {
      const teamRes = await saveProfileProposal(team.record_id, teamMerged, {
        proposerRecordId: person.record_id,
        proposerClaimHash: claimHash,
        rationale: question ? `Self-report project evidence proposal. Follow-up question: ${question}` : "Self-report project evidence proposal.",
        sourceKinds: directSourceKinds,
        appVersion: ctx.appVersion,
        platform: ctx.platform,
        subjectType: "team",
      });
      if (!teamRes || !teamRes.ok) {
        applied = false;
        if (applyBtn) applyBtn.disabled = false;
        if (statusEl) statusEl.textContent = teamRes && teamRes.error === "unconfigured"
          ? "Supabase is not configured in this build."
          : `couldn't queue project update: ${teamRes && teamRes.error ? teamRes.error : "try again"}`;
        return;
      }
    }
    emitSelfReport(person.record_id, Object.keys(merged || {}), {
      coverageStatus: changed.length ? coverage.status : projectStatus,
      sourceKinds: directSourceKinds,
      usedAppContext: !!digests.appContextDigest,
      teamRecordId: team && teamChanged.length ? team.record_id : "",
      teamFields: teamChanged,
      teamProposalStatus: teamChanged.length ? "pending_review" : "",
      usefulness: usefulnessReport,
    });
    if (statusEl) statusEl.textContent = "sent - refreshing the cohort record...";
    try { await refreshCohortFromGithub(); } catch {}
    setTimeout(() => { refreshCohortFromGithub().catch(() => {}); }, 1500);
    renderSuccess(Object.keys(merged || {}), teamChanged);
  });
  const refineBtn = host.querySelector("[data-sr-refine]");
  if (refineBtn) {
    let refining = false;
    refineBtn.addEventListener("click", async () => {
      if (refining) return; // guard concurrent refine passes (double CLI spawn + host race)
      const answer = ((host.querySelector("[data-sr-answer]") || {}).value || "").trim();
      if (!answer) return;
      refining = true;
      refineBtn.disabled = true;
      const gen = runGen;
      const res = await synthesize(person, digests, answer);
      if (gen !== runGen) return; // modal closed/reopened mid-run → drop the stale result
      refining = false;
      if (!res.ok) return renderError(res.error);
      if (!res.changed.length && !(res.teamChanged && res.teamChanged.length)) return renderError("Looks good — nothing more to change. 🎉");
      renderReview(person, { ...res, digests });
    });
  }
}

async function safeCall(fn) {
  try { return await fn(); } catch { return null; }
}
