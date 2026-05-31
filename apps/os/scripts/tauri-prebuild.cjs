#!/usr/bin/env node
// tauri-prebuild.cjs
//
// Tauri `beforeBuildCommand` / `beforeDevCommand` hook. Produces
// `apps/os/dist-frontend/` — the static `frontendDist` Tauri serves — from
// the unmodified renderer in `apps/os/src/`.
//
// Why a copy step instead of pointing frontendDist straight at src/:
//   The renderer's <script type="importmap"> resolves three / @cosmos.gl /
//   3d-force-graph from `../node_modules/...`. There is no node_modules
//   sibling inside the packaged bundle, so we copy just those runtime
//   packages into dist-frontend/vendor-npm/ and rewrite the importmap +
//   the UMD <script> to point there. Everything else in src/ is copied
//   verbatim (html, css, renderer/, vendor/, content/, cohort-surface.json,
//   favicon, hermes/). This replaces electron-builder's asar packing and
//   the dev-only link-deps.js symlink seam for packaged builds.
//
// It also injects `api-shim.js` (the window.api → Tauri invoke/listen
// bridge that replaces preload.js) as the first script in index.html and
// hermes/index.html.
//
// Idempotent: wipes dist-frontend each run. `--watch` re-runs on src change.

"use strict";
const fs = require("node:fs");
const path = require("node:path");

const OS_DIR = path.resolve(__dirname, "..");
const SRC = path.join(OS_DIR, "src");
const OUT = path.join(OS_DIR, "dist-frontend");
const NM = path.join(OS_DIR, "node_modules");

// Runtime npm packages the renderer pulls via the importmap / a UMD tag.
// Copied wholesale (dereferencing the link-deps symlinks) into vendor-npm/.
const RUNTIME_PKGS = ["three", "@cosmos.gl/graph", "3d-force-graph"];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

function build() {
  if (!fs.existsSync(SRC)) {
    console.error(`[tauri-prebuild] missing src dir: ${SRC}`);
    process.exit(1);
  }
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy the whole renderer verbatim.
  copyDir(SRC, OUT);

  // 2. Stage runtime npm packages into dist-frontend/vendor-npm/<pkg>/.
  const vendorNpm = path.join(OUT, "vendor-npm");
  for (const pkg of RUNTIME_PKGS) {
    const fromDir = path.join(NM, pkg);
    if (!fs.existsSync(fromDir)) {
      console.error(
        `[tauri-prebuild] runtime package not found: ${fromDir} — run \`npm install\` (and the link-deps postinstall).`
      );
      process.exit(1);
    }
    const toDir = path.join(vendorNpm, pkg);
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    copyDir(fromDir, toDir);
  }

  // 3. Copy the api-shim next to index.html so it loads with script-src 'self'.
  const shimSrc = path.join(SRC, "api-shim.js");
  if (!fs.existsSync(shimSrc)) {
    console.error(`[tauri-prebuild] missing ${shimSrc} (the window.api bridge).`);
    process.exit(1);
  }
  // already copied by the verbatim src copy; nothing extra to do.

  // 4. Rewrite index.html: importmap + UMD tag → vendor-npm, inject shim.
  rewriteIndexHtml(path.join(OUT, "index.html"));

  // 5. Inject shim into hermes (external script — its CSP forbids inline).
  injectShim(path.join(OUT, "hermes", "index.html"), "../api-shim.js");

  // 6. Guard against the importmap-vs-bundle hazard: no bare three/addons or
  //    three/examples/jsm imports (those are vendored under src/vendor/).
  lintThreeAddons(OUT);

  console.log(`[tauri-prebuild] wrote ${path.relative(OS_DIR, OUT)}/`);
}

function rewriteIndexHtml(file) {
  let html = fs.readFileSync(file, "utf8");

  // importmap: ../node_modules/<pkg> → ./vendor-npm/<pkg>
  html = html
    .replace(
      '"three": "../node_modules/three/build/three.module.js"',
      '"three": "./vendor-npm/three/build/three.module.js"'
    )
    .replace('"three/": "../node_modules/three/"', '"three/": "./vendor-npm/three/"')
    .replace(
      '"@cosmos.gl/graph": "../node_modules/@cosmos.gl/graph/dist/index.js"',
      '"@cosmos.gl/graph": "./vendor-npm/@cosmos.gl/graph/dist/index.js"'
    );

  // UMD <script> for 3d-force-graph
  html = html.replace(
    'src="../node_modules/3d-force-graph/dist/3d-force-graph.min.js"',
    'src="./vendor-npm/3d-force-graph/dist/3d-force-graph.min.js"'
  );

  html = withShim(html, "api-shim.js");
  fs.writeFileSync(file, html);
}

// Insert <script src="<rel>"></script> as the first script in <head>,
// right after the CSP <meta> so the bridge exists before any module loads.
function withShim(html, rel) {
  if (html.includes(`src="${rel}"`)) return html;
  const tag = `\n    <script src="${rel}"></script>`;
  // After the closing </title> is a stable anchor present in both pages.
  if (html.includes("</title>")) {
    return html.replace("</title>", `</title>${tag}`);
  }
  return html.replace("</head>", `${tag}\n  </head>`);
}

function injectShim(file, rel) {
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, withShim(fs.readFileSync(file, "utf8"), rel));
}

function lintThreeAddons(root) {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "vendor-npm" || e.name === "vendor") continue; // upstream copies
        walk(p);
      } else if (e.name.endsWith(".js") || e.name.endsWith(".html")) {
        const t = fs.readFileSync(p, "utf8");
        if (/from\s+["']three\/(addons|examples\/jsm)/.test(t)) offenders.push(p);
      }
    }
  };
  walk(root);
  if (offenders.length) {
    console.error(
      "[tauri-prebuild] bare three/addons|three/examples/jsm imports (must be vendored under src/vendor/):\n" +
        offenders.map((o) => "  " + path.relative(root, o)).join("\n")
    );
    process.exit(1);
  }
}

if (process.argv.includes("--watch")) {
  build();
  console.log("[tauri-prebuild] watching src/ …");
  let timer = null;
  fs.watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
      } catch (e) {
        console.error("[tauri-prebuild] rebuild failed:", e.message);
      }
    }, 150);
  });
} else {
  build();
}
