// wdio.conf.mjs — WebdriverIO config for driving the real Tauri build of
// Shape Rotator OS on macOS (and headless Linux/CI via Xvfb).
//
// How the pieces fit (see e2e/README.md for the full story):
//   • `tauri-plugin-webdriver-automation` is compiled into the debug binary
//     (cargo build --features webdriver). At launch it starts an in-process
//     HTTP server inside the webview and prints its port to stdout.
//   • `tauri-wd` (the CLI from `cargo install tauri-webdriver-automation`) is a
//     W3C WebDriver server on :4444. It spawns the binary named by the
//     `tauri:options.binary` capability and bridges WebDriver → plugin.
//   • WebdriverIO connects to :4444 and runs the Mocha specs below.
//
// We spawn `tauri-wd` ourselves in onPrepare and kill it in onComplete so a
// plain `npm test` is fully self-contained. We also reap leaked app processes
// after every session — tauri-wd 0.1.x does not reliably terminate the binary
// it spawned when a session is deleted, so without this they pile up and later
// session creation times out.

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WD_PORT = 4444;
// The debug binary the driver should launch. We use an ISOLATED copy
// (`-e2e` suffix) produced by `build:app`, so that another concurrent
// `cargo build` (which writes the plain `shape-rotator-os`, possibly WITHOUT
// the `webdriver` feature) can never clobber the binary the driver attaches to.
const APP_BINARY = resolve(
  __dirname,
  "../src-tauri/target/debug/shape-rotator-os-e2e",
);

let tauriWd; // child process handle for the tauri-wd server

// Kill any of OUR test binaries (matched by the exact `-e2e` debug path, so
// neither the user's installed app nor a concurrent dev build is touched).
function reapAppProcesses() {
  try {
    execSync(`pkill -f "target/debug/shape-rotator-os-e2e" 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {
    /* pkill exits non-zero when nothing matched — fine */
  }
}

export const config = {
  runner: "local",
  port: WD_PORT,

  specs: ["./specs/**/*.e2e.mjs"],
  // Tauri is single-window/single-session; never parallelize across the app.
  maxInstances: 1,

  capabilities: [
    {
      // No browserName — this is a Tauri session, routed by tauri:options.
      "tauri:options": {
        binary: APP_BINARY,
      },
    },
  ],

  logLevel: "warn",
  bail: 0,
  // One retry absorbs the occasional live-data hiccup (a slow daemon response,
  // a transient empty network) without masking real, repeatable failures.
  specFileRetries: 1,
  specFileRetriesDeferred: false,
  waitforTimeout: 20000, // live P2P/daemon data can take a beat to land
  connectionRetryTimeout: 180000,
  // Retry session creation: tauri-wd announces the plugin port before the Tauri
  // window exists, so the first newSession can hit "no window" under load. A
  // retry re-rolls that race.
  connectionRetryCount: 10,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    // Live deps (real swf-node boot, GitHub, network) are slow. Generous.
    timeout: 120000,
  },

  // ─── lifecycle ────────────────────────────────────────────────────────
  onPrepare() {
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `Debug binary not found at ${APP_BINARY}.\n` +
          `Build it first: (cd apps/os/e2e && npm run build:app)`,
      );
    }
    reapAppProcesses(); // clear any strays from a previous aborted run
    tauriWd = spawn("tauri-wd", ["--port", String(WD_PORT)], {
      stdio: "inherit",
      env: process.env,
    });
    tauriWd.on("error", (err) => {
      if (err.code === "ENOENT") {
        // eslint-disable-next-line no-console
        console.error(
          "\n`tauri-wd` not on PATH. Install it once:\n" +
            "  cargo install tauri-webdriver-automation --locked\n",
        );
      }
    });
    // Give the WebDriver server a moment to bind :4444 before sessions open.
    return new Promise((r) => setTimeout(r, 1500));
  },

  // Runs in the worker after each spec's session is deleted. Reap the app the
  // driver spawned so the next spec starts from a clean machine.
  afterSession() {
    reapAppProcesses();
  },

  onComplete() {
    if (tauriWd && !tauriWd.killed) tauriWd.kill("SIGTERM");
    reapAppProcesses();
  },
};
