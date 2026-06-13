// matrix.js
//
// A minimal Matrix client that lives in the MAIN process and talks to the
// cohort homeserver over the plain Client-Server HTTP API (no SDK, no E2EE).
// The renderer never touches the network — it drives this module over IPC and
// receives rooms/messages as broadcast events. That keeps the renderer's CSP
// strict (it only does loopback IPC) and means the heavy lift (login, the
// long-poll /sync loop, sending) all happens in Node where `fetch` is free of
// CSP and CORS.
//
// SCOPE (v1): unencrypted channels only — read + write. Encrypted rooms (DMs,
// any room with m.room.encryption) are listed but flagged `encrypted:true`;
// their ciphertext is never decrypted here. When we add E2EE we swap THIS
// module's transport for matrix-js-sdk + rust-crypto behind the same IPC
// surface — the renderer doesn't change.
//
// Session lifecycle
//   start(app)   — call on app.whenReady; resumes sync if a token is saved
//   stop()       — call on before-quit; aborts the sync loop
//   login(...)   — password login, persists the session, starts sync
//   loginToken() — adopt an existing access token
//   logout()     — drop the session + stop sync
//
// Persistence (under app userData)
//   matrix-session.json — { homeserver, userId, deviceId }
//   matrix-token.enc    — access token, encrypted via Electron safeStorage
//                         (Keychain / libsecret / DPAPI); plaintext fallback
//                         with a warning when encryption is unavailable.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { BrowserWindow, safeStorage, shell } = require("electron");

// The cohort homeserver (docs/MATRIX.md). The Client-Server API base is the
// same host; we skip .well-known discovery for v1.
const DEFAULT_HS = "https://mtrx.shaperotator.xyz";

// Sync filter — keep payloads small: only the state + timeline event types we
// render. lazy_load_members keeps member state out of the initial snapshot.
const SYNC_FILTER = {
  room: {
    timeline: { limit: 40, types: ["m.room.message", "m.room.encrypted"] },
    state: {
      types: ["m.room.name", "m.room.canonical_alias", "m.room.encryption"],
      lazy_load_members: true,
    },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
};

const MAX_MSGS_PER_ROOM = 300;   // ring-buffer cap so memory stays bounded
const SYNC_TIMEOUT_MS = 30000;   // long-poll window for incremental syncs

let app = null;
let session = null;              // { homeserver, userId, deviceId }
let token = null;
let state = "logged_out";        // logged_out | connecting | syncing | error
let lastError = "";
let since = null;                // sync cursor
let running = false;
let abort = null;                // AbortController for the in-flight sync
let txn = 0;
const rooms = new Map();         // roomId → { name, alias, encrypted, unread, msgs:[], lastTs }

// ─── persistence ──────────────────────────────────────────────────────────

function sessionFile() { return path.join(app.getPath("userData"), "matrix-session.json"); }
function tokenFile() { return path.join(app.getPath("userData"), "matrix-token.enc"); }

function loadSession() {
  try {
    session = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
  } catch { session = null; }
  try {
    const buf = fs.readFileSync(tokenFile());
    token = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
  } catch { token = null; }
  if (!session || !token) { session = null; token = null; }
}

function saveSession(sess, tok) {
  session = sess;
  token = tok;
  try { fs.writeFileSync(sessionFile(), JSON.stringify(sess), { mode: 0o600 }); } catch (e) { warn(`session write failed: ${e.message}`); }
  try {
    const out = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(tok)
      : Buffer.from(tok, "utf8");
    if (!safeStorage.isEncryptionAvailable()) warn("safeStorage unavailable — matrix token stored in plaintext");
    fs.writeFileSync(tokenFile(), out, { mode: 0o600 });
  } catch (e) { warn(`token write failed: ${e.message}`); }
}

function clearSession() {
  session = null; token = null; since = null;
  rooms.clear();
  try { fs.unlinkSync(sessionFile()); } catch {}
  try { fs.unlinkSync(tokenFile()); } catch {}
}

// ─── helpers ────────────────────────────────────────────────────────────────

function warn(msg) { try { process.stderr.write(`[matrix:warn] ${msg}\n`); } catch {} }
function log(msg) { try { process.stderr.write(`[matrix:log] ${msg}\n`); } catch {} }

function hsBase() { return (session?.homeserver || DEFAULT_HS).replace(/\/+$/, ""); }
function authHeaders() { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }; }

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try { win.webContents.send(channel, payload); } catch {}
  }
}

function setState(s, err = "") {
  state = s;
  lastError = err;
  broadcast("matrix:status", getStatus());
}

function roomName(r, roomId) { return r.name || r.alias || roomId; }

function roomSummaries() {
  return [...rooms.entries()]
    .map(([roomId, r]) => ({
      roomId,
      name: roomName(r, roomId),
      encrypted: !!r.encrypted,
      unread: r.unread || 0,
      lastTs: r.lastTs || 0,
      lastPreview: r.msgs.length ? r.msgs[r.msgs.length - 1].body.slice(0, 80) : "",
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

// ─── sync processing ──────────────────────────────────────────────────────

function ensureRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) { r = { name: "", alias: "", encrypted: false, unread: 0, msgs: [], lastTs: 0, seen: new Set() }; rooms.set(roomId, r); }
  return r;
}

function applyState(r, ev) {
  if (ev.type === "m.room.name") r.name = ev.content?.name || r.name;
  else if (ev.type === "m.room.canonical_alias") r.alias = ev.content?.alias || r.alias;
  else if (ev.type === "m.room.encryption") r.encrypted = true;
}

// Plain-text representation of a message event. Emotes get a "* " prefix;
// non-text msgtypes fall back to a terse placeholder so the timeline never
// shows a blank line.
function messageBody(ev) {
  const c = ev.content || {};
  if (typeof c.body === "string" && c.body) {
    if (c.msgtype === "m.emote") return `* ${c.body}`;
    return c.body;
  }
  const kind = (c.msgtype || "").replace(/^m\./, "");
  return kind ? `[${kind}]` : "[message]";
}

function toMsg(ev) {
  return {
    eventId: ev.event_id,
    sender: ev.sender,
    body: messageBody(ev),
    ts: ev.origin_server_ts || 0,
    mine: ev.sender === session?.userId,
  };
}

function addMessage(r, msg) {
  if (!msg.eventId || r.seen.has(msg.eventId)) return false;
  r.seen.add(msg.eventId);
  r.msgs.push(msg);
  if (msg.ts > r.lastTs) r.lastTs = msg.ts;
  if (r.msgs.length > MAX_MSGS_PER_ROOM) {
    const dropped = r.msgs.splice(0, r.msgs.length - MAX_MSGS_PER_ROOM);
    for (const d of dropped) r.seen.delete(d.eventId);
  }
  return true;
}

function processSync(data) {
  const joined = data.rooms?.join || {};
  let roomsChanged = false;
  for (const [roomId, room] of Object.entries(joined)) {
    const r = ensureRoom(roomId);
    for (const ev of room.state?.events || []) applyState(r, ev);
    const fresh = [];
    for (const ev of room.timeline?.events || []) {
      if (ev.type === "m.room.encryption") { r.encrypted = true; continue; }
      if (ev.type === "m.room.name" || ev.type === "m.room.canonical_alias") { applyState(r, ev); continue; }
      if (ev.type === "m.room.encrypted") { r.encrypted = true; continue; }
      if (ev.type === "m.room.message") {
        const msg = toMsg(ev);
        if (addMessage(r, msg)) fresh.push(msg);
      }
    }
    if (room.unread_notifications) r.unread = room.unread_notifications.notification_count || 0;
    if (fresh.length) broadcast("matrix:messages", { roomId, messages: fresh });
    roomsChanged = true;
  }
  // Rooms we've left this sync — drop them from the list.
  for (const roomId of Object.keys(data.rooms?.leave || {})) {
    if (rooms.delete(roomId)) roomsChanged = true;
  }
  if (roomsChanged) broadcast("matrix:rooms", roomSummaries());
}

// ─── sync loop ──────────────────────────────────────────────────────────────

async function syncLoop() {
  let backoff = 1000;
  while (running) {
    abort = new AbortController();
    try {
      const url = new URL(hsBase() + "/_matrix/client/v3/sync");
      url.searchParams.set("filter", JSON.stringify(SYNC_FILTER));
      if (since) {
        url.searchParams.set("since", since);
        url.searchParams.set("timeout", String(SYNC_TIMEOUT_MS));
      } else {
        url.searchParams.set("timeout", "0"); // fast initial snapshot
      }
      const res = await fetch(url, { headers: authHeaders(), signal: abort.signal });
      if (res.status === 401) {
        warn("access token rejected (401) — logging out");
        clearSession();
        running = false;
        setState("logged_out", "session expired — sign in again");
        broadcast("matrix:rooms", []);
        return;
      }
      if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
      const data = await res.json();
      since = data.next_batch;
      processSync(data);
      if (state !== "syncing") setState("syncing");
      backoff = 1000;
    } catch (e) {
      if (!running) return;            // aborted by stop()/logout()
      if (e.name === "AbortError") continue;
      warn(`sync error: ${e.message} — retrying in ${backoff}ms`);
      setState("error", e.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

function startSync() {
  if (running || !token || !session) return;
  running = true;
  setState("connecting");
  syncLoop();
}

function stopSync() {
  running = false;
  try { abort?.abort(); } catch {}
}

// ─── public API ───────────────────────────────────────────────────────────

function getStatus() {
  return {
    state,
    userId: session?.userId || null,
    homeserver: session?.homeserver || DEFAULT_HS,
    error: lastError || "",
  };
}

async function login({ homeserver, user, password } = {}) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  try {
    const res = await fetch(hs + "/_matrix/client/v3/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: String(user || "").replace(/^@/, "") },
        password,
        initial_device_display_name: "Shape Rotator OS",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return { ok: false, error: data.error || `login failed (HTTP ${res.status})` };
    }
    stopSync();
    rooms.clear(); since = null;
    saveSession({ homeserver: hs, userId: data.user_id, deviceId: data.device_id }, data.access_token);
    log(`logged in as ${data.user_id}`);
    startSync();
    return { ok: true, userId: data.user_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loginToken({ homeserver, token: tok } = {}) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  try {
    const res = await fetch(hs + "/_matrix/client/v3/account/whoami", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.user_id) return { ok: false, error: data.error || "token rejected" };
    stopSync();
    rooms.clear(); since = null;
    saveSession({ homeserver: hs, userId: data.user_id, deviceId: data.device_id || null }, tok);
    startSync();
    return { ok: true, userId: data.user_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── browser sign-in (SSO) ──────────────────────────────────────────────────
// The credential-free path: the app opens the homeserver's SSO page in the
// user's real browser, they authenticate with the cohort identity provider
// (e.g. GitHub) on a page they already trust, and the homeserver redirects
// back to a loopback URL with a one-time login token. The password never
// touches the app. Requires the homeserver to advertise `m.login.sso` (see
// docs/MATRIX_OIDC_SETUP.md for the one-time Synapse config that enables it).
let ssoServer = null;

// Reports which login methods the homeserver offers, so the UI can show the
// browser button when available and a clear "not enabled yet" state otherwise.
async function getFlows(homeserver) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  try {
    const res = await fetch(hs + "/_matrix/client/v3/login");
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, flows: Array.isArray(data.flows) ? data.flows : [] };
  } catch (e) {
    return { ok: false, error: e.message, flows: [] };
  }
}

function cancelSSO() {
  if (ssoServer) { try { ssoServer.close(); } catch {} ssoServer = null; }
}

// Drive the full browser SSO handshake. Resolves once the loopback callback
// fires and the returned login token is redeemed for an access token.
function loginSSO({ homeserver, idpId } = {}) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  cancelSSO();
  const nonce = crypto.randomBytes(16).toString("hex"); // unguessable callback path
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      cancelSSO();
      resolve(result);
    };
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.includes(nonce)) { res.writeHead(404); res.end(); return; }
        const loginToken = url.searchParams.get("loginToken");
        const page = (title, msg) => `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#1A1719;color:#f5f3ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${title}</h2><p style="opacity:.7">${msg}</p></div>`;
        if (!loginToken) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(page("Sign-in failed", "No login token was returned. You can close this tab."));
          finish({ ok: false, error: "no login token returned" });
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page("Signed in ✓", "Return to Shape Rotator OS — you can close this tab."));
        const r = await fetch(hs + "/_matrix/client/v3/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "m.login.token", token: loginToken, initial_device_display_name: "Shape Rotator OS" }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.access_token) { finish({ ok: false, error: data.error || `token redeem failed (HTTP ${r.status})` }); return; }
        stopSync();
        rooms.clear(); since = null;
        saveSession({ homeserver: hs, userId: data.user_id, deviceId: data.device_id || null }, data.access_token);
        log(`signed in via browser as ${data.user_id}`);
        startSync();
        finish({ ok: true, userId: data.user_id });
      } catch (e) {
        try { res.writeHead(500); res.end(); } catch {}
        finish({ ok: false, error: e.message });
      }
    });
    ssoServer = server;
    server.on("error", (e) => finish({ ok: false, error: `local listener failed: ${e.message}` }));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUrl = `http://localhost:${port}/${nonce}`;
      const ssoPath = idpId
        ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idpId)}`
        : `/_matrix/client/v3/login/sso/redirect`;
      const ssoUrl = `${hs}${ssoPath}?redirectUrl=${encodeURIComponent(redirectUrl)}`;
      log(`opening browser SSO: ${ssoUrl}`);
      shell.openExternal(ssoUrl);
    });
    // Give up after 5 minutes so a dropped flow doesn't leak a listener.
    timer = setTimeout(() => finish({ ok: false, error: "sign-in timed out" }), 5 * 60 * 1000);
  });
}

async function logout() {
  const hs = hsBase();
  const hadToken = token;
  stopSync();
  clearSession();
  setState("logged_out");
  broadcast("matrix:rooms", []);
  // Best-effort server-side logout; ignore failures (token already cleared).
  if (hadToken) {
    try { await fetch(hs + "/_matrix/client/v3/logout", { method: "POST", headers: { Authorization: `Bearer ${hadToken}` } }); } catch {}
  }
  return { ok: true };
}

function getRooms() { return roomSummaries(); }

function getMessages(roomId) {
  const r = rooms.get(roomId);
  if (!r) return { roomId, encrypted: false, messages: [] };
  return { roomId, name: roomName(r, roomId), encrypted: !!r.encrypted, messages: r.msgs.slice() };
}

async function send(roomId, body) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  const r = rooms.get(roomId);
  if (r?.encrypted) return { ok: false, error: "room is end-to-end encrypted — not supported yet" };
  const text = String(body || "").trim();
  if (!text) return { ok: false, error: "empty message" };
  const txnId = `srwk-${Date.now()}-${txn++}`;
  try {
    const url = `${hsBase()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ msgtype: "m.text", body: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.event_id) return { ok: false, error: data.error || `send failed (HTTP ${res.status})` };
    return { ok: true, eventId: data.event_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function start(electronApp) {
  app = electronApp;
  loadSession();
  if (session && token) {
    log(`resuming session for ${session.userId}`);
    startSync();
  } else {
    setState("logged_out");
  }
}

function stop() { stopSync(); cancelSSO(); }

module.exports = {
  start, stop,
  getStatus, getFlows, login, loginToken, loginSSO, cancelSSO, logout,
  getRooms, getMessages, send,
};
