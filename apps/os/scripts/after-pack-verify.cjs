// electron-builder afterPack hook — release safety gate.
//
// Runs after the app is packed into app.asar but BEFORE artifact
// (dmg/exe/AppImage) creation and BEFORE publish. Throwing here aborts
// the entire build, so a broken package can never reach the release page.
//
// Dev mode runs from source (node_modules on disk), so it physically
// cannot catch "works in dev, broken in the packaged app" bugs. Two
// shipped before this guard existed:
//   - v0.2.13: main.js did require("./swarm-node") but swarm-node.js was
//     never listed in build.files → asar lacked it → "Cannot find module"
//     on launch → dead app.
//   - v0.2.14: the membrane imported three/examples/jsm/* but
//     electron-builder's node_modules copier hard-strips examples/ dirs →
//     0 jsm files in the asar → import cascade → blank main pane.
//
// The check reads the *actual packed asar* and asserts:
//   1. every relative require("./x") in main.js + preload.js resolves
//      to a file that's really in the asar
//   2. every relative ES import/export ("./x", "../y") between bundled
//      src/ modules resolves to a file in the asar (including
//      string-literal dynamic import("./x") calls, which lazy renderers use)
//      (catches v0.2.14: a renderer module importing a sibling that didn't
//      get packaged)
//   3. no bundled src/ file imports three/examples/jsm or three/addons —
//      the importmap routes those to node_modules/three/, which the
//      packer strips; they must be vendored into src/vendor/ instead
//   4. lazy stylesheets loaded with loadStylesheetOnce("x.css") exist in
//      the asar next to index.html
//   5. a small anchor allowlist (entrypoints + index.html + boot.js)
//
// Optionally (SROS_SMOKE_TEST=1, host arch matches the packed arch) it
// also boots the packed binary headless via scripts/smoke-test.cjs and
// throws if the renderer never signals ready — defense-in-depth for
// runtime boot failures that static analysis can't see.

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  const asar = require("@electron/asar");
  const { appOutDir, packager, electronPlatformName, arch } = context;
  const productName = packager.appInfo.productFilename;
  const resourcesDir = (electronPlatformName === "darwin" || electronPlatformName === "mas")
    ? path.join(appOutDir, `${productName}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");

  // Locate the packed app.asar for this platform.
  let asarPath;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    asarPath = path.join(resourcesDir, "app.asar");
  } else {
    asarPath = path.join(resourcesDir, "app.asar");
  }

  // Normalized set of in-asar file paths (no leading slash, forward slashes).
  const entries = new Set(
    asar.listPackage(asarPath).map((p) => p.replace(/^[/\\]/, "").split(path.sep).join("/"))
  );
  const readText = (rel) => asar.extractFile(asarPath, rel).toString("utf8");
  // Resolve a path to a real asar entry, trying common module extensions.
  const resolveEntry = (rel) => {
    if (entries.has(rel)) return rel;
    for (const ext of [".js", ".mjs", ".cjs", ".json"]) if (entries.has(rel + ext)) return rel + ext;
    for (const ix of ["/index.js", "/index.mjs"]) if (entries.has(rel + ix)) return rel + ix;
    return null;
  };

  const problems = [];

  // ── 1. relative requires in the main-process entrypoints ──────────
  for (const f of ["main.js", "preload.js"]) {
    if (!entries.has(f)) { problems.push(`entrypoint "${f}" is missing from the asar`); continue; }
    const src = readText(f);
    const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!resolveEntry(target)) {
        problems.push(`${f} requires "${m[1]}" but it does not resolve in the asar`);
      }
    }
  }

  // ── 2. relative ES import/export graph across bundled src/ modules ─
  // Matches: import ... from "x" | import "x" | export ... from "x" |
  // string-literal import("x"). Dynamic import(expr) is intentionally
  // skipped; there is no path to resolve statically.
  const STATIC_SPEC = /(?:^|[\s;])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;
  const DYNAMIC_SPEC = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const resolveSrcRelativeSpec = (fromEntry, spec) => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromEntry), spec));
    if (!resolved.startsWith("src/")) return null; // escapes into node_modules etc. — not our graph
    return resolveEntry(resolved);
  };
  for (const e of entries) {
    if (!e.startsWith("src/") || !e.endsWith(".js")) continue;
    let src;
    try { src = readText(e); } catch { continue; }
    let m;
    while ((m = STATIC_SPEC.exec(src)) !== null) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith(".")) continue; // bare specifier → importmap/node_modules, out of scope here
      if (!resolveSrcRelativeSpec(e, spec)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e), spec));
        problems.push(`${e} imports "${spec}" -> ${resolved} which is not in the asar`);
      }
    }
    while ((m = DYNAMIC_SPEC.exec(src)) !== null) {
      const spec = m[1];
      if (!spec || !spec.startsWith(".")) continue;
      if (!resolveSrcRelativeSpec(e, spec)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e), spec));
        problems.push(`${e} dynamically imports "${spec}" -> ${resolved} which is not in the asar`);
      }
    }
  }

  // ── 3. no bundled src/ file may import the stripped three addons ──
  // The importmap maps "three/" → node_modules/three/, and electron-
  // builder removes node_modules/*/examples, so a bare import of
  // three/examples/jsm (or the three/addons alias) is a dead reference
  // in the package. Vendor into src/vendor/ instead. (The vendored
  // copies may reference three/addons in JSDoc — they're excluded.)
  const STRIPPED_IMPORT = /(?:from\s+|import\s*\(\s*|(?:^|[\s;])import\s*)['"](three\/examples\/jsm|three\/addons)\//m;
  for (const e of entries) {
    if (!e.startsWith("src/") || !e.endsWith(".js")) continue;
    if (e.startsWith("src/vendor/")) continue;
    let src;
    try { src = readText(e); } catch { continue; }
    if (STRIPPED_IMPORT.test(src)) {
      problems.push(`${e} imports three/examples/jsm or three/addons — the packer strips those; vendor into src/vendor/ instead`);
    }
  }

  // ── 4. lazy stylesheet assets loaded by renderer modules ──────────
  const STYLESHEET_SPEC = /loadStylesheetOnce\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const e of entries) {
    if (!e.startsWith("src/") || !e.endsWith(".js")) continue;
    let src;
    try { src = readText(e); } catch { continue; }
    let m;
    while ((m = STYLESHEET_SPEC.exec(src)) !== null) {
      const href = m[1];
      if (!href || /^(?:https?:|data:|file:|app:|#)/.test(href)) continue;
      const resolved = path.posix.normalize(path.posix.join("src", href));
      if (!resolved.startsWith("src/")) {
        problems.push(`${e} lazy-loads stylesheet "${href}" outside src/`);
      } else if (!entries.has(resolved)) {
        problems.push(`${e} lazy-loads stylesheet "${href}" -> ${resolved} which is not in the asar`);
      }
    }
  }

  // ── 5. anchor allowlist — the load-bearing files must exist ───────
  const MUST_EXIST = ["main.js", "preload.js", "swarm-node.js", "swf-node.js", "src/index.html", "src/renderer/boot.js",
    // router pop-out: host adapter + vendored pipeline + verbatim renderer/shim
    "daybook-main.js", "daybook/redact.js", "daybook/draft.js", "daybook/link.js",
    "src/router/index.html", "src/router/app.js", "src/router/preload.js"];
  for (const f of MUST_EXIST) {
    if (!entries.has(f)) problems.push(`required runtime file missing from asar: ${f}`);
  }

  // Extra resources live next to app.asar, not inside it. The committed
  // article bodies are required at runtime in packaged builds.
  const articlesDir = path.join(resourcesDir, "cohort-data", "articles");
  let articleCount = 0;
  try {
    articleCount = fs.readdirSync(articlesDir).filter((name) => name.endsWith(".md")).length;
  } catch {}
  if (!articleCount) {
    problems.push(`committed context article markdown missing from extraResources: ${articlesDir}`);
  }

  if (problems.length) {
    throw new Error(
      "\n══════════════════════════════════════════════════════════════\n" +
      " RELEASE SAFETY GATE FAILED (afterPack verify-asar)\n" +
      " Refusing to build a broken package. Problems:\n" +
      problems.map((p) => "   ✗ " + p).join("\n") +
      "\n══════════════════════════════════════════════════════════════\n"
    );
  }

  console.log(
    `[afterPack] verify-asar OK · ${entries.size} asar entries · entrypoint requires + src import graph + lazy stylesheets resolve · no stripped-addon imports`
  );

  // ── 6. optional live boot smoke (opt-in, host-arch only) ──────────
  // SROS_SMOKE_TEST=1 boots the just-packed binary headless and waits
  // for the renderer's ready sentinel. Skipped for cross-arch packs
  // (can't run an x64 binary on an arm64 host reliably) so it never
  // flakes the matrix. Throwing aborts the build before publish.
  if (process.env.SROS_SMOKE_TEST !== "1") return;
  let archName;
  try { archName = require("electron-builder").Arch[arch]; } catch { archName = String(arch); }
  const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (archName !== hostArch) {
    console.log(`[afterPack] smoke-test skipped: packed arch ${archName} != host ${hostArch}`);
    return;
  }
  const binary = findPackedBinary(appOutDir, electronPlatformName, productName);
  if (!binary) {
    throw new Error(`[afterPack] smoke-test: could not locate packed binary under ${appOutDir}`);
  }
  console.log(`[afterPack] smoke-test: booting ${binary}`);
  const runner = path.join(__dirname, "smoke-test.cjs");
  const res = spawnSync(process.execPath, [runner, binary], { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`[afterPack] smoke-test FAILED (exit ${res.status}) for ${binary}`);
  }
};

function findPackedBinary(appOutDir, platformName, productName) {
  if (platformName === "darwin" || platformName === "mas") {
    const macosDir = path.join(appOutDir, `${productName}.app`, "Contents", "MacOS");
    try {
      const files = fs.readdirSync(macosDir);
      const exe = files.find((f) => f === productName) || files[0];
      return exe ? path.join(macosDir, exe) : null;
    } catch { return null; }
  }
  if (platformName === "win32") {
    try {
      const exe = fs.readdirSync(appOutDir).find((f) => f.toLowerCase().endsWith(".exe"));
      return exe ? path.join(appOutDir, exe) : null;
    } catch { return null; }
  }
  // linux: the unpacked app executable sits at appOutDir root alongside
  // executable Electron helpers. Prefer the product binary and never launch a
  // helper such as chrome-sandbox with --smoke-test.
  try {
    const helperNames = new Set(["chrome-sandbox", "chrome_crashpad_handler"]);
    const isExecutable = (st) => process.platform === "win32" || (st.mode & 0o111);
    const executableFiles = fs.readdirSync(appOutDir)
      .map((file) => ({ file, full: path.join(appOutDir, file) }))
      .filter(({ file, full }) => {
        if (helperNames.has(file)) return false;
        if (/\.(so|pak|bin|dat)$/i.test(file)) return false;
        try {
          const st = fs.statSync(full);
          return st.isFile() && isExecutable(st);
        } catch {
          return false;
        }
      });
    const exact = executableFiles.find(({ file }) => file === productName);
    if (exact) return exact.full;
    const normalizedProduct = String(productName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const normalized = executableFiles.find(({ file }) =>
      file.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === normalizedProduct
    );
    if (normalized) return normalized.full;
    return executableFiles[0]?.full || null;
  } catch {}
  return null;
}

exports.findPackedBinary = findPackedBinary;
