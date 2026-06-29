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
const ANSI_RE = /[][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d\/#&.:=?%@~_-]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
export function stripAnsi(s) {
  return String(s == null ? "" : s).replace(ANSI_RE, "");
}

// The ONLY person fields a self-report may propose — the self-declared
// surface_fields from cohort-data/schema.yml. "shipped" maps to prior_work;
// person has no "focus" field (that's team-only), so it's intentionally absent.
export const SELF_REPORT_FIELDS = Object.freeze({
  comm_style: "string",
  contribute_interests: "list",
  now: "string",
  weekly_intention: "string",
  availability_pref: "string",
  skills: "list",
  skill_areas: "list", // controlled vocab — filtered to allowedSkillAreas when provided
  seeking: "list",
  offering: "list",
  go_to_them_for: "list",
  recurring_themes: "list",
  working_style: "string",
  best_contexts: "list",
  prior_work: "list",
});

export const SELF_REPORT_TEAM_FIELDS = Object.freeze({
  traction: "string",
  prior_shipping: "list",
  success_dimensions: "list",
  journey: "object",
});

export const SELF_REPORT_CORE_FIELDS = Object.freeze(["now", "weekly_intention", "seeking", "offering", "go_to_them_for", "contribute_interests"]);
export const SELF_REPORT_DURABLE_FIELDS = Object.freeze(["skills", "skill_areas", "prior_work", "recurring_themes", "working_style", "best_contexts"]);
export const SELF_REPORT_COLLAB_FIELDS = Object.freeze(["comm_style", "availability_pref"]);
export const SELF_REPORT_REQUIRED_DURABLE_FIELDS = Object.freeze(["skills", "skill_areas", "prior_work"]);

export const SELF_REPORT_USEFULNESS_AREAS = Object.freeze([
  "findability",
  "collaboration",
  "current_state",
  "proof_history",
  "project_evidence",
  "timeline",
  "review_readiness",
]);
export const SELF_REPORT_USEFULNESS_STATUSES = Object.freeze([
  "improved",
  "unchanged",
  "needs_answer",
  "no_evidence",
  "queued_review",
  "auto_applied",
  "current_state_refresh",
]);
export const SELF_REPORT_SUGGESTED_ACTIONS = Object.freeze([
  "ask_member",
  "queue_project_evidence",
  "suggest_connections",
  "create_ask",
  "flag_stale_app_understanding",
]);

const STRING_MAX = 280;
const LIST_MAX = 12;
const ITEM_MAX = 140; // live test: prior_work artifact descriptions were cut mid-word at 80

// Build the synthesis prompt — Router/daybook style: the member's OWN local AI,
// running on THEIR machine with THEIR tools/github, grounds the update in real
// recent work and ASKS one question to sharpen it (rather than silently guessing).
// It emits STRICT JSON with only the changed whitelist fields + a `question`.
// `answer` folds the member's reply back in on a refine pass. Conservative by
// construction: propose a field only when the evidence supports it, never invent.
export function buildSelfReportPrompt({ person = {}, sessionDigest = "", githubDigest = "", appContextDigest = "", answer = "" } = {}) {
  const cur = {};
  for (const k of Object.keys(SELF_REPORT_FIELDS)) {
    if (person && person[k] != null) cur[k] = person[k];
  }
  const name = String((person && person.name) || "this member").trim() || "this member";
  const fields = Object.keys(SELF_REPORT_FIELDS).join(", ");
  const teamFields = Object.keys(SELF_REPORT_TEAM_FIELDS).join(", ");
  const usefulnessAreas = SELF_REPORT_USEFULNESS_AREAS.join(", ");
  const usefulnessStatuses = SELF_REPORT_USEFULNESS_STATUSES.join(", ");
  const suggestedActions = SELF_REPORT_SUGGESTED_ACTIONS.join(", ");
  const evidence = [
    appContextDigest ? `APP UNDERSTANDING (current app surface + timeline signals; correct if stale):\n${appContextDigest}` : "",
    sessionDigest ? `LOCAL AI SESSIONS (${name}'s recent work, read on their machine):\n${sessionDigest}` : "",
    githubDigest ? `GITHUB ACTIVITY (pre-gathered; scope/source noted in digest, verify/extend with gh/git if you can):\n${githubDigest}` : "",
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
    `- You may also propose a separate project/team object with only these fields: ${teamFields}.`,
    "- Propose a field ONLY when the evidence clearly supports a change; otherwise omit it.",
    "- Be truthful and conservative. Do NOT invent work that is not in the evidence.",
    "- `now` = one present-tense line on what they're building now. `weekly_intention` = this week's aim.",
    "- `skills`/`skill_areas`/`seeking`/`offering` = short lists; `prior_work` = shipped/public artifacts (list).",
    "- `go_to_them_for`, `recurring_themes`, `working_style`, and `best_contexts` sharpen the collaboration profile.",
    "- `comm_style`, `contribute_interests`, and `availability_pref` should come from explicit self-signal, not inference.",
    "",
    "APP RELEVANCE / CORRECTION PASS:",
    "- Treat APP UNDERSTANDING as the app's current belief, not as ground truth.",
    "- Use recent evidence and their answer to correct stale or misleading current fields.",
    "- Anchor changes to where they are now. Do not backdate or rewrite older timeline items.",
    "- For `prior_work`, preserve true existing history and append newly shipped artifacts.",
    "- For project/team `prior_shipping`, preserve true existing history and append newly shipped proof.",
    "- Remove or contradict past work only if the member explicitly says it is false or misattributed.",
    "",
    "PROFILE COVERAGE PASS:",
    "- Audit all profile sections before answering. Do not stop after `now` and `weekly_intention`.",
    "- If evidence shows shipped artifacts, demos, repos, releases, user proof, or reusable tools, update `prior_work`.",
    "- If evidence shows new capabilities or a changed work mode, update `skills` and/or `skill_areas`.",
    "- If evidence changes how others should work with them, update collaboration sections too.",
    "- If GitHub evidence is public-only or sparse, use `question` to ask for the missing private repo or shipped detail.",
    "- Omit unchanged fields, but make the proposal broad enough that the public profile stays useful.",
    "",
    "PROJECT / TEAM EVIDENCE PASS:",
    "- If the evidence is about the current project, put project evidence in `team`, not on the person profile.",
    "- Use `team.traction` for user/revenue/usage proof, `team.prior_shipping` for shipped artifacts,",
    "  `team.success_dimensions` for program-fit dimensions, and `team.journey` for current stage/bottleneck/next milestone.",
    "- Team/project updates are reviewed separately; propose them only when the app context clearly identifies the project.",
    "",
    "APP USEFULNESS REPORT:",
    `- Also include a \`usefulness\` object with area keys from: ${usefulnessAreas}.`,
    `- Each area value must be one of: ${usefulnessStatuses}.`,
    "- Use this to explain what the update does for the app: findability, collaboration, current-state accuracy, proof/history,",
    "  project intelligence, timeline freshness, and review readiness.",
    `- \`usefulness.missing_evidence\` is a short list of gaps. \`usefulness.suggested_actions\` may include: ${suggestedActions}.`,
    "- ALSO include `question`: ONE warm, specific question (≤20 words, addressed to them as 'you') that",
    "  invites them to confirm or sharpen the update. This is how you ASK rather than assume.",
    "- Output STRICT JSON ONLY. Preferred shape: { \"person\": { ...changed profile fields }, \"team\": { ...changed project fields }, \"usefulness\": { ...section health }, \"question\": \"...\" }.",
    "- If there is no team/project update, omit `team`. For backward compatibility, top-level profile fields are accepted.",
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

// Pull the model's JSON answer out of possibly-noisy CLI stdout. Agentic CLIs may
// echo the prompt (which contains a current-profile object) before the answer, emit
// cursor/OSC ANSI, or wrap reasoning in a bare fence — so: strip ANSI, prefer a
// valid ```json fence, else scan ALL top-level balanced objects STRING-AWARELY and
// take the LAST that carries a whitelist field or `question` (the answer comes last).
// Returns { ok, delta } or { ok:false, error }.
export function parseSelfReportDelta(raw) {
  const text = stripAnsi(raw).trim();
  if (!text) return { ok: false, error: "empty" };
  const tryObj = (str) => {
    try { const v = JSON.parse(str); return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
    catch { return null; }
  };
  const candidates = [];
  // A ```json fence is the model's explicit answer block — try it first (but fall
  // through if it isn't valid JSON; models wrap *thinking* in bare fences).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  // Every top-level balanced { } object, tracking string context so a brace inside
  // a string value (free-text now/prior_work) doesn't mis-balance the scan.
  for (let a = 0; a < text.length; a++) {
    if (text[a] !== "{") continue;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let b = a; b < text.length; b++) {
      const c = text[b];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = b; break; } }
    }
    if (end === -1) break;
    candidates.push(text.slice(a, end + 1));
    a = end;
  }
  if (!candidates.length) return { ok: false, error: "no_json" };
  const FIELDS = Object.keys(SELF_REPORT_FIELDS);
  const isAnswer = (o) => !!o && (
    ("question" in o)
    || FIELDS.some((f) => f in o)
    || (o.person && typeof o.person === "object" && !Array.isArray(o.person))
    || (o.team && typeof o.team === "object" && !Array.isArray(o.team))
    || (o.usefulness && typeof o.usefulness === "object" && !Array.isArray(o.usefulness))
  );
  // Prefer the LAST answer-shaped object; else the last parseable object at all.
  for (let n = candidates.length - 1; n >= 0; n--) { const v = tryObj(candidates[n]); if (v && isAnswer(v)) return { ok: true, delta: v }; }
  for (let n = candidates.length - 1; n >= 0; n--) { const v = tryObj(candidates[n]); if (v) return { ok: true, delta: v }; }
  return { ok: false, error: "parse_error" };
}

// Coerce ONE value to a bounded string. Rejects non-primitives (a nested object
// would stringify to "[object Object]") and trims a dangling high surrogate left by
// slicing at an odd UTF-16 boundary (which would render as � / break JSON later).
function clampOne(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  let s = String(v).trim();
  if (!s) return "";
  s = s.slice(0, max);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
  return s;
}
function clampStr(v) { return clampOne(v, STRING_MAX); }
function clampList(v) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  const out = [];
  for (const item of arr) {
    const s = clampOne(item, ITEM_MAX);
    if (s) out.push(s);
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

function plainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function sanitizeUsefulness(usefulness = {}) {
  if (!plainObject(usefulness)) return {};
  const statusSet = new Set(SELF_REPORT_USEFULNESS_STATUSES);
  const actionSet = new Set(SELF_REPORT_SUGGESTED_ACTIONS);
  const srcAreas = plainObject(usefulness.areas) ? usefulness.areas : usefulness;
  const areas = {};
  for (const area of SELF_REPORT_USEFULNESS_AREAS) {
    const raw = clampOne(srcAreas[area], 40);
    if (statusSet.has(raw)) areas[area] = raw;
  }
  const missing = clampList(usefulness.missing_evidence).slice(0, 8);
  const actions = clampList(usefulness.suggested_actions)
    .map((item) => item.toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((item, idx, arr) => actionSet.has(item) && arr.indexOf(item) === idx)
    .slice(0, 6);
  const out = {};
  if (Object.keys(areas).length) out.areas = areas;
  if (missing.length) out.missing_evidence = missing;
  if (actions.length) out.suggested_actions = actions;
  return out;
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

function listItems(value) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : [value]);
  return arr.map((item) => clampOne(item, ITEM_MAX)).filter(Boolean);
}

function mergeHistoryList(existing, proposed) {
  const out = [];
  const seen = new Set();
  for (const item of [...listItems(existing), ...listItems(proposed)]) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

// Non-destructive merge of a sanitized delta onto the current person record.
// `prior_work` is additive: it is historical evidence, so a terse AI proposal
// may append shipped work but must not erase already-approved past work.
// Returns the fields that ACTUALLY change (so the review UI shows a real diff and
// an all-noop synthesis writes nothing).
export function mergeDelta(person = {}, cleanDelta = {}) {
  const merged = {};
  const changed = [];
  for (const [key, val] of Object.entries(cleanDelta)) {
    const nextVal = key === "prior_work" ? mergeHistoryList(person ? person[key] : undefined, val) : val;
    if (!valuesEqual(person ? person[key] : undefined, nextVal)) {
      merged[key] = nextVal;
      changed.push(key);
    }
  }
  return { merged, changed };
}

function valueEmpty(v) {
  if (Array.isArray(v)) {
    return !v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean).length;
  }
  return String(v == null ? "" : v).trim() === "";
}

const COVERAGE_AREAS = Object.freeze({
  current: ["now", "weekly_intention"],
  help: ["seeking", "offering", "go_to_them_for", "contribute_interests"],
  capability: ["skills", "skill_areas", "recurring_themes", "working_style", "best_contexts"],
  collaboration: ["comm_style", "availability_pref"],
  proof: ["prior_work"],
});

export function assessSelfReportCoverage(person = {}, changedFields = []) {
  const changed = [...new Set((Array.isArray(changedFields) ? changedFields : []).map(String))];
  const changedSet = new Set(changed);
  const missingEmptyFields = Object.keys(SELF_REPORT_FIELDS)
    .filter((field) => !changedSet.has(field) && valueEmpty(person ? person[field] : undefined));
  const missingEmptyDurableFields = SELF_REPORT_REQUIRED_DURABLE_FIELDS
    .filter((field) => missingEmptyFields.includes(field));
  const durableTouched = SELF_REPORT_DURABLE_FIELDS.some((field) => changedSet.has(field));
  const coreTouched = SELF_REPORT_CORE_FIELDS.filter((field) => changedSet.has(field)).length;
  const areaCoverage = {};
  for (const [area, fields] of Object.entries(COVERAGE_AREAS)) {
    areaCoverage[area] = fields.some((field) => changedSet.has(field));
  }
  const areaCount = Object.values(areaCoverage).filter(Boolean).length;
  let status = "broad";
  if (changed.length <= 2 || missingEmptyDurableFields.length) status = "thin";
  else if (areaCount < 3 || !durableTouched) status = "focused";
  return {
    status,
    changedFields: changed,
    changedCount: changed.length,
    areaCoverage,
    areaCount,
    coreTouched,
    durableTouched,
    missingEmptyFields,
    missingEmptyDurableFields,
  };
}
