// self-report.js — the consent-first "update from my recent work" modal.
//
// The INPUT side of "Your Mirror": with explicit, per-source permission it scans
// the member's real signal (their LOCAL Claude/Codex sessions, kept on-machine;
// their already-public GitHub activity) and drafts a profile update. The member
// reviews the proposed change and hands it to the existing profile editor, where
// THEY click save. Nothing is scanned without opt-in; nothing is written without
// the editor's existing save gate; only whitelisted fields ever move.
//
// The synth brain (prompt + safe JSON parse/whitelist/merge) is self-report-synth.mjs;
// the local scan + local-CLI run happen in main (window.api.selfReport*).

import {
  buildSelfReportPrompt,
  parseSelfReportDelta,
  sanitizeDelta,
  mergeDelta,
} from "./self-report-synth.mjs";
import { loadStylesheetOnce } from "./stylesheet-loader.js";
import { scanGithubActivity, resolvePersonHandle } from "./gh-self-report.mjs";
import { saveSelfReportUpdate } from "./supabase-self-report.mjs";
import { emitSelfReport } from "./cohort-emit.mjs";

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
  now: "now",
  weekly_intention: "weekly intention",
  skills: "skills",
  skill_areas: "skill areas",
  seeking: "seeking",
  offering: "offering",
  prior_work: "prior work",
};
const fieldLabel = (k) => FIELD_LABELS[k] || k;
const asText = (v) => (Array.isArray(v) ? v.join(", ") : String(v == null ? "" : v));
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s == null ? "" : s);
  return d.innerHTML;
}

let host = null;
let busyTimer = null;
let runGen = 0; // bumped on close; a long async pass captures it and drops a stale result
function clearBusyTimer() { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } }
function onKey(e) { if (e.key === "Escape") closeSelfReport(); }

export function closeSelfReport() {
  runGen += 1;
  clearBusyTimer();
  if (host) { host.remove(); host = null; }
  document.removeEventListener("keydown", onKey);
}

export async function openSelfReport({ person, githubDigest = "" } = {}) {
  if (!person || !person.record_id) return;
  await ensureStylesheet();
  closeSelfReport();
  host = document.createElement("div");
  host.className = "selfrep-overlay";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  document.body.appendChild(host);
  document.addEventListener("keydown", onKey);
  // Click the backdrop (not the card) to dismiss.
  host.addEventListener("mousedown", (e) => { if (e.target === host) closeSelfReport(); });
  renderConsent(person, githubDigest);
}

function card(inner) {
  return `<div class="selfrep-card">${inner}</div>`;
}

// ── Step 1 — consent ────────────────────────────────────────────────────────
function renderConsent(person, githubFallback) {
  const handle = resolvePersonHandle(person);
  const hasGithub = !!handle || !!(githubFallback && githubFallback.trim());
  const ghSmall = handle
    ? `Reads your recent <em>public</em> GitHub activity — one call to github.com for <b>@${esc(handle)}</b>’s public events. Nothing private, no token, nothing uploaded.`
    : (githubFallback ? "Uses the public commit/release signal already on your profile." : "No public GitHub handle on your profile yet.");
  host.innerHTML = card(`
    <header class="selfrep-head">
      <span class="selfrep-eyebrow">update from my recent work</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button>
    </header>
    <p class="selfrep-lede">I can draft an update to your profile from your own recent work — you review and approve every change. Pick what I may read:</p>
    <label class="selfrep-consent">
      <input type="checkbox" data-sr-sessions>
      <span>
        <b>My recent local AI sessions</b>
        <small>Reads your Claude Code / Codex logs <em>on this machine</em>, scrubbed into a short summary. Raw content never leaves your computer.</small>
      </span>
    </label>
    <label class="selfrep-consent${hasGithub ? "" : " is-disabled"}">
      <input type="checkbox" data-sr-github ${hasGithub ? "checked" : "disabled"}>
      <span>
        <b>My public GitHub activity</b>
        <small>${ghSmall}</small>
      </span>
    </label>
    <div class="selfrep-actions">
      <button type="button" class="selfrep-btn selfrep-ghost" data-sr-close>cancel</button>
      <button type="button" class="selfrep-btn selfrep-primary" data-sr-run disabled>scan &amp; draft</button>
    </div>
    <p class="selfrep-foot">Runs your own local AI tool — no API key, nothing uploaded.</p>
  `);
  const sessions = host.querySelector("[data-sr-sessions]");
  const github = host.querySelector("[data-sr-github]");
  const run = host.querySelector("[data-sr-run]");
  const refresh = () => { run.disabled = !(sessions.checked || (github && github.checked)); };
  sessions.addEventListener("change", refresh);
  if (github) github.addEventListener("change", refresh);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
  run.addEventListener("click", () => {
    runSelfReport(person, {
      useSessions: sessions.checked,
      useGithub: !!(github && github.checked),
      githubFallback,
    });
  });
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

// One synthesis pass by the member's own AI. When `answer` is given it's a refine
// pass (the answer to the AI's previous question folds in). Returns
// { ok, merged, changed, question } or { ok:false, error }.
async function synthesize(person, digests, answer = "") {
  setBusy(answer ? "sharpening with your answer…" : "drafting an update with your local AI…");
  const prompt = buildSelfReportPrompt({
    person, sessionDigest: digests.sessionDigest, githubDigest: digests.githubDigest, answer,
  });
  const synth = await safeCall(() => window.api?.selfReportSynthesize?.({ prompt }));
  if (!synth || !synth.ok) {
    return {
      ok: false,
      error: synth && synth.reason === "no_local_ai_cli"
        ? "No local AI tool found. Install Claude Code, Codex, or Ollama (or set the command in chat settings)."
        : "Your local AI tool didn’t return a draft. Try again.",
    };
  }
  const parsed = parseSelfReportDelta(synth.stdout || "");
  if (!parsed.ok) return { ok: false, error: "Couldn’t read a clean update from the AI’s reply. Try again." };
  // The AI's follow-up question rides alongside the delta; sanitize drops it from
  // the writable fields (it's interview, not a profile value).
  const question = typeof parsed.delta.question === "string" ? parsed.delta.question.trim() : "";
  const { merged, changed } = mergeDelta(person, sanitizeDelta(parsed.delta));
  return { ok: true, merged, changed, question };
}

async function runSelfReport(person, { useSessions, useGithub, githubFallback }) {
  renderBusy("reading your recent work…");
  let sessionDigest = "";
  if (useSessions) {
    const scan = await safeCall(() => window.api?.selfReportScan?.({ days: 14 }));
    if (!scan || !scan.ok) return renderError("Scanning your local sessions isn’t available on this build yet.");
    sessionDigest = scan.digest || "";
  }
  let githubDigest = "";
  if (useGithub) {
    const handle = resolvePersonHandle(person);
    if (handle) {
      setBusy("reading your recent GitHub activity…");
      const gh = await safeCall(() => scanGithubActivity(handle));
      githubDigest = (gh && gh.ok && gh.digest) ? gh.digest : (githubFallback || "");
    } else {
      githubDigest = githubFallback || "";
    }
  }
  if (!sessionDigest && !githubDigest) {
    return renderError("No recent activity found to read. Try again after some work, or update your profile by hand.");
  }
  const digests = { sessionDigest, githubDigest };
  const res = await synthesize(person, digests, "");
  if (!res.ok) return renderError(res.error);
  if (!res.changed.length) {
    return renderError("Your profile already matches your recent work — nothing to update. 🎉");
  }
  renderReview(person, { ...res, digests });
}

// ── Step 3 — review → optional interview refine → hand to the editor ──────────
function renderReview(person, state) {
  clearBusyTimer();
  if (!host) return; // an async pass finished after the modal was closed
  const { merged, changed, question, digests } = state;
  const rows = changed.map((k) => `
    <div class="selfrep-diff">
      <div class="selfrep-diff-k">${esc(fieldLabel(k))}</div>
      <div class="selfrep-diff-was">${esc(asText(person[k]) || "—")}</div>
      <div class="selfrep-diff-arrow" aria-hidden="true">→</div>
      <div class="selfrep-diff-new">${esc(asText(merged[k]))}</div>
    </div>`).join("");
  // Router-style: the member's AI asks ONE question to sharpen; answering it runs a
  // refine pass. Optional — they can open the editor without answering.
  const refine = question ? `
    <div class="selfrep-refine">
      <p class="selfrep-q">${esc(question)}</p>
      <textarea data-sr-answer placeholder="answer to sharpen it (optional)…"></textarea>
      <button type="button" class="selfrep-btn selfrep-ghost selfrep-refine-btn" data-sr-refine>refine with my answer ↻</button>
    </div>` : "";
  host.innerHTML = card(`
    <header class="selfrep-head"><span class="selfrep-eyebrow">proposed update · ${changed.length} field${changed.length === 1 ? "" : "s"}</span>
      <button type="button" class="selfrep-x" data-sr-close aria-label="close">✕</button></header>
    <p class="selfrep-lede">Drafted from your recent work by your own AI. Answer its question to sharpen it, or open it in your profile editor to save.</p>
    <div class="selfrep-diffs">${rows}</div>
    ${refine}
    <div class="selfrep-actions">
      <button type="button" class="selfrep-btn selfrep-ghost" data-sr-close>discard</button>
      <button type="button" class="selfrep-btn selfrep-primary" data-sr-apply>open in editor →</button>
    </div>
  `);
  for (const b of host.querySelectorAll("[data-sr-close]")) b.addEventListener("click", closeSelfReport);
  let applied = false;
  host.querySelector("[data-sr-apply]").addEventListener("click", () => {
    if (applied) return; // guard a double-click → duplicate inbox rows + double editor open
    applied = true;
    // RECEIVE (additive): append the approved delta to the Supabase inbox
    // (os_profile_updates) so an operator/Engine can approve + promote it cohort-wide.
    // The canonical write is still the editor save below; this is the durable
    // cross-device receive. .then/.catch so a silent inbox drop is logged (it would
    // otherwise defeat the cross-device premise) and a future throw can't leak.
    const sourceKinds = [
      digests.sessionDigest ? "sessions" : "",
      digests.githubDigest ? "github" : "",
    ].filter(Boolean);
    Promise.resolve(saveSelfReportUpdate(person.record_id, merged, { question: question || "", sourceKinds }))
      .then((r) => { if (!r || !r.ok) console.warn("[self-report] receive write failed:", r && r.error); })
      .catch((e) => console.warn("[self-report] receive write error:", e && e.message ? e.message : e));
    // Spine: a loud "refreshed their profile from recent work" feed line (field
    // NAMES only; the values stay gated in the os_profile_updates inbox).
    emitSelfReport(person.record_id, Object.keys(merged || {}));
    // Hand the proposal to the existing profile editor as a one-shot prefill; the
    // member tweaks and clicks the editor's own "save" — the real HITL gate.
    if (typeof window.__srwkOpenProfile === "function") {
      window.__srwkOpenProfile({
        kind: "person",
        record_id: person.record_id,
        mode: "edit",
        draftPatch: { record_id: person.record_id, fields: merged },
      });
    }
    closeSelfReport();
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
      if (!res.changed.length) return renderError("Looks good — nothing more to change. 🎉");
      renderReview(person, { ...res, digests });
    });
  }
}

async function safeCall(fn) {
  try { return await fn(); } catch { return null; }
}
