// matrix-crypto-proc.js — utilityProcess child that hosts the Olm/Megolm engine.
//
// Forked by matrix-crypto-host.js (see it for the why). The whole point of this
// process boundary is crash containment: @matrix-org/matrix-sdk-crypto-nodejs
// can panic in native Rust and abort the process — here that kills only this
// child, and the main app survives.
//
// It owns NO HTTP. The OlmMachine's outgoing requests are marshaled to the
// parent (main process) over the parent port, where matrix.js's authed
// net.fetch bridge runs them; responses come back the same way. Logs from
// matrix-crypto.js go to this process's stderr, which utilityProcess inherits,
// so they still surface in the app's console. Protocol mirrors the host.

const mxcrypto = require("./matrix-crypto");

const port = process.parentPort;
let seq = 0;
const httpPending = new Map();   // http id → { resolve, reject }

function post(msg) { try { port.postMessage(msg); } catch {} }

// The http(method, path, bodyObj) callback matrix-crypto.js expects. Round-trips
// to the parent and resolves { status, body }; rejects only on a transport
// error, so the engine retries — matching the parent's net.fetch contract.
function rpcHttp(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const id = `h${++seq}`;
    httpPending.set(id, { resolve, reject });
    post({ kind: "http", id, method, path: apiPath, body });
  });
}

const handlers = {
  async init(args) { await mxcrypto.init({ ...args, http: rpcHttp }); return true; },
  async onSyncChanges(payload) { await mxcrypto.onSyncChanges(payload || {}); return true; },
  async decryptEvent({ rawEvent, roomId }) { return mxcrypto.decryptEvent(rawEvent, roomId); },
  async encryptForRoom(params) { return mxcrypto.encryptForRoom(params); },
  async close() { try { mxcrypto.close(); } catch {} return true; },
};

port.on("message", async (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.kind === "http-reply") {
    const p = httpPending.get(msg.id);
    if (!p) return;
    httpPending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve({ status: msg.status, body: msg.body });
    return;
  }

  if (msg.kind === "cmd") {
    const fn = handlers[msg.name];
    if (!fn) { post({ kind: "cmd-reply", id: msg.id, ok: false, error: `unknown cmd ${msg.name}` }); return; }
    try {
      const result = await fn(msg.args);
      post({ kind: "cmd-reply", id: msg.id, ok: true, result });
    } catch (err) {
      post({ kind: "cmd-reply", id: msg.id, ok: false, error: (err && err.message) || String(err) });
    }
  }
});
