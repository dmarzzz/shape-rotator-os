const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Renderer-ready sentinel for the --smoke-test launch mode. boot.js
  // calls this once boot() resolves; main's smoke path waits for it and
  // exits 0. Fire-and-forget; ignored when not in smoke mode.
  signalReady:  () => { try { ipcRenderer.send("smoke:ready"); } catch {} },
  loadPrefs:    () => ipcRenderer.invoke("prefs:load"),
  savePrefs:    (d) => ipcRenderer.invoke("prefs:save", d),
  env:          () => ipcRenderer.invoke("env:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  loadContextVault:       ()   => ipcRenderer.invoke("context-vault:manifest"),
  scanContextVault:       ()   => ipcRenderer.invoke("context-vault:scan"),
  readContextVaultSource: (id) => ipcRenderer.invoke("context-vault:read-source", id),
  readContextVaultRawBundle: () => ipcRenderer.invoke("context-vault:read-raw-bundle"),
  revealContextVaultSource: (id) => ipcRenderer.invoke("context-vault:reveal-source", id),
  revealContextVaultCorpus: () => ipcRenderer.invoke("context-vault:reveal-corpus"),
  clipboardWrite: (text) => ipcRenderer.invoke("clipboard:write", text),
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
  openDownloadedInstaller: (path) => ipcRenderer.invoke("shell:openDownloadedInstaller", path),
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
  // Streams main's periodic-check hits ("fg:update-available") so the
  // renderer can light the update indicator + raise a toast without the
  // user ever clicking the version stamp. `cb` receives { version }.
  onUpdateAvailable: (cb) => {
    const handler = (_e, info) => { try { cb(info); } catch {} };
    ipcRenderer.on("fg:update-available", handler);
    return () => ipcRenderer.removeListener("fg:update-available", handler);
  },
  // calendar export — PNG (recommended for messaging) or PDF.
  exportCalendar:        (opts)   => ipcRenderer.invoke("fg:export-calendar", opts),
  // bundled swf-node supervisor — see apps/os/swf-node.js. The renderer
  // can poll getSwfNodeStatus() for a one-shot read, or subscribe via
  // onSwfNodeStatus(cb) to a stream of state changes (idle | starting |
  // running | crashed | unsupported). The returned function detaches
  // the listener — call it on unmount.
  getSwfNodeStatus: () => ipcRenderer.invoke("fg:swf-node-status"),
  // Explicitly (re)spawn the daemon if it's down — for a manual "restart
  // backend" affordance. Resolves { ok, status }.
  restartSwfNode: () => ipcRenderer.invoke("fg:swf-node-restart"),
  onSwfNodeStatus: (cb) => {
    const handler = (_e, s) => { try { cb(s); } catch {} };
    ipcRenderer.on("fg:swf-node-status-changed", handler);
    return () => ipcRenderer.removeListener("fg:swf-node-status-changed", handler);
  },
  // When status === "external_squatter", returns `{ version, indrex }`
  // describing the foreign daemon that grabbed :7777 before us. Null
  // otherwise. Use to render a remediation banner.
  getSwfNodeExternalInfo: () => ipcRenderer.invoke("fg:swf-node-external-info"),
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

  // ─── easel · NDI projection (apps/os/easel-ndi.js) ──────────────────
  // listSources() enumerates screens/windows (main-side desktopCapturer);
  // start() opens an NDI sender; frame() ships one RGBA frame (await for
  // natural backpressure — main drops frames if a send is in flight);
  // stats() reports { live, name, connections, frames }; stop() ends it.
  easel: {
    available:   ()  => ipcRenderer.invoke("easel:available"),
    listSources: ()  => ipcRenderer.invoke("easel:list-sources"),
    start:       (o) => ipcRenderer.invoke("easel:start", o || {}),
    frame:       (f) => ipcRenderer.invoke("easel:frame", f),
    stats:       ()  => ipcRenderer.invoke("easel:stats"),
    stop:        ()  => ipcRenderer.invoke("easel:stop"),
    // Receive side — discover NDI sources on the LAN + stream the chosen
    // source's video frames into the renderer. Returns a detach function.
    findNdi:     (o) => ipcRenderer.invoke("easel:find-sources", o || {}),
    rxStart:     (sourceName) => ipcRenderer.invoke("easel:rx-start", { sourceName }),
    rxStop:      ()  => ipcRenderer.invoke("easel:rx-stop"),
    rxStats:     ()  => ipcRenderer.invoke("easel:rx-stats"),
    onRxFrame:   (cb) => {
      const handler = (_e, frame) => { try { cb(frame); } catch {} };
      ipcRenderer.on("easel:rx-frame", handler);
      return () => ipcRenderer.removeListener("easel:rx-frame", handler);
    },
    onRxAudio:   (cb) => {
      const handler = (_e, frame) => { try { cb(frame); } catch {} };
      ipcRenderer.on("easel:rx-audio", handler);
      return () => ipcRenderer.removeListener("easel:rx-audio", handler);
    },
    // Per-source low-bandwidth thumbnail receivers — drives the live
    // previews inside each LAN feed card.
    thumbStart:  (sourceName) => ipcRenderer.invoke("easel:thumb-start", { sourceName }),
    thumbStop:   (sourceName) => ipcRenderer.invoke("easel:thumb-stop", { sourceName }),
    thumbStopAll: () => ipcRenderer.invoke("easel:thumb-stop-all"),
    onThumbFrame: (cb) => {
      const handler = (_e, frame) => { try { cb(frame); } catch {} };
      ipcRenderer.on("easel:thumb-frame", handler);
      return () => ipcRenderer.removeListener("easel:thumb-frame", handler);
    },
  },

  // ─── router (Teleport Router) ────────────────────────────────────────
  // The router app runs in its OWN pop-out window (src/router/) behind its own
  // shim preload (window.daybook). From the MAIN window we only need to open it
  // — the apps card / command palette / onboarding step call this.
  daybook: {
    openWindow: () => ipcRenderer.invoke("daybook:open-window"),
  },
});
