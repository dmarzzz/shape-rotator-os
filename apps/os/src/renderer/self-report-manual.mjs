// self-report-manual.mjs -- no-scan, member-authored profile updates.
//
// This is the privacy-forward sibling of the local-AI self-report flow. The
// member answers only the questions they want to answer; empty answers are
// ignored, and the same self-report whitelist gates the final Supabase delta.

import { parseSelfReportDelta, sanitizeDelta } from "./self-report-synth.mjs";

export const MANUAL_SELF_REPORT_QUESTIONS = Object.freeze([
  {
    field: "now",
    label: "What are you focused on now?",
    hint: "One present-tense line.",
    type: "string",
    placeholder: "Building a demoable agent workflow for...",
  },
  {
    field: "weekly_intention",
    label: "What is your next concrete aim?",
    hint: "This week or the next visible milestone.",
    type: "string",
    placeholder: "Get two users through the new onboarding loop.",
  },
  {
    field: "seeking",
    label: "What help would be useful?",
    hint: "One item per line works best.",
    type: "list",
    placeholder: "Design partner intros\nFeedback on the demo flow",
  },
  {
    field: "offering",
    label: "What can you offer others?",
    hint: "Skills, review, intros, tools, or time.",
    type: "list",
    placeholder: "TEE architecture review\nFast frontend prototyping",
  },
  {
    field: "go_to_them_for",
    label: "What should people come to you for?",
    hint: "This improves cohort routing.",
    type: "list",
    placeholder: "Private AI UX\nLocal-first workflows",
  },
  {
    field: "prior_work",
    label: "What shipped or became usable recently?",
    hint: "Only share what you are comfortable making visible.",
    type: "list",
    placeholder: "Launched the invite flow\nPublished a short technical note",
  },
  {
    field: "skills",
    label: "Which skills should your profile show?",
    hint: "Plain words; no need to over-format.",
    type: "list",
    placeholder: "TypeScript\nSupabase\nAgent tooling",
  },
  {
    field: "working_style",
    label: "How should people work with you?",
    hint: "One sentence is enough.",
    type: "string",
    placeholder: "Async first, but happy to jam on concrete blockers.",
  },
]);

const MANUAL_FIELD_SET = new Set(MANUAL_SELF_REPORT_QUESTIONS.map((q) => q.field));

const LIST_SPLIT_RE = /\r?\n|;|,(?=\s*\S)/g;

function cleanString(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

export function splitManualList(value) {
  return String(value == null ? "" : value)
    .split(LIST_SPLIT_RE)
    .map(cleanString)
    .filter(Boolean);
}

export function buildManualSelfReportDelta(answers = {}, { allowedSkillAreas } = {}) {
  const raw = {};
  for (const q of MANUAL_SELF_REPORT_QUESTIONS) {
    const value = answers[q.field];
    if (q.type === "list") {
      const items = splitManualList(value);
      if (items.length) raw[q.field] = items;
    } else {
      const text = cleanString(value);
      if (text) raw[q.field] = text;
    }
  }
  return sanitizeDelta(raw, { allowedSkillAreas });
}

function manualProfileSnapshot(person = {}) {
  const current = {};
  for (const q of MANUAL_SELF_REPORT_QUESTIONS) {
    if (person && person[q.field] != null) current[q.field] = person[q.field];
  }
  return current;
}

export function buildManualAgentPrompt({ person = {} } = {}) {
  const questions = MANUAL_SELF_REPORT_QUESTIONS
    .map((q) => `- ${q.field} (${q.type}): ${q.label} ${q.hint}`)
    .join("\n");
  return [
    "Help me draft a public Shape Rotator OS profile update.",
    "",
    "Privacy rules:",
    "- Include only information I would be comfortable showing on my public cohort profile.",
    "- Do not include private contact details, secrets, raw chat logs, private transcript text, emails, phone numbers, Telegram handles, or confidential customer names.",
    "- If you are unsure whether something is public-safe, omit it or ask me first.",
    "",
    "Allowed fields:",
    questions,
    "",
    "Current public profile values for those fields:",
    JSON.stringify(manualProfileSnapshot(person), null, 2),
    "",
    "Return STRICT JSON only, in this shape:",
    JSON.stringify({
      person: {
        now: "one present-tense line",
        weekly_intention: "one concrete next aim",
        seeking: ["help wanted"],
        offering: ["things I can help with"],
        go_to_them_for: ["routing topics"],
        prior_work: ["public-safe shipped or usable work"],
        skills: ["skills to show"],
        working_style: "one sentence on how to work with me",
      },
    }, null, 2),
    "",
    "Omit unchanged or unknown fields. Use arrays for list fields.",
  ].join("\n");
}

function manualSourceFromDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = value.person && typeof value.person === "object" && !Array.isArray(value.person)
    ? value.person
    : value;
  const out = {};
  for (const field of MANUAL_FIELD_SET) {
    if (field in nested) out[field] = nested[field];
  }
  return out;
}

export function parseManualAgentDraft(raw, opts = {}) {
  const parsed = parseSelfReportDelta(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const delta = sanitizeDelta(manualSourceFromDraft(parsed.delta), opts);
  if (!Object.keys(delta).length) return { ok: false, error: "empty_delta" };
  const answers = {};
  for (const q of MANUAL_SELF_REPORT_QUESTIONS) {
    if (!(q.field in delta)) continue;
    answers[q.field] = Array.isArray(delta[q.field]) ? delta[q.field].join("\n") : String(delta[q.field]);
  }
  return { ok: true, answers, delta };
}

export function buildManualUsefulness(delta = {}) {
  const fields = new Set(Object.keys(delta || {}));
  const areas = {};
  if (fields.has("now") || fields.has("weekly_intention")) areas.current_state = "improved";
  if (fields.has("seeking") || fields.has("offering") || fields.has("go_to_them_for")) areas.collaboration = "improved";
  if (fields.has("skills") || fields.has("working_style")) areas.findability = "improved";
  if (fields.has("prior_work")) areas.proof_history = "improved";
  if (fields.size) {
    areas.timeline = "current_state_refresh";
    areas.review_readiness = "auto_applied";
  }
  return Object.keys(areas).length
    ? { areas, suggested_actions: fields.has("seeking") || fields.has("offering") ? ["suggest_connections"] : [] }
    : {};
}
