'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Device link: connect two Router apps directly (device-to-device) so one can
// pull the other's Claude/Codex work — recent-work digests AND, on request,
// raw session transcripts. Two transports:
//
//   • Direct (pairing code): newline-delimited JSON over a TCP socket; a shared
//     secret in the pairing code authenticates the peer. Both machines run
//     Router. LAN today; a tunnel can carry it cross-internet later.
//   • SSH: connect to any machine you can already `ssh` into (user@host or an
//     ~/.ssh/config alias) and read its ~/.claude & ~/.codex logs directly —
//     NOTHING needs to run on the other side, and it works across the internet
//     using your existing SSH keys. Key auth only (BatchMode); no passwords.
//
// Per-link permissions gate what the direct-transport host shares.
// ─────────────────────────────────────────────────────────────────────────

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { collectRecent, digestFromRawFiles } = require('./transcripts');
const intro = require('./intro');
const scope = require('./scope');
const { redact } = require('./redact');

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const MAX_RAW_BYTES = 4 * 1024 * 1024; // cap a raw-log transfer

let host = null;    // { server, secret, port, perms, peers:Set, onChange }
let client = null;  // { socket, buf, pending:Map, nextId, connected, info }
let sshPeer = null; // { target } — an authed SSH destination we can read from

// ── helpers ────────────────────────────────────────────────────────────────
function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}
function makeCode(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function parseCode(code) { try { return JSON.parse(Buffer.from(String(code).trim(), 'base64url').toString()); } catch { return null; } }
function send(socket, obj) { try { socket.write(JSON.stringify(obj) + '\n'); } catch { /* dropped */ } }

// Derive the FULL repo path (cwd) a raw .jsonl belongs to, so device-link can
// gate it through the SAME scope allowlist as the daily digest (I3/I4). The
// authoritative source is the `cwd` recorded inside the session itself; we read
// the first JSON line that carries one. Falls back to reconstructing the path
// from Claude's encoded project dir name ("-Users-me-teleport-router" →
// "/Users/me/teleport/router"). Returns '' when no full path can be derived —
// the caller then treats it as unknown, which scope.decide() denies by default.
function repoPathForRawFile(file, content) {
  // 1) Authoritative: a cwd field somewhere in the session content.
  const text = typeof content === 'string' ? content : '';
  // Scan only the first chunk for a cwd to stay cheap on large files.
  const head = text.length > 65536 ? text.slice(0, 65536) : text;
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line || line.indexOf('cwd') < 0) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const cwd = obj.cwd
      || (obj.payload && (obj.payload.cwd || obj.payload.cwd_path))
      || obj.cwd_path;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  // 2) Fallback for Claude: reconstruct from the encoded project dir name.
  // The dir is the parent of the .jsonl when it lives under .claude/projects.
  const parent = path.dirname(file);
  if (parent.startsWith(CLAUDE_PROJECTS)) {
    const dirName = path.basename(parent);
    // Claude encodes the absolute cwd by replacing path separators with '-'
    // (leading '-' included). This is lossy for real '-' in names, but it is a
    // best-effort full-path candidate; scope.decide() still denies it unless a
    // rule/override matches it.
    const decoded = '/' + dirName.replace(/^-+/, '').replace(/-/g, '/');
    return decoded;
  }
  // 3) No derivable full path — unknown repo, denied by default.
  return '';
}

// Gate already-pulled raw files (SSH transport) through the SAME scope
// allowlist the local digest uses (I3/I4): each file's repo FULL path is
// derived from its recorded cwd/encoded dir (repoPathForRawFile) and kept only
// when scope.decide() includes it. Unknown/underivable repos are denied by
// default. This mirrors readRawLogs' :112-114 gate so the SSH recent/today
// digest paths can never fold in an excluded or unknown repo's content.
function gateRawFiles(files) {
  const sc = scope.loadScope();
  return (files || []).filter((f) => {
    const repoPath = repoPathForRawFile(f.path || f.name || '', f.content);
    if (!repoPath) return false; // unknown repo — deny by default
    return scope.decide(repoPath, sc).included;
  });
}

// Recent raw session transcripts (last `days`), capped in total size.
//
// I4: every candidate file is gated through the SAME scope allowlist on its
// repo's FULL path (excluded/unknown repos are never read past the cwd probe
// and never shipped), and its content is run through the SAME deterministic
// redact() before it leaves so device-link can never ship an unredacted secret.
function readRawLogs({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const out = [];
  let total = 0;
  const sc = scope.loadScope();
  const rules = scope.loadRules();
  const add = (file) => {
    if (total >= MAX_RAW_BYTES) return;
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff) return;
      let content = fs.readFileSync(file, 'utf8');
      // I4 gate: drop the file unless its repo's FULL path is in scope.
      const repoPath = repoPathForRawFile(file, content);
      if (!repoPath) return; // unknown repo — deny by default
      if (!scope.decide(repoPath, sc).included) return; // excluded / not allowed
      // I4: redact the raw bytes before they can leave this machine.
      content = redact(content, rules, { source: path.basename(file) }).masked;
      if (total + content.length > MAX_RAW_BYTES) content = content.slice(0, MAX_RAW_BYTES - total) + '\n…(truncated)';
      total += content.length;
      out.push({ source: file.includes('.codex') ? 'codex' : 'claude', name: path.basename(file), content });
    } catch { /* skip */ }
  };
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
      const dir = path.join(CLAUDE_PROJECTS, d);
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) add(path.join(dir, f)); } catch { /* */ }
    }
  } catch { /* */ }
  try {
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) add(p);
    } };
    walk(CODEX_SESSIONS);
  } catch { /* */ }
  return { files: out, totalBytes: total, truncated: total >= MAX_RAW_BYTES };
}

// ── host side: serve this machine's work to an authed peer ──────────────────
function hostInfo() {
  if (!host) return null;
  return {
    running: true, ip: lanIP(), port: host.port,
    code: makeCode({ ip: lanIP(), port: host.port, secret: host.secret }),
    peers: host.peers.size, perms: host.perms,
  };
}

async function handleRequest(socket, msg, perms) {
  const reply = (data) => send(socket, { id: msg.id, ...data });
  try {
    if (msg.type === 'list-projects') {
      // I3/I4: a peer's project list is an egress hop too — gate each discovered
      // project through the SAME deny-by-default scope allowlist used by
      // get-recent/get-raw, keyed on its FULL path, so an excluded/private repo
      // directory name (often the sensitive fact itself) never leaves to a peer.
      // discoverProjects() stays unfiltered for the LOCAL intro UI; we filter
      // only here at the link egress boundary.
      const sc = scope.loadScope();
      const all = await intro.discoverProjects();
      const projects = (all || []).filter((p) => p && p.path && scope.decide(p.path, sc).included);
      return reply({ type: 'projects', projects });
    }
    if (msg.type === 'get-recent') {
      if (!perms.recent) return reply({ type: 'error', error: 'Peer has not allowed recent-work sharing.' });
      // I4: scrub the shared digest through the SAME redact() rules before it
      // leaves this machine to the linked peer.
      const r = await collectRecent(msg.days || 30, scope.loadRules());
      return reply({ type: 'recent', date: r.projects && r.projectCount, projectCount: r.projectCount, projects: r.projects, digest: r.digest });
    }
    if (msg.type === 'get-raw') {
      // I4: raw sharing is OFF unless BOTH the per-link perm AND the persisted
      // raw-share permission are explicitly enabled. perms.raw defaults OFF and
      // scope.rawSharingEnabled() defaults false (perm-raw OFF).
      if (!perms.raw || !scope.rawSharingEnabled()) {
        return reply({ type: 'error', error: 'Peer has not allowed raw-log sharing.' });
      }
      return reply({ type: 'raw', ...readRawLogs({ days: msg.days || 7 }) });
    }
    reply({ type: 'error', error: 'Unknown request: ' + msg.type });
  } catch (e) {
    reply({ type: 'error', error: e.message });
  }
}

function startHost({ perms = { recent: true, raw: false }, onChange } = {}) {
  if (host) return Promise.resolve(hostInfo());
  const secret = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let authed = false, buf = '';
      host.peers.add(socket);
      if (host.onChange) host.onChange(hostInfo());
      socket.on('data', async (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'auth') {
            authed = msg.secret === host.secret;
            send(socket, { id: msg.id, type: 'auth', ok: authed });
            if (!authed) socket.end();
            continue;
          }
          if (!authed) { socket.end(); return; }
          await handleRequest(socket, msg, host.perms);
        }
      });
      const drop = () => { host && host.peers.delete(socket); if (host && host.onChange) host.onChange(hostInfo()); };
      socket.on('error', drop);
      socket.on('close', drop);
    });
    server.on('error', () => { host = null; resolve(null); });
    server.listen(0, () => {
      host = { server, secret, port: server.address().port, perms, peers: new Set(), onChange };
      resolve(hostInfo());
    });
  });
}

function stopHost() {
  if (!host) return;
  try { for (const s of host.peers) s.destroy(); host.server.close(); } catch { /* */ }
  host = null;
}

// ── client side: connect to a peer and request its work ─────────────────────
function dispatch(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && client.pending.has(msg.id)) { client.pending.get(msg.id)(msg); client.pending.delete(msg.id); }
}
function sendReq(type, params = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !client.socket) return reject(new Error('Not connected.'));
    const id = String(client.nextId++);
    client.pending.set(id, resolve);
    send(client.socket, { id, type, ...params });
    setTimeout(() => { if (client && client.pending.has(id)) { client.pending.delete(id); reject(new Error('Peer did not respond.')); } }, 30000);
  });
}

function connectPeer(code) {
  const info = parseCode(code);
  if (!info || !info.ip || !info.port) return Promise.reject(new Error('Invalid link code.'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.port, info.ip, async () => {
      client = { socket, buf: '', pending: new Map(), nextId: 1, connected: false, info };
      try {
        const r = await sendReq('auth', { secret: info.secret });
        if (r.ok) { client.connected = true; resolve({ ok: true, peer: `${info.ip}:${info.port}` }); }
        else { socket.end(); reject(new Error('Authentication failed.')); }
      } catch (e) { reject(e); }
    });
    socket.on('data', (d) => {
      client.buf += d.toString();
      let i;
      while ((i = client.buf.indexOf('\n')) >= 0) { const line = client.buf.slice(0, i); client.buf = client.buf.slice(i + 1); if (line.trim()) dispatch(line); }
    });
    socket.on('error', (e) => { if (client && !client.connected) reject(e); });
    socket.on('close', () => { if (client) client.connected = false; });
  });
}
function disconnectPeer() { if (client && client.socket) { try { client.socket.destroy(); } catch { /* */ } } client = null; }
function peerConnected() { return !!(client && client.connected); }

const peerListProjects = () => sendReq('list-projects');
const peerGetRecent = (days = 30) => sendReq('get-recent', { days });
const peerGetRaw = (days = 7) => sendReq('get-raw', { days });

// ── SSH transport: read a peer's logs over an existing SSH connection ─────────
// No Router runs on the other side; we just `ssh user@host` and read its
// ~/.claude & ~/.codex jsonl. Key auth only (BatchMode) — passwords would hang
// a GUI, so we surface a clear "set up a key" error instead.

// Decode Claude's encoded project dir ("-Users-me-teleport-router" → "teleport-router").
function decodeClaudeDir(dirName) {
  const parts = String(dirName).split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

// Reject anything that isn't a plain ssh destination (block option-injection,
// shell metachars, whitespace). Allows user@host, host, and config aliases,
// with an optional trailing :port.
function validTarget(t) {
  const s = String(t || '').trim();
  if (!s || s.startsWith('-')) return null;
  if (/[\s -]/.test(s)) return null;
  if (/[;&|`$(){}<>"'\\*?!#]/.test(s)) return null;
  return s;
}

function sshArgs(target) {
  let host = target;
  let port = null;
  const m = host.match(/^([^:]+):(\d{1,5})$/);
  if (m) { host = m[1]; port = m[2]; }
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
  if (port) args.push('-p', port);
  args.push(host, 'sh -s');
  return args;
}

function sshErr(err, code) {
  const e = (err || '').trim();
  if (/permission denied|publickey|authentication/i.test(e)) return 'SSH refused — the app uses key auth only (no password prompts). Set up an SSH key for this host first.';
  if (/could not resolve|name or service|nodename nor servname/i.test(e)) return 'Host not found.';
  if (/connection refused/i.test(e)) return 'Connection refused — is SSH enabled on that machine?';
  if (/timed out|timeout/i.test(e)) return 'Connection timed out — is the host reachable?';
  if (/no route to host/i.test(e)) return 'No route to host — check the network.';
  return e.split('\n').filter(Boolean).pop() || `ssh exited with code ${code}`;
}

// Run a POSIX sh script on the peer (piped via stdin), return its stdout bytes.
function runSSH(target, script, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn('ssh', sshArgs(target)); } catch (e) { return reject(e); }
    const chunks = [];
    let err = '';
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } reject(new Error('SSH timed out — is the host reachable?')); }, timeoutMs);
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(to); reject(e.code === 'ENOENT' ? new Error('ssh is not installed on this machine.') : e); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(sshErr(err, code))); });
    p.stdin.on('error', () => { /* peer closed early */ });
    p.stdin.write(script);
    p.stdin.end();
  });
}

// Parse the byte stream emitted by the remote raw-pull loop. Each record is a
// header line  \037F\037<src>\037<size>\037<path>\037\n  then exactly <size>
// bytes of file content. Sizes let us jump cleanly past any content bytes.
function parseRawStream(buf) {
  const files = [];
  let total = 0;
  let i = 0;
  while (i < buf.length) {
    const h = buf.indexOf('F', i, 'latin1');
    if (h < 0) break;
    const nl = buf.indexOf('\n', h);
    if (nl < 0) break;
    const parts = buf.toString('latin1', h, nl).split(''); // ['','F',src,size,path,'']
    const src = parts[2] === 'codex' ? 'codex' : 'claude';
    const sz = parseInt(parts[3], 10) || 0;
    const fpath = parts[4] || '';
    const start = nl + 1;
    const end = Math.min(start + sz, buf.length);
    files.push({ source: src, name: fpath.split('/').pop() || fpath, path: fpath, content: buf.toString('utf8', start, end) });
    total += end - start;
    i = end;
  }
  return { files, totalBytes: total, truncated: buf.includes('TRUNC', 0, 'latin1') };
}

async function sshConnect(target) {
  const t = validTarget(target);
  if (!t) throw new Error('Enter an SSH host like user@host (no spaces or shell characters).');
  const probe = 'echo ROUTER_OK; uname -s; [ -d "$HOME/.claude/projects" ] && echo HAS_CLAUDE; [ -d "$HOME/.codex/sessions" ] && echo HAS_CODEX';
  const out = (await runSSH(t, probe, { timeoutMs: 20000 })).toString();
  if (!out.includes('ROUTER_OK')) throw new Error('Connected, but got an unexpected response from the host.');
  const hasClaude = out.includes('HAS_CLAUDE');
  const hasCodex = out.includes('HAS_CODEX');
  if (!hasClaude && !hasCodex) throw new Error('Reached the host, but found no ~/.claude or ~/.codex logs there.');
  sshPeer = { target: t };
  addPeer(t); // remember it so its folders fold into the daily digest
  const osName = (out.match(/ROUTER_OK\s*\n\s*(\S+)/) || [])[1] || '';
  return { ok: true, target: t, os: osName, hasClaude, hasCodex };
}

function sshDisconnect() { sshPeer = null; }
function sshConnected() { return !!sshPeer; }
function sshTarget() { return sshPeer ? sshPeer.target : null; }

async function sshListProjects() {
  if (!sshPeer) throw new Error('Not connected over SSH.');
  const script = 'echo CLAUDE; ls -1 "$HOME/.claude/projects" 2>/dev/null; echo CODEX; find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null | wc -l';
  const lines = (await runSSH(sshPeer.target, script)).toString().split('\n');
  const ci = lines.indexOf('CLAUDE');
  const xi = lines.indexOf('CODEX');
  const dirs = (ci >= 0 && xi > ci ? lines.slice(ci + 1, xi) : []).filter(Boolean);
  const codexCount = parseInt(((xi >= 0 ? lines.slice(xi + 1) : []).find((s) => s.trim()) || '0').trim(), 10) || 0;
  return { type: 'projects', projects: dirs.map(decodeClaudeDir), codexSessions: codexCount };
}

// Pull a target's recent raw .jsonl over SSH (explicit target — does not touch
// the interactive sshPeer state, so it's safe to call for saved peers too).
async function sshRawFor(target, days = 7, { timeoutMs = 120000 } = {}) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
  const script =
`H="$HOME"; cap=${MAX_RAW_BYTES}; tot=0
find "$H/.claude/projects" "$H/.codex/sessions" -name '*.jsonl' -mtime -${d} -print 2>/dev/null | while IFS= read -r f; do
  sz=$(wc -c < "$f" 2>/dev/null | tr -d ' '); [ -z "$sz" ] && sz=0
  tot=$((tot+sz)); if [ "$tot" -gt "$cap" ]; then printf '\\037TRUNC\\037\\n'; break; fi
  case "$f" in */.codex/*) src=codex;; *) src=claude;; esac
  printf '\\037F\\037%s\\037%s\\037%s\\037\\n' "$src" "$sz" "$f"
  cat "$f"
done`;
  const buf = await runSSH(target, script, { timeoutMs });
  return parseRawStream(buf);
}

async function sshGetRaw(days = 7) {
  if (!sshPeer) throw new Error('Not connected over SSH.');
  // I4: refuse the explicit raw-pull unless raw sharing is enabled (perm-raw
  // defaults OFF). The digest paths (sshGetRecent/collectPeerToday) use
  // sshRawFor directly and stay available; only the raw-files surface is gated.
  if (!scope.rawSharingEnabled()) throw new Error('Raw-log sharing is off. Turn on the raw-share permission to pull raw transcripts.');
  const r = await sshRawFor(sshPeer.target, days);
  // I4: redact the pulled bytes before they reach the renderer/staging/Router.
  const rules = scope.loadRules();
  const files = (r.files || []).map((f) => ({
    ...f,
    content: redact(f.content, rules, { source: f.name || (f.path || '') }).masked,
  }));
  return { type: 'raw', source: 'ssh', target: sshPeer.target, ...r, files };
}

async function sshGetRecent(days = 30) {
  if (!sshPeer) throw new Error('Not connected over SSH.');
  const raw = await sshRawFor(sshPeer.target, days);
  const label = `the last ${days} days on ${sshPeer ? sshPeer.target : 'the peer'}`;
  // I3/I4: gate each pulled file through the SAME scope allowlist as the local
  // digest BEFORE building, then scrub the result through the SAME redact().
  const files = gateRawFiles(raw.files);
  const dig = digestFromRawFiles(files, label, scope.loadRules());
  return { type: 'recent', source: 'ssh', target: sshPeer ? sshPeer.target : null, truncated: raw.truncated, totalBytes: raw.totalBytes, ...dig };
}

// ── saved SSH peers: machines whose logs fold into the daily digest ──────────
const CONFIG_DIR = path.join(HOME, '.router-daybook');
const PEERS_FILE = path.join(CONFIG_DIR, 'peers.json');

function listPeers() {
  try { const a = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function savePeers(arr) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(PEERS_FILE, JSON.stringify(arr, null, 2)); } catch { /* */ }
}
function addPeer(target) {
  const t = validTarget(target);
  if (!t) return listPeers();
  const peers = listPeers();
  if (!peers.find((p) => p.target === t)) { peers.push({ target: t }); savePeers(peers); }
  return peers;
}
function removePeer(target) {
  const peers = listPeers().filter((p) => p.target !== target);
  savePeers(peers);
  return peers;
}

// Pull a saved peer's TODAY-ish work (last ~24h) and shape it into a digest, so
// the daily reflection can fold in another machine's folders. Never throws —
// an unreachable peer just comes back { ok:false } and is skipped.
async function collectPeerToday(target) {
  const t = validTarget(target);
  if (!t) return { target, ok: false, error: 'Invalid saved peer.' };
  try {
    const raw = await sshRawFor(t, 1, { timeoutMs: 25000 });
    // I3/I4: gate each pulled file through the SAME scope allowlist as the local
    // digest BEFORE building, then scrub the result through the SAME redact()
    // before it folds into today's local digest.
    const files = gateRawFiles(raw.files);
    const dig = digestFromRawFiles(files, `today on ${t}`, scope.loadRules());
    return { target: t, ok: true, projectCount: dig.projectCount, projects: dig.projects, digest: dig.digest, truncated: raw.truncated, totalBytes: raw.totalBytes };
  } catch (e) {
    return { target: t, ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  startHost, stopHost, hostInfo,
  connectPeer, disconnectPeer, peerConnected,
  peerListProjects, peerGetRecent, peerGetRaw,
  parseCode, makeCode,
  sshConnect, sshDisconnect, sshConnected, sshTarget,
  sshListProjects, sshGetRecent, sshGetRaw,
  listPeers, addPeer, removePeer, collectPeerToday,
};
