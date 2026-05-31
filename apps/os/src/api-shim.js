// api-shim.js — the Tauri replacement for Electron's preload.js.
//
// Rebuilds the exact `window.api` surface the renderer expects, backed by
// Tauri's global IPC (`window.__TAURI__`, enabled via withGlobalTauri).
// Every method keeps its original name + signature so boot.js / alchemy.js /
// easel.js / atlas.js / sync-client.js are untouched.
//
// Design choices:
//   - Only window.__TAURI__.core.invoke + .event.listen are used (the two
//     globals guaranteed by withGlobalTauri). All OS/plugin work (opener,
//     clipboard, dialog, updater, keyring, subprocess) lives in Rust
//     #[tauri::command]s — the shim never imports plugin JS, so no bundler.
//   - onX(cb) subscriptions return a SYNCHRONOUS detach fn, matching the
//     `const off = onX(cb); off()` contract Electron's removeListener gave.
//   - The easel data plane (frames) flows over a direct loopback WebSocket
//     to the Node NDI sidecar, never through Tauri IPC (8MB RGBA @ 30fps).
(function () {
  "use strict";
  const T = window.__TAURI__;
  if (!T || !T.core || !T.event) {
    console.error("[api-shim] window.__TAURI__ unavailable — withGlobalTauri off?");
  }
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const listen = (channel, handler) => T.event.listen(channel, handler);

  // onX(cb): subscribe to a Tauri event; return a sync unlisten closure.
  // listen() is async (Promise<UnlistenFn>); we capture the fn when it
  // resolves and the returned closure detaches once available (no-op if
  // called earlier). cb receives the raw event payload (Electron handlers
  // took (_e, data) — here we pass just the payload, matching usage).
  const sub = (channel, cb) => {
    let un = null;
    let detached = false;
    listen(channel, (e) => {
      try {
        cb(e.payload);
      } catch {}
    }).then((fn) => {
      un = fn;
      if (detached) un();
    });
    return () => {
      detached = true;
      if (un) un();
    };
  };

  // ─── easel WebSocket client (data plane to the NDI sidecar) ──────────
  // Lazily connects to ws://127.0.0.1:<port> once a method needs it. The
  // sidecar hands Rust {port, token}; we fetch it via easel_endpoint.
  const easelWS = makeEaselClient();

  window.api = {
    signalReady: () => {
      try {
        invoke("signal_ready");
      } catch {}
    },
    loadPrefs: () => invoke("prefs_load"),
    savePrefs: (d) => invoke("prefs_save", { d }),
    env: () => invoke("env_get"),
    openExternal: (url) => invoke("open_external", { url }),

    loadContextVault: () => invoke("context_vault_manifest"),
    scanContextVault: () => invoke("context_vault_scan"),
    readContextVaultSource: (id) => invoke("context_vault_read_source", { id }),
    readContextVaultRawBundle: () => invoke("context_vault_read_raw_bundle"),
    revealContextVaultSource: (id) => invoke("context_vault_reveal_source", { id }),
    revealContextVaultCorpus: () => invoke("context_vault_reveal_corpus"),

    clipboardWrite: (text) => invoke("clipboard_write", { text }),

    // app updates
    checkAppUpdate: () => invoke("check_app_update"),
    applyAppUpdate: () => invoke("apply_app_update"),
    applyUpdateAndRestart: () => invoke("apply_update_and_restart"),
    downloadAndRevealUpdate: () => invoke("download_and_reveal_update"),
    openDownloadedInstaller: (path) => invoke("open_downloaded_installer", { path }),
    getAppInfo: () => invoke("get_app_info"),
    onUpdateProgress: (cb) => sub("update://progress", cb),

    exportCalendar: (opts) => exportCalendar(opts),

    // swf-node supervisor
    getSwfNodeStatus: () => invoke("swf_node_status"),
    restartSwfNode: () => invoke("swf_node_restart"),
    onSwfNodeStatus: (cb) => sub("swf-node://status", cb),
    getSwfNodeExternalInfo: () => invoke("swf_node_external_info"),
    getSwfAgentToken: () => invoke("swf_agent_token"),

    // research-swarm
    swarmStatus: () => invoke("swarm_status"),
    swarmStart: (o) => invoke("swarm_start", { opts: o || {} }),
    swarmStop: () => invoke("swarm_stop"),
    getSwarmConfig: () => invoke("swarm_config_get"),
    setSwarmConfig: (o) => invoke("swarm_config_set", { opts: o || {} }),
    onSwarmOutput: (cb) => sub("swarm://output", cb),
    onSwarmStatus: (cb) => sub("swarm://status", cb),

    // easel · NDI projection (control over WS; available() via Rust)
    easel: {
      available: () => invoke("easel_available"),
      listSources: () => easelWS.listSources(),
      start: (o) => easelWS.call("start", o || {}),
      frame: (f) => easelWS.sendFrame(f),
      stats: () => easelWS.call("stats"),
      stop: () => easelWS.call("stop"),
      findNdi: (o) => easelWS.call("find", o || {}),
      rxStart: (sourceName) => easelWS.call("rxStart", { sourceName }),
      rxStop: () => easelWS.call("rxStop"),
      rxStats: () => easelWS.call("rxStats"),
      onRxFrame: (cb) => easelWS.on("rx-frame", cb),
      onRxAudio: (cb) => easelWS.on("rx-audio", cb),
      thumbStart: (sourceName) => easelWS.call("thumbStart", { sourceName }),
      thumbStop: (sourceName) => easelWS.call("thumbStop", { sourceName }),
      thumbStopAll: () => easelWS.call("thumbStopAll"),
      onThumbFrame: (cb) => easelWS.on("thumb-frame", cb),
    },
  };

  // PDF export is produced in the renderer (jsPDF) then handed to the same
  // Rust command as a data: URL; PNG goes straight to Rust. Keeps the
  // backend a trivial dialog+write and the call sites unchanged.
  async function exportCalendar(opts) {
    opts = opts || {};
    if (opts.format === "pdf" && opts.dataUrl && window.__srfgMakePdfDataUrl) {
      try {
        const pdfUrl = await window.__srfgMakePdfDataUrl(opts);
        return invoke("export_calendar", { opts: { ...opts, dataUrl: pdfUrl } });
      } catch (e) {
        return { ok: false, reason: "pdf_render_failed", error: String(e) };
      }
    }
    return invoke("export_calendar", { opts });
  }

  // ─── easel sidecar WS client ────────────────────────────────────────
  function makeEaselClient() {
    let ws = null;
    let connecting = null;
    let nextId = 1;
    const pending = new Map();
    const subs = { "rx-frame": new Set(), "rx-audio": new Set(), "thumb-frame": new Set() };

    // Sidecar restarts on a new ephemeral port; Rust re-emits the endpoint.
    sub("easel://endpoint", () => {
      try {
        ws && ws.close();
      } catch {}
      ws = null;
    });

    async function connect() {
      if (ws && ws.readyState === 1) return ws;
      if (connecting) return connecting;
      connecting = (async () => {
        const ep = await invoke("easel_endpoint"); // { port, token } or null
        if (!ep || !ep.port) {
          connecting = null;
          throw new Error("easel sidecar unavailable");
        }
        const sock = new WebSocket(`ws://127.0.0.1:${ep.port}?token=${encodeURIComponent(ep.token || "")}`);
        sock.binaryType = "arraybuffer";
        await new Promise((res, rej) => {
          sock.onopen = res;
          sock.onerror = () => rej(new Error("easel ws error"));
        });
        sock.onmessage = onMessage;
        sock.onclose = () => {
          if (ws === sock) ws = null;
          for (const { reject } of pending.values()) reject(new Error("easel ws closed"));
          pending.clear();
        };
        ws = sock;
        connecting = null;
        return sock;
      })();
      return connecting;
    }

    function onMessage(ev) {
      if (typeof ev.data === "string") {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.ok === false ? reject(new Error(msg.error || "easel error")) : resolve(msg.result);
        }
        return;
      }
      // binary frame: dispatch by leading type byte
      const buf = ev.data;
      const dv = new DataView(buf);
      const type = dv.getUint8(0);
      if (type === 0x02) dispatch("rx-frame", decodeRxFrame(dv, buf));
      else if (type === 0x03) dispatch("rx-audio", decodeRxAudio(dv, buf));
      else if (type === 0x04) dispatch("thumb-frame", decodeThumbFrame(dv, buf));
    }

    function dispatch(kind, payload) {
      for (const cb of subs[kind]) {
        try {
          cb(payload);
        } catch {}
      }
    }

    function decodeRxFrame(dv, buf) {
      const width = dv.getUint32(8, true);
      const height = dv.getUint32(12, true);
      const lineStride = dv.getUint32(16, true);
      const data = new Uint8Array(buf, 20);
      return { width, height, lineStride, data };
    }
    function decodeRxAudio(dv, buf) {
      const sampleRate = dv.getUint32(8, true);
      const channels = dv.getUint32(12, true);
      const samples = dv.getUint32(16, true);
      const data = new Uint8Array(buf, 20);
      return { sampleRate, channels, samples, data };
    }
    function decodeThumbFrame(dv, buf) {
      const nameLen = dv.getUint16(2, true);
      const width = dv.getUint32(8, true);
      const height = dv.getUint32(12, true);
      const lineStride = dv.getUint32(16, true);
      const nameBytes = new Uint8Array(buf, 20, nameLen);
      const sourceName = new TextDecoder().decode(nameBytes);
      const off = 20 + nameLen;
      const data = new Uint8Array(buf, off + ((4 - (off % 4)) % 4));
      return { sourceName, width, height, lineStride, data };
    }

    async function call(op, args) {
      let sock;
      try {
        sock = await connect();
      } catch {
        return null;
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sock.send(JSON.stringify({ id, op, args: args || {} }));
      });
    }

    // SEND_FRAME wire layout: type(u8 @0) | pad(3) | width(u32 @4) | height(u32 @8) | RGBA bytes @12
    function sendFrame(f) {
      if (!ws || ws.readyState !== 1 || !f || !f.data) return Promise.resolve();
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data.buffer || f.data);
      if (ws.bufferedAmount > bytes.byteLength) return Promise.resolve(); // latest-wins drop
      const out = new Uint8Array(12 + bytes.byteLength);
      const hv = new DataView(out.buffer);
      hv.setUint8(0, 0x01);
      hv.setUint32(4, f.width >>> 0, true);
      hv.setUint32(8, f.height >>> 0, true);
      out.set(bytes, 12);
      ws.send(out.buffer);
      return Promise.resolve();
    }

    return {
      call,
      sendFrame,
      listSources: () => call("listSources"),
      on: (kind, cb) => {
        const set = subs[kind];
        set.add(cb);
        connect().catch(() => {});
        return () => set.delete(cb);
      },
    };
  }
})();
