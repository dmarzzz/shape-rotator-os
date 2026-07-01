// matrix.js
//
// A compact Matrix client that lives in the MAIN process and talks to the
// cohort homeserver over the Client-Server HTTP API, with E2EE delegated to the
// crash-contained crypto helper process.
// The renderer never touches the network — it drives this module over IPC and
// receives rooms/messages as broadcast events. That keeps the renderer's CSP
// strict (it only does loopback IPC) and means the heavy lift (login, the
// long-poll /sync loop, sending) all happens in Node where `fetch` is free of
// CSP and CORS.
//
// SCOPE: cohort chat rooms, including current-message Olm/Megolm E2EE. The
// renderer still never touches the homeserver; it drives this module over IPC.
//
// Session lifecycle
//   start(app)   — call on app.whenReady; resumes sync if a token is saved
//   stop()       — call on before-quit; aborts the sync loop
//   login(...)   — password login, persists the session, starts sync
//   logout()     — drop the session + stop sync
//
// Persistence (under app userData — keyed to productName, stable across updates)
//   matrix-session.json — { homeserver, userId, deviceId, oauth? }
//   matrix-token        — access token, plaintext, mode 0600
//
// We deliberately do NOT use Electron safeStorage (OS keychain) here. The app
// ships UNSIGNED, and on an unsigned build macOS pops a "enter your login
// password" Keychain prompt and ties access to the (per-build) code signature —
// so the token would become unreadable after an update and silently log the
// user out. A 0600 file in the per-user userData dir avoids the prompt and
// survives updates. The dir is already user-private; the token is a revocable
// access token, not a password. (If the app is ever Developer-ID signed +
// notarized, safeStorage becomes viable again and this can be revisited.)

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { BrowserWindow, shell, net } = require("electron");

// Route every homeserver request through Electron's net.fetch (Chromium's
// network stack: the SYSTEM cert store, proxies, HTTP/2) rather than Node's
// global fetch/undici, which uses Node's own bundled CAs and can fail to
// verify the Phala-TEE homeserver's cert chain that curl + the browser accept
// (symptom: "couldn't reach the homeserver" while curl returns 200). This
// module-scope shadow makes all fetch(...) calls below use it; the browser
// fetch inside deviceHelperHtml is a string template and is unaffected.
const fetch = (...args) => net.fetch(...args);

// Olm/Megolm engine, isolated in a utilityProcess (matrix-crypto-host.js drives
// it; matrix-crypto-proc.js runs the native @matrix-org/matrix-sdk-crypto-nodejs
// engine out-of-process). The native module can panic (SIGABRT) — uncatchable by
// JS — so we keep it OUT of the main process: a crash there only kills the child
// and we degrade to "encrypted rooms stay locked", never taking the app down.
// Same async surface as the in-process engine, so call sites below are unchanged.
const mxcrypto = require("./matrix-crypto-host");
const oauth = require("./matrix-oauth");

// The cohort homeserver (docs/MATRIX.md). The Client-Server API base is the
// same host; we skip .well-known discovery for v1.
const DEFAULT_HS = "https://mtrx.shaperotator.xyz";

// Sync filter — keep payloads small: only the state + timeline event types we
// render. lazy_load_members keeps member state out of the initial snapshot.
const SYNC_FILTER = {
  room: {
    timeline: { limit: 40, types: ["m.room.message", "m.room.encrypted", "m.reaction", "m.room.redaction"] },
    state: {
      types: ["m.room.name", "m.room.canonical_alias", "m.room.encryption", "m.room.history_visibility"],
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
let cryptoTried = false;         // guards one crypto-init attempt per session
const rooms = new Map();         // roomId → { name, alias, encrypted, unread, msgs:[], lastTs }
const avatarCache = new Map();   // `${userId}|${size}` → data: URL ("" = no picture)

// ─── persistence ──────────────────────────────────────────────────────────

function sessionFile() { return path.join(app.getPath("userData"), "matrix-session.json"); }
function tokenFile() { return path.join(app.getPath("userData"), "matrix-token"); }
// Pre-migration keychain-encrypted token from earlier dev builds (see header).
function legacyTokenFile() { return path.join(app.getPath("userData"), "matrix-token.enc"); }

// Atomic write: a temp file in the same dir + rename, so a crash/power-loss
// mid-write can never leave a truncated session/token on disk. This matters
// for the OAuth refresh-token rotation: MAS invalidates the old refresh token
// the instant it issues a new one, so a half-written matrix-session.json would
// strand a dead token and force a re-login on next launch.
function atomicWrite(file, data, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}   // don't leave a half-written temp behind
    throw e;
  }
}

function loadSession() {
  try {
    session = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
  } catch { session = null; }
  try {
    token = fs.readFileSync(tokenFile(), "utf8");
  } catch { token = null; }
  if (!session || !token) { session = null; token = null; }
}

// Write the current session + token to disk (no crypto teardown — used by both
// a fresh login and a transparent token refresh). Plaintext 0600 file; see the
// header for why we don't use safeStorage.
function persistSession() {
  try { atomicWrite(sessionFile(), JSON.stringify(session), 0o600); } catch (e) { warn(`session write failed: ${e.message}`); }
  try { atomicWrite(tokenFile(), token, 0o600); } catch (e) { warn(`token write failed: ${e.message}`); }
}

// One-time cleanup for installs that ran an earlier dev build which stored the
// token via safeStorage (matrix-token.enc) + a keychain-encrypted crypto store
// key. We can no longer read those (and don't want the keychain prompt), so drop
// them; the next sign-in regenerates everything as plaintext. Matrix shipped
// disabled before this release, so real users have no legacy files — no-op there.
function migrateOffSafeStorage() {
  try {
    if (!fs.existsSync(legacyTokenFile())) return;
    fs.unlinkSync(legacyTokenFile());
    try { fs.unlinkSync(cryptoKeyFile()); } catch {}
    log("migrated off safeStorage — cleared legacy keychain-encrypted token + crypto key");
  } catch {}
}

function saveSession(sess, tok) {
  // A fresh login means a new device → drop any machine bound to the old one.
  try { mxcrypto.close(); } catch {}
  cryptoTried = false;
  session = sess;
  token = tok;
  persistSession();
}

function clearSession() {
  session = null; token = null; since = null;
  rooms.clear();
  avatarCache.clear();
  try { mxcrypto.close(); } catch {}
  cryptoTried = false;
  try { fs.unlinkSync(sessionFile()); } catch {}
  try { fs.unlinkSync(tokenFile()); } catch {}
  try { fs.unlinkSync(legacyTokenFile()); } catch {}
}

// ─── E2EE crypto integration ────────────────────────────────────────────────
// Per-device crypto store directory under userData, keyed by user+device so a
// re-login (which mints a new device) never collides with an old store.
function cryptoStoreDir() {
  const id = `${session?.userId || "unknown"}_${session?.deviceId || "nodev"}`.replace(/[^a-zA-Z0-9._@-]/g, "_");
  const dir = path.join(app.getPath("userData"), "matrix-crypto", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cryptoKeyFile() { return path.join(app.getPath("userData"), "matrix-crypto", "store.key"); }

// A random passphrase that encrypts the crypto store at rest. Plaintext 0600
// file alongside the token (same reasoning — see the header: no keychain prompt,
// survives updates).
function cryptoPassphrase() {
  try {
    return fs.readFileSync(cryptoKeyFile(), "utf8");
  } catch {}
  const pass = crypto.randomBytes(32).toString("base64");
  try {
    fs.mkdirSync(path.dirname(cryptoKeyFile()), { recursive: true });
    atomicWrite(cryptoKeyFile(), pass, 0o600);
  } catch (e) { warn(`crypto key write failed: ${e.message}`); }
  return pass;
}

// Authed homeserver call for the crypto engine. Returns { status, body } and
// only throws when no authenticated request should be made. The crypto engine
// marks a request sent only after a 2xx response, so auth/rate-limit/server
// failures remain retryable.
async function cryptoHttp(method, apiPath, bodyObj) {
  await ensureFreshTokenFor("crypto request");
  const doFetch = async () => {
    const res = await fetch(hsBase() + apiPath, {
      method,
      headers: authHeaders(),
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  };
  const first = await doFetch();
  const { res, body } = await retrySoftLogoutOnce(first.res, first.body, doFetch, "crypto request");
  return { status: res.status, body };
}

// Initialise the Olm machine once per session. Failure is non-fatal: encrypted
// rooms simply stay locked while plain rooms keep working.
async function ensureCrypto() {
  if (mxcrypto.isReady() || cryptoTried) return;
  cryptoTried = true;
  if (!session?.userId || !session?.deviceId) { warn("no stable device id — encrypted rooms stay locked"); return; }
  try {
    await mxcrypto.init({
      userId: session.userId,
      deviceId: session.deviceId,
      storePath: cryptoStoreDir(),
      passphrase: cryptoPassphrase(),
      http: cryptoHttp,
    });
    log("E2EE crypto initialised");
  } catch (e) {
    warn(`crypto init failed (encrypted rooms stay locked): ${e.message}`);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function warn(msg) { try { process.stderr.write(`[matrix:warn] ${msg}\n`); } catch {} }
function log(msg) { try { process.stderr.write(`[matrix:log] ${msg}\n`); } catch {} }

function hsBase() { return (session?.homeserver || DEFAULT_HS).replace(/\/+$/, ""); }
function authHeaders() { return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }; }

function currentAccessTokenStillUsable() {
  return !session?.oauth?.refreshToken || Date.now() < (session.oauth.expiresAt || 0);
}

async function ensureFreshTokenFor(action) {
  const refreshed = await ensureFreshToken();
  if (refreshed === "ok") return;
  if (refreshed === "fatal") {
    logOutExpired("Your session expired — please sign in again.");
    throw new Error("Your session expired — please sign in again.");
  }
  if (!currentAccessTokenStillUsable()) {
    throw new Error(`Couldn't refresh Matrix session before ${action}; retry when your connection is back.`);
  }
  warn(`token refresh unavailable before ${action}; trying the current access token`);
}

async function retrySoftLogoutOnce(res, body, retry, action) {
  if (res.status !== 401 || !body?.soft_logout || !session?.oauth?.refreshToken) return { res, body };
  const refreshed = await ensureFreshToken(true);
  if (refreshed === "ok") return retry();
  if (refreshed === "fatal") {
    logOutExpired("Your session expired — please sign in again.");
    throw new Error("Your session expired — please sign in again.");
  }
  warn(`soft-logout during ${action}, but token refresh is transiently unavailable`);
  return { res, body };
}

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
    .map(([roomId, r]) => {
      const last = r.msgs.length ? r.msgs[r.msgs.length - 1] : null;
      return {
        roomId,
        name: roomName(r, roomId),
        encrypted: !!r.encrypted,
        unread: r.unread || 0,
        lastTs: r.lastTs || 0,
        lastPreview: last ? last.body.slice(0, 80) : "",
        lastSender: last ? last.sender : "",
        lastMine: last ? !!last.mine : false,
      };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

// ─── sync processing ──────────────────────────────────────────────────────

function ensureRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) { r = { name: "", alias: "", encrypted: false, encInfo: null, historyVisibility: "shared", unread: 0, msgs: [], lastTs: 0, lastEventId: null, lastReadEventId: null, seen: new Set(), utdEvents: new Map() }; rooms.set(roomId, r); }
  return r;
}

function applyState(r, ev) {
  if (ev.type === "m.room.name") r.name = ev.content?.name || r.name;
  else if (ev.type === "m.room.canonical_alias") r.alias = ev.content?.alias || r.alias;
  else if (ev.type === "m.room.encryption") { r.encrypted = true; r.encInfo = ev.content || r.encInfo || {}; }
  else if (ev.type === "m.room.history_visibility") r.historyVisibility = ev.content?.history_visibility || r.historyVisibility;
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

// Build a timeline message from a decrypted event. The envelope (event_id,
// sender, timestamp) comes from the outer m.room.encrypted event; the body
// comes from the decrypted `{ type, content }`.
function toMsgFromDecrypted(outerEv, clear) {
  return {
    eventId: outerEv.event_id,
    sender: outerEv.sender,
    body: messageBody(clear),
    ts: outerEv.origin_server_ts || 0,
    mine: outerEv.sender === session?.userId,
  };
}

// Placeholder for an event we couldn't decrypt (no room key — almost always
// history sent before this device logged in). `utd` lets the renderer style it.
function utdMsg(outerEv) {
  return {
    eventId: outerEv.event_id,
    sender: outerEv.sender,
    body: "🔒 unable to decrypt",
    ts: outerEv.origin_server_ts || 0,
    mine: outerEv.sender === session?.userId,
    utd: true,
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

// ─── relations: replies, edits, reactions ──────────────────────────────────
// A message can carry an `m.relates_to`. We surface three kinds:
//   • m.in_reply_to → the renderer shows a quoted line for the parent.
//   • m.replace (edit) → we rewrite the target message's body in place.
//   • m.annotation (reaction) → we aggregate emoji counts per target.
// In encrypted rooms the relation rides UNENCRYPTED on the outer event (so the
// server can aggregate), while new_content/body stay encrypted — callers pass
// the already-resolved relation + content here.

function ensureReactions(r) {
  if (!r.reactions) { r.reactions = new Map(); r.reactionEvents = new Map(); r.myReactions = new Map(); }
}

// Apply an edit (m.replace) to the target message in place. Ignores edits older
// than one already applied. Returns the updated message so it can be
// re-broadcast (the renderer replaces by eventId).
//
// editorSender MUST equal the original message's sender: an m.replace is only
// authoritative when authored by the same user. The homeserver does not enforce
// this, so without the check any room member could target another user's
// event_id and rewrite what that user appears to have said (it renders under the
// victim's name/avatar). `m.sender` is the cryptographically-bound outer-event
// sender, so this is safe in E2EE rooms too. Mirrors Element's behaviour.
function applyEdit(r, targetId, newContent, ts, editorSender) {
  const m = r.msgs.find((x) => x.eventId === targetId);
  if (!m) return null;
  if (editorSender && m.sender && editorSender !== m.sender) return null;
  const body = newContent && typeof newContent.body === "string" ? newContent.body : null;
  if (body == null) return null;
  if (m.editTs && ts < m.editTs) return null;
  m.body = newContent.msgtype === "m.emote" ? `* ${body}` : body;
  m.edited = true;
  m.editTs = ts;
  return m;
}

function addReaction(r, reactionEventId, targetId, key, sender) {
  ensureReactions(r);
  if (!reactionEventId || r.reactionEvents.has(reactionEventId)) return false;
  r.reactionEvents.set(reactionEventId, { targetId, key, sender });
  let byKey = r.reactions.get(targetId);
  if (!byKey) { byKey = new Map(); r.reactions.set(targetId, byKey); }
  let users = byKey.get(key);
  if (!users) { users = new Set(); byKey.set(key, users); }
  users.add(sender);
  if (sender === session?.userId) {
    let mine = r.myReactions.get(targetId);
    if (!mine) { mine = new Map(); r.myReactions.set(targetId, mine); }
    mine.set(key, reactionEventId);
  }
  return true;
}

function removeReaction(r, reactionEventId) {
  ensureReactions(r);
  const info = r.reactionEvents.get(reactionEventId);
  if (!info) return false;
  r.reactionEvents.delete(reactionEventId);
  const byKey = r.reactions.get(info.targetId);
  if (byKey) {
    const users = byKey.get(info.key);
    if (users) { users.delete(info.sender); if (!users.size) byKey.delete(info.key); }
    if (!byKey.size) r.reactions.delete(info.targetId);
  }
  if (info.sender === session?.userId) {
    const mine = r.myReactions.get(info.targetId);
    if (mine) { mine.delete(info.key); if (!mine.size) r.myReactions.delete(info.targetId); }
  }
  return true;
}

// { [targetEventId]: [{ key, count, mine }] } for the renderer.
function reactionsForRoom(r) {
  ensureReactions(r);
  const out = {};
  for (const [targetId, byKey] of r.reactions) {
    const list = [...byKey.entries()]
      .map(([key, users]) => ({ key, count: users.size, mine: users.has(session?.userId) }))
      .filter((x) => x.count > 0);
    if (list.length) out[targetId] = list;
  }
  return out;
}

// Pull the `m.relates_to` off an event (outer content for encrypted, plain
// content otherwise) into a normalized shape.
function relationOf(content) {
  const rel = content && content["m.relates_to"];
  if (!rel || typeof rel !== "object") return null;
  if (rel.rel_type === "m.replace" && rel.event_id) return { kind: "edit", target: rel.event_id };
  if (rel.rel_type === "m.annotation" && rel.event_id && typeof rel.key === "string") return { kind: "reaction", target: rel.event_id, key: rel.key };
  const replyId = rel["m.in_reply_to"] && rel["m.in_reply_to"].event_id;
  if (replyId) return { kind: "reply", target: replyId };
  return null;
}

async function processSync(data, initial) {
  const joined = data.rooms?.join || {};
  let roomsChanged = false;
  for (const [roomId, room] of Object.entries(joined)) {
    const r = ensureRoom(roomId);
    for (const ev of room.state?.events || []) applyState(r, ev);
    const fresh = [];
    let reactionsChanged = false;
    for (const ev of room.timeline?.events || []) {
      if (ev.type === "m.room.encryption" || ev.type === "m.room.name" || ev.type === "m.room.canonical_alias" || ev.type === "m.room.history_visibility") { applyState(r, ev); continue; }
      // Reactions ride unencrypted even in E2EE rooms; aggregate them.
      if (ev.type === "m.reaction") {
        const rel = relationOf(ev.content);
        if (rel?.kind === "reaction" && addReaction(r, ev.event_id, rel.target, rel.key, ev.sender)) reactionsChanged = true;
        continue;
      }
      // Redaction removes a reaction (un-react) — message redaction is left as-is.
      if (ev.type === "m.room.redaction") {
        const target = ev.redacts || ev.content?.redacts;
        if (target && removeReaction(r, target)) reactionsChanged = true;
        continue;
      }
      if (ev.type === "m.room.encrypted") {
        r.encrypted = true;
        // The relation (reply/edit) is on the OUTER, unencrypted event.
        const rel = relationOf(ev.content);
        let msg = null;
        if (mxcrypto.isReady()) {
          try {
            const clear = await mxcrypto.decryptEvent(ev, roomId);
            if (clear && clear.type === "m.room.message") {
              if (rel?.kind === "edit") {
                const edited = applyEdit(r, rel.target, clear.content?.["m.new_content"], ev.origin_server_ts || 0, ev.sender);
                if (edited) fresh.push(edited);
                continue;
              }
              msg = toMsgFromDecrypted(ev, clear);
              if (rel?.kind === "reply") msg.replyToId = rel.target;
            } else if (clear && clear.type === "m.reaction") {
              const crel = relationOf(clear.content);
              if (crel?.kind === "reaction" && addReaction(r, ev.event_id, crel.target, crel.key, ev.sender)) reactionsChanged = true;
              continue;
            }
          } catch {
            msg = utdMsg(ev);
            if (!initial) rememberUtd(r, ev);   // retry live key/message races; skip the backlog
          }
        } else {
          msg = utdMsg(ev);
        }
        if (msg && addMessage(r, msg)) fresh.push(msg);
        continue;
      }
      if (ev.type === "m.room.message") {
        const rel = relationOf(ev.content);
        if (rel?.kind === "edit") {
          const edited = applyEdit(r, rel.target, ev.content?.["m.new_content"], ev.origin_server_ts || 0, ev.sender);
          if (edited) fresh.push(edited);
          continue;
        }
        const msg = toMsg(ev);
        if (rel?.kind === "reply") msg.replyToId = rel.target;
        if (addMessage(r, msg)) fresh.push(msg);
      }
    }
    if (reactionsChanged) broadcast("matrix:reactions", { roomId, reactions: reactionsForRoom(r) });
    // Track the newest event in the room (any type) so markRead can place a
    // read receipt at the tip of the timeline. Timeline batches are oldest →
    // newest, so the last event with an id is the most recent.
    const tl = room.timeline?.events || [];
    for (let i = tl.length - 1; i >= 0; i--) {
      if (tl[i]?.event_id) { r.lastEventId = tl[i].event_id; break; }
    }
    if (room.unread_notifications) r.unread = room.unread_notifications.notification_count || 0;
    // Local read state wins over a lagging server count. The homeserver's
    // notification_count doesn't drop the instant we send a receipt (and some
    // setups never reflect our own receipt back), which made the badge snap
    // straight back to its old value after a click. If we've marked this room
    // read up to its newest event, hold it at zero; a genuinely newer message
    // moves lastEventId past lastReadEventId, so it counts again.
    if (r.lastReadEventId && r.lastReadEventId === r.lastEventId) r.unread = 0;
    if (fresh.length) broadcast("matrix:messages", { roomId, messages: fresh });
    roomsChanged = true;
  }
  // Rooms we've left this sync — drop them from the list.
  for (const roomId of Object.keys(data.rooms?.leave || {})) {
    if (rooms.delete(roomId)) roomsChanged = true;
  }
  if (roomsChanged) broadcast("matrix:rooms", roomSummaries());
}

// ─── matrix.org OAuth device login + token refresh ──────────────────────────
// matrix.org delegates auth to MAS (OAuth2). We sign in with the device-code
// "approve on your phone" grant — no password touches the app — and its access
// tokens are short-lived (~5 min), so we refresh them transparently. The
// reusable OAuth client_id is persisted so we register only once.
function oauthClientFile() { return path.join(app.getPath("userData"), "matrix-oauth-client.json"); }
// `full:true` marks a client registered with BOTH the device grant and
// authorization_code, so an older device-only client is re-registered before
// the browser flow uses it.
function loadOAuthClient() {
  try { const c = JSON.parse(fs.readFileSync(oauthClientFile(), "utf8")); return (c.clientId && c.full) ? c.clientId : null; } catch { return null; }
}
function saveOAuthClient(clientId) {
  try { fs.writeFileSync(oauthClientFile(), JSON.stringify({ clientId, full: true }), { mode: 0o600 }); } catch (e) { warn(`oauth client write failed: ${e.message}`); }
}
async function ensureOAuthClient(disc) {
  let clientId = loadOAuthClient();
  if (!clientId) {
    clientId = await oauth.registerClient({ registrationEndpoint: disc.registrationEndpoint, clientName: "Shape Rotator OS", clientUri: "https://github.com/dmarzzz/shape-rotator-os" });
    saveOAuthClient(clientId);
  }
  return clientId;
}

// Establish a matrix.org session from freshly-granted OAuth tokens (shared by
// the device-code and browser flows): persist, whoami for the user id, sync.
async function establishOAuthSession(disc, deviceId, tok, clientId) {
  stopSync(); rooms.clear(); since = null;
  const sess = {
    homeserver: disc.homeserver, userId: null, deviceId,
    oauth: { clientId, tokenEndpoint: disc.tokenEndpoint, refreshToken: tok.refreshToken, expiresAt: Date.now() + (tok.expiresIn || 300) * 1000 },
  };
  saveSession(sess, tok.accessToken);   // resets crypto for the new device
  // whoami is REQUIRED, not best-effort: the OlmMachine and "is this my message?"
  // both key off a real user id. Persisting userId:null would silently break
  // crypto for the entire session, so a transient failure here fails the login
  // (retry once) rather than establishing a half-session.
  let gotUser = false;
  for (let attempt = 0; attempt < 2 && !gotUser; attempt++) {
    try {
      const who = await fetch(disc.homeserver + "/_matrix/client/v3/account/whoami", { headers: { Authorization: `Bearer ${tok.accessToken}` } });
      const wb = await who.json().catch(() => ({}));
      if (wb.user_id) { session.userId = wb.user_id; gotUser = true; }
      if (wb.device_id) session.deviceId = wb.device_id;
    } catch {}
  }
  if (!gotUser) {
    clearSession();
    setState("logged_out", "Couldn't confirm your matrix.org account — please sign in again.");
    return { ok: false, error: "couldn't confirm account (whoami failed)" };
  }
  persistSession();
  log(`matrix.org sign-in complete for ${session.userId}`);
  startSync();
  return { ok: true, userId: session.userId };
}

let refreshing = null;
// Returns "ok" | "fatal" | "transient".
async function doRefresh() {
  try {
    const r = await oauth.refresh({ tokenEndpoint: session.oauth.tokenEndpoint, clientId: session.oauth.clientId, refreshToken: session.oauth.refreshToken });
    if (r.ok) {
      token = r.accessToken;
      session.oauth.refreshToken = r.refreshToken;   // MAS rotates it — must persist the new one
      session.oauth.expiresAt = Date.now() + (r.expiresIn || 300) * 1000;
      persistSession();
      return "ok";
    }
    warn(`token refresh ${r.fatal ? "rejected — session expired" : "failed transiently"}: ${r.error}`);
    return r.fatal ? "fatal" : "transient";
  } catch (e) { warn(`token refresh error: ${e.message}`); return "transient"; }
  finally { refreshing = null; }
}

// Keep an OAuth access token valid: refresh when within 90s of expiry, or when
// forced after a soft-logout 401. Single-flight. Returns "ok" | "fatal" |
// "transient" ("ok" for long-lived password-login sessions against the
// cohort server, which never refresh).
async function ensureFreshToken(force = false) {
  if (!session?.oauth?.refreshToken) return "ok";
  if (!force && Date.now() < (session.oauth.expiresAt || 0) - 90000) return "ok";
  if (!refreshing) refreshing = doRefresh();
  return refreshing;
}

let deviceCancel = false;
function cancelDevice() { deviceCancel = true; }

// "Approve on your phone" sign-in against matrix.org (OAuth device grant). Shows
// the user a short code + URL, then polls until they approve on another device.
async function loginMatrixOrg() {
  deviceCancel = false;
  setState("connecting");
  try {
    const disc = await oauth.discover("matrix.org");
    const clientId = await ensureOAuthClient(disc);
    const deviceId = oauth.newDeviceId();
    const da = await oauth.startDeviceAuthorization({ deviceAuthorizationEndpoint: disc.deviceAuthorizationEndpoint, clientId, deviceId });
    broadcast("matrix:device-code", { userCode: da.userCode, verificationUri: da.verificationUri, expiresIn: da.expiresIn });
    const result = await oauth.pollForToken({ tokenEndpoint: disc.tokenEndpoint, clientId, deviceCode: da.deviceCode, interval: da.interval, expiresIn: da.expiresIn, isCancelled: () => deviceCancel });
    if (result.cancelled) { setState("logged_out"); return { ok: false, error: "cancelled" }; }
    if (result.denied) { setState("logged_out"); return { ok: false, error: "sign-in was declined" }; }
    if (result.expired) { setState("logged_out"); return { ok: false, error: "the code expired — start again" }; }
    if (result.error) { setState("logged_out", result.error); return { ok: false, error: result.error }; }
    return await establishOAuthSession(disc, deviceId, result, clientId);
  } catch (e) {
    setState("logged_out", e.message);
    return { ok: false, error: e.message };
  }
}

// Loopback HTTP server that catches the OAuth redirect on 127.0.0.1:<ephemeral>.
// Resolves with the authorization code once the browser redirects back.
function startLoopback(expectedState) {
  return new Promise((resolve, reject) => {
    let settle;
    const codePromise = new Promise((res, rej) => { settle = { res, rej }; });
    const srv = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); res.end(); return; }
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><body style='font-family:system-ui;text-align:center;padding-top:48px;color:#333'>Signed in. You can close this tab and return to Shape Rotator OS.</body>");
      const err = u.searchParams.get("error");
      const st = u.searchParams.get("state");
      const code = u.searchParams.get("code");
      if (err) settle.rej(new Error(err));
      else if (st !== expectedState) settle.rej(new Error("state mismatch — please try again"));
      else if (code) settle.res(code);
      else settle.rej(new Error("no code returned"));
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      const to = setTimeout(() => settle.rej(new Error("timed out waiting for sign-in")), 5 * 60 * 1000);
      const close = () => { clearTimeout(to); try { srv.close(); } catch {} };
      // Reject the pending wait so the renderer's Cancel tears the flow down
      // immediately (otherwise the await hangs to the 5-min timeout and then
      // paints a phantom "timed out" over whatever the user moved on to).
      const cancel = (reason) => { settle.rej(new Error(reason || "cancelled")); };
      codePromise.then(close, close);
      resolve({ port, codePromise, close, cancel });
    });
  });
}

// Cancel handle for the in-flight matrix.org browser flow, so the renderer's
// Cancel button aborts the main-process loopback instead of leaking it for 5
// minutes (and then painting a phantom error).
let mxorgBrowserCancel = null;
function cancelMatrixOrgBrowser() { try { mxorgBrowserCancel?.("cancelled"); } catch {} }

// OAuth in the user's own browser (authorization_code + PKCE). Password — if the
// browser even needs one — goes to matrix.org's page, never the app.
async function loginMatrixOrgBrowser() {
  setState("connecting");
  let close = null;
  try {
    const disc = await oauth.discover("matrix.org");
    if (!disc.authorizationEndpoint) throw new Error("server has no authorization endpoint");
    const clientId = await ensureOAuthClient(disc);
    const deviceId = oauth.newDeviceId();
    const { verifier, challenge } = oauth.pkce();
    const state = oauth.randomState();
    const lo = await startLoopback(state);
    close = lo.close;
    mxorgBrowserCancel = lo.cancel;
    const redirectUri = `http://127.0.0.1:${lo.port}/callback`;
    const authUrl = oauth.buildAuthorizationUrl({ authorizationEndpoint: disc.authorizationEndpoint, clientId, redirectUri, deviceId, codeChallenge: challenge, state });
    shell.openExternal(authUrl);
    const code = await lo.codePromise;
    const tok = await oauth.exchangeCode({ tokenEndpoint: disc.tokenEndpoint, clientId, code, redirectUri, codeVerifier: verifier });
    return await establishOAuthSession(disc, deviceId, tok, clientId);
  } catch (e) {
    // A user-driven cancel must not leave an error on the gate (it would render
    // as a "please sign in again" reauth notice over a fresh gate).
    if (e.message === "cancelled") { setState("logged_out"); return { ok: false, error: "cancelled" }; }
    setState("logged_out", e.message);
    return { ok: false, error: e.message };
  } finally {
    mxorgBrowserCancel = null;
    try { close?.(); } catch {}
  }
}

// ── decryption retry ─────────────────────────────────────────────────────────
// A room key sometimes lands a sync or two after the message it unlocks (the
// sender shares it as a separate to-device step). We keep a small set of recent
// undecryptable LIVE events and re-attempt them each sync until the key arrives
// or we give up. Backlog UTDs (pre-login) are never stored — we have no key for
// them and never will without key-backup.
const MAX_UTD_RETRY = 50;        // most-recent live UTDs kept per room
const MAX_UTD_TRIES = 12;        // attempts before we accept the key isn't coming

function rememberUtd(r, ev) {
  if (!ev.event_id || r.utdEvents.has(ev.event_id)) return;
  r.utdEvents.set(ev.event_id, { ev, tries: 0 });
  while (r.utdEvents.size > MAX_UTD_RETRY) r.utdEvents.delete(r.utdEvents.keys().next().value);
}

async function retryDecryptions() {
  if (!mxcrypto.isReady()) return;
  let listChanged = false;
  for (const [roomId, r] of rooms) {
    if (!r.utdEvents?.size) continue;
    const resolved = [];
    for (const [eventId, rec] of [...r.utdEvents]) {
      try {
        const clear = await mxcrypto.decryptEvent(rec.ev, roomId);
        const idx = r.msgs.findIndex((m) => m.eventId === eventId);
        if (clear && clear.type === "m.room.message") {
          const upgraded = toMsgFromDecrypted(rec.ev, clear);
          if (idx >= 0) r.msgs[idx] = upgraded;
          resolved.push(upgraded);
        } else if (idx >= 0) {
          r.msgs.splice(idx, 1);   // decrypted to a non-message — drop the placeholder
        }
        r.utdEvents.delete(eventId);
      } catch {
        if (++rec.tries >= MAX_UTD_TRIES) r.utdEvents.delete(eventId);
      }
    }
    if (resolved.length) { broadcast("matrix:messages", { roomId, messages: resolved }); listChanged = true; }
  }
  if (listChanged) broadcast("matrix:rooms", roomSummaries());
}

// Clean session teardown when a session genuinely can't be recovered (refresh
// token dead / token revoked). Surfaces a reason the gate shows, so it never
// feels like a silent logout.
function logOutExpired(reason) {
  clearSession();
  running = false;
  setState("logged_out", reason || "Your session expired — please sign in again.");
  broadcast("matrix:rooms", []);
}

// ─── sync loop ──────────────────────────────────────────────────────────────

async function syncLoop() {
  let backoff = 1000;
  if ((await ensureFreshToken()) === "fatal") { logOutExpired(); return; }   // expired OAuth token from a prior session
  await ensureCrypto();       // ready before the first snapshot so live messages decrypt
  while (running) {
    abort = new AbortController();
    try {
      if ((await ensureFreshToken()) === "fatal") { logOutExpired(); return; }
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
        const eb = await res.json().catch(() => ({}));
        // OAuth soft-logout = the access token just expired — try to refresh.
        if (session?.oauth?.refreshToken && eb.soft_logout) {
          const r = await ensureFreshToken(true);
          if (r === "ok") { backoff = 1000; continue; }                       // refreshed → retry
          if (r === "transient") throw new Error("token refresh unavailable");  // network hiccup → back off, NOT a logout
          // r === "fatal" → refresh token genuinely dead; fall through to logout
        }
        warn("access token rejected (401) — logging out");
        logOutExpired("Your session expired — please sign in again.");
        return;
      }
      if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
      const data = await res.json();
      const initial = !since;
      since = data.next_batch;
      // Feed the crypto engine first (to-device carries the room keys), so the
      // timeline events in this same response can be decrypted below.
      if (mxcrypto.isReady()) {
        await mxcrypto.onSyncChanges({
          toDevice: data.to_device?.events,
          changed: data.device_lists?.changed,
          left: data.device_lists?.left,
          otkCounts: data.device_one_time_keys_count,
          fallbackKeys: data.device_unused_fallback_key_types,
        });
      }
      await processSync(data, initial);
      await retryDecryptions();   // unlock any live messages whose key just arrived
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
    cryptoReady: mxcrypto.isReady(),
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
    if (!res.ok) warn(`getFlows: ${hs} returned HTTP ${res.status}`);
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}`, flows: Array.isArray(data.flows) ? data.flows : [] };
  } catch (e) {
    warn(`getFlows: cannot reach ${hs} — ${e.message}`);
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
  if (!r) return { roomId, encrypted: false, cryptoReady: mxcrypto.isReady(), messages: [], reactions: {} };
  return { roomId, name: roomName(r, roomId), encrypted: !!r.encrypted, cryptoReady: mxcrypto.isReady(), messages: r.msgs.slice(), reactions: reactionsForRoom(r) };
}

async function getJoinedMembers(roomId) {
  const url = `${hsBase()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`;
  await ensureFreshTokenFor("encrypted send");
  const doFetch = async () => {
    const res = await fetch(url, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  };
  const first = await doFetch();
  const { res, body } = await retrySoftLogoutOnce(first.res, first.body, doFetch, "encrypted member lookup");
  if (!res.ok) throw new Error(body.error || body.errcode || `couldn't read room members (HTTP ${res.status})`);
  if (!body.joined || typeof body.joined !== "object" || Array.isArray(body.joined)) {
    throw new Error("homeserver did not return joined room members");
  }
  const members = Object.keys(body.joined);
  if (session?.userId && !members.includes(session.userId)) members.push(session.userId);
  if (!members.length) throw new Error("homeserver returned no joined room members");
  return members;
}

// PUT one event into a room and return { ok, eventId }.
async function rawSend(roomId, eventType, content) {
  const txnId = `srwk-${Date.now()}-${txn++}`;
  const url = `${hsBase()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${encodeURIComponent(txnId)}`;
  const res = await fetch(url, { method: "PUT", headers: authHeaders(), body: JSON.stringify(content) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.event_id) return { ok: false, error: data.error || `send failed (HTTP ${res.status})` };
  return { ok: true, eventId: data.event_id };
}

// Wrap message content for the room: encrypt in E2EE rooms (Megolm shared to
// every member device first), plain otherwise. `relatesTo`, when given, is
// attached UNENCRYPTED to the outer event so the server can aggregate the
// relation (reply/edit) without decrypting — per the spec for encrypted rooms.
async function buildMessage(roomId, r, content, relatesTo) {
  if (!r?.encrypted) {
    if (relatesTo) content["m.relates_to"] = relatesTo;
    return { eventType: "m.room.message", payload: content };
  }
  if (!mxcrypto.isReady()) throw new Error("encryption isn't ready yet — try again in a moment");
  const members = await getJoinedMembers(roomId);
  const payload = await mxcrypto.encryptForRoom({
    roomId, members, encInfo: r.encInfo, historyVisibility: r.historyVisibility,
    eventType: "m.room.message", content,
  });
  if (relatesTo) payload["m.relates_to"] = relatesTo;
  return { eventType: "m.room.encrypted", payload };
}

async function send(roomId, body, opts = {}) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  try {
    await ensureFreshTokenFor("send");
    const r = rooms.get(roomId);
    const text = String(body || "").trim();
    if (!text) return { ok: false, error: "empty message" };
    const content = { msgtype: "m.text", body: text };
    const relatesTo = opts.replyTo ? { "m.in_reply_to": { event_id: opts.replyTo } } : null;
    const { eventType, payload } = await buildMessage(roomId, r, content, relatesTo);
    return await rawSend(roomId, eventType, payload);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Edit one of our own messages (m.replace). new_content stays encrypted; the
// m.replace relation rides on the outer event (see buildMessage).
async function editMessage(roomId, eventId, body) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  try {
    await ensureFreshTokenFor("edit");
    const r = rooms.get(roomId);
    const text = String(body || "").trim();
    if (!text) return { ok: false, error: "empty message" };
    if (!eventId) return { ok: false, error: "no target" };
    const content = { msgtype: "m.text", body: `* ${text}`, "m.new_content": { msgtype: "m.text", body: text } };
    const { eventType, payload } = await buildMessage(roomId, r, content, { rel_type: "m.replace", event_id: eventId });
    return await rawSend(roomId, eventType, payload);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Toggle a reaction. Reactions are sent unencrypted (standard, so servers can
// aggregate). If we've already reacted with this key, redact ours instead.
async function react(roomId, eventId, key) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  if (!eventId || !key) return { ok: false, error: "bad reaction" };
  // Wrap like every other outbound path: a network-layer fetch rejection would
  // otherwise reject the IPC invoke (renderer unhandledrejection) instead of
  // returning the uniform { ok, error } shape callers expect.
  try {
    await ensureFreshTokenFor("reaction");
    const r = rooms.get(roomId);
    const existing = r?.myReactions?.get(eventId)?.get(key);
    if (existing) return redactEvent(roomId, existing);
    return await rawSend(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function redactEvent(roomId, eventId) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  const txnId = `srwk-${Date.now()}-${txn++}`;
  const url = `${hsBase()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`;
  try {
    await ensureFreshTokenFor("redact");
    const res = await fetch(url, { method: "PUT", headers: authHeaders(), body: JSON.stringify({}) });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return { ok: false, error: d.error || `redact failed (HTTP ${res.status})` }; }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Mark a room read up to its newest event — sends the read marker + receipt so
// the homeserver zeroes its notification_count (the source of the unread
// badge). The app otherwise never tells the server we've read anything, so the
// count only ever grows; calling this when the user opens a channel is what
// makes the badge clear while they're reading it. Optimistically clears the
// local count + rebroadcasts so the UI updates immediately, before the receipt
// round-trips. De-dupes on lastReadEventId so re-selecting a room or a burst of
// messages in the active room doesn't spam the homeserver.
async function markRead(roomId) {
  if (!token || !session) return { ok: false, error: "not signed in" };
  const r = rooms.get(roomId);
  if (!r) return { ok: false, error: "unknown room" };
  const eventId = r.lastEventId || (r.msgs.length ? r.msgs[r.msgs.length - 1].eventId : null);
  if (!eventId) return { ok: true, skipped: "no event" };
  if (eventId === r.lastReadEventId && !r.unread) return { ok: true, skipped: "already read" };
  try {
    await ensureFreshTokenFor("read receipt");
    r.lastReadEventId = eventId;
    if (r.unread) { r.unread = 0; broadcast("matrix:rooms", roomSummaries()); }
    const url = `${hsBase()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`;
    const res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ "m.fully_read": eventId, "m.read": eventId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || `read marker failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Resolve an mxc:// avatar to a data: URL the renderer can drop straight into an
// <img>/background. Media on modern homeservers is authenticated (a Bearer
// token an <img src> can't send), so we fetch the thumbnail here with the token
// and hand back base64. Cached by uri+size; the authenticated media route is
// tried first, with the legacy unauthenticated route as a fallback for older
// servers. Returns { ok, dataUrl } — failures are soft (renderer keeps the
// initial-letter circle).
function parseMxc(mxc) {
  const m = /^mxc:\/\/([^/]+)\/([^?]+)/.exec(String(mxc || ""));
  return m ? { server: m[1], id: m[2] } : null;
}

async function fetchThumbnail(mxc, size) {
  const p = parseMxc(mxc);
  if (!p) return "";
  const q = `width=${size}&height=${size}&method=crop`;
  const urls = [
    `${hsBase()}/_matrix/client/v1/media/thumbnail/${p.server}/${encodeURIComponent(p.id)}?${q}`,
    `${hsBase()}/_matrix/media/v3/thumbnail/${p.server}/${encodeURIComponent(p.id)}?${q}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      const ct = res.headers.get("content-type") || "image/png";
      return `data:${ct};base64,${buf.toString("base64")}`;
    } catch { /* try the next route */ }
  }
  return "";
}

// Resolve a user's profile picture to a data: URL. Keyed by user id (not mxc):
// the renderer only knows the sender, and a user's avatar_url isn't reliably in
// the lazily-loaded room membership, whereas /profile returns it for any user
// (federated included). Cached by user+size, including misses ("" = no picture)
// so users without one aren't re-fetched every render.
async function getAvatar(userId, size = 48) {
  if (!token || !session || !userId) return { ok: false };
  const key = `${userId}|${size}`;
  if (avatarCache.has(key)) {
    const v = avatarCache.get(key);
    return v ? { ok: true, dataUrl: v } : { ok: false };
  }
  try {
    await ensureFreshToken();
    const pres = await fetch(`${hsBase()}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!pres.ok) {
      // Only negative-cache a DEFINITIVE answer. 404/403 = no such user / forbidden
      // → cache the miss. 429/5xx are transient (rate-limit, federated /profile
      // blip) → don't cache, so the next render retries instead of being stuck on
      // the initial-letter fallback for the whole session.
      if (pres.status === 404 || pres.status === 403) avatarCache.set(key, "");
      return { ok: false };
    }
    const prof = await pres.json().catch(() => ({}));
    if (!prof.avatar_url) { avatarCache.set(key, ""); return { ok: false }; }  // real miss: user has no picture
    const dataUrl = await fetchThumbnail(prof.avatar_url, size);
    if (dataUrl) { avatarCache.set(key, dataUrl); return { ok: true, dataUrl }; }
    return { ok: false };   // avatar_url present but thumbnail fetch transiently failed → don't cache, allow retry
  } catch {
    return { ok: false };   // transient (token refresh / network) — don't cache, allow retry
  }
}

function start(electronApp) {
  app = electronApp;
  migrateOffSafeStorage();
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
  getStatus, getFlows, login, loginSSO, loginViaDevice, loginWithCode, cancelSSO, logout,
  loginMatrixOrg, loginMatrixOrgBrowser, cancelDevice, cancelMatrixOrgBrowser,
  getRooms, getMessages, send, markRead, getAvatar, react, editMessage, redactEvent,
};
