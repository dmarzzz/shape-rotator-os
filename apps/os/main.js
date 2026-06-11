const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const swfNode = require("./swf-node");
const swarm = require("./swarm-node");
const easelNdi = require("./easel-ndi");
// Daybook (apps→daybook): registering this module wires every `daybook:*`
// ipcMain handler (digest pipeline, scope/redaction, onboarding). Side-effect
// require, mirroring the prefs/swarm/easel handlers below. See daybook-main.js.
require("./daybook-main");

// Headless launch self-test. `--smoke-test` (or SROS_SMOKE_TEST=1) boots
// the renderer in a hidden window, waits for boot.js to signal ready, and
// exits 0/1. CI runs this against the *packaged* binary (see
// scripts/after-pack-verify.cjs) to catch runtime boot failures — e.g. a
// renderer module that throws at import time — which static asar analysis
// can't see and which dev mode (runs from source) can't reproduce.
const SMOKE_TEST = process.argv.includes("--smoke-test") || process.env.SROS_SMOKE_TEST === "1";

function runSmokeTest() {
  const TIMEOUT_MS = Number(process.env.SROS_SMOKE_TIMEOUT_MS) || 45000;
  const log = (m) => process.stdout.write(`[smoke] ${m}\n`);
  let settled = false;
  const finish = (code, why) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    log(code === 0 ? `PASS: ${why}` : `FAIL: ${why}`);
    app.exit(code);
  };
  const timer = setTimeout(
    () => finish(1, `renderer did not signal ready within ${TIMEOUT_MS}ms`),
    TIMEOUT_MS
  );

  log(`booting renderer headless (timeout ${TIMEOUT_MS}ms)…`);
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, sandbox: false, nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (_e, lvl, msg) => {
    if (lvl >= 2) log(`renderer error: ${msg}`); // surface boot exceptions
  });
  win.webContents.on("did-fail-load", (_e, ec, desc, url) =>
    finish(1, `did-fail-load ${ec} ${desc} ${url}`));
  win.webContents.on("render-process-gone", (_e, d) =>
    finish(1, `render-process-gone: ${d && d.reason}`));
  win.webContents.on("preload-error", (_e, p, err) =>
    finish(1, `preload-error ${p}: ${err && err.message}`));
  ipcMain.once("smoke:ready", () => finish(0, "renderer signalled ready"));
  win.loadFile(path.join(__dirname, "src", "index.html"));
}

// One-time userData migration. Electron resolves `app.getPath("userData")`
// from `productName` (or, if unset, the package name). Every time we
// rename the app — `srwk-wall` → `srwk-visualizer` → `Shape Rotator` →
// `Shape Rotator OS` — the userData path changes and a fresh
// launch finds no saved state. This walks the historical names and
// copies any prior contents into the current dir.
//
// We migrate files (not the directory itself) so any pre-existing
// new-path entries win, and we never *delete* the old paths — leaving
// them intact lets users roll back to an older build without losing data.
//
// To add a future rename: prepend the old name to `legacyNames` below.
function migrateLegacyUserData() {
  try {
    const newDir = app.getPath("userData");
    const parent = path.dirname(newDir);
    // Earlier names this app ever used for its userData folder, in
    // descending recency order. The first one that exists wins.
    const legacyNames = ["Shape Rotator", "srwk-visualizer", "srwk-wall"];
    let chosen = null;
    for (const n of legacyNames) {
      const candidate = path.join(parent, n);
      if (candidate === newDir) continue; // already running under that name
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        chosen = candidate; break;
      }
    }
    if (!chosen) return;
    fs.mkdirSync(newDir, { recursive: true });
    const copyTree = (src, dst) => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyTree(s, d);
        } else if (entry.isFile()) {
          if (fs.existsSync(d)) continue; // don't clobber newer state
          try { fs.copyFileSync(s, d); } catch {}
        }
      }
    };
    copyTree(chosen, newDir);
    process.stderr.write(`[viz:log] migrated userData from ${chosen} → ${newDir}\n`);
  } catch (e) {
    process.stderr.write(`[viz:warn] userData migration failed: ${e && e.message}\n`);
  }
}

migrateLegacyUserData();

const STATE_DIR = app.getPath("userData");
const WINDOW_STATE = path.join(STATE_DIR, "window_state.json");
const PREFS_FILE = path.join(STATE_DIR, "viz_prefs.json");
const LEGACY_PREFS_FILE = path.join(STATE_DIR, "wall_prefs.json");
const CONTEXT_VAULT_DIR = path.join(STATE_DIR, "context-vault");
const CONTEXT_VAULT_MANIFEST = path.join(CONTEXT_VAULT_DIR, "manifest.json");
const CONTEXT_VAULT_ARTICLE_INDEX = path.join(CONTEXT_VAULT_DIR, "shape-rotator-article-index.md");
const CONTEXT_VAULT_RAW_BUNDLE = path.join(CONTEXT_VAULT_DIR, "shape-rotator-transcripts.md");
const CONTEXT_VAULT_CORPUS = CONTEXT_VAULT_ARTICLE_INDEX;
const REPO_COHORT_ARTICLES_DIR = path.resolve(__dirname, "..", "..", "cohort-data", "articles");
const PACKAGED_COHORT_ARTICLES_DIR = process.resourcesPath
  ? path.join(process.resourcesPath, "cohort-data", "articles")
  : null;

// If a `wall_prefs.json` survived from before the rename (either from this
// install or copied over by migrateLegacyUserData()), promote it to the new
// `viz_prefs.json` filename. We rename rather than copy so the next save
// produces a single canonical file.
function migratePrefsFile() {
  try {
    if (!fs.existsSync(PREFS_FILE) && fs.existsSync(LEGACY_PREFS_FILE)) {
      fs.renameSync(LEGACY_PREFS_FILE, PREFS_FILE);
      process.stderr.write(`[viz:log] migrated prefs ${LEGACY_PREFS_FILE} → ${PREFS_FILE}\n`);
    }
  } catch (e) {
    process.stderr.write(`[viz:warn] prefs migration failed: ${e && e.message}\n`);
  }
}

migratePrefsFile();

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJSON(p, d) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d));
  fs.renameSync(tmp, p);
}

function hashShort(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

function contextVaultRoots() {
  const desktop = app.getPath("desktop");
  const docs = app.getPath("documents");
  return [
    {
      key: "shape-rotator-desktop",
      label: "In-person session context",
      path: path.join(desktop, "scripts @ shape rotator"),
      max_depth: 4,
    },
    {
      key: "voxterm-transcripts",
      label: "VoxTerm transcripts",
      path: path.join(docs, "voxterm-transcripts"),
      max_depth: 4,
    },
    {
      key: "voxterm-documents",
      label: "VoxTerm documents",
      path: path.join(docs, "voxterm"),
      max_depth: 4,
    },
    {
      key: "voxterm-documents-cap",
      label: "VoxTerm documents",
      path: path.join(docs, "VoxTerm"),
      max_depth: 4,
    },
    {
      key: "bundled-raw-scripts",
      label: "Bundled transcripts",
      path: path.join(__dirname, "src", "content", "context", "raw-scripts"),
      max_depth: 1,
      bundled: true,
    },
  ];
}

function skipContextVaultEntry(name) {
  return name.startsWith(".") || new Set([
    "node_modules",
    "dist",
    "build",
    "release",
    ".git",
    ".next",
    ".vercel",
    "coverage",
  ]).has(name);
}

function walkTranscriptFiles(root, out = [], depth = 0, maxDepth = 4) {
  if (!root || depth > maxDepth || out.length >= 350) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (out.length >= 350) break;
    if (!entry || skipContextVaultEntry(entry.name)) continue;
    const fp = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) walkTranscriptFiles(fp, out, depth + 1, maxDepth);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(txt|md|markdown)$/i.test(entry.name)) continue;
    out.push(fp);
  }
  return out;
}

function meaningfulLines(text, cap = 14) {
  const lines = String(text || "").split(/\r?\n/);
  const picked = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(line)) continue;
    if (/^meeting\s+/i.test(line) && picked.length > 0) continue;
    picked.push(line);
    if (picked.length >= cap) break;
  }
  return picked;
}

function inferTranscriptDate(name, text, mtime) {
  const hay = `${name}\n${String(text || "").slice(0, 400)}`;
  const iso = /\b(20\d{2})[-_ ](0?[1-9]|1[0-2])[-_ ](0?[1-9]|[12]\d|3[01])\b/.exec(hay);
  if (iso) {
    const y = iso[1];
    const m = String(iso[2]).padStart(2, "0");
    const d = String(iso[3]).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const month = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d)(?:,)?\s+(20\d{2})\b/i.exec(hay);
  if (month) {
    const months = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const m = months[month[1].slice(0, 3).toLowerCase()] || "01";
    const d = String(month[2]).padStart(2, "0");
    return `${month[3]}-${m}-${d}`;
  }
  try { return new Date(mtime).toISOString().slice(0, 10); }
  catch { return null; }
}

function inferSpeakers(text) {
  const counts = new Map();
  const add = (name) => {
    let n = String(name || "").trim().replace(/\s+/g, " ");
    n = n.replace(/[.,;:]+$/, "");
    if (!n || n.length < 2 || n.length > 48) return;
    if (/^(speaker|unknown|meeting|transcript|session)$/i.test(n)) return;
    counts.set(n, (counts.get(n) || 0) + 1);
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const a = /^([^:\n]{2,48}):\s+\S/.exec(line.trim());
    if (a) add(a[1]);
    const b = /^([^0-9\n]{2,48}?)\s{2,}\d{1,2}:\d{2}(?::\d{2})?\s*$/.exec(line.trim());
    if (b) add(b[1]);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name]) => name);
}

function inferSkillAreas(text) {
  const t = String(text || "").toLowerCase();
  const checks = [
    ["tee", /\btee\b|trusted execution|tdx|sgx|sev|enclave/],
    ["dstack", /\bdstack\b|phala/],
    ["attestation", /attestation|ra-tls|quote verification/],
    ["formal-verification", /formal verification|kani|cvc5|proof certificate/],
    ["zk", /\bzk\b|zero[- ]knowledge|groth|snark/],
    ["threshold-crypto", /threshold|committee signs|mpc signature/],
    ["mpc", /\bmpc\b|multi-party/],
    ["agentic", /agent|agents|claude|codex|llm|hermes|smithers/],
    ["agent-runtime", /runtime|orchestrat|workflow|sandbox|daemon/],
    ["agent-routing", /routing|router|openrouter|model route/],
    ["cross-chain", /cross[- ]chain|bridge|wallet|asset|erc ?20|swap/],
    ["identity", /identity|credential|pubkey|signature|device key/],
    ["p2p", /\bp2p\b|mdns|lan|peer|gossip/],
    ["durable-workflows", /durable|cron|checkpoint|resume|handoff/],
    ["confidential-db", /database|postgres|encrypted-at-rest|confidential db/],
    ["design", /design|ux|interface|visual|prototype/],
    ["bd-gtm", /\bgtm\b|distribution|sales|customer|market|launch/],
    ["research-to-product", /research|paper|product|prototype|productization/],
    ["generative-media", /video|audio|media|transcript|voice|voxterm/],
    ["mechanism-design", /mechanism|incentive|market design|auction/],
  ];
  return checks.filter(([, re]) => re.test(t)).map(([k]) => k).slice(0, 8);
}

function inferSignals(text) {
  const lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const signalRe = /\b(should|need|needs|want|wants|would love|help|debug|question|ask|resource|tool|demo|ship|build|insight|pattern|risk|privacy|trust|verify|automate|workflow)\b/i;
  const out = [];
  for (const line of lines) {
    if (out.length >= 6) break;
    if (/^\d{1,2}:\d{2}/.test(line)) continue;
    if (line.length < 28 || line.length > 260) continue;
    if (signalRe.test(line)) out.push(line);
  }
  return out;
}

function transcriptTitle(filePath) {
  return path.basename(filePath).replace(/\.(txt|md|markdown)$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
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
  return String(source?.title || "")
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
  if (source?.article_title) {
    return {
      title: source.article_title,
      dek: source.article_dek || source.article_angle || "",
      angle: source.article_angle || source.article_dek || "",
      section: source.article_section || "article",
    };
  }
  const hay = [
    source?.title,
    (source?.skill_areas || []).join(" "),
    (source?.signals || []).join(" "),
    source?.excerpt,
  ].filter(Boolean).join(" ");
  const matched = ARTICLE_BRIEFS.find(rule => rule.match.test(hay));
  if (matched) return { ...matched, dek: matched.angle };
  const id = String(source?.article_id || source?.corpus_id || "").trim();
  const skills = (source?.skill_areas || []).slice(0, 2).join(" + ");
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

function articleSlug(s, fallback = "article") {
  const slug = String(s || fallback)
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

function parseSimpleFrontmatterScalar(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "null") return raw === "null" ? null : "";
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1)
      .split(",")
      .map(v => parseSimpleFrontmatterScalar(v))
      .filter(v => v !== "");
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseSimpleFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text || ""));
  if (!m) return { frontmatter: {}, body: String(text || "") };
  const frontmatter = {};
  let listKey = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const list = /^\s*-\s+(.+)$/.exec(rawLine);
    if (list && listKey) {
      if (!Array.isArray(frontmatter[listKey])) frontmatter[listKey] = [];
      frontmatter[listKey].push(parseSimpleFrontmatterScalar(list[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2] || "";
    if (!value.trim()) {
      frontmatter[key] = [];
      listKey = key;
      continue;
    }
    frontmatter[key] = parseSimpleFrontmatterScalar(value);
    listKey = null;
  }
  return { frontmatter, body: m[2] || "" };
}

function cohortArticleDirs() {
  const seen = new Set();
  return [PACKAGED_COHORT_ARTICLES_DIR, REPO_COHORT_ARTICLES_DIR].filter((dir) => {
    if (!dir) return false;
    const key = path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.statSync(dir).isDirectory()
        && fs.readdirSync(dir).some(name => name.endsWith(".md"));
    } catch {
      return false;
    }
  });
}

function readCommittedArticles() {
  const articlesDir = cohortArticleDirs()[0];
  if (!articlesDir) return [];
  let files;
  try {
    files = fs.readdirSync(articlesDir).filter(name => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const articles = [];
  for (const file of files) {
    const filePath = path.join(articlesDir, file);
    let raw;
    try { raw = fs.readFileSync(filePath, "utf8"); }
    catch { continue; }
    const { frontmatter, body } = parseSimpleFrontmatter(raw);
    if (frontmatter.record_type !== "article" || !frontmatter.record_id) continue;
    const title = frontmatter.title || sourceTitleForConcept({ title: file });
    const slug = frontmatter.slug || articleSlug(title);
    articles.push({
      id: `article:${frontmatter.record_id}`,
      entry_kind: "article",
      article_id: frontmatter.record_id,
      corpus_id: frontmatter.record_id,
      article_title: title,
      article_angle: frontmatter.working_angle || "",
      article_dek: frontmatter.working_angle || "",
      article_section: frontmatter.editorial_section || "article",
      article_slug: slug,
      article_file: file,
      article_body_md: String(body || "").trim(),
      article_full_md: String(raw || "").trim(),
      content_version: frontmatter.content_version || "",
      status: frontmatter.status || "draft",
      date: frontmatter.authored_week || null,
      source_kind: "cohort-article",
      source_refs: (frontmatter.sources || []).map(source => ({ title: String(source || "") })),
      support_count: Array.isArray(frontmatter.sources) ? frontmatter.sources.length : 0,
      skill_areas: frontmatter.related_clusters || [],
      related_teams: frontmatter.related_teams || [],
      related_people: frontmatter.related_people || [],
      path: filePath,
      size_bytes: Buffer.byteLength(raw, "utf8"),
      line_count: raw.split(/\r?\n/).length,
      char_count: raw.length,
    });
  }
  return articles;
}

function articleDedupeKey(source) {
  return String(source?.article_slug || articleSlug(source?.article_title || source?.title || source?.id || "article")).toLowerCase();
}

function mergeCommittedArticles(generatedArticles = []) {
  const committed = readCommittedArticles();
  const seen = new Set(committed.map(articleDedupeKey));
  const generated = generatedArticles.filter(article => {
    const key = articleDedupeKey(article);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...committed, ...generated];
}

function articleBriefHaystack(source) {
  return [
    source?.title,
    source?.article_title,
    source?.article_angle,
    (source?.skill_areas || []).join(" "),
    (source?.signals || []).join(" "),
    source?.excerpt,
  ].filter(Boolean).join("\n");
}

function buildArticleEntries(inputSources = []) {
  if (!inputSources.length) return [];
  return ARTICLE_BRIEFS.map((brief) => {
    let matched = inputSources.filter(source => brief.match.test(articleBriefHaystack(source)));
    if (!matched.length) matched = inputSources;
    const slug = articleSlug(brief.title, brief.key);
    const skills = uniqList(matched.flatMap(source => source.skill_areas || []), 10);
    const refs = matched.map(source => ({
      id: source.id,
      title: source.title,
      date: source.date,
      kind: source.source_kind,
    })).filter(ref => ref.id || ref.title);
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
      date: matched.map(source => source.date).filter(Boolean).sort().pop() || null,
      source_kind: "article-brief",
      support_count: matched.length,
      source_refs: refs,
      skill_areas: skills,
      line_count: matched.reduce((sum, source) => sum + (source.line_count || 0), 0),
      size_bytes: matched.reduce((sum, source) => sum + (source.size_bytes || 0), 0),
      char_count: matched.reduce((sum, source) => sum + (source.char_count || 0), 0),
    };
  });
}

function inferSourceKind(filePath, root) {
  const hay = `${root?.key || ""} ${root?.label || ""} ${filePath}`.toLowerCase();
  if (hay.includes("voxterm")) return "voxterm";
  if (root?.key === "shape-rotator-desktop" || hay.includes("transcript")) return "in-person-context";
  return "manual";
}

const TRANSCRIPT_HEADER_LIST_FIELDS = new Set([
  "speakers",
  "calendar_matches",
  "related_teams",
  "related_people",
]);

function parseTranscriptHeaderList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const inner = raw.startsWith("[") && raw.endsWith("]")
    ? raw.slice(1, -1)
    : raw;
  return inner
    .split(",")
    .map(item => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseTranscriptHeaderMetadata(text) {
  const raw = String(text || "");
  const header = raw.split(/^-{5}\s*BEGIN TRANSCRIPT\s*-{5}/mi)[0] || "";
  const metadata = {};
  const titleLine = header.split(/\r?\n/).find(line => /^#\s+/.test(line.trim()));
  if (titleLine) metadata.header_title = titleLine.replace(/^#\s+/, "").trim();
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const value = match[2] || "";
    metadata[key] = TRANSCRIPT_HEADER_LIST_FIELDS.has(key)
      ? parseTranscriptHeaderList(value)
      : value;
  }
  return metadata;
}

function scanTranscriptFile(filePath, root) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return null; }
  if (!stat.isFile() || stat.size <= 0) return null;
  // Keep individual reads bounded. These are transcripts, not binary blobs.
  const maxBytes = 1_500_000;
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8").slice(0, maxBytes); }
  catch { return null; }
  const lines = raw.split(/\r?\n/);
  const header = parseTranscriptHeaderMetadata(raw);
  const title = transcriptTitle(filePath);
  const date = inferTranscriptDate(path.basename(filePath), raw, stat.mtimeMs);
  const skills = inferSkillAreas(`${title}\n${raw}`);
  const speakers = Array.isArray(header.speakers) && header.speakers.length ? header.speakers : inferSpeakers(raw);
  const excerptLines = meaningfulLines(raw, 10);
  const signals = inferSignals(raw);
  const id = hashShort(`${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`);
  const sourceKind = inferSourceKind(filePath, root);
  return {
    id,
    record_id: header.record_id || null,
    article_title: null,
    article_angle: null,
    article_slug: null,
    article_dek: null,
    article_section: null,
    title,
    path: filePath,
    root_key: root.key,
    root_label: root.label,
    source_kind: sourceKind,
    date,
    size_bytes: stat.size,
    line_count: lines.length,
    char_count: raw.length,
    mtime: new Date(stat.mtimeMs).toISOString(),
    source_format: header.source_format || null,
    segments: Number(header.segments) || null,
    review_status: header.review_status || null,
    submit_recommendation: header.submit_recommendation || null,
    calendar_matches: header.calendar_matches || [],
    related_teams: header.related_teams || [],
    related_people: header.related_people || [],
    utility: header.utility || null,
    import_boundary: header.import_boundary || null,
    content_boundary: header.content_boundary || header.import_boundary || null,
    redactions: header.redactions || null,
    speakers,
    skill_areas: skills,
    signals,
    excerpt: excerptLines.join("\n"),
    truncated: stat.size > maxBytes,
  };
}

function contextVaultTotals(sources = [], rawScripts = []) {
  return {
    sources: sources.length,
    articles: sources.length,
    raw_scripts: rawScripts.length,
    lines: sources.reduce((n, s) => n + (s.line_count || 0), 0),
    bytes: sources.reduce((n, s) => n + (s.size_bytes || 0), 0),
    voxterm: sources.filter(s => s.source_kind === "voxterm").length,
    in_person_context: sources.filter(s => s.source_kind === "in-person-context").length,
    manual: sources.filter(s => s.source_kind === "manual").length,
  };
}

function readContextVaultSourceText(filePath, maxBytes = 2_000_000) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    return {
      text: raw.slice(0, maxBytes),
      truncated: Buffer.byteLength(raw, "utf8") > maxBytes,
    };
  } catch {
    return { text: "", truncated: false };
  }
}

function existingRawScripts(rawScripts = []) {
  const next = [];
  let changed = false;
  for (const source of Array.isArray(rawScripts) ? rawScripts : []) {
    const filePath = source?.path;
    if (!filePath) {
      changed = true;
      continue;
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        changed = true;
        continue;
      }
      next.push(source);
    } catch {
      changed = true;
    }
  }
  return { rawScripts: next, changed };
}

function rawScriptFingerprint(rawScripts = []) {
  const parts = [];
  for (const source of Array.isArray(rawScripts) ? rawScripts : []) {
    const filePath = source?.path || "";
    let statSize = source?.size_bytes || 0;
    let statMtime = source?.mtime || "";
    try {
      const stat = fs.statSync(filePath);
      statSize = stat.size;
      statMtime = Math.round(stat.mtimeMs);
    } catch {}
    parts.push(JSON.stringify({
      id: source?.id || "",
      title: source?.title || "",
      path: filePath,
      source_kind: source?.source_kind || "",
      date: source?.date || "",
      record_id: source?.record_id || "",
      review_status: source?.review_status || "",
      submit_recommendation: source?.submit_recommendation || "",
      line_count: source?.line_count || 0,
      size_bytes: source?.size_bytes || 0,
      stat_size: statSize,
      stat_mtime: statMtime,
    }));
  }
  return hashShort(parts.sort().join("\n"));
}

function removeContextVaultRawBundle() {
  try {
    if (fs.existsSync(CONTEXT_VAULT_RAW_BUNDLE)) fs.unlinkSync(CONTEXT_VAULT_RAW_BUNDLE);
  } catch {}
}

function writeContextVaultRawBundle(rawScripts = []) {
  const generatedAt = new Date().toISOString();
  const sourceFingerprint = rawScriptFingerprint(rawScripts);
  const lines = [
    "---",
    'title: "Shape Rotator Transcripts"',
    `generated_at: ${JSON.stringify(generatedAt)}`,
    `transcript_count: ${rawScripts.length}`,
    `source_fingerprint: ${JSON.stringify(sourceFingerprint)}`,
    'kind: "transcript-bundle"',
    "---",
    "",
    "# Shape Rotator Transcripts",
    "",
    "Bundled transcript set for private prompting inside Shape Rotator OS.",
    "",
  ];
  for (const source of rawScripts) {
    const raw = readContextVaultSourceText(source.path, 2_000_000);
    lines.push(`## ${source.title || path.basename(source.path || "transcript")}`);
    lines.push("");
    lines.push(`source_id: ${source.id || ""}`);
    lines.push(`source_kind: ${source.source_kind || "transcript"}`);
    lines.push(`date: ${source.date || ""}`);
    lines.push(`lines: ${source.line_count || 0}`);
    lines.push(`path: ${source.path || ""}`);
    if (source.record_id) lines.push(`record_id: ${source.record_id}`);
    if (source.review_status) lines.push(`review_status: ${source.review_status}`);
    if (source.submit_recommendation) lines.push(`submit_recommendation: ${source.submit_recommendation}`);
    if (source.calendar_matches?.length) lines.push(`calendar_matches: [${source.calendar_matches.join(", ")}]`);
    if (source.related_teams?.length) lines.push(`related_teams: [${source.related_teams.join(", ")}]`);
    if (source.related_people?.length) lines.push(`related_people: [${source.related_people.join(", ")}]`);
    if (source.utility) lines.push(`utility: ${source.utility}`);
    if (source.content_boundary) lines.push(`content_boundary: ${source.content_boundary}`);
    if (source.redactions) lines.push(`redactions: ${source.redactions}`);
    lines.push("");
    lines.push("----- BEGIN TRANSCRIPT -----");
    lines.push(raw.text || "");
    if (raw.truncated || source.truncated) lines.push("----- TRUNCATED -----");
    lines.push("----- END TRANSCRIPT -----");
    lines.push("");
  }
  fs.mkdirSync(path.dirname(CONTEXT_VAULT_RAW_BUNDLE), { recursive: true });
  const body = lines.join("\n");
  fs.writeFileSync(CONTEXT_VAULT_RAW_BUNDLE, body);
  return {
    path: CONTEXT_VAULT_RAW_BUNDLE,
    kind: "transcript-bundle",
    generated_at: generatedAt,
    transcript_count: rawScripts.length,
    source_fingerprint: sourceFingerprint,
    line_count: body.split(/\r?\n/).length,
    char_count: body.length,
    size_bytes: Buffer.byteLength(body, "utf8"),
  };
}

function normalizeContextVaultRawBundle(rawScripts = [], rawBundle = null) {
  if (!rawScripts.length) {
    const hadFile = fs.existsSync(CONTEXT_VAULT_RAW_BUNDLE);
    removeContextVaultRawBundle();
    return { raw_bundle: null, changed: !!rawBundle || hadFile };
  }
  const sourceFingerprint = rawScriptFingerprint(rawScripts);
  if (
    !rawBundle
    || rawBundle.kind !== "transcript-bundle"
    || rawBundle.path !== CONTEXT_VAULT_RAW_BUNDLE
    || rawBundle.source_fingerprint !== sourceFingerprint
    || !fs.existsSync(rawBundle.path || "")
  ) {
    return { raw_bundle: writeContextVaultRawBundle(rawScripts), changed: true };
  }
  return { raw_bundle: rawBundle, changed: false };
}

function writeContextVaultCorpus(sources = []) {
  const generatedAt = new Date().toISOString();
  const lines = [
    "---",
    'title: "Shape Rotator Article Index"',
    `generated_at: ${JSON.stringify(generatedAt)}`,
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
  ];
  lines.push("## Article Index", "");
  lines.push("| title | angle | supporting inputs |");
  lines.push("|---|---|---|");
  for (const source of sources) {
    const title = source.article_title || articleTitle(source);
    const angle = source.article_angle || articleAngle(source);
    const support = source.support_count || source.source_refs?.length || 0;
    lines.push(`| ${title.replace(/\|/g, "\\|")} | ${angle.replace(/\|/g, "\\|")} | ${support} |`);
  }
  lines.push("", "## Articles", "");
  for (const source of sources) {
    const title = source.article_title || articleTitle(source);
    const angle = source.article_angle || articleAngle(source);
    const section = source.article_section || articleSection(source);
    const slug = source.article_slug || articleSlug(title);
    const skillAreas = (source.skill_areas || []).slice(0, 8);
    const support = source.support_count || source.source_refs?.length || 0;
    lines.push(`### ${title}`);
    lines.push("");
    lines.push(`- status: draft-candidate`);
    lines.push(`- suggested_slug: ${slug}`);
    lines.push(`- editorial_section: ${section}`);
    lines.push(`- working_angle: ${angle}`);
    lines.push(`- supporting_private_inputs: ${support}`);
    lines.push(`- inferred_skill_areas: ${skillAreas.length ? skillAreas.join(", ") : "none inferred"}`);
    lines.push("");
    lines.push("#### Drafting Cues");
    lines.push("");
    lines.push("- Review the private input before drafting.");
    lines.push("- Extract a public-safe thesis, reusable program context, and any explicit asks.");
    if (skillAreas.length) lines.push(`- Inferred areas to consider: ${skillAreas.join(", ")}.`);
    lines.push("");
    lines.push("#### Article Notes");
    lines.push("");
    lines.push("- Article body is intentionally not generated here; use the private input only during a reviewed drafting pass.");
    lines.push("- Do not copy raw private notes into public OS content.");
    lines.push("");
    lines.push("#### Publish Boundary");
    lines.push("");
    lines.push("- Keep private inputs hidden.");
    lines.push("- Publish only cleaned synthesis, reusable program context, or explicit asks.");
    lines.push("");
  }
  fs.mkdirSync(path.dirname(CONTEXT_VAULT_CORPUS), { recursive: true });
  const body = lines.join("\n");
  fs.writeFileSync(CONTEXT_VAULT_CORPUS, body);
  return {
    path: CONTEXT_VAULT_CORPUS,
    kind: "private-article-index",
    generated_at: generatedAt,
    article_count: sources.length,
    line_count: body.split(/\r?\n/).length,
    char_count: body.length,
    size_bytes: Buffer.byteLength(body, "utf8"),
  };
}

function normalizeContextVaultManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.sources)) return manifest;
  const currentRoots = contextVaultRoots();
  const currentRootMap = new Map(currentRoots.map(root => [root.key, root]));
  const existingRoots = Array.isArray(manifest.roots) ? manifest.roots : [];
  const rawScriptState = existingRawScripts(manifest.raw_scripts);
  const rawScripts = rawScriptState.rawScripts;
  const roots = existingRoots.map(root => {
    const current = currentRootMap.get(root.key);
    return current ? { ...root, ...current, exists: fs.existsSync(current.path) } : root;
  });
  for (const root of currentRoots) {
    if (!roots.some(r => r.key === root.key)) {
      roots.push({ ...root, exists: fs.existsSync(root.path) });
    }
  }
  if (!manifest.sources.every(source => source.entry_kind === "article")) {
    const sources = mergeCommittedArticles(buildArticleEntries(manifest.sources));
    const totals = contextVaultTotals(sources, rawScripts);
    const corpus = writeContextVaultCorpus(sources);
    const rawBundleState = normalizeContextVaultRawBundle(rawScripts, manifest.raw_bundle || null);
    const raw_bundle = rawBundleState.raw_bundle;
    const next = { ...manifest, schema_version: 2, roots, totals, corpus, raw_bundle, sources, raw_scripts: rawScripts };
    try { writeJSON(CONTEXT_VAULT_MANIFEST, next); } catch {}
    return next;
  }
  const rootMap = new Map(roots.map(root => [root.key, root]));
  let changed = rawScriptState.changed;
  if (JSON.stringify(existingRoots) !== JSON.stringify(roots)) changed = true;
  const normalizedSources = manifest.sources.map((source, index) => {
    if (source.entry_kind === "article") {
      const title = source.article_title || articleTitle(source);
      const angle = source.article_angle || articleAngle(source);
      const dek = source.article_dek || articleDek(source);
      const section = source.article_section || articleSection(source);
      const slug = source.article_slug || articleSlug(title);
      if (
        source.article_title === title
        && source.article_angle === angle
        && source.article_dek === dek
        && source.article_section === section
        && source.article_slug === slug
      ) return source;
      changed = true;
      return { ...source, article_title: title, article_angle: angle, article_dek: dek, article_section: section, article_slug: slug };
    }
    const root = rootMap.get(source.root_key) || { key: source.root_key, label: source.root_label };
    const sourceKind = inferSourceKind(source.path || "", root);
    const articleId = source.article_id || (
      /^ART-\d+$/i.test(String(source.corpus_id || "")) ? source.corpus_id : `ART-${String(index + 1).padStart(3, "0")}`
    );
    const corpusId = articleId;
    const articleBase = { ...source, article_id: articleId, corpus_id: corpusId };
    const articleTitleValue = articleTitle(articleBase);
    const articleAngleValue = articleAngle({ ...articleBase, article_title: articleTitleValue });
    const articleDekValue = articleDek({ ...articleBase, article_title: articleTitleValue });
    const articleSectionValue = articleSection({ ...articleBase, article_title: articleTitleValue });
    const articleSlugValue = articleSlug(articleTitleValue);
    const rootLabel = root.label || source.root_label;
    if (
      source.source_kind === sourceKind
      && source.article_id === articleId
      && source.corpus_id === corpusId
      && source.article_title === articleTitleValue
      && source.article_angle === articleAngleValue
      && source.article_dek === articleDekValue
      && source.article_section === articleSectionValue
      && source.article_slug === articleSlugValue
      && source.root_label === rootLabel
    ) return source;
    changed = true;
    return {
      ...source,
      source_kind: sourceKind,
      article_id: articleId,
      corpus_id: corpusId,
      article_title: articleTitleValue,
      article_angle: articleAngleValue,
      article_dek: articleDekValue,
      article_section: articleSectionValue,
      article_slug: articleSlugValue,
      root_label: rootLabel,
    };
  });
  const sources = mergeCommittedArticles(normalizedSources);
  if (JSON.stringify(manifest.sources || []) !== JSON.stringify(sources)) changed = true;
  const totals = contextVaultTotals(sources, rawScripts);
  if (JSON.stringify(manifest.totals || {}) !== JSON.stringify(totals)) changed = true;
  let corpus = manifest.corpus || null;
  if (
    !corpus
    || corpus.kind !== "private-article-index"
    || corpus.path !== CONTEXT_VAULT_CORPUS
    || !fs.existsSync(corpus.path || "")
  ) {
    corpus = writeContextVaultCorpus(sources);
    changed = true;
  }
  const rawBundleState = normalizeContextVaultRawBundle(rawScripts, manifest.raw_bundle || null);
  const raw_bundle = rawBundleState.raw_bundle;
  if (rawBundleState.changed) changed = true;
  if (!changed) return manifest;
  const next = { ...manifest, totals, corpus, raw_bundle, sources, raw_scripts: rawScripts };
  try { writeJSON(CONTEXT_VAULT_MANIFEST, next); } catch {}
  return next;
}

function buildContextVaultManifest() {
  const roots = contextVaultRoots();
  const rootReports = roots.map((root) => {
    const exists = fs.existsSync(root.path);
    return { ...root, exists };
  });
  const candidates = [];
  for (const root of rootReports) {
    if (!root.exists) continue;
    for (const filePath of walkTranscriptFiles(root.path, [], 0, root.max_depth ?? 4)) {
      const source = scanTranscriptFile(filePath, root);
      if (source) candidates.push(source);
    }
  }
  const seenScripts = new Set();
  const sources = [];
  for (const source of candidates) {
    const key = `${String(source.title || "").toLowerCase()}:${source.size_bytes || 0}`;
    if (seenScripts.has(key)) continue;
    seenScripts.add(key);
    sources.push(source);
  }
  sources.sort((a, b) => String(b.date || b.mtime).localeCompare(String(a.date || a.mtime)));
  const articles = mergeCommittedArticles(buildArticleEntries(sources));
  const corpus = writeContextVaultCorpus(articles);
  const rawBundle = sources.length ? writeContextVaultRawBundle(sources) : null;
  if (!sources.length) removeContextVaultRawBundle();
  const manifest = {
    schema_version: 2,
    scanned_at: new Date().toISOString(),
    vault_dir: CONTEXT_VAULT_DIR,
    roots: rootReports,
    totals: contextVaultTotals(articles, sources),
    corpus,
    raw_bundle: rawBundle,
    sources: articles,
    raw_scripts: sources,
  };
  writeJSON(CONTEXT_VAULT_MANIFEST, manifest);
  return manifest;
}

function readContextVaultManifest() {
  const manifest = normalizeContextVaultManifest(readJSON(CONTEXT_VAULT_MANIFEST, null));
  return manifest || buildContextVaultManifest();
}

function sourceFromManifest(sourceId) {
  const manifest = readContextVaultManifest();
  const source = manifest?.sources?.find(s => s.id === sourceId)
    || manifest?.raw_scripts?.find(s => s.id === sourceId);
  return source ? { manifest, source } : { manifest, source: null };
}

function createWindow() {
  const ws = readJSON(WINDOW_STATE, { width: 1600, height: 1000 });
  // Bounds-validate the saved x/y against currently-attached displays —
  // if the user disconnected a secondary monitor between launches, the
  // saved position lands the window invisibly off-screen and the app
  // looks frozen. Drop the saved position when no display contains it;
  // Electron will then center on the active display.
  if (typeof ws.x === "number" && typeof ws.y === "number") {
    try {
      const probe = { x: ws.x + 50, y: ws.y + 50 };
      const onScreen = screen.getAllDisplays().some(d => {
        const b = d.bounds;
        return probe.x >= b.x && probe.x < b.x + b.width
            && probe.y >= b.y && probe.y < b.y + b.height;
      });
      if (!onScreen) {
        process.stderr.write(`[viz:log] saved window position (${ws.x},${ws.y}) is off-screen — centering on active display\n`);
        delete ws.x; delete ws.y;
      }
    } catch {}
  }
  const win = new BrowserWindow({
    width: ws.width, height: ws.height, x: ws.x, y: ws.y,
    minWidth: 960, minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#03020c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (ws.fullscreen) win.setFullScreen(true);
  if (process.env.SRWK_ALWAYS_ON_TOP === "1") win.setAlwaysOnTop(true);
  win.loadFile(path.join(__dirname, "src", "index.html"));
  if (process.env.SRWK_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });

  let t = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    clearTimeout(t);
    t = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeJSON(WINDOW_STATE, { ...win.getBounds(), fullscreen: win.isFullScreen() });
    }, 250);
  };
  // On close, cancel the pending debounce + write synchronously — otherwise
  // the 250ms timer fires after the window is destroyed and throws.
  win.on("resize", save);
  win.on("move", save);
  win.on("close", () => {
    clearTimeout(t);
    if (win.isDestroyed()) return;
    try { writeJSON(WINDOW_STATE, { ...win.getBounds(), fullscreen: win.isFullScreen() }); } catch {}
  });

  win.webContents.on("console-message", (_e, lvl, msg) => {
    process.stderr.write(`[viz:${["log","warn","error"][lvl]||"log"}] ${msg}\n`);
  });
  return win;
}

// ─── hermes PoC window ────────────────────────────────────────────────
// A standalone window for the Hermes (local LLM) cohort assistant. The
// renderer hits a local Ollama daemon directly — main is only here to
// own window lifecycle. Code lives in src/hermes/.
let hermesWin = null;
function createHermesWindow() {
  if (hermesWin && !hermesWin.isDestroyed()) {
    hermesWin.focus();
    return hermesWin;
  }
  hermesWin = new BrowserWindow({
    width: 760, height: 680, minWidth: 560, minHeight: 480,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#03020c",
    title: "ask cohort · hermes",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  hermesWin.loadFile(path.join(__dirname, "src", "hermes", "index.html"));
  if (process.env.SRWK_DEVTOOLS) hermesWin.webContents.openDevTools({ mode: "detach" });
  hermesWin.on("closed", () => { hermesWin = null; });
  hermesWin.webContents.on("console-message", (_e, lvl, msg) => {
    process.stderr.write(`[hermes:${["log","warn","error"][lvl]||"log"}] ${msg}\n`);
  });
  return hermesWin;
}

// Application menu — preserves Electron's stock per-platform roles
// and inserts an "Ask Cohort (Hermes)…" item under a Tools menu.
// Without this template Electron uses its default menu, which gives
// us no surface to attach the Hermes entry to.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Tools",
      submenu: [
        {
          label: "Ask Cohort (Hermes)…",
          accelerator: isMac ? "Cmd+Shift+H" : "Ctrl+Shift+H",
          click: () => createHermesWindow(),
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("prefs:load", async () => readJSON(PREFS_FILE, {}));
ipcMain.handle("prefs:save", async (_e, d) => { writeJSON(PREFS_FILE, d); return true; });
ipcMain.handle("context-vault:manifest", async () => ({
  ok: true,
  manifest: readContextVaultManifest(),
  roots: contextVaultRoots(),
  vault_dir: CONTEXT_VAULT_DIR,
}));
ipcMain.handle("context-vault:scan", async () => {
  try {
    return { ok: true, manifest: buildContextVaultManifest() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("context-vault:read-source", async (_e, sourceId) => {
  try {
    const { source } = sourceFromManifest(sourceId);
    if (!source) return { ok: false, error: "source_not_found" };
    if (!source.path) return { ok: false, error: "article_has_no_single_source_file" };
    const raw = fs.readFileSync(source.path, "utf8");
    return {
      ok: true,
      source,
      text: raw.slice(0, 2_000_000),
      truncated: raw.length > 2_000_000,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("context-vault:read-raw-bundle", async () => {
  try {
    const manifest = readContextVaultManifest();
    const rawScripts = Array.isArray(manifest?.raw_scripts) ? manifest.raw_scripts : [];
    if (!rawScripts.length) {
      removeContextVaultRawBundle();
      return { ok: false, error: "raw_bundle_not_available" };
    }
    const bundlePath = manifest?.raw_bundle?.path;
    if (!bundlePath || !fs.existsSync(bundlePath)) return { ok: false, error: "raw_bundle_not_found" };
    const raw = fs.readFileSync(bundlePath, "utf8");
    return {
      ok: true,
      path: bundlePath,
      text: raw.slice(0, 5_000_000),
      truncated: raw.length > 5_000_000,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("context-vault:reveal-source", async (_e, sourceId) => {
  const { source } = sourceFromManifest(sourceId);
  if (!source) return { ok: false, error: "source_not_found" };
  if (!source.path) return { ok: false, error: "article_has_no_single_source_file" };
  try {
    shell.showItemInFolder(source.path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("context-vault:reveal-corpus", async () => {
  try {
    const manifest = readContextVaultManifest();
    const corpusPath = manifest?.corpus?.path || CONTEXT_VAULT_CORPUS;
    if (!fs.existsSync(corpusPath)) return { ok: false, error: "corpus_not_found" };
    shell.showItemInFolder(corpusPath);
    return { ok: true, path: corpusPath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("clipboard:write", async (_e, text) => {
  try {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("env:get", async () => ({
  // Point at a local swf-node --full. The aggregator routes (/graph,
  // /events, /admin/*) live on the same port as the peer-server;
  // 7777 is the swf-node default. Override with SWF_NODE_URL or the
  // legacy SRWK_SERVER for back-compat.
  serverUrl: process.env.SWF_NODE_URL
    || process.env.SRWK_SERVER
    || "http://127.0.0.1:7777",
  mode: process.env.SRWK_ROLE === "bench" ? "bench" : "visualizer",
}));
ipcMain.handle("shell:openExternal", async (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle("shell:openDownloadedInstaller", async (_e, filePath) => {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { ok: false, reason: "bad_path" };
  }
  const downloads = path.resolve(app.getPath("downloads"));
  const target = path.resolve(filePath);
  const rel = path.relative(downloads, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "outside_downloads" };
  }
  const allowedExt = new Set([".dmg", ".exe", ".deb", ".appimage"]);
  if (!allowedExt.has(path.extname(target).toLowerCase())) {
    return { ok: false, reason: "unsupported_file" };
  }
  if (!fs.existsSync(target)) return { ok: false, reason: "missing" };
  try {
    if (process.platform === "darwin" || process.platform === "win32") {
      const detail = await shell.openPath(target);
      return detail ? { ok: false, reason: "open_failed", detail } : { ok: true };
    }
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "open_failed", detail: e?.message || String(e) };
  }
});

// ─── bundled swf-node supervisor ─────────────────────────────────────
// Spawn + supervise the swf-node binary that ships in
// Contents/Resources/swf-node/. Until this landed, the renderer was
// pointed at http://127.0.0.1:7777 and assumed the user was running
// the daemon externally. Now the OS app owns it.
//
// State broadcast goes to every BrowserWindow so the renderer (once it
// adds a status indicator) sees idle → starting → running, plus
// crashed/unsupported terminal states.
function broadcastSwfNodeStatus(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send("fg:swf-node-status-changed", state); } catch {}
  }
}

// Self-heal the daemon: if the app is running but the backend is down
// (crashed, or `unsupported` because the binary was briefly missing during
// an in-place update), re-check + respawn when the user comes back to the
// app. Debounced so a genuinely-missing binary isn't hammered on every
// focus event. The supervisor itself gives up after RESTART_LIMIT, so
// without this an app left open with a dead daemon never recovers.
let _lastDaemonRecheck = 0;
function recheckDaemon() {
  const st = swfNode.getStatus();
  if (st === "running" || st === "starting") return;
  const now = Date.now();
  if (now - _lastDaemonRecheck < 10_000) return;
  _lastDaemonRecheck = now;
  if (swfNode.restart(app, broadcastSwfNodeStatus)) {
    process.stderr.write("[viz:log] backend was down on focus/activate — respawning swf-node\n");
  }
}

ipcMain.handle("fg:swf-node-status", async () => swfNode.getStatus());

// Explicit "restart the backend" — wired to the network tab's down-state
// affordance. Bypasses the focus-recheck debounce so a deliberate click
// always tries. Returns whether a spawn was kicked off + the new status.
ipcMain.handle("fg:swf-node-restart", async () => {
  _lastDaemonRecheck = Date.now();
  const started = swfNode.restart(app, broadcastSwfNodeStatus);
  return { ok: started, status: swfNode.getStatus() };
});

// When the supervisor latched into `external_squatter` at start() time,
// expose what /.well-known/indrex reported on :7777. The renderer reads
// this to render a remediation banner: "an older swf-node vX.Y.Z is
// running on this machine — pkill -f swf-node and relaunch". Returns
// null in the normal case (we spawned our own child).
ipcMain.handle("fg:swf-node-external-info", async () => swfNode.getExternalDaemonInfo() || null);

// Renderer asks for the agent bearer token here so sync-client.js can
// authenticate against POST /sync/local_record. swf-node.js generates +
// persists the token on first launch (apps/os/swf-node.js). Returns
// null when no token is available — the renderer falls back to the
// github PR path in that case (dev with an external swf-node, Windows
// builds, swf-node disabled / crashed).
ipcMain.handle("fg:swf-agent-token", async () => swfNode.getAgentToken() || null);

// ─── swarm-mode IPC ──────────────────────────────────────────────────
//
// `research-swarm` subprocess supervision. Config (LLM model, API key,
// Ollama URL) is stored under userData; the Anthropic key is encrypted
// via Electron's `safeStorage` (Keychain on macOS, libsecret on Linux,
// DPAPI on Windows) so it never lives in plaintext on disk.
//
// Renderer surface:
//   fg:swarm:status        → current run state ({state, requestId, ...})
//   fg:swarm:start (q,...) → spawn agent; emits fg:swarm:output stream
//   fg:swarm:stop          → SIGTERM the running child
//   fg:swarm:config:get    → returns {lmModel, lmApiBase, hasApiKey, agent}
//   fg:swarm:config:set    → persists model + base + (optionally) api key
//
// Streamed events to renderer:
//   fg:swarm:output        { requestId, stream: stdout|stderr, line }
//   fg:swarm:status        { state: running|idle, ... }

const SWARM_CONFIG_FILE = path.join(app.getPath("userData"), "swarm-config.json");
const SWARM_KEY_FILE    = path.join(app.getPath("userData"), "swarm-api-key.enc");

function readSwarmConfig() {
  try { return JSON.parse(fs.readFileSync(SWARM_CONFIG_FILE, "utf8")); }
  catch { return {}; }
}
function writeSwarmConfig(obj) {
  try { fs.writeFileSync(SWARM_CONFIG_FILE, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { process.stderr.write(`[swarm] config write failed: ${e.message}\n`); return false; }
}
function readSwarmApiKey() {
  try {
    if (!fs.existsSync(SWARM_KEY_FILE)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      // fallback path — should rarely hit in practice (mac Keychain is always there)
      return fs.readFileSync(SWARM_KEY_FILE, "utf8");
    }
    const buf = fs.readFileSync(SWARM_KEY_FILE);
    return safeStorage.decryptString(buf);
  } catch (e) {
    process.stderr.write(`[swarm] api key decrypt failed: ${e.message}\n`);
    return null;
  }
}
function writeSwarmApiKey(plain) {
  try {
    if (!plain) { try { fs.unlinkSync(SWARM_KEY_FILE); } catch {} return true; }
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(String(plain));
      fs.writeFileSync(SWARM_KEY_FILE, buf, { mode: 0o600 });
    } else {
      // mac dev mode without Keychain access shouldn't really happen
      fs.writeFileSync(SWARM_KEY_FILE, String(plain), { mode: 0o600 });
    }
    return true;
  } catch (e) { process.stderr.write(`[swarm] api key write failed: ${e.message}\n`); return false; }
}

ipcMain.handle("fg:swarm:status", async () => swarm.getStatus());

// Poll swf-node's /health until 200 or the deadline. The supervisor's
// "running" state doesn't guarantee the HTTP server is bound yet —
// there's a small grace window between spawn and listen. The agent's
// very first /web_search will fail if we don't wait for it.
async function waitForSwfHttpReady(swfNodeUrl, deadlineMs) {
  const url = `${swfNodeUrl.replace(/\/+$/, "")}/health`;
  while (Date.now() < deadlineMs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 400);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(res => setTimeout(res, 150));
  }
  return false;
}

// Before the swarm spawns, make sure the swf-node sidecar is healthy
// — the agent now routes ALL web traffic through it (RA_BACKEND=
// swf-node in swarm-node.js), so a down peer means a dead run with
// network errors and zero atlas growth. Tries one auto-restart if
// needed; gives the renderer a clear actionable error if that fails.
async function ensureSwfNodeReady() {
  const url = process.env.SWF_NODE_URL || "http://127.0.0.1:7777";
  if (await waitForSwfHttpReady(url, Date.now() + 250)) return { ok: true, url };
  const st = swfNode.getStatus();
  if (st !== "running" && st !== "starting") {
    process.stderr.write(`[swarm] swf-node not ready (state=${st}) — auto-restart before swarm start\n`);
    _lastDaemonRecheck = Date.now();
    swfNode.restart(app, broadcastSwfNodeStatus);
  }
  const ready = await waitForSwfHttpReady(url, Date.now() + 3000);
  if (ready) return { ok: true, url };
  return {
    ok: false,
    reason: "swf_node_unavailable",
    detail:
      "swf-node sidecar isn't responding on " + url + ". The swarm " +
      "routes all of its web traffic through swf-node so the atlas " +
      "stays consistent and your privacy policy is applied — without " +
      "it, a run would produce nothing useful. Try the 'restart " +
      "backend' affordance in the network tab.",
  };
}

ipcMain.handle("fg:swarm:start", async (_e, opts) => {
  const swfReady = await ensureSwfNodeReady();
  if (!swfReady.ok) return swfReady;

  const cfg = readSwarmConfig();
  const o = opts || {};
  // model can be overridden per-call; defaults to the saved config.
  const lmModel   = o.lmModel   || cfg.lmModel   || "anthropic/claude-sonnet-4-6";
  const lmApiBase = o.lmApiBase || cfg.lmApiBase || "";
  let   lmApiKey  = o.lmApiKey;
  if (!lmApiKey && lmModel.startsWith("anthropic/")) lmApiKey = readSwarmApiKey();
  return swarm.start({
    requestId: o.requestId || `req_${Math.random().toString(36).slice(2, 10)}`,
    query:     o.query,
    lmModel, lmApiKey, lmApiBase,
    parallel:  !!o.parallel,
    workers:   o.workers,
    swfNodeUrl:   swfReady.url,
    swfNodeToken: swfNode.getAgentToken() || "",
  });
});

ipcMain.handle("fg:swarm:stop",   async () => swarm.stop());

ipcMain.handle("fg:swarm:config:get", async () => {
  const cfg = readSwarmConfig();
  const agent = swarm.getAgentInfo();
  return {
    lmModel:   cfg.lmModel   || "anthropic/claude-sonnet-4-6",
    lmApiBase: cfg.lmApiBase || "",
    hasApiKey: !!readSwarmApiKey(),
    agent,
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle("fg:swarm:config:set", async (_e, opts) => {
  const o = opts || {};
  const cfg = readSwarmConfig();
  if (typeof o.lmModel   === "string") cfg.lmModel   = o.lmModel.trim();
  if (typeof o.lmApiBase === "string") cfg.lmApiBase = o.lmApiBase.trim();
  writeSwarmConfig(cfg);
  // apiKey is optional; if present, encrypt+persist. If explicitly "" (empty), clear.
  if (Object.prototype.hasOwnProperty.call(o, "lmApiKey")) {
    writeSwarmApiKey(o.lmApiKey);
  }
  return { ok: true };
});

// Bridge swarm-node's local emitters to renderer IPC. The single
// BrowserWindow we own gets every event.
function broadcastSwarm(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch {}
  }
}
swarm.onStatus((s) => broadcastSwarm("fg:swarm:status-changed", s));
swarm.onOutput((o) => broadcastSwarm("fg:swarm:output", o));

// ─── easel · NDI projection (apps/os/easel-ndi.js) ───────────────────
// Renderer lists capture sources, then streams RGBA frames here to be
// broadcast as an NDI source. Source enumeration must run in main
// (desktopCapturer is main-process in Electron); the renderer turns the
// chosen id into a MediaStream via getUserMedia.
ipcMain.handle("easel:available", async () => easelNdi.isAvailable());
ipcMain.handle("easel:list-sources", async () => {
  const { desktopCapturer } = require("electron");
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith("screen") ? "screen" : "window",
    thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
  }));
});
ipcMain.handle("easel:start", async (e, opts) => {
  try {
    const res = await easelNdi.start(opts && opts.name);
    // While broadcasting, keep the renderer's capture pump running at full
    // FPS even when the OS window is backgrounded/occluded. Otherwise
    // switching to another app throttles its timers and the NDI stream
    // stalls. Restored to throttled on stop.
    try { e.sender.setBackgroundThrottling(false); } catch {}
    return res;
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle("easel:frame", async (_e, frame) => easelNdi.sendFrame(frame));
ipcMain.handle("easel:stats", async () => easelNdi.stats());
ipcMain.handle("easel:stop", async (e) => {
  try { e.sender.setBackgroundThrottling(true); } catch {}
  return easelNdi.stop();
});
// ─── easel · receive side (watch others on the LAN) ───
// Discover NDI sources + stream the chosen source's frames back to the
// renderer. Frame data crosses IPC as a Uint8Array (RGBA, line-stride);
// the renderer puts it on a canvas via putImageData.
ipcMain.handle("easel:find-sources", async (_e, opts) => easelNdi.find(opts || {}));
ipcMain.handle("easel:rx-start", async (e, opts) => {
  const wc = e.sender;
  // Keep the renderer's frame-draw work running smoothly even when the app
  // window is backgrounded (same reason we do it for the sender side).
  try { wc.setBackgroundThrottling(false); } catch {}
  return easelNdi.recvStart({
    sourceName: opts && opts.sourceName,
    onFrame: (frame) => {
      if (wc.isDestroyed()) return;
      try { wc.send("easel:rx-frame", frame); } catch {}
    },
    onAudio: (frame) => {
      if (wc.isDestroyed()) return;
      try { wc.send("easel:rx-audio", frame); } catch {}
    },
  });
});
ipcMain.handle("easel:rx-stop", async (e) => {
  // Only re-throttle if the sender side isn't still live.
  try {
    const sStats = easelNdi.stats && easelNdi.stats();
    if (!sStats || !sStats.live) e.sender.setBackgroundThrottling(true);
  } catch {}
  return easelNdi.recvStop();
});
ipcMain.handle("easel:rx-stats", async () => easelNdi.recvStats());

// Per-source thumbnail receivers — drive the live previews inside each
// LAN feed card. Frames stream back via "easel:thumb-frame" tagged with
// sourceName so the renderer can route to the right card canvas.
ipcMain.handle("easel:thumb-start", async (e, opts) => {
  const wc = e.sender;
  return easelNdi.thumbStart({
    sourceName: opts && opts.sourceName,
    onFrame: (frame) => {
      if (wc.isDestroyed()) return;
      try { wc.send("easel:thumb-frame", frame); } catch {}
    },
  });
});
ipcMain.handle("easel:thumb-stop", async (_e, opts) => easelNdi.thumbStop(opts && opts.sourceName));
ipcMain.handle("easel:thumb-stop-all", async () => easelNdi.thumbStopAll());

// Dev-only sync-client smoke test. Triggers the renderer's
// window.__srfgSyncClientSelfTest() helper (apps/os/src/renderer/sync-client.js
// installs it on load). Bound here so a user can also run it from
// outside the renderer's devtools — e.g. via a hidden hotkey wired in
// the main process. Returns whatever the renderer's selftest resolved
// with, or { ok: false, reason: "no_window" } when no BrowserWindow
// exists yet.
ipcMain.handle("fg:sync-client-selftest", async () => {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (!win) return { ok: false, reason: "no_window" };
  try {
    return await win.webContents.executeJavaScript(
      "window.__srfgSyncClientSelfTest && window.__srfgSyncClientSelfTest()"
    );
  } catch (e) {
    return { ok: false, reason: "exec_failed", error: e?.message || String(e) };
  }
});

// ─── electron-updater (release-driven app binary updates) ────────────
// Reads the `latest-{mac,win,linux}.yml` feed published by
// .github/workflows/os-release.yml on each tag push. No-op in
// dev — `npm run dev` users still update via git pull / npm install.
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;          // wait for explicit user click
    autoUpdater.autoInstallOnAppQuit = true;   // apply on next quit if downloaded
    autoUpdater.on("error", (err) => process.stderr.write(`[viz:warn] updater error: ${err && err.message}\n`));
    autoUpdater.on("update-available", (info) => process.stderr.write(`[viz:log] update available: ${info && info.version}\n`));
    autoUpdater.on("update-not-available", () => process.stderr.write(`[viz:log] no update available\n`));
    autoUpdater.on("download-progress", (p) => {
      process.stderr.write(`[viz:log] downloading update: ${Math.round(p.percent || 0)}%\n`);
      // Forward to the renderer so the inline update panel can render a
      // live % bar. The Shape Rotator OS only ever has one window, so first-of
      // is fine; guard for "no window yet" (the updater can technically
      // fire before the renderer is created if a check is triggered early).
      try {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send("fg:update-progress", {
          percent: p.percent || 0,
          bytesPerSecond: p.bytesPerSecond || 0,
          transferred: p.transferred || 0,
          total: p.total || 0,
        });
      } catch {}
    });
    autoUpdater.on("update-downloaded", (info) => process.stderr.write(`[viz:log] update downloaded: ${info && info.version}\n`));
    // Defer the first check ~30s so it doesn't race the boot-path fetch to swf-node on 127.0.0.1:7777.
    // Then re-check every 6h so long-running sessions still notice new releases.
    setTimeout(() => {
      try { autoUpdater.checkForUpdates().catch((err) => process.stderr.write(`[viz:warn] updater check failed: ${err && err.message}\n`)); }
      catch (e) { process.stderr.write(`[viz:warn] updater check threw: ${e.message}\n`); }
      setInterval(() => {
        try { autoUpdater.checkForUpdates().catch((err) => process.stderr.write(`[viz:warn] updater check failed: ${err && err.message}\n`)); }
        catch (e) { process.stderr.write(`[viz:warn] updater check threw: ${e.message}\n`); }
      }, 6 * 60 * 60 * 1000);
    }, 30 * 1000);
  } catch (e) {
    process.stderr.write(`[viz:warn] electron-updater init failed: ${e.message}\n`);
  }
}

ipcMain.handle("fg:check-update", async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: "dev_mode", current: app.getVersion(), detail: "auto-update is disabled in dev (npm run dev). git pull && npm install instead." };
  }
  try {
    const { autoUpdater } = require("electron-updater");
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version || null;
    const available = !!latest && latest !== app.getVersion();
    return { ok: true, current: app.getVersion(), latest, available };
  } catch (e) {
    return { ok: false, reason: "check_failed", detail: e.message, current: app.getVersion() };
  }
});

ipcMain.handle("fg:apply-update", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev_mode" };
  try {
    const { autoUpdater } = require("electron-updater");
    await autoUpdater.downloadUpdate();
    return { ok: true, detail: "downloaded · will install on next quit (or click 'install + restart' to apply now)" };
  } catch (e) {
    return { ok: false, reason: "download_failed", detail: e.message };
  }
});

ipcMain.handle("fg:apply-update-and-restart", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev_mode" };
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "install_failed", detail: e.message };
  }
});

// Read a build-time flag from the bundled package.json. CI stamps
// `signed=true` via electron-builder's --config.extraMetadata.signed
// flag when the macOS build went through the full sign + notarize
// path. Unsigned mac builds (and every Windows/Linux build) leave it
// undefined, so the renderer keeps using the manual-download flow.
let _pkgSigned = false;
try { _pkgSigned = !!require("./package.json").signed; } catch {}

ipcMain.handle("fg:get-app-info", () => {
  const platform = process.platform;
  const isAppImage = !!process.env.APPIMAGE;
  // Whether electron-updater's quitAndInstall path is viable here:
  //   Windows         — NSIS, no signing required
  //   Linux AppImage  — single-binary, replaceable without root
  //   macOS (signed)  — Hardened Runtime + notarytool stamp lets us
  //                     pass macOS's signature verification on swap.
  //                     `_pkgSigned` is true only when CI signed +
  //                     notarized this build.
  //   macOS (unsigned)— Gatekeeper refuses the .app swap → manual path
  //   Linux .deb      — system install, would need sudo → manual path
  const canAutoUpdate =
    platform === "win32" ||
    (platform === "linux" && isAppImage) ||
    (platform === "darwin" && _pkgSigned);
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform,
    arch: process.arch,
    canAutoUpdate,
    isAppImage,
    signed: _pkgSigned,
  };
});

// ─── manual-install download path ───────────────────────────────────
// macOS won't let an unsigned app rewrite itself, so electron-updater's
// quitAndInstall silently fails. Instead of pretending: stream the
// platform's release asset to ~/Downloads/, then `shell.openPath` it —
// on mac that mounts the dmg and pops the standard Finder install
// window. The renderer streams "fg:update-progress" events the same
// way electron-updater would, so the existing progress UI lights up.
//
// Returns { ok, path, version } on success, or { ok: false, reason }
// otherwise. No-op in dev (no point downloading; the user has the source).
//
// IMPORTANT: this path must not hit api.github.com. The unauthenticated
// REST API is rate-limited to 60 req/hr per IP, and a cohort sharing a
// LAN can saturate the bucket from elsewhere (cohort-source, etc.). We
// learn the latest version from electron-updater (which fetches
// latest-{platform}.yml via the github.com → objects.githubusercontent.com
// redirect — no API quota) and construct the asset download URL from the
// known release-naming convention. The download URL itself is also a
// github.com redirect, so the whole flow stays off the API entirely.
function platformAssetName(version) {
  const proc = process;
  if (proc.platform === "darwin") {
    return proc.arch === "arm64"
      ? `ShapeRotatorOS-${version}-mac-arm64.dmg`
      : `ShapeRotatorOS-${version}-mac-x64.dmg`;
  }
  if (proc.platform === "linux") {
    return proc.arch === "arm64"
      ? `ShapeRotatorOS-${version}-linux-arm64.deb`
      : `ShapeRotatorOS-${version}-linux-amd64.deb`;
  }
  if (proc.platform === "win32") {
    return proc.arch === "arm64"
      ? `ShapeRotatorOS-${version}-win-arm64.exe`
      : `ShapeRotatorOS-${version}-win-x64.exe`;
  }
  return null;
}

function releaseAssetBasename(value) {
  return String(value || "").split(/[\\/]/).pop();
}

function updateInfoAsset(updateInfo, assetName) {
  const files = Array.isArray(updateInfo?.files) ? updateInfo.files : [];
  const match = files.find((file) => releaseAssetBasename(file?.url) === assetName);
  if (match?.sha512) return match;
  if (releaseAssetBasename(updateInfo?.path) === assetName && updateInfo?.sha512) {
    return { url: updateInfo.path, sha512: updateInfo.sha512, size: updateInfo.size };
  }
  return null;
}

ipcMain.handle("fg:download-and-reveal-update", async () => {
  if (!app.isPackaged) return { ok: false, reason: "dev_mode", detail: "no asset to download in dev." };
  const https = require("node:https");
  const fsp = require("node:fs/promises");

  // 1) resolve the latest version via electron-updater (no API quota).
  //    autoUpdater.checkForUpdates() reads latest-{mac,win,linux}.yml
  //    from the github.com /releases/latest/download/ redirect, which
  //    in turn points at objects.githubusercontent.com. None of that
  //    counts against the api.github.com 60/hr budget.
  let version;
  let updateInfo = null;
  try {
    const { autoUpdater } = require("electron-updater");
    const result = await autoUpdater.checkForUpdates();
    updateInfo = result?.updateInfo || null;
    version = String(updateInfo?.version || "").replace(/^v/, "");
  } catch (e) {
    return { ok: false, reason: "check_failed", detail: `couldn't resolve latest version: ${e.message}` };
  }
  if (!version) return { ok: false, reason: "no_version", detail: "couldn't read latest version from update feed." };

  const assetName = platformAssetName(version);
  if (!assetName) return { ok: false, reason: "no_asset", detail: `no platform asset for ${process.platform}/${process.arch}` };
  const expectedAsset = updateInfoAsset(updateInfo, assetName);
  if (!expectedAsset?.sha512) {
    return { ok: false, reason: "missing_checksum", detail: `update feed has no sha512 for ${assetName}` };
  }
  // github.com/.../releases/download/ is a redirect to objects.githubusercontent.com.
  // Not rate-limited. The followingGet loop below already handles 30x chains.
  const downloadUrl = `https://github.com/dmarzzz/shape-rotator-os/releases/download/v${version}/${assetName}`;

  // 2) stream the asset to ~/Downloads/<name>.
  const downloads = app.getPath("downloads");
  await fsp.mkdir(downloads, { recursive: true });
  const dest = path.join(downloads, assetName);
  const partial = `${dest}.part`;

  let downloadResult;
  try {
    downloadResult = await new Promise((resolve, reject) => {
      const write = fs.createWriteStream(partial);
      const hasher = crypto.createHash("sha512");
      const win = BrowserWindow.getAllWindows()[0];
      const rejectDownload = (err) => {
        try { write.destroy(); } catch {}
        reject(err);
      };
      const followingGet = (url, depth) => {
        if (depth > 5) return rejectDownload(new Error("too many redirects"));
        https.get(url, { headers: { "User-Agent": "shape-rotator-os" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const nextUrl = res.headers.location ? new URL(res.headers.location, url).toString() : null;
            res.resume();
            if (!nextUrl) return rejectDownload(new Error(`redirect from ${url} had no Location header`));
            return followingGet(nextUrl, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return rejectDownload(new Error(`download returned HTTP ${res.statusCode}`));
          }
          const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
          let got = 0;
          let lastEmit = 0;
          res.on("data", (chunk) => {
            got += chunk.length;
            hasher.update(chunk);
            // Emit at most ~20 progress events/sec to avoid flooding IPC.
            const now = Date.now();
            if (now - lastEmit > 50 || got === total) {
              lastEmit = now;
              const percent = total ? (got / total) * 100 : 0;
              try {
                if (win && !win.isDestroyed()) {
                  win.webContents.send("fg:update-progress", { percent, transferred: got, total });
                }
              } catch {}
            }
          });
          res.pipe(write);
          write.on("finish", () => {
            const actualSha512 = hasher.digest("base64");
            const expectedSize = Number(expectedAsset.size || 0);
            if (expectedSize && got !== expectedSize) {
              return reject(new Error(`download size mismatch for ${assetName}: got ${got}, expected ${expectedSize}`));
            }
            if (actualSha512 !== expectedAsset.sha512) {
              return reject(new Error(`download checksum mismatch for ${assetName}`));
            }
            resolve({ bytes: got, sha512: actualSha512 });
          });
          write.on("error", reject);
          res.on("error", reject);
        }).on("error", rejectDownload);
      };
      followingGet(downloadUrl, 0);
    });
  } catch (e) {
    try { await fsp.rm(partial, { force: true }); } catch {}
    return { ok: false, reason: "download_failed", detail: e.message };
  }

  try {
    await fsp.rename(partial, dest);
  } catch (e) {
    try { await fsp.rm(partial, { force: true }); } catch {}
    return { ok: false, reason: "download_failed", detail: e.message };
  }

  // 3) reveal / open. Platform-specific because the right next step
  // differs:
  //   macOS  — openPath(.dmg) mounts the dmg and pops the standard
  //            "drag .app to /Applications" Finder window. User drags
  //            + runs xattr -cr (see renderer copy).
  //   Windows — openPath(.exe) launches the NSIS installer. UAC
  //            prompts; installer walks through; done.
  //   Linux  — showItemInFolder(.deb). We can't sudo dpkg from inside
  //            the app, so the user runs it themselves. The renderer
  //            shows the shell snippet.
  try {
    if (process.platform === "darwin" || process.platform === "win32") {
      await shell.openPath(dest);
    } else {
      shell.showItemInFolder(dest);
    }
  } catch (e) {
    // The file is downloaded successfully even if open fails — surface
    // the path so the renderer can show "your installer is at <path>".
    return { ok: true, path: dest, version, openFailed: e.message };
  }
  return { ok: true, path: dest, version, bytes: downloadResult.bytes };
});

// ─── calendar export — PNG / PDF ────────────────────────────────────
// Renderer hands us a base64 data URL (the canvas snapshot). We pop a
// native save dialog so the user can pick where the file lands. PNG
// is recommended for messaging — renders inline in iMessage, Slack,
// Discord. PDF route uses Electron's offscreen window + printToPDF
// with a sized HTML wrapper around the same image.
function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || "").match(/^data:.+;base64,(.+)$/);
  if (!m) throw new Error("invalid data url");
  return Buffer.from(m[1], "base64");
}
ipcMain.handle("fg:export-calendar", async (_e, opts = {}) => {
  const format = opts.format === "pdf" ? "pdf" : "png";
  const stamp = new Date().toISOString().slice(0, 10);
  // Caller can pass `filename` to override the default; used by the
  // dossier export so the file doesn't land as "cohort-calendar".
  const baseName = (typeof opts.filename === "string" && opts.filename.trim())
    ? opts.filename.trim()
    : `cohort-calendar-${stamp}`;
  const defaultName = `${baseName}.${format}`;
  try {
    const win = BrowserWindow.getFocusedWindow();
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: format === "pdf" ? "Export cohort calendar (PDF)" : "Export cohort calendar (PNG)",
      defaultPath: path.join(app.getPath("desktop"), defaultName),
      filters: format === "pdf"
        ? [{ name: "PDF", extensions: ["pdf"] }]
        : [{ name: "PNG image", extensions: ["png"] }],
    });
    if (canceled || !filePath) return { ok: false, reason: "cancelled" };

    if (format === "png") {
      const buf = dataUrlToBuffer(opts.dataUrl);
      fs.writeFileSync(filePath, buf);
      return { ok: true, path: filePath };
    }

    // PDF path: open an offscreen BrowserWindow at the canvas's pixel
    // size, render the image, ask the chromium engine for a PDF, save.
    const w = Math.max(800, Math.round(opts.w || 1400));
    const h = Math.max(600, Math.round(opts.h || 1100));
    const pdfWin = new BrowserWindow({
      show: false,
      width: Math.min(w, 4000),
      height: Math.min(h, 4000),
      webPreferences: { offscreen: false, sandbox: false, contextIsolation: true },
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#0b0a08;}
      img{display:block;width:${w}px;height:${h}px;}
      @page{size:${w}px ${h}px;margin:0;}
    </style></head><body><img src="${opts.dataUrl}"></body></html>`;
    await pdfWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdfBuf = await pdfWin.webContents.printToPDF({
      pageSize: { width: w * 1000, height: h * 1000 },   // micrometers
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(filePath, pdfBuf);
    pdfWin.destroy();
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: "export_failed", detail: String(e && e.message || e) };
  }
});

app.whenReady().then(() => {
  // Headless self-test path: boot the renderer, assert ready, exit. Skips
  // the dock icon, menu, swf-node spawn, and auto-updater — none of that
  // matters for "does the renderer load without throwing".
  if (SMOKE_TEST) { runSmokeTest(); return; }

  // Dev-mode dock icon. Packaged builds get their icon from electron-builder
  // (build-resources/icon.icns); in `npm run os` we'd otherwise see
  // the generic Electron dock icon. Set it explicitly here.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, "build-resources", "icon.png")); }
    catch (e) { process.stderr.write(`[viz:warn] dock icon set failed: ${e && e.message}\n`); }
  }
  createWindow();
  buildAppMenu();
  initAutoUpdater();
  // Spin the bundled swf-node up after the first window exists so its
  // state-change broadcasts have a webContents target. On win32 + when
  // the binary is missing, start() short-circuits to "unsupported"
  // and the renderer keeps the legacy "swf-node not running" UX.
  swfNode.start(app, broadcastSwfNodeStatus);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    recheckDaemon();
  });
  // Coming back to the window re-checks the backend — the main recovery
  // path after an in-place update that left the daemon down.
  app.on("browser-window-focus", () => recheckDaemon());
});

// Gracefully stop the bundled swf-node on quit. We use before-quit
// (fires once per quit, before windows are closed) and await stop()
// so SIGTERM + grace window + SIGKILL all complete before the
// process exits. Without `event.preventDefault()` electron quits
// immediately and the child becomes our zombie.
let _quittingSwfNode = false;
app.on("before-quit", (event) => {
  if (_quittingSwfNode) return;
  const status = swfNode.getStatus();
  if (status === "idle" || status === "unsupported" || status === "crashed") return;
  event.preventDefault();
  _quittingSwfNode = true;
  swfNode.stop().finally(() => {
    app.quit();
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
