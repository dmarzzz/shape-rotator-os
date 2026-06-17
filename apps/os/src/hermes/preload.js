// preload.js — context-isolated bridge for the hermes "Ask Cohort" window.
//
// Exposes ONLY the brain's IPC surface (hermes + shape) on `window.api`. Kept
// inside the component (rather than reusing the host app's preload) so the whole
// brain is self-contained and swappable: the host points the hermes window's
// webPreferences.preload at this file (see integration.js) and nothing else is
// shared. The matching main-process handlers are registered in integration.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // ─── hermes "brain" (the user's own codex/claude CLI — see engine.js) ───
  // backends() lists detected CLIs; run() executes one grounded prompt and
  // resolves { ok, text }; onChunk(cb) streams partial stdout (returns an
  // unsubscribe fn); stop() cancels. The data-mode privacy gate + provider-key
  // stripping are enforced in the main process (engine.js).
  hermes: {
    backends: ()     => ipcRenderer.invoke("hermes:backends"),
    run:      (opts) => ipcRenderer.invoke("hermes:run", opts || {}),
    stop:     ()     => ipcRenderer.invoke("hermes:stop"),
    onChunk: (cb) => {
      const h = (_e, p) => { try { cb(p); } catch {} };
      ipcRenderer.on("hermes:chunk", h);
      return () => ipcRenderer.removeListener("hermes:chunk", h);
    },
  },

  // ─── shape ("self-shape" scan — see shape-scanner.js) ───────────────────
  // get() returns the persisted shape (or null); scan() rebuilds it from the
  // user's PUBLIC GitHub + LOCAL Codex session metadata; saveSynthesis() stores
  // a structured shape read. All local; nothing is sent to our servers.
  shape: {
    get:           ()     => ipcRenderer.invoke("shape:get"),
    scan:          (opts) => ipcRenderer.invoke("shape:scan", opts || {}),
    saveSynthesis: (opts) => ipcRenderer.invoke("shape:saveSynthesis", opts || {}),
  },
});
