// build-cohort-connections.mjs — the DAILY connection routine.
//
// Computes the cohort connection graph ("who should talk to whom") from the
// public cohort markdown and writes it to
// cohort-data/artifacts/connections/generated/connections.json. Designed to be
// run by an organizer with their OWN local AI CLI (Claude Code / Codex / Ollama)
// — no API key, nothing called from the shipped app. The app only ever READS the
// published edges (see apps/os/src/renderer/supabase-connections.mjs).
//
// Pipeline:
//   1. Load teams + people + clusters + dependencies from cohort-data/.
//   2. Compute recent-activity recency per team from the github-progress /
//      github-releases artifacts (so active projects surface).
//   3. Deterministic pass (scripts/lib/cohort-connections-engine.mjs) — the
//      reliable baseline + the candidate set handed to the LLM.
//   4. LLM pass via the operator's local CLI — richer reasons + implicit needs
//      the rules miss. Degrades to the deterministic graph if no CLI / bad JSON.
//   5. Merge (LLM wins on collisions, deterministic fills gaps) -> artifact.
//
// Flags:
//   --no-llm           deterministic only (skip the local AI pass)
//   --publish          also upsert to Supabase (needs SUPABASE_* env)
//   --out <path>       artifact path override
//   --per-record <n>   max edges per source (default 6)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { deterministicEdges, mergeEdges, parseLlmEdges, recordSignals } from "./lib/cohort-connections-engine.mjs";
import { runLocalAi, resolveLlmCommand } from "./lib/local-ai-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT_DIR = path.join(ROOT, "cohort-data");
const OUT_DEFAULT = path.join(COHORT_DIR, "artifacts", "connections", "generated", "connections.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(name);
}

// Parse `---`-fenced YAML frontmatter from a markdown file.
function readFrontmatter(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = yaml.load(m[1]);
    return fm && typeof fm === "object" ? fm : null;
  } catch {
    return null;
  }
}

function readDir(sub) {
  const dir = path.join(COHORT_DIR, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !/(^|[-_])example/i.test(f) && f !== "STYLE.md")
    .map((f) => readFrontmatter(path.join(dir, f)))
    .filter(Boolean);
}

// Per-team activity recency in [0,1] from the github-progress / -releases
// artifacts. More recent/voluminous public work => higher, so the engine can
// nudge "active + interesting" teams up the suggestion list.
export function loadActivity() {
  const counts = new Map();
  const bump = (id, n) => { if (!id) return; counts.set(id, (counts.get(id) || 0) + n); };
  for (const sub of ["github-progress", "github-releases"]) {
    const dir = path.join(COHORT_DIR, "artifacts", sub, "generated");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "manifest.json") continue;
      let a;
      try { a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const id = String(a.record_id || "");
      const n = Number(a.useful_commit_count || (Array.isArray(a.releases) ? a.releases.length : 0) || (Array.isArray(a.commits) ? a.commits.length : 0) || 1);
      bump(id, Number.isFinite(n) ? n : 1);
    }
  }
  const max = Math.max(1, ...counts.values());
  const norm = new Map();
  for (const [id, n] of counts) norm.set(id, Math.min(1, n / max));
  return norm;
}

function loadCorpus() {
  const teams = readDir("teams").map((r) => ({ ...r, record_type: "team" }));
  const people = readDir("people").map((r) => ({ ...r, record_type: "person" }));
  const clusters = readDir("clusters");
  const dependencies = readDir("dependencies");
  return { teams, people, clusters, dependencies };
}

// A compact, grounded corpus the LLM can reason over without the whole repo.
function recordDigest(r) {
  const sig = recordSignals(r);
  const fields = [];
  if (sig.focus) fields.push(`focus: ${sig.focus}`);
  if (sig.now) fields.push(`now: ${sig.now}`);
  if (sig.seekPhrases.length) fields.push(`seeking: ${sig.seekPhrases.slice(0, 4).join("; ")}`);
  if (sig.offerPhrases.length) fields.push(`offering: ${sig.offerPhrases.slice(0, 5).join("; ")}`);
  if (r.skill_areas) fields.push(`skills: ${(Array.isArray(r.skill_areas) ? r.skill_areas : []).join(", ")}`);
  return `- ${sig.id} (${sig.type}, "${sig.name}") :: ${fields.join(" | ")}`;
}

function buildPrompt({ records, candidates }) {
  const ids = records.map((r) => String(r.record_id)).filter(Boolean);
  const corpus = records.map(recordDigest).join("\n");
  const cand = candidates.slice(0, 120).map((e) => `${e.from} -> ${e.to} (${e.kind}, ${e.score})`).join("\n");
  return [
    "You are the cohort connector for a startup accelerator. Your job: find the most useful, NON-OBVIOUS connections between members — who should talk to whom, and exactly why, grounded ONLY in the records below.",
    "",
    "Rules:",
    "- Use ONLY these record ids; never invent ids or facts. Valid ids:",
    `  ${ids.join(", ")}`,
    "- Each edge is directional: from = the member who should reach out, to = the member worth talking to.",
    "- Prefer concrete complementarity: a stated need met by another's offering, a shared hard problem, a dependency, a skill one has that another is missing.",
    "- The `reason` must be specific and cite the actual need/offer (1–2 sentences). No filler.",
    "- score is 0..1 (how strong/useful the connection is).",
    "",
    "Records:",
    corpus,
    "",
    "Deterministic candidate edges already found (refine, re-rank, add the ones rules miss; drop weak ones):",
    cand,
    "",
    'Return ONLY JSON: {"edges":[{"from":"id","to":"id","score":0.0,"kind":"seeking-offering|skill-overlap|dependency|shared-problem|complementary","reason":"..."}]}',
  ].join("\n");
}

async function main() {
  const { teams, people, clusters, dependencies } = loadCorpus();
  const records = [...teams, ...people];
  const validIds = new Set(records.map((r) => String(r.record_id)).filter(Boolean));
  const activityById = loadActivity();
  const perRecord = Number(arg("--per-record", "6")) || 6;

  const deterministic = deterministicEdges(records, { dependencies, clusters, activityById, perRecord });
  console.log(`[connections] ${records.length} records (${teams.length} teams, ${people.length} people) -> ${deterministic.length} deterministic edges`);

  let edges = deterministic;
  let generator = "deterministic";

  if (!flag("--no-llm")) {
    const cmd = resolveLlmCommand();
    if (!cmd) {
      console.warn("[connections] no local AI CLI found (set COHORT_LLM_CMD or install claude/codex/ollama) — using deterministic graph only");
    } else {
      console.log(`[connections] running local AI: ${cmd.join(" ")}`);
      const prompt = buildPrompt({ records, candidates: deterministic });
      const res = await runLocalAi(prompt, { cmd });
      if (res.ok) {
        const llm = parseLlmEdges(res.text);
        if (llm.length) {
          edges = mergeEdges(llm, deterministic, { validIds, perRecord });
          generator = `local-ai:${cmd[0]}`;
          console.log(`[connections] local AI returned ${llm.length} edges -> ${edges.length} merged`);
        } else {
          console.warn("[connections] local AI output had no parseable edges — using deterministic graph");
        }
      } else {
        console.warn(`[connections] local AI failed (${res.reason}: ${res.detail || ""}) — using deterministic graph`);
      }
    }
  }

  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator,
    edge_count: edges.length,
    edges,
  };

  const outPath = arg("--out", OUT_DEFAULT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[connections] wrote ${edges.length} edges -> ${path.relative(ROOT, outPath)} (generator=${generator})`);

  if (flag("--publish")) {
    const { publishConnections } = await import("./publish-connections-to-supabase.mjs");
    const r = await publishConnections({ payload });
    console.log(r.skipped ? `[connections] publish skipped — ${r.reason}` : `[connections] published ${r.edges} edges (HTTP ${r.status})`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(`[connections] ${e.stack || e.message}`); process.exit(1); });
}
