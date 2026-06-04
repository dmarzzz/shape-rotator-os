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

if (missing.length) {
  console.error("[check-packaging-files] build.files misses required main-process files:");
  for (const rel of missing) console.error(`  - ${rel}`);
  process.exit(1);
}

console.log(`[check-packaging-files] ok: ${requiredFiles.size} required main-process files covered`);
