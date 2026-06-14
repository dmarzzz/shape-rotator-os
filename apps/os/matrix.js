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
let ssoFinish = null; // settle-callback of the in-flight browser/device flow

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

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

// Cancel the in-flight browser/device flow: close the loopback AND settle its
// promise (otherwise the renderer's await hangs until the 5-min timeout, then
// paints a phantom "timed out" error over whatever the user moved on to).
function cancelSSO() {
  const f = ssoFinish; ssoFinish = null;
  if (ssoServer) { try { ssoServer.close(); } catch {} ssoServer = null; }
  if (f) f({ ok: false, error: "cancelled" });
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
      try { server.close(); } catch {}          // tear down ONLY our own loopback
      if (ssoServer === server) ssoServer = null;
      if (ssoFinish === finish) ssoFinish = null;
      resolve(result);
    };
    ssoFinish = finish;
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.includes(nonce)) { res.writeHead(404); res.end(); return; }
        const loginToken = url.searchParams.get("loginToken");
        if (!loginToken) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(resultPage("Sign-in failed", "No login token was returned. You can close this tab."));
          finish({ ok: false, error: "no login token returned" });
          return;
        }
        const result = await applyLoginToken(hs, loginToken);
        if (result.ok) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage("Signed in ✓", "Return to Shape Rotator OS — you can close this tab."));
        } else {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(resultPage("Sign-in failed", escHtml(result.error || "could not redeem the code") + " — return to Shape Rotator OS and try again."));
        }
        finish(result);
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

// Small dark "you can close this tab" page shown in the browser after a flow.
function resultPage(title, msg) {
  return `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#1A1719;color:#f5f3ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${title}</h2><p style="opacity:.7">${msg}</p></div>`;
}

// Redeem a one-time login token (m.login.token) for a FRESH device session.
// Shared by the SSO callback, the device-approval flow, and manual paste — the
// app never sees the user's password or their other device's access token,
// only this short-lived token.
async function applyLoginToken(hs, loginToken) {
  try {
    const r = await fetch(hs + "/_matrix/client/v3/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "m.login.token", token: loginToken, initial_device_display_name: "Shape Rotator OS" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) return { ok: false, error: data.error || `sign-in failed (HTTP ${r.status})` };
    stopSync();
    rooms.clear(); since = null;
    saveSession({ homeserver: hs, userId: data.user_id, deviceId: data.device_id || null }, data.access_token);
    log(`signed in via login token as ${data.user_id}`);
    startSync();
    return { ok: true, userId: data.user_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Manual fallback: redeem a one-time login code the user pasted in directly.
async function loginWithCode({ homeserver, token } = {}) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  const code = String(token || "").trim();
  if (!code) return { ok: false, error: "paste a login code first" };
  return applyLoginToken(hs, code);
}

// ─── device-approval sign-in (MSC3882 login-token) ──────────────────────────
// The homeserver advertises m.login.token with get_login_token, but has no
// rendezvous endpoint, so we bridge it locally. The app opens a small helper
// page (served by a loopback http server) in the user's browser. The user
// pastes an access token from a device they're already signed in to; the
// helper calls /login/get_token THERE (so the password — and the access token
// — never touch this app), then hands the resulting short-lived login token
// back to the loopback, which redeems it for a fresh device session.
function deviceHelperHtml(hs, nonce) {
  // Escape for a <script> context: JSON.stringify alone leaves '<'/'>' intact,
  // so a homeserver containing "</script>" could break out. Unicode-escape the
  // HTML-significant chars (JS parses them back to the same string). Defensive
  // today (hs is the hardcoded DEFAULT_HS) but load-bearing if hs ever becomes
  // user/.well-known-supplied.
  const jsLit = (v) => JSON.stringify(String(v))
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const safeHs = jsLit(hs);
  const safeNonce = jsLit(nonce);
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Shape Rotator OS — sign in</title>
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#1A1719;color:#f5f3ee;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
 .card{width:100%;max-width:440px;background:rgba(245,243,238,.03);border:1px solid rgba(245,243,238,.12);border-radius:12px;padding:28px}
 .eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:rgba(245,243,238,.4);margin-bottom:12px}
 h1{font-size:20px;font-weight:500;margin:0 0 8px}
 p{font-size:13px;line-height:1.55;color:rgba(245,243,238,.62);margin:0 0 14px}
 ol{font-size:13px;line-height:1.65;color:rgba(245,243,238,.72);padding-left:18px;margin:0 0 16px}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(245,243,238,.08);padding:1px 5px;border-radius:4px}
 label{display:block;font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(245,243,238,.45);margin-bottom:6px}
 input{width:100%;background:rgba(245,243,238,.04);border:1px solid rgba(245,243,238,.16);border-radius:6px;padding:10px 12px;color:#f5f3ee;font-family:ui-monospace,Menlo,monospace;font-size:12px;outline:none}
 input:focus{border-color:rgba(245,243,238,.4)}
 button{width:100%;margin-top:14px;cursor:pointer;border:1px solid rgba(208,83,50,.6);background:rgba(208,83,50,.18);color:#fff;border-radius:6px;padding:11px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
 button:hover{background:rgba(208,83,50,.3)} button:disabled{opacity:.5;cursor:default}
 .msg{margin-top:12px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;min-height:14px;color:rgba(245,243,238,.6)}
 .msg.err{color:#e8896b}
 .hs{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:rgba(245,243,238,.45);word-break:break-all}
</style></head><body>
<div class=card>
 <div class=eyebrow>SHAPE ROTATOR &middot; cohort matrix</div>
 <h1>Approve this sign-in</h1>
 <p>This signs Shape Rotator OS into <span class=hs></span> using a device you're already logged in to. <strong>Your password is never used here.</strong></p>
 <ol>
  <li>In Element (a Matrix client you're already signed in to), open <code>Settings &rarr; Help &amp; About</code>.</li>
  <li>Scroll to <code>Access Token</code>, reveal and copy it.</li>
  <li>Paste it below and approve. It's used once to mint a 2-minute code, then discarded.</li>
 </ol>
 <label for=tok>Access token</label>
 <input id=tok type=password placeholder="syt_&hellip;" autocomplete=off spellcheck=false>
 <button id=go>Approve sign-in</button>
 <div class=msg id=msg></div>
</div>
<script>
 var HS=${safeHs}, NONCE=${safeNonce};
 document.querySelector('.hs').textContent=HS;
 var go=document.getElementById('go'),tok=document.getElementById('tok'),msg=document.getElementById('msg');
 function err(t){msg.textContent=t;msg.className='msg err';go.disabled=false;}
 go.onclick=async function(){
  var t=tok.value.trim();
  if(!t){err('Paste your access token first.');return;}
  msg.className='msg';msg.textContent='Minting a one-time code\\u2026';go.disabled=true;
  try{
   var r=await fetch(HS+'/_matrix/client/v1/login/get_token',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:'{}'});
   var d=await r.json().catch(function(){return{};});
   if(r.status===401&&d&&d.flows){err('This homeserver needs re-authentication for device sign-in (UIA), which is not supported yet. Close this tab and click Cancel in Shape Rotator OS, then tell the SR OS team you hit this.');return;}
   if(!r.ok||!d.login_token){err((d&&(d.error||d.errcode))||('Failed (HTTP '+r.status+')'));return;}
   msg.textContent='Approved \\u2014 signing you in\\u2026';
   window.location='/'+NONCE+'?loginToken='+encodeURIComponent(d.login_token);
  }catch(e){err('Network error: '+((e&&e.message)||e));}
 };
 tok.addEventListener('keydown',function(e){if(e.key==='Enter')go.click();});
</script></body></html>`;
}

function loginViaDevice({ homeserver } = {}) {
  const hs = (homeserver || DEFAULT_HS).replace(/\/+$/, "");
  cancelSSO();
  const nonce = crypto.randomBytes(16).toString("hex"); // unguessable callback path
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}          // tear down ONLY our own loopback
      if (ssoServer === server) ssoServer = null;
      if (ssoFinish === finish) ssoFinish = null;
      resolve(result);
    };
    ssoFinish = finish;
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        // Any path WITHOUT the nonce → serve the mint helper page.
        if (!url.pathname.includes(nonce)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(deviceHelperHtml(hs, nonce));
          return;
        }
        // The nonce callback → the helper handed us a minted login token.
        const loginToken = url.searchParams.get("loginToken");
        if (!loginToken) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(resultPage("Sign-in failed", "No code was returned. You can close this tab."));
          finish({ ok: false, error: "no login token returned" });
          return;
        }
        const result = await applyLoginToken(hs, loginToken);
        if (result.ok) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage("Signed in ✓", "Return to Shape Rotator OS — you can close this tab."));
        } else {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(resultPage("Sign-in failed", escHtml(result.error || "could not redeem the code") + " — return to Shape Rotator OS and try again."));
        }
        finish(result);
      } catch (e) {
        try { res.writeHead(500); res.end(); } catch {}
        finish({ ok: false, error: e.message });
      }
    });
    ssoServer = server;
    server.on("error", (e) => finish({ ok: false, error: `local listener failed: ${e.message}` }));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      log(`opening device sign-in helper on http://localhost:${port}/`);
      shell.openExternal(`http://localhost:${port}/`);
    });
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
  getStatus, getFlows, login, loginToken, loginSSO, loginViaDevice, loginWithCode, cancelSSO, logout,
  getRooms, getMessages, send,
};
