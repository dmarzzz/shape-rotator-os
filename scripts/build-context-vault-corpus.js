#!/usr/bin/env node
/* Build a private article index from local in-person context + VoxTerm sessions. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, ".context-vault", "shape-rotator-article-index.md");
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 500;

const DEFAULT_ROOTS = [
  {
    key: "in-person-context",
    kind: "in-person-context",
    label: "In-person session context",
    dir: path.join(HOME, "Desktop", "scripts @ shape rotator"),
    maxDepth: 4,
  },
  {
    key: "voxterm-transcripts",
    kind: "voxterm-session",
    label: "VoxTerm transcripts",
    dir: path.join(HOME, "Documents", "voxterm-transcripts"),
    maxDepth: 4,
  },
  {
    key: "voxterm-documents",
    kind: "voxterm-session",
    label: "VoxTerm documents",
    dir: path.join(HOME, "Documents", "voxterm"),
    maxDepth: 4,
  },
  {
    key: "voxterm-documents-cap",
    kind: "voxterm-session",
    label: "VoxTerm documents",
    dir: path.join(HOME, "Documents", "VoxTerm"),
    maxDepth: 4,
  },
];

const MONTHS = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    roots: DEFAULT_ROOTS,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      args.output = path.resolve(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: npm run context:corpus -- [--output path]",
    "",
    "Builds one private Markdown article index from:",
    "- ~/Desktop/scripts @ shape rotator (in-person session context)",
    "- ~/Documents/voxterm-transcripts and related VoxTerm folders",
    "",
    `Default output: ${path.relative(REPO_ROOT, DEFAULT_OUTPUT)}`,
  ].join("\n");
}

function shouldSkip(name) {
  return name.startsWith(".") || new Set([
    "node_modules",
    "dist",
    "build",
    "release",
    "out",
    ".git",
    ".next",
    ".vercel",
    "coverage",
  ]).has(name);
}

function walk(root, depth = 0, out = []) {
  if (!root || depth > root.maxDepth || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = fs.readdirSync(root.dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (!entry || shouldSkip(entry.name)) continue;
    const fp = path.join(root.dir, entry.name);
    if (entry.isDirectory()) {
      walk({ ...root, dir: fp }, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(txt|md|markdown)$/i.test(entry.name)) continue;
    out.push({ root, path: fp });
  }
  return out;
}

function readSource(file) {
  let stat;
  try {
    stat = fs.statSync(file.path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  let text;
  try {
    text = fs.readFileSync(file.path, "utf8");
  } catch {
    return null;
  }
  const truncated = Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES;
  if (truncated) text = text.slice(0, MAX_FILE_BYTES);
  return {
    ...file,
    stat,
    text: text.replace(/\r\n/g, "\n"),
    truncated,
  };
}

function inferDate(file, text) {
  const hay = `${path.basename(file)}\n${String(text || "").slice(0, 600)}`;
  const iso = /\b(20\d{2})[-_ ](0?[1-9]|1[0-2])[-_ ](0?[1-9]|[12]\d|3[01])\b/.exec(hay);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  const month = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*[_ -]?\s*([0-3]?\d)(?:,)?(?:\s*[_ -]?\s*(20\d{2}))?\b/i.exec(hay);
  if (month) {
    const y = month[3] || new Date().getFullYear();
    return `${y}-${MONTHS[month[1].slice(0, 3).toLowerCase()]}-${String(month[2]).padStart(2, "0")}`;
  }
  return null;
}

function titleFor(filePath) {
  return path.basename(filePath)
    .replace(/\.(txt|md|markdown)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function frontmatterScalar(value) {
  return JSON.stringify(String(value || ""));
}

const ARTICLE_BRIEFS = [
  {
    key: "llm-agent-memory-workflows-social-routing",
    title: "Why LLM agents need memory, workflows, and social routing",
    angle: "Useful agent work disappears into private sessions, lost context, and brittle long-running tasks, so Shape Rotator should explain why agent workflows need durable memory, social routing, audit trails, and human override.",
    section: "agent infrastructure",
    match: /\b(agent|agents|llm|memory|workflow|workflows|routing|router|social|audit|override|long-running|durable|elocute|dumb agent|project intros|office hours)\b/i,
  },
  {
    key: "privacy-capability-product",
    title: "Privacy is not the product; capability is the product",
    angle: "Private AI infrastructure, TEEs, and data sovereignty only become interesting when they unlock a concrete workflow people already want.",
    section: "privacy and capability",
    match: /\b(privacy|private|local-first|private-first|tee|tees|dstack|enclave|confidential|sovereignty|capability)\b/i,
  },
  {
    key: "verifiability-ai-infrastructure-ux",
    title: "Verifiability is becoming UX for AI infrastructure",
    angle: "Remote attestation and deployable proof are moving from backend trust primitives into things users can see, understand, and act on.",
    section: "verifiability ux",
    match: /\b(verifiability|verify|verification|attestation|remote attestation|proof|dstack|zk|quote|deployable)\b/i,
  },
];

function sourceTitleForConcept(source) {
  return String(source.title || "")
    .replace(/\btranscripts?\b/ig, "")
    .replace(/\bnotes?\b/ig, "")
    .replace(/\bsession\b/ig, "")
    .replace(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,)?(?:\s+20\d{2})?\b/ig, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\(\d+\)/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .trim();
}

function articleConcept(source) {
  if (source.article_title) {
    return {
      title: source.article_title,
      dek: source.article_dek || source.article_angle || "",
      angle: source.article_angle || source.article_dek || "",
      section: source.article_section || "article",
    };
  }
  const hay = [
    source.title,
    (source.skill_areas || []).join(" "),
    (source.signals || []).join(" "),
    source.excerpt,
  ].filter(Boolean).join(" ");
  const matched = ARTICLE_BRIEFS.find(rule => rule.match.test(hay));
  if (matched) return { ...matched, dek: matched.angle };
  const id = String(source.article_id || source.corpus_id || "").trim();
  const skills = (source.skill_areas || []).slice(0, 2).join(" + ");
  const focus = skills || sourceTitleForConcept(source) || "cohort context";
  return {
    title: `${id || "Article draft"}: ${focus} patterns worth drafting`,
    dek: `A public-safe article candidate distilled from private context around ${focus}.`,
    angle: `Draft a public-safe Shape Rotator article about the reusable ${focus} patterns in this context vault entry.`,
    section: "article candidate",
  };
}

function articleTitle(source) {
  return articleConcept(source).title;
}

function articleDek(source) {
  return articleConcept(source).dek;
}

function articleAngle(source) {
  return articleConcept(source).angle;
}

function articleSection(source) {
  return articleConcept(source).section;
}

function slugify(value, fallback = "article") {
  const slug = String(value || fallback)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function uniqList(values = [], cap = 12) {
  const out = [];
  for (const value of values.map(v => String(v || "").trim()).filter(Boolean)) {
    if (out.includes(value)) continue;
    out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function articleBriefHaystack(source) {
  return [
    source.title,
    source.article_title,
    source.article_angle,
    (source.skill_areas || []).join(" "),
    (source.signals || []).join(" "),
    source.excerpt,
    source.text,
  ].filter(Boolean).join("\n");
}

function buildArticleEntries(inputSources = []) {
  if (!inputSources.length) return [];
  return ARTICLE_BRIEFS.map((brief) => {
    let matched = inputSources.filter(source => brief.match.test(articleBriefHaystack(source)));
    if (!matched.length) matched = inputSources;
    const slug = slugify(brief.title, brief.key);
    const skills = uniqList(matched.flatMap(source => source.skill_areas || []), 10);
    return {
      id: slug,
      entry_kind: "article",
      article_id: slug,
      corpus_id: slug,
      article_title: brief.title,
      article_angle: brief.angle,
      article_dek: brief.angle,
      article_section: brief.section,
      article_slug: slug,
      support_count: matched.length,
      skill_areas: skills,
    };
  });
}

function buildCorpus(sources) {
  const generatedAt = new Date().toISOString();

  const lines = [
    "---",
    'title: "Shape Rotator Article Index"',
    `generated_at: ${frontmatterScalar(generatedAt)}`,
    `article_count: ${sources.length}`,
    'kind: "private-article-index"',
    "---",
    "",
    "# Shape Rotator Article Index",
    "",
    "Private local article index generated from the local context vault. It is a working list of draft candidates, not public-ready copy.",
    "",
    "## Prompting Contract",
    "",
    "- Treat each entry as an article draft candidate.",
    "- Separate public-safe synthesis from private/internal notes.",
    "- Do not publish private user data, travel logistics, raw notes, or personal details without review.",
    "- Prefer extracting reusable OS content: articles, context cards, program notes, asks, journal entries, people/project references, and open questions.",
    "- Reference article titles when making claims from this index.",
    "",
    "## Article Index",
    "",
  ];
  lines.push("| title | angle | supporting inputs |");
  lines.push("|---|---|---|");
  sources.forEach((article) => {
    const support = article.support_count || 0;
    lines.push(`| ${articleTitle(article).replace(/\|/g, "\\|")} | ${articleAngle(article).replace(/\|/g, "\\|")} | ${support} |`);
  });

  lines.push("", "## Articles", "");
  sources.forEach((article) => {
    lines.push(`### ${articleTitle(article)}`);
    lines.push("");
    lines.push(`- status: draft-candidate`);
    lines.push(`- suggested_slug: ${slugify(articleTitle(article))}`);
    lines.push(`- editorial_section: ${articleSection(article)}`);
    lines.push(`- working_angle: ${articleAngle(article)}`);
    lines.push(`- supporting_private_inputs: ${article.support_count || 0}`);
    lines.push("");
    lines.push("#### Working Angle");
    lines.push("");
    lines.push(articleAngle(article));
    lines.push("");
    lines.push("#### Article Notes");
    lines.push("");
    lines.push("- Review the private input before drafting.");
    lines.push("- Extract a public-safe thesis, reusable program context, and any explicit asks.");
    lines.push("- Do not copy raw private notes into public OS content.");
    lines.push("");
    lines.push("#### Publish Boundary");
    lines.push("");
    lines.push("- Keep private inputs hidden.");
    lines.push("- Publish only cleaned synthesis, reusable program context, or explicit asks.");
    lines.push("");
  });

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const rootReports = args.roots.map(root => ({
    ...root,
    exists: fs.existsSync(root.dir),
  }));

  const candidates = [];
  for (const root of rootReports) {
    if (!root.exists) continue;
    walk(root, 0, candidates);
  }

  const seenPaths = new Set();
  const uniqueCandidates = candidates.filter(candidate => {
    const key = path.resolve(candidate.path);
    if (seenPaths.has(key)) return false;
    seenPaths.add(key);
    return true;
  });

  const sources = uniqueCandidates
    .map(readSource)
    .filter(Boolean)
    .map(source => ({
      ...source,
      title: titleFor(source.path),
      date: inferDate(source.path, source.text),
    }))
    .sort((a, b) => {
      const dateCmp = String(b.date || b.stat?.mtimeMs || "").localeCompare(String(a.date || a.stat?.mtimeMs || ""));
      if (dateCmp) return dateCmp;
      return a.path.localeCompare(b.path);
    });

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  const articles = buildArticleEntries(sources);
  fs.writeFileSync(args.output, buildCorpus(articles));

  const missing = rootReports.filter(r => !r.exists).length;
  console.log(`wrote ${args.output}`);
  console.log(`articles: ${articles.length}`);
  console.log(`inputs: ${sources.length}`);
  console.log(`missing roots: ${missing}`);
  console.log(`chars: ${sources.reduce((sum, s) => sum + s.text.length, 0)}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exitCode = 1;
}
