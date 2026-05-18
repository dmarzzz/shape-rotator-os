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
});
