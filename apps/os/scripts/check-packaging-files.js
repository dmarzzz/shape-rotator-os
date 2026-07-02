const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const pkgPath = path.join(appRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const buildFiles = (pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [])
  .filter((entry) => typeof entry === "string");

function relPath(absPath) {
  return path.relative(appRoot, absPath).split(path.sep).join("/");
}

function isInsideApp(absPath) {
  const rel = path.relative(appRoot, absPath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveLocalRequire(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(base)
    ? [base]
    : [base + ".js", base + ".json", path.join(base, "index.js")];

  return candidates.find((candidate) => {
    try {
      return isInsideApp(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

const requirePattern = /(?:^|[^\w.])require\s*\(\s*["']([^"']+)["']\s*\)/g;
const staticImportPattern = /(?:^|[\s;])(?:import|export)\b[^"']*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/g;
const dynamicImportPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const stylesheetPattern = /loadStylesheetOnce\s*\(\s*["']([^"']+)["']\s*\)/g;
const htmlAssetPattern = /(?:src|href)=["']([^"']+)["']/g;
const strippedThreeImportPattern = /(?:from\s+|import\s*\(\s*|(?:^|[\s;])import\s*)["'](three\/examples\/jsm|three\/addons)\//m;
const seen = new Set();
const requiredFiles = new Set();

function walkRequires(absFile) {
  const rel = relPath(absFile);
  if (seen.has(rel)) return;
  seen.add(rel);
  requiredFiles.add(rel);

  if (!rel.endsWith(".js")) return;
  const source = fs.readFileSync(absFile, "utf8");
  for (const match of source.matchAll(requirePattern)) {
    const specifier = match[1];
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const resolved = resolveLocalRequire(absFile, specifier);
    if (resolved) walkRequires(resolved);
  }
}

for (const entry of [pkg.main || "main.js", "preload.js"]) {
  const absEntry = path.join(appRoot, entry);
  if (fs.existsSync(absEntry)) walkRequires(absEntry);
}

function patternMatches(pattern, rel) {
  const normalized = pattern.replace(/\\/g, "/");
  if (normalized === rel) return true;
  if (normalized === "**" || normalized === "**/*") return true;
  if (normalized === "*") return !rel.includes("/");
  if (/^\*\.[^/]+$/.test(normalized)) {
    return !rel.includes("/") && rel.endsWith(normalized.slice(1));
  }
  if (normalized.endsWith("/**/*")) {
    const dir = normalized.slice(0, -"/**/*".length);
    return rel.startsWith(dir + "/");
  }
  if (normalized.endsWith("/**")) {
    const dir = normalized.slice(0, -"/**".length);
    return rel === dir || rel.startsWith(dir + "/");
  }
  return false;
}

function isCovered(rel) {
  let covered = false;
  for (const pattern of buildFiles) {
    if (pattern.startsWith("!")) {
      if (patternMatches(pattern.slice(1), rel)) covered = false;
    } else if (patternMatches(pattern, rel)) {
      covered = true;
    }
  }
  return covered;
}

const missing = [...requiredFiles].filter((rel) => !isCovered(rel));
const requiredReleaseScripts = [
  "scripts/before-pack-stage-binaries.cjs",
  "scripts/fetch-github-release-binary.sh",
  "scripts/fetch-swf-node.sh",
  "scripts/fetch-research-swarm.sh",
  "scripts/fetch-whisper.sh",
];
for (const rel of requiredReleaseScripts) {
  if (!fs.existsSync(path.join(appRoot, rel))) {
    missing.push(rel);
  }
}

function walkFiles(rootDir, extensions) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.statSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      continue;
    }
    if (extensions.has(path.extname(current))) files.push(current);
  }
  return files;
}

function resolveLocalAsset(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = path.extname(base)
    ? [base]
    : [base + ".js", base + ".mjs", base + ".cjs", base + ".json", base + ".css", path.join(base, "index.js"), path.join(base, "index.mjs")];

  return candidates.find((candidate) => {
    try {
      return isInsideApp(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function stripUrlSuffix(specifier) {
  return specifier.split(/[?#]/, 1)[0];
}

function isLocalBrowserAsset(specifier) {
  return specifier &&
    !/^(?:https?:|data:|file:|app:|mailto:|#)/.test(specifier) &&
    !specifier.startsWith("/");
}

function requireCoveredAsset(problems, ownerRel, label, absPath) {
  if (!absPath || !isInsideApp(absPath)) {
    problems.push(`${ownerRel} references missing ${label}`);
    return;
  }
  const rel = relPath(absPath);
  if (!isCovered(rel)) problems.push(`${ownerRel} references ${label} ${rel}, but build.files does not include it`);
}

const sourceProblems = [];
const srcRoot = path.join(appRoot, "src");
if (fs.existsSync(srcRoot)) {
  for (const absFile of walkFiles(srcRoot, new Set([".js", ".mjs"]))) {
    const rel = relPath(absFile);
    const source = fs.readFileSync(absFile, "utf8");

    if (!rel.startsWith("src/vendor/") && strippedThreeImportPattern.test(source)) {
      sourceProblems.push(`${rel} imports three/examples/jsm or three/addons; package those modules under src/vendor instead`);
    }

    for (const match of source.matchAll(staticImportPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith(".")) continue;
      requireCoveredAsset(sourceProblems, rel, `static import "${specifier}"`, resolveLocalAsset(absFile, specifier));
    }

    for (const match of source.matchAll(dynamicImportPattern)) {
      const specifier = match[1];
      if (!specifier || !specifier.startsWith(".")) continue;
      requireCoveredAsset(sourceProblems, rel, `dynamic import "${specifier}"`, resolveLocalAsset(absFile, specifier));
    }

    for (const match of source.matchAll(stylesheetPattern)) {
      const href = stripUrlSuffix(match[1]);
      if (!isLocalBrowserAsset(href)) continue;
      requireCoveredAsset(sourceProblems, rel, `lazy stylesheet "${href}"`, path.join(srcRoot, href));
    }
  }

  for (const absFile of walkFiles(srcRoot, new Set([".html"]))) {
    const rel = relPath(absFile);
    const source = fs.readFileSync(absFile, "utf8");
    for (const match of source.matchAll(htmlAssetPattern)) {
      const specifier = stripUrlSuffix(match[1]);
      if (!isLocalBrowserAsset(specifier)) continue;
      requireCoveredAsset(sourceProblems, rel, `HTML asset "${specifier}"`, resolveLocalAsset(absFile, specifier));
    }
  }
}

if (missing.length || sourceProblems.length) {
  console.error("[check-packaging-files] build.files misses required main-process files:");
  for (const rel of missing) console.error(`  - ${rel}`);
  if (sourceProblems.length) {
    console.error("[check-packaging-files] renderer package references are not covered:");
    for (const problem of sourceProblems) console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`[check-packaging-files] ok: ${requiredFiles.size} required main-process files covered; renderer imports/styles/assets covered`);
