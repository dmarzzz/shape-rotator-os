// electron-builder afterPack hook — release safety gate.
//
// Runs after the app is packed into app.asar but BEFORE artifact
// (dmg/exe/AppImage) creation and BEFORE publish. Throwing here aborts
// the entire build, so a broken package can never reach the release page.
//
// This exists because dev mode runs from source (node_modules on disk),
// so it physically cannot catch "works in dev, broken in the packaged
// app" bugs. Two shipped before this guard existed:
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
//   2. a curated MUST_EXIST allowlist is present
//   3. no bundled src/ file imports three/examples/jsm or three/addons
//      (those get stripped — they must be vendored into src/)

const path = require("node:path");

exports.default = async function afterPack(context) {
  const asar = require("@electron/asar");
  const { appOutDir, packager, electronPlatformName } = context;
  const productName = packager.appInfo.productFilename;

  // Locate the packed app.asar for this platform.
  let asarPath;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    asarPath = path.join(appOutDir, `${productName}.app`, "Contents", "Resources", "app.asar");
  } else {
    asarPath = path.join(appOutDir, "resources", "app.asar");
  }

  // Normalized set of in-asar file paths (no leading slash, forward slashes).
  const entries = new Set(
    asar.listPackage(asarPath).map((p) => p.replace(/^[/\\]/, "").split(path.sep).join("/"))
  );
  const readText = (rel) => asar.extractFile(asarPath, rel).toString("utf8");
  const resolves = (rel) =>
    entries.has(rel) || entries.has(rel + ".js") || entries.has(rel + "/index.js");

  const problems = [];

  // ── 1. relative requires in the main-process entrypoints ──────────
  for (const f of ["main.js", "preload.js"]) {
    if (!entries.has(f)) { problems.push(`entrypoint "${f}" is missing from the asar`); continue; }
    const src = readText(f);
    const re = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const target = m[1].replace(/^\.\//, "");
      if (!resolves(target)) {
        problems.push(`${f} does require("${m[1]}") but it is not in the asar`);
      }
    }
  }

  // ── 2. curated must-exist allowlist ───────────────────────────────
  // Files that are load-bearing at runtime and have silently gone
  // missing before. Add to this as new runtime deps land.
  const MUST_EXIST = [
    "main.js",
    "preload.js",
    "swarm-node.js",
    "swf-node.js",
    "src/renderer/boot.js",
    "src/index.html",
    "src/vendor/three-jsm/postprocessing/EffectComposer.js",
    "src/vendor/three-jsm/postprocessing/UnrealBloomPass.js",
    "src/vendor/three-jsm/postprocessing/RenderPass.js",
    "src/vendor/three-jsm/postprocessing/OutputPass.js",
    "src/vendor/three-jsm/environments/RoomEnvironment.js",
    "src/vendor/three-jsm/utils/BufferGeometryUtils.js",
  ];
  for (const f of MUST_EXIST) {
    if (!entries.has(f)) problems.push(`required runtime file missing from asar: ${f}`);
  }

  // ── 3. no bundled src/ file may import the stripped three addons ──
  // electron-builder removes node_modules/*/examples, so any direct
  // import of three/examples/jsm (or the three/addons alias) will be a
  // dead reference in the package. They must be vendored into src/.
  const STRIPPED_IMPORT = /from\s+['"](three\/examples\/jsm|three\/addons)\//;
  for (const e of entries) {
    if (!e.startsWith("src/") || !e.endsWith(".js")) continue;
    if (e.startsWith("src/vendor/")) continue; // the vendored copies are allowed to reference (JSDoc only)
    let src;
    try { src = readText(e); } catch { continue; }
    if (STRIPPED_IMPORT.test(src)) {
      problems.push(`${e} imports three/examples/jsm or three/addons — electron-builder strips those; vendor into src/vendor/ instead`);
    }
  }

  if (problems.length) {
    const msg =
      "\n══════════════════════════════════════════════════════════════\n" +
      " RELEASE SAFETY GATE FAILED (afterPack verify-asar)\n" +
      " Refusing to build a broken package. Problems:\n" +
      problems.map((p) => "   ✗ " + p).join("\n") +
      "\n══════════════════════════════════════════════════════════════\n";
    throw new Error(msg);
  }

  console.log(
    `[afterPack] verify-asar OK · ${entries.size} asar entries · all entrypoint requires + must-exist files present · no stripped-addon imports`
  );
};
