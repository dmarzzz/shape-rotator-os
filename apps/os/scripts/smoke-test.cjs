// Headless launch smoke test runner.
//
//   node scripts/smoke-test.cjs <path-to-packed-binary>
//
// Boots the given Electron binary with --smoke-test and exits with its
// status: 0 = renderer signalled ready, non-zero = boot failed / timed
// out. Called by the afterPack hook against the just-packed binary
// (SROS_SMOKE_TEST=1), and runnable by hand against any built .app/.exe/
// AppImage to reproduce a boot failure locally.
//
// On Linux CI with no display, wraps the launch in `xvfb-run` when
// available so the GUI process can start headlessly. macOS/Windows
// runners have a window server, so no wrapper is needed there.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const binary = process.argv[2];
if (!binary) {
  console.error("[smoke] usage: node scripts/smoke-test.cjs <packed-binary>");
  process.exit(2);
}
if (!fs.existsSync(binary)) {
  console.error(`[smoke] binary not found: ${binary}`);
  process.exit(2);
}

// Hard outer timeout — a little longer than the in-app watchdog so the
// app reports its own failure first; this only fires if the process hangs
// before Electron's loop even starts.
const APP_TIMEOUT = Number(process.env.SROS_SMOKE_TIMEOUT_MS) || 45000;
const OUTER_TIMEOUT = APP_TIMEOUT + 30000;

let cmd = binary;
let args = ["--smoke-test"];

// Linux headless: prepend xvfb-run if there's no display and it exists.
if (process.platform === "linux" && !process.env.DISPLAY) {
  const hasXvfb = spawnSync("which", ["xvfb-run"]).status === 0;
  if (hasXvfb) {
    cmd = "xvfb-run";
    args = ["-a", "--server-args=-screen 0 1280x800x24", binary, "--smoke-test"];
    console.log("[smoke] no DISPLAY — wrapping in xvfb-run");
  } else {
    console.log("[smoke] warning: no DISPLAY and no xvfb-run; launch may fail");
  }
}

console.log(`[smoke] launching: ${cmd} ${args.join(" ")}`);
const child = spawn(cmd, args, {
  stdio: "inherit",
  env: { ...process.env, SROS_SMOKE_TEST: "1" },
});

const killer = setTimeout(() => {
  console.error(`[smoke] outer timeout (${OUTER_TIMEOUT}ms) — killing`);
  try { child.kill("SIGKILL"); } catch {}
  process.exit(1);
}, OUTER_TIMEOUT);

child.on("exit", (code, signal) => {
  clearTimeout(killer);
  if (signal) { console.error(`[smoke] killed by ${signal}`); process.exit(1); }
  process.exit(code == null ? 1 : code);
});
child.on("error", (err) => {
  clearTimeout(killer);
  console.error(`[smoke] spawn error: ${err.message}`);
  process.exit(1);
});
