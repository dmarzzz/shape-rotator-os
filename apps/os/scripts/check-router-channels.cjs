#!/usr/bin/env node
"use strict";
// Channel-coverage guard for the vendored router pop-out.
//
// The window runs router-daybook's renderer + preload VERBATIM, talking over a
// fixed set of un-namespaced IPC channels. daybook-main.js (the host adapter) is
// the ONE piece the file-copy can't sync — so when upstream adds a new
// window.daybook.* method, the shim preload starts invoking a channel that has
// no ipcMain.handle, and a renderer call silently rejects at runtime.
//
// This script makes that failure loud + early: it parses the shim preload's
// invoked channels and the adapter's handled channels and exits non-zero if any
// invoked channel is unhandled. Push channels (ipcRenderer.on) are checked as a
// soft warning (a listener with no emitter is harmless — e.g. precompute-ready).
//
// Run by sync-daybook-vendor.sh after a re-vendor, and safe to add to CI.

const fs = require("fs");
const path = require("path");

const OS = path.join(__dirname, "..");
const SHIM = path.join(OS, "src", "router", "preload.js");
const ADAPTER = path.join(OS, "daybook-main.js");

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const matchAll = (src, re) => { const out = new Set(); let m; while ((m = re.exec(src))) out.add(m[1]); return out; };

const shim = read(SHIM);
const adapter = read(ADAPTER);
if (!shim) { console.error(`[check-router-channels] missing shim preload: ${SHIM}`); process.exit(2); }
if (!adapter) { console.error(`[check-router-channels] missing adapter: ${ADAPTER}`); process.exit(2); }

const invoked = matchAll(shim, /invoke\(\s*['"]([^'"]+)['"]/g);
const listened = matchAll(shim, /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g);
const handled = matchAll(adapter, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g);
const sent = matchAll(adapter, /\.webContents\.send\(\s*['"]([^'"]+)['"]/g);

const missingHandlers = [...invoked].filter((c) => !handled.has(c)).sort();
const missingEmitters = [...listened].filter((c) => !sent.has(c)).sort();
// Handlers the shim never calls (excluding open-window, which the MAIN window's
// preload invokes) — dead/extra, informational only.
const unusedHandlers = [...handled].filter((c) => !invoked.has(c) && c !== "daybook:open-window").sort();

let bad = false;
if (missingHandlers.length) {
  bad = true;
  console.error("\n  ✗ shim invokes channels with NO ipcMain.handle in daybook-main.js:");
  for (const c of missingHandlers) console.error(`      ${c}   <-- add: ipcMain.handle('${c}', …)`);
}
if (missingEmitters.length) {
  console.warn("\n  ⚠ shim listens for push channels the adapter never sends (usually fine):");
  for (const c of missingEmitters) console.warn(`      ${c}`);
}
if (unusedHandlers.length) {
  console.warn("\n  · adapter handles channels the shim never invokes (dead/extra):");
  for (const c of unusedHandlers) console.warn(`      ${c}`);
}

if (bad) {
  console.error(`\n[check-router-channels] FAIL — ${missingHandlers.length} unhandled channel(s). Port the handler(s) above into daybook-main.js.\n`);
  process.exit(1);
}
console.log(`[check-router-channels] ok — all ${invoked.size} invoked channels are handled in daybook-main.js`);
