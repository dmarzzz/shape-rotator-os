// Renderer bundler / build-time resolver gate.
//
//   node scripts/bundle-renderer.cjs --check   # CI gate: bundle to a
//       throwaway path, fail non-zero if the renderer's full import
//       graph (relative + bare specifiers) can't be resolved.
//   node scripts/bundle-renderer.cjs            # emit the bundle to
//       dist-renderer/boot.bundle.js (foundation for the runtime cutover).
//
// Why: the afterPack asar gate (scripts/after-pack-verify.cjs) resolves
// the *relative* src/ import graph, but deliberately skips *bare*
// specifiers ("three", "js-yaml", …) since those route through the
// importmap to node_modules. esbuild's real resolver closes that gap —
// if a renderer module imports a bare package that isn't installed (typo,
// removed dep) or a module that won't resolve, this fails fast, before
// the ~10-minute electron-builder run.
//
// Aliases mirror src/index.html's importmap exactly so the bundle uses
// the same module sources the runtime importmap would:
//   three                 → node_modules/three/build/three.module.js
//   js-yaml               → src/vendor/js-yaml.mjs
//   @shape-rotator/shape-ui → src/vendor/shape-ui/index.js
// ForceGraph3D is a UMD global from the <script> tag in index.html (never
// imported), so esbuild leaves it as a free global reference — correct.
//
// NOTE: this does NOT yet swap the shipped runtime over to the bundle —
// that cutover (drop the importmap + node_modules-in-asar reliance) needs
// a visual QA pass across the WebGL tabs and is a deferred follow-up.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const APP_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(APP_DIR, "src", "renderer", "boot.js");
const check = process.argv.includes("--check");
const outfile = check
  ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sros-bundle-")), "boot.bundle.js")
  : path.join(APP_DIR, "dist-renderer", "boot.bundle.js");

(async () => {
  try {
    const result = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      format: "esm",           // preserves import.meta.url (cohort-source.js)
      platform: "browser",
      target: ["chrome120"],   // electron 33 ships chromium ~130
      outfile,
      sourcemap: !check,
      metafile: true,
      logLevel: "warning",
      alias: {
        "three": path.join(APP_DIR, "node_modules", "three", "build", "three.module.js"),
        // Subpath imports like `three/examples/jsm/geometries/ConvexGeometry.js`
        // (cube.js): the bare `three` alias above is a single file, so esbuild
        // would otherwise remap the subpath onto that file path. Mirror the
        // importmap's `"three/": "../node_modules/three/"`. esbuild uses the
        // longest matching alias, so this wins for three/examples/* paths.
        "three/examples": path.join(APP_DIR, "node_modules", "three", "examples"),
        "js-yaml": path.join(APP_DIR, "src", "vendor", "js-yaml.mjs"),
        "@shape-rotator/shape-ui": path.join(APP_DIR, "src", "vendor", "shape-ui", "index.js"),
      },
    });
    const inputs = Object.keys(result.metafile.inputs).length;
    const bytes = fs.statSync(outfile).size;
    console.log(`[bundle-renderer] OK · ${inputs} modules → ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    if (check) {
      fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
      console.log("[bundle-renderer] check mode: discarded output");
    } else {
      console.log(`[bundle-renderer] wrote ${outfile}`);
    }
  } catch (err) {
    console.error("\n[bundle-renderer] FAILED — renderer import graph did not resolve:\n");
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
})();
