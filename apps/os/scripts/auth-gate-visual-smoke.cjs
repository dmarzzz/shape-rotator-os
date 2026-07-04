const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const APP_DIR = path.resolve(__dirname, "..");
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shape-os-auth-gate-"));
const WATCHDOG_MS = Number(process.env.SROS_AUTH_GATE_VISUAL_TIMEOUT_MS) || 30000;
const SCREENSHOT_PATH = process.env.SROS_AUTH_GATE_SCREENSHOT || "";
const DEBUG = process.env.SROS_AUTH_GATE_DEBUG === "1";

app.setPath("userData", USER_DATA_DIR);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finish(code, message) {
  if (message) process[code === 0 ? "stdout" : "stderr"].write(`[auth-gate-visual] ${message}\n`);
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  } catch {}
  try { app.exit(code); } catch {}
  setTimeout(() => process.exit(code), 25);
}

async function waitForGate(win) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const ok = await win.webContents.executeJavaScript(`!!document.querySelector("#auth-gate .ag-card")`, true);
    if (ok) return;
    await sleep(100);
  }
  throw new Error("auth gate did not render");
}

async function sampleGate(win) {
  return win.webContents.executeJavaScript(`(() => {
    const gate = document.querySelector("#auth-gate");
    const card = gate?.querySelector(".ag-card");
    const mark = gate?.querySelector(".ag-mark");
    const rect = card?.getBoundingClientRect();
    const gateStyle = gate ? getComputedStyle(gate) : null;
    const cardStyle = card ? getComputedStyle(card) : null;
    const markStyle = mark ? getComputedStyle(mark) : null;
    return {
      state: gate?.dataset?.agState || "",
      rect: rect ? {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      } : null,
      gateBackground: gateStyle?.backgroundColor || "",
      cardBackground: cardStyle?.backgroundColor || "",
      cardBackdrop: cardStyle?.backdropFilter || cardStyle?.webkitBackdropFilter || "",
      markAnimation: markStyle?.animationName || "",
      markBackground: markStyle?.backgroundColor || "",
    };
  })()`, true);
}

function maxRectShift(samples) {
  const first = samples[0]?.rect;
  if (!first) return Infinity;
  let max = 0;
  for (const sample of samples) {
    if (!sample.rect) return Infinity;
    for (const key of ["left", "top", "width", "height"]) {
      max = Math.max(max, Math.abs(sample.rect[key] - first[key]));
    }
  }
  return max;
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => finish(2, `watchdog timed out after ${WATCHDOG_MS}ms`), WATCHDOG_MS);
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 820,
      show: Boolean(SCREENSHOT_PATH),
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      finish(1, `render process gone: ${details?.reason || "unknown"}`);
    });
    await win.loadFile(path.join(APP_DIR, "src", "index.html"), {
      query: { authProof: "1", agDemo: "signedout" },
    });
    await waitForGate(win);

    const samples = [];
    for (let i = 0; i < 9; i += 1) {
      samples.push(await sampleGate(win));
      await sleep(220);
    }

    const shift = maxRectShift(samples);
    const backgrounds = new Set(samples.map((sample) => sample.gateBackground));
    const cardBackgrounds = new Set(samples.map((sample) => sample.cardBackground));
    const cardBackdrops = new Set(samples.map((sample) => sample.cardBackdrop));
    const markBackgrounds = new Set(samples.map((sample) => sample.markBackground));
    const animations = new Set(samples.map((sample) => sample.markAnimation));
    if (shift > 1) throw new Error(`card moved ${shift.toFixed(2)}px`);
    if (backgrounds.size !== 1) throw new Error(`gate background changed: ${[...backgrounds].join(" -> ")}`);
    if (cardBackgrounds.size !== 1) throw new Error(`card background changed: ${[...cardBackgrounds].join(" -> ")}`);
    if (cardBackdrops.size !== 1 || [...cardBackdrops].some((value) => !value || value === "none")) {
      throw new Error(`card backdrop missing or changed: ${[...cardBackdrops].join(" -> ")}`);
    }
    if (markBackgrounds.size !== 1) throw new Error(`mark background changed: ${[...markBackgrounds].join(" -> ")}`);
    if ([...animations].some((name) => name && name !== "none")) {
      throw new Error(`mark animated: ${[...animations].join(", ")}`);
    }
    if (samples.some((sample) => sample.state !== "signin")) {
      throw new Error(`unexpected auth state samples: ${samples.map((sample) => sample.state).join(", ")}`);
    }
    if (DEBUG) process.stdout.write(`[auth-gate-visual] sample ${JSON.stringify(samples[samples.length - 1])}\n`);
    if (SCREENSHOT_PATH) {
      try {
        if (!win.isVisible()) win.show();
        await sleep(250);
        const png = await win.capturePage();
        fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
        fs.writeFileSync(SCREENSHOT_PATH, png.toPNG());
      } catch (error) {
        process.stderr.write(`[auth-gate-visual] screenshot skipped: ${error?.message || error}\n`);
      }
    }
    clearTimeout(watchdog);
    finish(0, `PASS: stable sign-in gate (${samples.length} samples, max shift ${shift.toFixed(2)}px, userData=${USER_DATA_DIR})`);
  } catch (error) {
    clearTimeout(watchdog);
    finish(1, `FAIL: ${error?.message || error}`);
  }
}).catch((error) => finish(1, `FAIL: ${error?.message || error}`));

app.on("window-all-closed", () => app.quit());
