#!/usr/bin/env node
// ingest-session-readouts.mjs — the distill-then-hardcode step of the
// transcript pipeline (docs/reviewed-transcript-map.md "Content Boundary
// Rules"). Takes a JSON array of public-safe session readouts produced
// from private-vault transcripts and hardcodes them into cohort data:
//
//   cohort-data/session-insights.json        canonical structured readouts
//   cohort-data/constellation-cues.json      per-team cues (app-visible)
//   cohort-data/session-readouts/<id>.md     human-readable review copy
//
// Raw transcripts never pass through this script — only distilled
// readouts vetted against the redaction rules. Re-running with the same
// input is idempotent (upsert by vault_id / cue identity).
//
// Usage: node scripts/ingest-session-readouts.mjs <readouts.json>

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT = path.join(ROOT, "cohort-data");
const INSIGHTS_PATH = path.join(COHORT, "session-insights.json");
const CUES_PATH = path.join(COHORT, "constellation-cues.json");
const READOUTS_DIR = path.join(COHORT, "session-readouts");

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CONSENT = new Set(["cohort-internal", "speaker-pending", "public-cleared"]);
// Cohort-publishable kinds. MUST stay in sync with COHORT_PUBLISHABLE_KINDS in the
// engine's scripts/lib/distillation-contract.mjs (separate repo) — the engine emits
// these. session-readout-ingest.test.mjs guards against drift. Restricted kinds
// (interview, planning) are intentionally excluded: 1:1 / strategy sessions must
// never become a cohort readout.
export const COHORT_PUBLISHABLE_KINDS = ["intros", "workshop", "salon", "standup", "hangout", "office-hours", "jam", "demo", "lecture"];
const KINDS = new Set(COHORT_PUBLISHABLE_KINDS);

// Readout-layer privacy patterns (the right layer for this — a vault_id is
// distinguishable from legit prose here, unlike the broad surface scan where a
// currency/org match would false-positive on declared team data).
const FINANCIAL_LEGAL = [
  { label: "currency figure", re: /(?:US)?\$\s?\d[\d,.]*\s?(?:k|m|bn|b|million|billion)?\b/i },
  { label: "cap-table/fundraising term", re: /\b(cap table|term sheet|valuation of|pre-money|post-money|SAFE round)\b/i },
  { label: "legal-process term", re: /\b(class action|subpoena|cease and desist|lawsuit|indictment)\b/i },
];
const BANNED_WORDS = ["very", "really", "quite", "just", "basically", "actually", "leverage", "synergy", "north star", "10x", "unlock", "paradigm", "non-trivial", "meaningful", "interesting", "tailwind", "strong fit", "strong traction"];
const NARRATION_OPENER = /^\s*the (room|session|group|team|cohort|conversation|discussion) (held|named|surfaced|argued|discussed|covered|framed|noted)/i;
const DEANON_METRIC = /\b\d[\d,]*\s*(stars|followers|users|customers|requests|tokens|seats|signups|sign-ups|waitlist)\b/i;

// Insights are objects {text, subjects, evidence_level} (engine contract) but legacy
// readouts carry bare strings; read either shape.
function insightText(i) { return typeof i === "string" ? i : String(i?.text || ""); }
function insightSubjects(i) { return i && typeof i === "object" && Array.isArray(i.subjects) ? i.subjects : []; }
function idTokens(v) { return String(v || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function rosterNameTokens(ids) { const s = new Set(); for (const id of ids) for (const t of idTokens(id)) if (t.length >= 3) s.add(t); return s; }
function readoutTexts(r) {
  const out = [r.title, r.one_liner, r.thesis, r.summary, ...(r.themes || [])];
  for (const i of r.insights || []) out.push(insightText(i));
  for (const q of r.qa || []) out.push(q.q, q.a);
  return out.filter((x) => typeof x === "string");
}

function recordIds(dir) {
  return new Set(readdirSync(path.join(COHORT, dir))
    .filter(f => f.endsWith(".md"))
    .map(f => f.replace(/\.md$/, "")));
}

function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
}

// External guest/partner names that must never appear in a readout identifier.
// Kept in the gitignored private dir so the PUBLIC repo never discloses guest names.
function externalNames() {
  const file = path.join(COHORT, ".private", "external-speakers.json");
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, "utf8")).names || []; }
  catch { return []; }
}

// Soft, non-fatal style/coverage warnings (Zinsser house style). Surfaced to the
// human reviewer; never block ingest on their own.
export function lintReadout(r) {
  const warnings = [];
  for (const text of readoutTexts(r)) {
    for (const w of BANNED_WORDS) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) warnings.push(`banned clutter word "${w}": ${text.slice(0, 70)}`);
    if (DEANON_METRIC.test(text)) warnings.push(`de-anonymizing metric: ${text.match(DEANON_METRIC)[0]}`);
  }
  for (const i of r.insights || []) if (NARRATION_OPENER.test(insightText(i))) warnings.push(`meeting-narration opener: ${insightText(i).slice(0, 70)}`);
  return warnings;
}

export function validateReadout(r, teams, people, external = []) {
  const where = `readout ${r?.vault_id || "?"}`;
  assert.match(r?.vault_id || "", SLUG, `${where}: vault_id must be a kebab-case slug`);
  if (r.date != null) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${where}: date must be ISO or null`);
  assert.ok(r.title && r.one_liner, `${where}: title and one_liner required`);
  // Editorial fields matching the cohort distillation house style: a punchy
  // thesis hook and a blogpost-style "60-second version" narrative. Each maps
  // 1:1 to a render slot (thesis = hero line, summary = lede paragraph).
  assert.ok(typeof r.thesis === "string" && r.thesis.trim(), `${where}: thesis (one-line hook) required`);
  assert.ok(typeof r.summary === "string" && r.summary.trim(), `${where}: summary (blogpost-style narrative) required`);
  assert.ok(KINDS.has(r.kind), `${where}: kind must be one of ${[...KINDS].join("|")}`);
  assert.ok(CONSENT.has(r.consent), `${where}: consent must be one of ${[...CONSENT].join("|")}`);
  assert.ok(Array.isArray(r.themes) && r.themes.length, `${where}: themes required`);
  assert.ok(Array.isArray(r.insights) && r.insights.length, `${where}: insights required`);
  for (const i of r.insights) assert.ok(insightText(i).trim(), `${where}: each insight needs non-empty text`);
  for (const id of r.teams || []) assert.ok(teams.has(id), `${where}: unknown team record_id ${id}`);
  for (const id of r.people || []) assert.ok(people.has(id), `${where}: unknown person record_id ${id}`);
  // Per-insight subjects must be roster ids, and every team/person tag must be the
  // subject of >=1 insight (no orphan tags). Only enforced on the structured shape.
  const structured = r.insights.every((i) => i && typeof i === "object" && Array.isArray(i.subjects));
  if (structured) {
    const subjectSet = new Set();
    for (const i of r.insights) for (const s of insightSubjects(i)) {
      assert.ok(teams.has(s) || people.has(s), `${where}: insight subject not in roster: ${s}`);
      subjectSet.add(s);
    }
    for (const id of r.teams || []) assert.ok(subjectSet.has(id), `${where}: orphan team tag (no insight references it): ${id}`);
    for (const id of r.people || []) assert.ok(subjectSet.has(id), `${where}: orphan person tag (no insight references it): ${id}`);
  }
  // Privacy: no financial/legal specifics anywhere, and no human name inside an
  // identifier (vault_id/title/one_liner are not consent-bearing).
  for (const text of readoutTexts(r)) {
    for (const rule of FINANCIAL_LEGAL) {
      assert.ok(!rule.re.test(text), `${where}: ${rule.label} must be generalized: "${(text.match(rule.re) || [])[0]}"`);
    }
  }
  const nameTokens = rosterNameTokens(people);
  const externalTokens = new Set();
  for (const n of external) for (const t of idTokens(n)) if (t.length >= 3) externalTokens.add(t);
  for (const field of ["vault_id", "title", "one_liner"]) {
    for (const tok of idTokens(r[field])) {
      assert.ok(!nameTokens.has(tok), `${where}: ${field} contains a cohort name token "${tok}" — name it by team/topic`);
      assert.ok(!externalTokens.has(tok), `${where}: ${field} contains an external/guest name token "${tok}"`);
    }
  }
  for (const ref of r.references || []) {
    assert.ok(ref.label, `${where}: reference needs a label`);
    if (ref.href != null) assert.match(ref.href, /^https?:\/\//, `${where}: reference href must be a public URL or null`);
  }
  for (const cue of r.cues || []) {
    assert.ok(cue.label && cue.excerpt, `${where}: cue needs label and excerpt`);
    for (const id of cue.teams || []) assert.ok(teams.has(id), `${where}: cue references unknown team ${id}`);
  }
  // The whole readout must never reference repo transcript paths.
  assert.ok(!JSON.stringify(r).includes("raw-scripts/"), `${where}: must not reference raw-scripts paths`);
}

function readoutMarkdown(r) {
  const lines = [
    "---",
    `vault_id: ${r.vault_id}`,
    `date: ${r.date || "null"}`,
    `title: ${JSON.stringify(r.title)}`,
    `kind: ${r.kind}`,
    `consent: ${r.consent}`,
    `teams: [${(r.teams || []).join(", ")}]`,
    `people: [${(r.people || []).join(", ")}]`,
    `source: private-vault:${r.vault_id}`,
    "---",
    "",
    `# ${r.title}`,
    "",
    `**${r.thesis}**`,
    "",
    `*${r.one_liner}*`,
    "",
    "## the 60-second version",
    "",
    r.summary,
    "",
    "## insights",
    "",
    ...(r.insights || []).map(i => `- ${insightText(i)}`),
    "",
    "## themes",
    "",
    ...(r.themes || []).map(t => `- ${t}`),
  ];
  if ((r.qa || []).length) {
    lines.push("", "## q&a", "");
    for (const { q, a } of r.qa) lines.push(`**Q: ${q}**`, "", a, "");
  }
  if ((r.references || []).length) {
    lines.push("", "## references", "");
    for (const ref of r.references) {
      lines.push(ref.href ? `- [${ref.label}](${ref.href})` : `- ${ref.label}`);
    }
  }
  lines.push("", "## provenance", "",
    `Distilled from a private-vault transcript (\`${r.vault_id}\`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: \`${r.consent}\`.`);
  if (r.consent === "speaker-pending") {
    lines.push("",
      "This session included external or featured speakers. The readout is held to thematic, unattributed distillation; a richer version requires a speaker consent pass.");
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: node scripts/ingest-session-readouts.mjs <readouts.json>");
    return 1;
  }
  const incoming = JSON.parse(readFileSync(path.resolve(input), "utf8"));
  assert.ok(Array.isArray(incoming) && incoming.length, "input must be a non-empty JSON array");

  const teams = recordIds("teams");
  const people = recordIds("people");
  const external = externalNames();
  for (const r of incoming) validateReadout(r, teams, people, external);
  // Soft style/coverage warnings for the reviewer (never block ingest).
  for (const r of incoming) {
    const warnings = lintReadout(r);
    for (const w of warnings) console.warn(`  ⚠ ${r.vault_id}: ${w}`);
  }

  // Upsert canonical insights (cues live in constellation-cues.json).
  const existing = loadJson(INSIGHTS_PATH, []);
  const byId = new Map(existing.map(r => [r.vault_id, r]));
  for (const r of incoming) {
    const { cues, ...rest } = r;
    byId.set(r.vault_id, { ...rest, source: `private-vault:${r.vault_id}` });
  }
  const merged = [...byId.values()].sort((a, b) => {
    const ad = a.date || "9999-99-99";
    const bd = b.date || "9999-99-99";
    return ad !== bd ? ad.localeCompare(bd) : a.vault_id.localeCompare(b.vault_id);
  });
  writeFileSync(INSIGHTS_PATH, `${JSON.stringify(merged, null, 2)}\n`);

  // Append per-team cues, dedup by (source, label).
  const cues = loadJson(CUES_PATH, []);
  const cueKeys = new Set(cues.map(c => `${c.source}|${c.label}`));
  let cuesAdded = 0;
  for (const r of incoming) {
    for (const cue of r.cues || []) {
      const source = `private-vault:${r.vault_id}`;
      if (cueKeys.has(`${source}|${cue.label}`)) continue;
      cueKeys.add(`${source}|${cue.label}`);
      cues.push({ teams: cue.teams || [], label: cue.label, source, excerpt: cue.excerpt });
      cuesAdded += 1;
    }
  }
  writeFileSync(CUES_PATH, `${JSON.stringify(cues, null, 2)}\n`);

  // Human-readable review copies.
  mkdirSync(READOUTS_DIR, { recursive: true });
  for (const r of incoming) {
    writeFileSync(path.join(READOUTS_DIR, `${r.vault_id}.md`), readoutMarkdown(r));
  }

  console.log(`session insights: ${merged.length} total (${incoming.length} ingested)`);
  console.log(`constellation cues: ${cues.length} total (+${cuesAdded})`);
  console.log(`readout markdown: ${incoming.length} files in cohort-data/session-readouts/`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}

export { KINDS, main };
