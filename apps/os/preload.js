const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadPrefs:    () => ipcRenderer.invoke("prefs:load"),
  savePrefs:    (d) => ipcRenderer.invoke("prefs:save", d),
  env:          () => ipcRenderer.invoke("env:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  // app updates (electron-updater + GitHub Releases; no-op in dev)
  checkAppUpdate:        ()       => ipcRenderer.invoke("fg:check-update"),
  applyAppUpdate:        ()       => ipcRenderer.invoke("fg:apply-update"),
  applyUpdateAndRestart: ()       => ipcRenderer.invoke("fg:apply-update-and-restart"),
  // Manual-install path for unsigned mac builds: streams the platform's
  // release asset to ~/Downloads/ and opens it (mac: shell.openPath →
  // dmg mounts; linux/windows: reveals in Finder/Explorer). Returns
  // { ok, path, version } so the renderer can show "downloaded · drag
  // to /Applications" with the file path the user just got.
  downloadAndRevealUpdate: () => ipcRenderer.invoke("fg:download-and-reveal-update"),
  getAppInfo:            ()       => ipcRenderer.invoke("fg:get-app-info"),
  // Streams electron-updater's `download-progress` events (forwarded from
  // main.js → "fg:update-progress") into the renderer so the inline update
  // panel can render a % bar instead of leaving the user staring at a
  // frozen button. `cb` receives the raw progress object from electron-
  // updater: { percent, bytesPerSecond, transferred, total }.
  onUpdateProgress: (cb) => {
    const handler = (_e, p) => { try { cb(p); } catch {} };
    ipcRenderer.on("fg:update-progress", handler);
    return () => ipcRenderer.removeListener("fg:update-progress", handler);
  },
  // calendar export — PNG (recommended for messaging) or PDF.
  exportCalendar:        (opts)   => ipcRenderer.invoke("fg:export-calendar", opts),
  // bundled swf-node supervisor — see apps/os/swf-node.js. The renderer
  // can poll getSwfNodeStatus() for a one-shot read, or subscribe via
  // onSwfNodeStatus(cb) to a stream of state changes (idle | starting |
  // running | crashed | unsupported). The returned function detaches
  // the listener — call it on unmount.
  getSwfNodeStatus: () => ipcRenderer.invoke("fg:swf-node-status"),
  onSwfNodeStatus: (cb) => {
    const handler = (_e, s) => { try { cb(s); } catch {} };
    ipcRenderer.on("fg:swf-node-status-changed", handler);
    return () => ipcRenderer.removeListener("fg:swf-node-status-changed", handler);
  },
  // Agent bearer for swf-node's agent-gated routes (POST /sync/local_record
  // primarily). Generated + persisted by apps/os/swf-node.js on first
  // launch; main reads it from there. Returns null in dev mode without
  // a bundled binary / on Windows / when SWF_NODE_DISABLE=1 — the
  // renderer's sync-client falls back to the github PR path then.
  getSwfAgentToken: () => ipcRenderer.invoke("fg:swf-agent-token"),

  // ─── swarm mode (research-swarm subprocess) ─────────────────────────
  // Lifecycle: getSwarmConfig → swarmConfigSet (first run) → swarmStart
  // → consume swarmOutput stream → swarmStop (cancel) or wait for
  // fg:swarm:status-changed { state: "idle", exitCode } final event.
  swarmStatus:     ()    => ipcRenderer.invoke("fg:swarm:status"),
  swarmStart:      (o)   => ipcRenderer.invoke("fg:swarm:start", o || {}),
  swarmStop:       ()    => ipcRenderer.invoke("fg:swarm:stop"),
  getSwarmConfig:  ()    => ipcRenderer.invoke("fg:swarm:config:get"),
  setSwarmConfig:  (o)   => ipcRenderer.invoke("fg:swarm:config:set", o || {}),
  onSwarmOutput: (cb) => {
    const h = (_e, p) => { try { cb(p); } catch {} };
    ipcRenderer.on("fg:swarm:output", h);
    return () => ipcRenderer.removeListener("fg:swarm:output", h);
  },
  onSwarmStatus: (cb) => {
    const h = (_e, p) => { try { cb(p); } catch {} };
    ipcRenderer.on("fg:swarm:status-changed", h);
    return () => ipcRenderer.removeListener("fg:swarm:status-changed", h);
  },
});
