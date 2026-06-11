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
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT = path.join(ROOT, "cohort-data");
const INSIGHTS_PATH = path.join(COHORT, "session-insights.json");
const CUES_PATH = path.join(COHORT, "constellation-cues.json");
const READOUTS_DIR = path.join(COHORT, "session-readouts");

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const CONSENT = new Set(["cohort-internal", "speaker-pending", "public-cleared"]);
const KINDS = new Set(["intros", "workshop", "lecture", "salon", "hangout", "standup"]);

function recordIds(dir) {
  return new Set(readdirSync(path.join(COHORT, dir))
    .filter(f => f.endsWith(".md"))
    .map(f => f.replace(/\.md$/, "")));
}

function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
}

function validateReadout(r, teams, people) {
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
  for (const id of r.teams || []) assert.ok(teams.has(id), `${where}: unknown team record_id ${id}`);
  for (const id of r.people || []) assert.ok(people.has(id), `${where}: unknown person record_id ${id}`);
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
    "## themes",
    "",
    ...(r.themes || []).map(t => `- ${t}`),
    "",
    "## insights",
    "",
    ...(r.insights || []).map(i => `- ${i}`),
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
  for (const r of incoming) validateReadout(r, teams, people);

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

process.exitCode = main();
