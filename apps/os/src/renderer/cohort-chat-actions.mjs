// cohort-chat-actions.mjs — the action contract behind the agentic cohort chat.
//
// Pure + deterministic + node-testable (no fs / network / DOM / localStorage). It
// is the SECURITY BOUNDARY between the member's local LLM and the app's write
// channels: the model may EMIT structured action blocks, but it can never make the
// app DO anything that isn't on this whitelist, sanitized here, and (for writes)
// human/operator-approved downstream.
//
// The discipline mirrors self-report-synth.mjs (parse the LAST balanced JSON out
// of noisy CLI stdout, then whitelist/clamp the result — never trust the model):
//   1. parseChatActions() scans stdout for action objects ({action, args} or a
//      {actions:[...]} batch), string-awarely so a brace inside a free-text value
//      doesn't mis-balance the scan.
//   2. each action is matched to a verb in ACTIONS and run through that verb's
//      sanitizer; anything unknown, malformed, or about an unknown record is
//      DROPPED (not best-effort repaired).
//   3. proposal verbs are PROVENANCE-STAMPED app-side from the caller's identity
//      (NOT from the model): origin = { proposer_record_id, proposer_claim_hash,
//      is_self }. is_self is derived (subject === proposer), so a third-party
//      proposal (is_self=false) is the checkable "this is from someone else"
//      signal the inbox + operators triage. The model proposes CONTENT; the app
//      decides WHO is proposing.
//
// Nothing here writes anything. Execution (saveProfileProposal / emitConnection /
// emitContest / the local scan doors) lives in the impure wiring
// (cohort-chat.js), which calls parseChatActions, renders a HITL review, and only
// then routes approved actions to the existing gated channels.

// ── field whitelist (the os_profile_updates delta surface) ────────────────────
// The self-declared self-report fields (self-report-synth.mjs SELF_REPORT_FIELDS)
// PLUS the identity-location fields the agent keeps
// current — geo + links.github + links.repo. This MUST stay in lockstep with the
// os_profile_updates delta whitelist CHECK (latest os_profile_updates migration);
// the DB re-asserts it.
export const PROPOSABLE_PROFILE_FIELDS = Object.freeze({
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
  geo: "string",
  links: "links", // object, scoped to { github, repo }
});

// ── team field whitelist (the award-evidence surface) ─────────────────────────
// When the proposal subject is a TEAM (the member's focused project), the delta is
// drawn from the team award-evidence fields instead of the personal ones — this is
// what makes "Best Shape Rotation" (journey) and "Best Team–Product Fit" (traction /
// shipping) legible. MUST stay in lockstep with the os_profile_updates whitelist
// CHECK once the Engine migration widens it to team subjects; until then a team
// delta is well-formed here but rejected server-side (fail-closed, never silent).
export const PROPOSABLE_TEAM_FIELDS = Object.freeze({
  traction: "string",
  prior_shipping: "list",
  success_dimensions: "list",
  journey: "journey", // nested PMF object — sanitized field-by-field below
});

// The journey sub-schema (cohort-data/schema.yml teams.journey). Bounded numerics,
// closed enums, and free-text notes — anything off-schema is dropped.
const JOURNEY_INT = Object.freeze({ stage: [1, 8], evidence_quality: [1, 5], market_upside: [1, 5] });
const JOURNEY_ENUM = Object.freeze({
  primary_bottleneck: new Set(["ICP Clarity", "Pain Intensity", "Solution Quality", "Technical Risk", "GTM", "Retention", "Business Model", "Fundraising", "Regulatory", "Team"]),
  company_type: new Set(["B2B", "Consumer", "Infra", "Marketplace", "Protocol", "AI", "Other"]),
  confidence: new Set(["Low", "Medium", "High"]),
});
const JOURNEY_TEXT = Object.freeze(["icp", "problem", "solution", "evidence_notes", "next_milestone"]);

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

// Whitelist + coerce a nested journey object. Returns null when nothing survives.
export function sanitizeJourney(src) {
  if (!src || typeof src !== "object" || Array.isArray(src)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(JOURNEY_INT)) {
    if (k in src) { const n = clampInt(src[k], lo, hi); if (n != null) out[k] = n; }
  }
  for (const [k, set] of Object.entries(JOURNEY_ENUM)) {
    if (k in src) { const s = clampOne(src[k], 64); if (set.has(s)) out[k] = s; }
  }
  for (const k of JOURNEY_TEXT) {
    if (k in src) { const s = clampStr(src[k]); if (s) out[k] = s; }
  }
  return Object.keys(out).length ? out : null;
}

// Whitelist + coerce a proposed TEAM delta to PROPOSABLE_TEAM_FIELDS.
export function sanitizeTeamFields(fields) {
  const clean = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return clean;
  for (const [key, kind] of Object.entries(PROPOSABLE_TEAM_FIELDS)) {
    if (!(key in fields)) continue;
    if (kind === "string") { const s = clampStr(fields[key]); if (s) clean[key] = s; }
    else if (kind === "list") { const l = clampList(fields[key]); if (l.length) clean[key] = l; }
    else if (kind === "journey") { const j = sanitizeJourney(fields[key]); if (j) clean.journey = j; }
  }
  return clean;
}

// The verbs the agent may emit. Anything else parsed from stdout is discarded.
export const ACTION_TYPES = Object.freeze([
  "propose_profile_update", // draft a delta for ANY member's profile (provenance-stamped)
  "propose_connection",     // "X should talk to Y" → cohort_events connection event
  "file_contest",           // "this card looks off" → public_card_contests
  "request_scan",           // ask to read local sessions / public github (consent-gated tool)
  "ask",                    // a clarifying question surfaced to the member (self-questioning)
  "note",                   // free-text the agent wants shown (terminal display)
]);

const STRING_MAX = 280;
const LIST_MAX = 12;
const ITEM_MAX = 140;
const REASON_MAX = 400;
const ID_MAX = 128;
export const MAX_ACTIONS_PER_TURN = 6;

// The contest reason vocab — mirrors supabase-contest.mjs CONTEST_KINDS (kept
// inline so this security module stays import-free; the durable write re-checks).
export const CONTEST_KINDS = Object.freeze([
  "stale_declaration", "off_github_work", "wrong_attribution", "context_missing",
]);

// ── value coercion (mirrors self-report-synth.mjs clampOne) ───────────────────
// Coerce ONE value to a bounded string; reject non-primitives; trim a dangling
// high surrogate left by slicing at an odd UTF-16 boundary.
function clampOne(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  let s = String(v).trim();
  if (!s) return "";
  s = s.slice(0, max);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return s;
}
function clampStr(v) { return clampOne(v, STRING_MAX); }
function clampList(v) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  for (const item of arr) {
    const s = clampOne(item, ITEM_MAX);
    if (s) out.push(s);
    if (out.length >= LIST_MAX) break;
  }
  return out;
}

// ── github "location" normalizers (kept inline so this module stays standalone;
// they match gh-self-report.mjs::normalizeHandle / gh-user.js shapes) ──────────
export function normalizeGithubHandle(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^@+/, "");
  const m = s.match(/github\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.split(/[/?#]/)[0].trim();
  // a github username is 1–39 chars, alnum or single hyphens; reject anything else.
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(s) ? s : "";
}
export function normalizeGithubRepo(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  const m = s.match(/github\.com\/([^/?#]+\/[^/?#]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@+/, "").replace(/\.git$/i, "").split(/[?#]/)[0].trim();
  const parts = s.split("/").filter(Boolean);
  if (parts.length !== 2) return "";
  const owner = normalizeGithubHandle(parts[0]);
  const repo = parts[1].trim();
  if (!owner || !/^[\w.-]{1,100}$/.test(repo)) return "";
  return `${owner}/${repo}`;
}

// Whitelist + coerce a proposed profile delta to PROPOSABLE_PROFILE_FIELDS. Drops
// off-whitelist keys, empties, and (for links) anything outside github/repo.
// Returns a clean object suitable for the os_profile_updates `delta`.
export function sanitizeProfileFields(fields, { allowedSkillAreas } = {}) {
  const clean = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return clean;
  for (const [key, kind] of Object.entries(PROPOSABLE_PROFILE_FIELDS)) {
    if (!(key in fields)) continue;
    if (kind === "string") {
      const s = clampStr(fields[key]);
      if (s) clean[key] = s;
    } else if (kind === "list") {
      let list = clampList(fields[key]);
      if (key === "skill_areas" && allowedSkillAreas instanceof Set) {
        list = list.filter((x) => allowedSkillAreas.has(x));
      }
      if (list.length) clean[key] = list;
    } else if (kind === "links") {
      const src = fields[key];
      if (!src || typeof src !== "object" || Array.isArray(src)) continue;
      const links = {};
      const gh = normalizeGithubHandle(src.github);
      const repo = normalizeGithubRepo(src.repo);
      if (gh) links.github = gh;
      if (repo) links.repo = repo;
      if (Object.keys(links).length) clean.links = links;
    }
  }
  return clean;
}

function clampId(v) {
  const s = String(v == null ? "" : v).trim();
  return s && s.length <= ID_MAX ? s : "";
}
// A subject id is acceptable if it's well-formed AND (when a known-id set is
// supplied) actually names a cohort record — so the model can't invent people.
function subjectOk(id, knownRecordIds) {
  if (!id) return false;
  if (knownRecordIds instanceof Set && knownRecordIds.size) return knownRecordIds.has(id);
  return true;
}

// Stamp who is proposing, computed from the caller's identity — never the model.
// `subjectId` is the record the proposal is ABOUT.
function stampOrigin(subjectId, ctx) {
  const proposer = clampId(ctx && ctx.proposerRecordId);
  return {
    proposer_record_id: proposer || null,
    proposer_claim_hash: (ctx && ctx.proposerClaimHash) ? String(ctx.proposerClaimHash).slice(0, 128) : null,
    is_self: !!proposer && proposer === subjectId,
  };
}

// ── per-verb sanitizers: raw args → normalized action, or null to DROP ─────────
const ACTIONS = {
  propose_profile_update(args, ctx) {
    const subject = clampId(args.subject_record_id || args.record_id);
    if (!subjectOk(subject, ctx.knownRecordIds)) return null;
    // A TEAM subject draws from the award-evidence whitelist (journey/traction/
    // shipping); a PERSON from the personal one. is_self (stampOrigin) is naturally
    // false for a team — a person id never equals a team id — so team edits always
    // land pending the operator/daily review, never auto-applied.
    const isTeam = ctx.knownTeamIds instanceof Set && ctx.knownTeamIds.has(subject);
    const delta = isTeam
      ? sanitizeTeamFields(args.fields || args.delta)
      : sanitizeProfileFields(args.fields || args.delta, { allowedSkillAreas: ctx.allowedSkillAreas });
    if (!Object.keys(delta).length) return null; // nothing proposable ⇒ no action
    return {
      action: "propose_profile_update",
      subject_record_id: subject,
      subject_type: isTeam ? "team" : "person",
      delta,
      rationale: clampOne(args.rationale || args.reason, REASON_MAX),
      origin: stampOrigin(subject, ctx),
    };
  },
  propose_connection(args, ctx) {
    const from = clampId(args.from_record_id);
    const to = clampId(args.to_record_id);
    if (!subjectOk(from, ctx.knownRecordIds) || !subjectOk(to, ctx.knownRecordIds)) return null;
    if (from === to) return null;
    return {
      action: "propose_connection",
      from_record_id: from,
      to_record_id: to,
      reason: clampOne(args.reason || args.why, REASON_MAX),
      origin: stampOrigin(from, ctx), // is_self ⇒ "I'm proposing my OWN connection"
    };
  },
  file_contest(args, ctx) {
    const subject = clampId(args.subject_record_id || args.record_id);
    if (!subjectOk(subject, ctx.knownRecordIds)) return null;
    const kind = clampOne(args.contest_kind, 64);
    if (!CONTEST_KINDS.includes(kind)) return null;
    return {
      action: "file_contest",
      subject_record_id: subject,
      contest_kind: kind,
      card_kind: clampOne(args.card_kind, 64) || null,
      card_id: clampOne(args.card_id, ID_MAX) || null,
      note: clampOne(args.note, REASON_MAX),
      origin: stampOrigin(subject, ctx),
    };
  },
  request_scan(args) {
    const want = Array.isArray(args.sources) ? args.sources : [args.source];
    const sources = [...new Set(want.map((s) => String(s || "").toLowerCase().trim()))]
      .filter((s) => s === "sessions" || s === "github");
    if (!sources.length) return null;
    return { action: "request_scan", sources };
  },
  ask(args) {
    const question = clampOne(args.question || args.text, REASON_MAX);
    return question ? { action: "ask", question } : null;
  },
  note(args) {
    const text = clampOne(args.text || args.note, 1000);
    return text ? { action: "note", text } : null;
  },
};

// Sanitize ONE candidate action object → a normalized action, or null to drop it.
export function sanitizeAction(raw, ctx = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const verb = String(raw.action || raw.type || "").trim();
  if (!ACTION_TYPES.includes(verb) || typeof ACTIONS[verb] !== "function") return null;
  // args may be nested under `args`/`params`, or splatted onto the object itself.
  const args = (raw.args && typeof raw.args === "object") ? raw.args
    : (raw.params && typeof raw.params === "object") ? raw.params
    : raw;
  try { return ACTIONS[verb](args, ctx); } catch { return null; }
}

// ── stdout → candidate JSON objects (string-aware balanced scan) ──────────────
// Mirrors self-report-synth.mjs's scanner: a brace inside a free-text string value
// must not mis-balance the scan, and agentic CLIs prepend reasoning/ANSI before
// the answer. Returns every top-level balanced object (and ```json fences) as
// strings, in document order.
const ANSI_RE = /[][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d/#&.:=?%@~_-]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
export function stripAnsi(s) { return String(s == null ? "" : s).replace(ANSI_RE, "").replace(/\r/g, ""); }

export function extractJsonChunks(raw) {
  const text = stripAnsi(raw).trim();
  const chunks = [];
  if (!text) return chunks;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) chunks.push(fence[1].trim());
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
    chunks.push(text.slice(a, end + 1));
    a = end;
  }
  return chunks;
}

function tryObj(str) {
  try { const v = JSON.parse(str); return v && typeof v === "object" ? v : null; }
  catch { return null; }
}

// Parse the LAST action-bearing block out of the CLI's stdout into a validated,
// capped list of normalized actions. Accepts either a single {action,...} object,
// a {actions:[...]} batch, or a bare top-level array. Returns { actions, raw }
// where `actions` is already whitelisted/sanitized/stamped and safe to review.
export function parseChatActions(rawStdout, ctx = {}, { max = MAX_ACTIONS_PER_TURN } = {}) {
  const chunks = extractJsonChunks(rawStdout);
  // Collect candidate action OBJECTS, preferring the LAST batch (the answer comes
  // last; earlier blocks are usually the echoed prompt / reasoning).
  let candidates = null;
  for (let i = chunks.length - 1; i >= 0 && !candidates; i--) {
    const v = tryObj(chunks[i]);
    if (!v) continue;
    if (Array.isArray(v.actions)) candidates = v.actions;
    else if (Array.isArray(v)) candidates = v;
    else if (v.action || v.type) candidates = [v];
  }
  if (!candidates) return { actions: [], raw: rawStdout };
  const actions = [];
  for (const cand of candidates) {
    const a = sanitizeAction(cand, ctx);
    if (a) actions.push(a);
    if (actions.length >= max) break;
  }
  return { actions, raw: rawStdout };
}
