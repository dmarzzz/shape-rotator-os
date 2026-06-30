// matrix-crypto.js — Olm/Megolm engine for the cohort Matrix client.
//
// Thin wrapper around @matrix-org/matrix-sdk-crypto-nodejs (the Rust
// `OlmMachine`, the same crypto Element uses). It runs in the Electron MAIN
// process next to the sync loop in matrix.js. The crypto store is a real
// on-disk SQLite database under userData, so device keys / Olm sessions /
// inbound room keys survive restarts (a stable device_id is required — see
// matrix.js, which reuses the persisted session device).
//
// This module owns NO HTTP. matrix.js hands us an `http(method, path, body)`
// callback (its authed net.fetch) at init; we hand it the requests the
// OlmMachine wants sent and feed the responses back in. All machine mutations
// are serialised through a single promise-chain lock, per the rust-sdk
// guidance (never drive `outgoingRequests` / `shareRoomKey` concurrently).
//
// SCOPE (v1): decrypt incoming + encrypt outgoing for CURRENT messages.
// Cross-signing, device verification, and key backup are deferred — so history
// from before this device logged in stays "unable to decrypt" (expected, it's
// a Matrix property, not a bug). Sharing room keys to unverified devices is ON
// (onlyAllowTrustedDevices = false) so Element peers can read what we send.

let B = null;                    // the native bindings, lazily required
let machine = null;              // the OlmMachine instance (null until init)
let httpFn = null;               // (method, path, bodyObj) => { status, body }
let selfUserId = null;

function warn(msg) { try { process.stderr.write(`[matrix-crypto:warn] ${msg}\n`); } catch {} }
function log(msg) { try { process.stderr.write(`[matrix-crypto:log] ${msg}\n`); } catch {} }

// ── serialise every machine operation through one chain ──────────────────────
// The OlmMachine store is transactional, but the protocol requires that request
// draining and key sharing never interleave. A single mutex keeps it correct
// and is simpler to reason about than per-op locks.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});   // never let a rejection poison the chain
  return run;
}

function mapHistoryVisibility(s) {
  switch (s) {
    case "invited": return B.HistoryVisibility.Invited;
    case "joined": return B.HistoryVisibility.Joined;
    case "world_readable": return B.HistoryVisibility.WorldReadable;
    case "shared":
    default: return B.HistoryVisibility.Shared;
  }
}

// Create or load the machine. Throws if the native module is unavailable or the
// store can't be opened; the caller (matrix.js) catches and degrades to
// "encrypted rooms stay locked" so the rest of the client keeps working.
async function init({ userId, deviceId, storePath, passphrase, http }) {
  if (machine) return true;
  if (!userId || !deviceId) throw new Error("crypto needs a stable userId + deviceId");
  B = require("@matrix-org/matrix-sdk-crypto-nodejs");
  httpFn = http;
  selfUserId = userId;
  machine = await B.OlmMachine.initialize(
    new B.UserId(userId),
    new B.DeviceId(deviceId),
    storePath,
    passphrase || "",
    B.StoreType.Sqlite,
  );
  log(`OlmMachine ready for ${userId} / ${deviceId}`);
  // Upload device keys + answer the initial key query right away so the server
  // marks us E2EE-capable and starts sending us room keys.
  await drainOutgoing();
  return true;
}

function isReady() { return !!machine; }

// Execute one outgoing request the machine asked for. Returns true if it was
// marked as sent (got a server response), false if it should be retried.
async function sendOutgoingRequest(req) {
  const RT = B.RequestType;
  let route;
  switch (req.type) {
    case RT.KeysUpload:      route = ["POST", "/_matrix/client/v3/keys/upload"]; break;
    case RT.KeysQuery:       route = ["POST", "/_matrix/client/v3/keys/query"]; break;
    case RT.KeysClaim:       route = ["POST", "/_matrix/client/v3/keys/claim"]; break;
    case RT.SignatureUpload: route = ["POST", "/_matrix/client/v3/keys/signatures/upload"]; break;
    case RT.ToDevice:
      route = ["PUT", `/_matrix/client/v3/sendToDevice/${encodeURIComponent(req.eventType)}/${encodeURIComponent(req.txnId)}`];
      break;
    default:
      return true; // RoomMessage / KeysBackup: not used in v1, drop so we don't loop
  }
  let resp;
  try {
    resp = await httpFn(route[0], route[1], JSON.parse(req.body));
  } catch (e) {
    warn(`request ${req.type} network error: ${e.message} — will retry`);
    return false; // transient: leave unmarked so it's retried next drain
  }
  if (resp.status >= 500) { warn(`request ${req.type} HTTP ${resp.status} — will retry`); return false; }
  await machine.markRequestAsSent(req.id, req.type, JSON.stringify(resp.body || {}));
  return true;
}

// Drain every queued outgoing request. Caller must hold the lock (or be inside
// withLock); drainOutgoing() wraps itself for standalone calls.
async function drainNoLock() {
  if (!machine) return;
  const reqs = await machine.outgoingRequests();
  for (const req of reqs) {
    try { await sendOutgoingRequest(req); }
    catch (e) { warn(`drain ${req.type} failed: ${e.message}`); }
  }
}
function drainOutgoing() { return withLock(drainNoLock); }

// Feed one /sync response's crypto-relevant fields into the machine, then drain
// (uploads one-time keys, answers key queries, processes incoming room keys).
async function onSyncChanges({ toDevice, changed, left, otkCounts, fallbackKeys }) {
  if (!machine) return;
  await withLock(async () => {
    const devices = new B.DeviceLists(
      (changed || []).map((u) => new B.UserId(u)),
      (left || []).map((u) => new B.UserId(u)),
    );
    const processed = await machine.receiveSyncChanges(
      JSON.stringify(toDevice || []),
      devices,
      otkCounts || {},
      fallbackKeys || [],
    );
    // Diagnostic: surface incoming to-device events (room keys arrive this way),
    // so we can tell "key never arrived" from "arrived but decrypt raced". Log
    // ONLY the count + event types — never the bodies: a decrypted m.room_key
    // carries the live Megolm session key, so serialising the event to stderr
    // would leak it into logs/crash reports (truncation doesn't save us; a key
    // fits well under any limit).
    try {
      const evs = JSON.parse(processed || "[]");
      if (Array.isArray(evs) && evs.length) log(`to-device in (${evs.length}): ${evs.map((e) => (e && e.type) || "?").join(",")}`);
    } catch {}
    await drainNoLock();
  });
}

// Decrypt one m.room.encrypted timeline event. Returns the cleartext event
// `{ type, content, ... }`. Throws on UTD (missing room key etc.) — the caller
// renders an "unable to decrypt" placeholder and moves on.
async function decryptEvent(rawEvent, roomId) {
  if (!machine) throw new Error("crypto not ready");
  const d = await machine.decryptRoomEvent(JSON.stringify(rawEvent), new B.RoomId(roomId));
  return JSON.parse(d.event);
}

// Encrypt `content` for an encrypted room and return the m.room.encrypted
// content object to PUT to /send. Establishes Olm sessions and shares the
// Megolm key to all member devices first (idempotent after the first call).
//   members  : array of user-id strings (joined members)
//   encInfo  : the room's m.room.encryption content ({ rotation_period_ms, ... })
//   historyVisibility : the room's m.room.history_visibility string
async function encryptForRoom({ roomId, members, encInfo, historyVisibility, eventType, content }) {
  if (!machine) throw new Error("crypto not ready");
  const users = (members || []).map((u) => new B.UserId(u));
  return withLock(async () => {
    await machine.updateTrackedUsers(users);
    await drainNoLock();                       // flush any /keys/query first
    const claim = await machine.getMissingSessions(users);
    if (claim) {
      const r = await httpFn("POST", "/_matrix/client/v3/keys/claim", JSON.parse(claim.body));
      await machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(r.body || {}));
    }
    const settings = new B.EncryptionSettings();
    settings.algorithm = B.EncryptionAlgorithm.MegolmV1AesSha2;
    settings.onlyAllowTrustedDevices = false;  // share to unverified devices (Element peers)
    settings.historyVisibility = mapHistoryVisibility(historyVisibility);
    if (encInfo && encInfo.rotation_period_ms) settings.rotationPeriod = BigInt(encInfo.rotation_period_ms) * 1000n;
    if (encInfo && encInfo.rotation_period_msgs) settings.rotationPeriodMessages = BigInt(encInfo.rotation_period_msgs);

    for (const req of await machine.shareRoomKey(new B.RoomId(roomId), users, settings)) {
      const r = await httpFn("PUT", `/_matrix/client/v3/sendToDevice/${encodeURIComponent(req.eventType)}/${encodeURIComponent(req.txnId)}`, JSON.parse(req.body));
      await machine.markRequestAsSent(req.id, req.type, JSON.stringify(r.body || {}));
    }
    const encrypted = await machine.encryptRoomEvent(new B.RoomId(roomId), eventType, JSON.stringify(content));
    return JSON.parse(encrypted);
  });
}

function close() {
  try { machine?.close(); } catch (e) { warn(`close: ${e.message}`); }
  machine = null;
  httpFn = null;
  selfUserId = null;
  chain = Promise.resolve();
}

module.exports = { init, isReady, onSyncChanges, decryptEvent, encryptForRoom, close };
