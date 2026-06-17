// integration.js — the SINGLE integration point for the hermes "Ask Cohort"
// brain. The host Electron app wires the whole component in with two calls:
//
//   const hermes = require("./src/hermes/integration");
//   hermes.register({ app, ipcMain, BrowserWindow });   // once, at startup
//   // ...and put hermes.menuItem() under your Tools menu.
//
// Everything else (engine, shape scanner, preload, renderer) lives in this
// folder. To replace the brain, swap this folder and keep these two calls — the
// IPC channel names (hermes:* / shape:*) and the window contract are the only
// coupling. See README.md.
const path = require("node:path");
const engine = require("./engine");
const shapeScanner = require("./shape-scanner");

const HTML_FILE = path.join(__dirname, "index.html");
const PRELOAD_FILE = path.join(__dirname, "preload.js");

let _win = null;
let _BrowserWindow = null;
let _ipcMain = null;

// Every IPC channel this component owns — the unit of register/unregister.
const CHANNELS = ["hermes:backends", "hermes:run", "hermes:stop", "shape:get", "shape:scan", "shape:saveSynthesis"];

// Open (or focus) the brain window. Self-contained: uses the component's own
// preload and renderer, so it doesn't depend on the host app's preload.
function createWindow() {
  if (_win && !_win.isDestroyed()) { _win.focus(); return _win; }
  if (!_BrowserWindow) throw new Error("hermes: register({ BrowserWindow }) must be called before opening the window");
  _win = new _BrowserWindow({
    width: 760, height: 680, minWidth: 560, minHeight: 480,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#231F20",
    title: "ask cohort · hermes",
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  _win.loadFile(HTML_FILE);
  if (process.env.SRWK_DEVTOOLS) _win.webContents.openDevTools({ mode: "detach" });
  _win.on("closed", () => { _win = null; });
  _win.webContents.on("console-message", (_e, lvl, msg) => {
    process.stderr.write(`[hermes:${["log", "warn", "error"][lvl] || "log"}] ${msg}\n`);
  });
  return _win;
}

// Register the brain's main-process IPC. Mirrors the swarm pattern: detect
// backends, run one grounded prompt (streaming stdout over "hermes:chunk"),
// cancel. The privacy gate + provider-key stripping live in engine.js; the
// shape scanner persists under the host's userData dir.
function register({ app, ipcMain, BrowserWindow }) {
  if (!app || !ipcMain || !BrowserWindow) throw new Error("hermes.register needs { app, ipcMain, BrowserWindow }");
  _BrowserWindow = BrowserWindow;
  _ipcMain = ipcMain;
  // Idempotent: drop any prior handlers first so re-registering (hot-swap, test
  // harness, re-init) doesn't throw ipcMain's "second handler" error.
  for (const c of CHANNELS) { try { ipcMain.removeHandler(c); } catch {} }

  ipcMain.handle("hermes:backends", async () => engine.detectBackends());
  ipcMain.handle("hermes:run", async (e, opts) => {
    const o = opts || {};
    return engine.run({
      backend:   o.backend,
      prompt:    o.prompt,
      dataMode:  o.dataMode || "public",
      requestId: o.requestId,
      onData: (chunk) => { try { e.sender.send("hermes:chunk", { requestId: o.requestId, chunk }); } catch {} },
    });
  });
  ipcMain.handle("hermes:stop", async () => engine.stop());

  ipcMain.handle("shape:get", async () => shapeScanner.getShape(app.getPath("userData")));
  ipcMain.handle("shape:scan", async (_e, opts) => {
    const o = opts || {};
    // Validate the renderer-supplied handle at the boundary (defense in depth —
    // scanGithubShape also re-checks before any interpolation). An invalid value
    // is dropped so detection falls back to the authed `gh api user`.
    const user = shapeScanner.validGithubHandle(o.user) ? o.user : undefined;
    return shapeScanner.buildShape({ user, dataDir: app.getPath("userData") });
  });
  ipcMain.handle("shape:saveSynthesis", async (_e, opts) => {
    const o = opts || {};
    return shapeScanner.saveSynthesis(app.getPath("userData"), o.synthesis || {});
  });
}

// Tear down everything register() installed: remove the IPC handlers and close
// the window. Lets a host hot-swap or dispose the component cleanly — the other
// half of the "swap the folder, keep the calls" contract.
function unregister() {
  if (_ipcMain) { for (const c of CHANNELS) { try { _ipcMain.removeHandler(c); } catch {} } }
  if (_win && !_win.isDestroyed()) { try { _win.close(); } catch {} }
  _win = null;
}

// The menu item the host inserts under its own Tools menu.
function menuItem() {
  const isMac = process.platform === "darwin";
  return {
    label: "Ask Cohort (Hermes)…",
    accelerator: isMac ? "Cmd+Shift+H" : "Ctrl+Shift+H",
    click: () => createWindow(),
  };
}

module.exports = { register, unregister, menuItem, createWindow };
