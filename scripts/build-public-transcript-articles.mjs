#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  publicArticleBlockedNames,
  publicArticleCandidateFromReadout,
  sanitizePublicArticleText,
} = require("./lib/public-article-policy.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(ROOT, "cohort-data", "artifacts", "transcript-distillations", "generated", "manifest.json");
const DEFAULT_OUT_DIR = path.join(ROOT, "cohort-data", "artifacts", "public-transcript-articles", "generated");

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function slugify(value, fallback = "transcript-insight") {
  const slug = String(value || fallback)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function frontmatterValue(value) {
  if (value == null) return "null";
  return JSON.stringify(String(value));
}

function loadBlockedNames(root = ROOT) {
  const surface = readJson(path.join(root, "apps", "os", "src", "cohort-surface.json"), {});
  return publicArticleBlockedNames({
    teams: surface?.teams || [],
    people: surface?.people || [],
  });
}

function artifactToReadout(artifact) {
  const summary = Array.isArray(artifact.summary) ? artifact.summary.join(" ") : artifact.summary;
  const themes = Array.isArray(artifact.themes) ? artifact.themes.join(", ") : artifact.themes;
  return {
    date: artifact.starts_at || artifact.created_at || null,
    title: artifact.session_title || "Public transcript insight",
    one_liner: summary || themes || artifact.session_title || "Public-cleared transcript insight.",
    summary: summary || themes || "",
    consent: "public-cleared",
  };
}

function buildArticleBody({ artifact, candidate, blockedNames }) {
  const themes = (artifact.themes || [])
    .map((item) => sanitizePublicArticleText(item, blockedNames))
    .filter(Boolean);
  const actions = (artifact.action_items || [])
    .map((item) => sanitizePublicArticleText(item, blockedNames))
    .filter(Boolean);
  const questions = (artifact.open_questions || [])
    .map((item) => sanitizePublicArticleText(item, blockedNames))
    .filter(Boolean);

  const lines = [
    "---",
    `record_type: article_candidate`,
    `schema_version: 1`,
    `title: ${frontmatterValue(candidate.title)}`,
    `slug: ${frontmatterValue(slugify(candidate.title))}`,
    `status: draft`,
    `article_mode: generalized_no_named_insights`,
    `named_entities_allowed: false`,
    `raw_allowed: false`,
    `source_transform: ${frontmatterValue("public_distillation_to_general_article_candidate")}`,
    "---",
    "",
    `# ${candidate.title}`,
    "",
    "## the claim",
    "",
    candidate.summary,
    "",
    "## reusable pattern",
    "",
  ];

  if (themes.length) {
    for (const theme of themes.slice(0, 6)) lines.push(`- ${theme}`);
  } else {
    lines.push("- Public-cleared transcript material should be rewritten as a reusable pattern, not as a named session recap.");
  }

  if (actions.length) {
    lines.push("", "## implications", "");
    for (const action of actions.slice(0, 6)) lines.push(`- ${action}`);
  }

  if (questions.length) {
    lines.push("", "## open questions", "");
    for (const question of questions.slice(0, 6)) lines.push(`- ${question}`);
  }

  lines.push(
    "",
    "## publication guardrails",
    "",
    "- Do not add named participants or named cohort teams as the source of the claim.",
    "- Do not quote transcript text.",
    "- Keep provenance internal; public copy should say this is derived from a public-approved transcript distillation.",
    "",
  );
  return lines.join("\n");
}

function publicArtifacts(manifest) {
  return (Array.isArray(manifest?.artifacts) ? manifest.artifacts : [])
    .filter((artifact) => artifact.surface === "public")
    .filter((artifact) => artifact.tier === "T3")
    .filter((artifact) => artifact.review_status === "published" && artifact.approval_state === "approved");
}

function buildPublicTranscriptArticles({
  manifest,
  blockedNames = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const artifacts = publicArtifacts(manifest);
  const articles = artifacts.map((artifact, index) => {
    const candidate = publicArticleCandidateFromReadout(artifactToReadout(artifact), { blockedNames });
    const slug = `${slugify(candidate.title, "transcript-insight")}-${String(index + 1).padStart(2, "0")}`;
    return {
      artifact_id: artifact.artifact_id || null,
      slug,
      article_mode: candidate.article_mode,
      named_entities_allowed: false,
      raw_allowed: false,
      title: candidate.title,
      summary: candidate.summary,
      file: `${slug}.md`,
      body: buildArticleBody({ artifact, candidate, blockedNames }),
    };
  });
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: "transcript-distillations/generated/manifest.json",
    article_count: articles.length,
    article_mode: "generalized_no_named_insights",
    named_entities_allowed: false,
    raw_allowed: false,
    articles,
  };
}

function writeArticles(outDir, bundle) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      fs.rmSync(path.join(outDir, entry.name));
    }
  }
  for (const article of bundle.articles) {
    fs.writeFileSync(path.join(outDir, article.file), article.body.endsWith("\n") ? article.body : `${article.body}\n`);
  }
  const manifest = {
    ...bundle,
    articles: bundle.articles.map(({ body, ...article }) => article),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function arg(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(arg(argv, "--manifest", DEFAULT_MANIFEST));
  const outDir = path.resolve(arg(argv, "--out-dir", DEFAULT_OUT_DIR));
  const manifest = readJson(manifestPath, { artifacts: [] });
  const bundle = buildPublicTranscriptArticles({
    manifest,
    blockedNames: loadBlockedNames(ROOT),
  });
  const written = writeArticles(outDir, bundle);
  console.log(JSON.stringify({
    ok: true,
    out_dir: path.relative(ROOT, outDir).replace(/\\/g, "/"),
    article_count: written.article_count,
    article_mode: written.article_mode,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

export {
  artifactToReadout,
  buildPublicTranscriptArticles,
  publicArtifacts,
  writeArticles,
};
