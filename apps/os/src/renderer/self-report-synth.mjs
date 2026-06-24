// self-report-synth.mjs — the brain of the permission-gated self-report.
//
// Pure + deterministic + node-testable (no fs / network / CLI here). It builds
// the prompt that the member's OWN local CLI runs — the same local-CLI mechanism
// the cohort-chat uses (claude -p / codex exec / ollama; no API key, the raw
// signal never leaves the member's machine) — and parses/validates the model's
// reply into a SAFE profile-field delta.
//
// Safety is enforced here, not trusted from the model: the reply is whitelisted
// to a fixed set of self-declared surface fields (cohort-data/schema.yml). The
// model can never touch record_id, team, role, links, or anything else, and the
// merge is non-destructive — only the member-approved delta ever reaches the
// existing profile-write path.

// Local CLIs emit ANSI color codes; strip them before parsing (mirrors cohort-chat.js).
const ANSI_RE = /\[[0-9;]*m/g;
export function stripAnsi(s) {
  return String(s == null ? "" : s).replace(ANSI_RE, "");
}

// The ONLY person fields a self-report may propose — the self-declared
// surface_fields from cohort-data/schema.yml. "shipped" maps to prior_work;
// person has no "focus" field (that's team-only), so it's intentionally absent.
export const SELF_REPORT_FIELDS = Object.freeze({
  now: "string",
  weekly_intention: "string",
  skills: "list",
  skill_areas: "list", // controlled vocab — filtered to allowedSkillAreas when provided
  seeking: "list",
  offering: "list",
  prior_work: "list",
});

const STRING_MAX = 280;
const LIST_MAX = 12;
const ITEM_MAX = 80;

// Build the synthesis prompt — Router/daybook style: the member's OWN local AI,
// running on THEIR machine with THEIR tools/github, grounds the update in real
// recent work and ASKS one question to sharpen it (rather than silently guessing).
// It emits STRICT JSON with only the changed whitelist fields + a `question`.
// `answer` folds the member's reply back in on a refine pass. Conservative by
// construction: propose a field only when the evidence supports it, never invent.
export function buildSelfReportPrompt({ person = {}, sessionDigest = "", githubDigest = "", answer = "" } = {}) {
  const cur = {};
  for (const k of Object.keys(SELF_REPORT_FIELDS)) {
    if (person && person[k] != null) cur[k] = person[k];
  }
  const name = String((person && person.name) || "this member").trim() || "this member";
  const fields = Object.keys(SELF_REPORT_FIELDS).join(", ");
  const evidence = [
    sessionDigest ? `LOCAL AI SESSIONS (${name}'s recent work, read on their machine):\n${sessionDigest}` : "",
    githubDigest ? `GITHUB ACTIVITY (pre-gathered, public — verify/extend with gh/git if you can):\n${githubDigest}` : "",
  ].filter(Boolean).join("\n\n");
  return [
    `You are ${name}'s OWN AI assistant, running on their machine. Help them keep their PUBLIC cohort`,
    "profile accurate and current — grounded in their REAL recent work, not a guess.",
    "",
    "GATHER (first-hand, since you run in their environment):",
    "- If `gh` or `git` is available to you, review their recent work yourself — e.g. `gh api user`,",
    "  recent commits / PRs / releases (`git -C <repo> log --oneline -20`). Prefer this first-hand signal.",
    "- Also use the LOCAL AI SESSIONS digest and any pre-gathered GITHUB ACTIVITY below.",
    "",
    "RULES:",
    `- Only propose values for these profile fields: ${fields}.`,
    "- Propose a field ONLY when the evidence clearly supports a change; otherwise omit it.",
    "- Be truthful and conservative. Do NOT invent work that is not in the evidence.",
    "- `now` = one present-tense line on what they're building now. `weekly_intention` = this week's aim.",
    "- `skills`/`skill_areas`/`seeking`/`offering` = short lists; `prior_work` = shipped/public artifacts (list).",
    "- ALSO include `question`: ONE warm, specific question (≤20 words, addressed to them as 'you') that",
    "  invites them to confirm or sharpen the update. This is how you ASK rather than assume.",
    "- Output STRICT JSON ONLY: { ...changed fields, \"question\": \"…\" }. No prose, no markdown fence.",
    "",
    "CURRENT PROFILE (do not repeat unchanged values):",
    JSON.stringify(cur, null, 1),
    answer ? `\nTHEIR ANSWER to your last question (fold this in, then ask a follow-up only if needed):\n${answer}` : "",
    "",
    "EVIDENCE:",
    evidence || "(nothing pre-gathered — gather it yourself with gh/git, or ask.)",
    "",
    "Respond with the JSON object now:",
  ].join("\n");
}

// Pull a JSON object out of possibly-noisy CLI stdout: prefer a ```json fence,
// else the outermost balanced {…}. Returns { ok, delta } or { ok:false, error }.
export function parseSelfReportDelta(raw) {
  const text = stripAnsi(raw).trim();
  if (!text) return { ok: false, error: "empty" };
  let candidate = null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  if (!candidate) {
    const start = text.indexOf("{");
    if (start === -1) return { ok: false, error: "no_json" };
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return { ok: false, error: "unbalanced" };
    candidate = text.slice(start, end + 1);
  }
  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch { return { ok: false, error: "parse_error" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not_object" };
  }
  return { ok: true, delta: parsed };
}

function clampStr(v) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, STRING_MAX) : "";
}
function clampList(v) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  const out = [];
  for (const item of arr) {
    const s = String(item == null ? "" : item).trim();
    if (s) out.push(s.slice(0, ITEM_MAX));
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

// Whitelist to the allowed fields, coerce types, drop empties. Anything the model
// returned outside SELF_REPORT_FIELDS is discarded. allowedSkillAreas (optional
// Set) filters skill_areas to the controlled vocab.
export function sanitizeDelta(delta, { allowedSkillAreas } = {}) {
  const clean = {};
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return clean;
  for (const [key, kind] of Object.entries(SELF_REPORT_FIELDS)) {
    if (!(key in delta)) continue;
    if (kind === "string") {
      const s = clampStr(delta[key]);
      if (s) clean[key] = s;
    } else {
      let list = clampList(delta[key]);
      if (key === "skill_areas" && allowedSkillAreas instanceof Set) {
        list = list.filter((x) => allowedSkillAreas.has(x));
      }
      if (list.length) clean[key] = list;
    }
  }
  return clean;
}

function valuesEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : (a == null ? [] : [a]);
    const bb = Array.isArray(b) ? b : (b == null ? [] : [b]);
    if (aa.length !== bb.length) return false;
    return aa.every((x, i) => String(x).trim() === String(bb[i]).trim());
  }
  return String(a == null ? "" : a).trim() === String(b == null ? "" : b).trim();
}

// Non-destructive merge of a sanitized delta onto the current person record.
// Returns the fields that ACTUALLY change (so the review UI shows a real diff and
// an all-noop synthesis writes nothing).
export function mergeDelta(person = {}, cleanDelta = {}) {
  const merged = {};
  const changed = [];
  for (const [key, val] of Object.entries(cleanDelta)) {
    if (!valuesEqual(person ? person[key] : undefined, val)) {
      merged[key] = val;
      changed.push(key);
    }
  }
  return { merged, changed };
}
