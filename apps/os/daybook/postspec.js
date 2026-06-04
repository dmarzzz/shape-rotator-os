'use strict';

// ─────────────────────────────────────────────────────────────────────────
// LOCKED post contract (v1).
//
// The single machine-readable source of truth for what a Router daily post
// must be. Both sides read from here so they can never drift:
//   • src/reflect.js  — builds the generator prompt from these constants.
//   • evals/gates.js  — checks a drafted post against them.
//
// Changing anything here is a deliberate version bump (RUBRIC_VERSION), not a
// casual edit — the eval framework and the prompt move together or not at all.
// The prose companion is evals/rubric.md.
// ─────────────────────────────────────────────────────────────────────────

// v2: connections must be TRULY USEFUL or omitted. A forced/plausible @-mention
// scores worse than none; restraint (no mention) is full marks (D1/D3).
// v3: the same restraint governs STRUGGLES and ASKS. Only Wins and Insight are
// required; Struggles (real friction only) and Asking (a genuine OPEN, unsolved
// need only) are optional — a normal design decision or a solved problem is
// neither a struggle nor an ask. No "always end on an ask."
// v4: ASKS are WEIGHTED BY IMPORTANCE AND URGENCY. A trivial-but-honest question
// (an internal implementation detail like which variable or nav pattern) is NOT
// a good ask — it doesn't matter to the cohort. The high-value asks are help
// testing/trying what he shipped, feedback on whether/how people would use it,
// a high-stakes direction call, or a problem he's genuinely stuck on. PREFER a
// high-value ask when one is naturally available (he shipped something the
// cohort could try or opine on); omission is full marks ONLY when the work was
// genuinely internal/no-stakes with nothing worth others' input. Surface the
// important thing — but don't omit an available high-value ask either. See
// evals/rubric.md D2.
const RUBRIC_VERSION = 4;

// The body lead-ins, in canonical order. Only Wins and Insight are required.
// Struggles, Offering, and Asking are optional — included ONLY when genuine
// (real friction / a real match / a real open need), never manufactured to
// fill a section. No lead-in is forced to be last.
const LEAD_INS = ['Wins', 'Struggles', 'Insight', 'Offering', 'Asking'];
const REQUIRED_LEAD_INS = ['Wins', 'Insight'];
const OPTIONAL_LEAD_INS = ['Struggles', 'Offering', 'Asking'];
const FINAL_LEAD_IN = null;

// Body word count window. The prompt aims for ~220–360; the gate is a little
// wider so a good post isn't failed for a few words either way.
const LENGTH = { min: 180, max: 400 };

// Scored dimensions D1–D6 are each 0–3 → 18 max. A post passes the locked eval
// iff all hard gates pass AND the judge score is at least THRESHOLD.
const SCORE_MAX = 18;
const THRESHOLD = 14;

// ── Banned phrasings (G3) ─────────────────────────────────────────────────
// The hedge / vague-verb / blanket-openness register that reads as lame and
// empty. Each entry is a case-insensitive regex tested against the post text.
// `label` is what the gate reports when it fires. reflect.js renders `example`
// into the prompt's "BANNED PHRASINGS" list so the generator avoids the exact
// same set the gate enforces.
const BANNED = [
  { label: 'compare notes',        example: 'compare notes',          re: /\bcompare notes\b/i },
  { label: 'pick your brain',      example: 'pick your brain',        re: /\bpick (?:your|his|their) brain\b/i },
  { label: 'swap ideas',           example: 'swap ideas',             re: /\bswap(?:ping)? ideas\b/i },
  { label: 'trade notes',          example: 'trade notes',            re: /\btrade notes\b/i },
  { label: 'sync up',              example: 'sync up',                re: /\bsync(?:ing)? up\b/i },
  { label: 'jam on',               example: 'jam on',                 re: /\bjam(?:ming)? on\b/i },
  { label: 'happy to chat',        example: 'happy to chat',          re: /\bhappy to (?:chat|talk|connect)\b/i },
  { label: 'down to chat',         example: 'always down to talk',    re: /\b(?:always )?down to (?:chat|talk)\b/i },
  { label: 'open to collaboration',example: 'open to collaboration',  re: /\bopen to (?:collaborat\w+|chatting|connecting)\b/i },
  { label: 'would be glad to',     example: 'would be glad to…',      re: /\bwould (?:be glad|love) to\b/i },
  { label: 'would welcome',        example: 'would welcome',          re: /\bwould welcome\b/i },
  { label: 'reach out',            example: 'feel free to reach out', re: /\b(?:feel free to |do )?reach out\b/i },
  { label: 'explore synergies',    example: 'explore synergies',      re: /\b(?:explore|find) synerg\w+/i },
  { label: 'if anyone has/is',     example: 'if anyone has built…',   re: /\bif anyone (?:has|is|'s|wants|knows)\b/i },
  { label: 'should anyone',        example: 'should anyone be…',      re: /\bshould anyone\b/i },
  { label: 'let me know',          example: 'let me know if…',        re: /\blet (?:me|him|them) know if\b/i },
];

// True iff `text` contains any banned phrasing; returns the matches found.
function findBanned(text) {
  const s = String(text || '');
  return BANNED.filter((b) => b.re.test(s)).map((b) => b.label);
}

module.exports = {
  RUBRIC_VERSION,
  LEAD_INS, REQUIRED_LEAD_INS, OPTIONAL_LEAD_INS, FINAL_LEAD_IN,
  LENGTH, SCORE_MAX, THRESHOLD,
  BANNED, findBanned,
};
