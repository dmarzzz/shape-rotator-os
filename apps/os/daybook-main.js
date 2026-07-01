'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Router (Teleport Router) — IPC host adapter for the pop-out window.
//
// The pop-out window (src/router/) runs the router-daybook renderer VERBATIM
// (renderer/app.js + index.html + styles.css) behind a verbatim shim preload
// (src/router/preload.js exposes window.daybook over the SOURCE un-namespaced
// channels). This file is the host's stand-in for router-daybook/src/main.js:
// it registers exactly those un-namespaced ipcMain channels by delegating to the
// vendored pipeline in daybook/ (byte-identical to upstream — see VENDOR.md).
//
// Differences from the standalone main.js (deliberately NOT ported):
//   • window lifecycle is the host's — see openRouterWindow() below.
//   • voice transcription (MLX-Whisper + ffmpeg) is NOT shipped — transcribe-audio
//     and warm-whisper are graceful stubs, so the interview falls back to typing.
//   • NO dock/tray icon (the host owns those) and NO daily precompute daemon
//     (it would do background SSH/HTTP egress with the window closed); the draft
//     is cold-built on open via draft:build, so onPrecomputeReady simply never
//     fires.
//
// STATE LOCATION: the vendored modules keep upstream's paths — app state in
// ~/.router-daybook/ (scope.json, redactions.json, notes.jsonl, patterns.json,
// drafts/, peers.json, introduced) and identity in ~/.routerrc. Those live in
// $HOME (writable in a packaged build) and are SHARED with a standalone
// router-daybook install if the user runs one. Nothing is re-rooted.
//
// PRIVACY: redact.js remains the single redactor; the post handler re-scrubs the
// exact outgoing bytes (I2 final hop) using the SAME scopeMod.loadRules() the
// generate() scrubs use. redaction:reveal stays local-only and never egresses.
//
// DEVICE-LINK: draft.js hard-requires ./link, so link.js is vendored and the
// link-* handlers are wired. NOTE this re-introduces plaintext-TCP pairing + SSH
// peer reads, and link.collectPeerToday folds saved peers into every buildDraft
// (background SSH egress on window open). startHost is opt-in from the UI.
// ─────────────────────────────────────────────────────────────────────────

const { ipcMain, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const { collectToday, collectRecent, collectMostRecentDay, claudeDirToPath } = require('./daybook/transcripts');
const { generate, extractPatterns } = require('./daybook/reflect');
const { buildDraft, readDraftCache, draftIsFresh, resolveName, localDateStr } = require('./daybook/draft');
const scopeMod = require('./daybook/scope');
const { redact } = require('./daybook/redact');
const { post, fetchFeed, cohortFeed, lastOwnPostMs, postStreak, whoami, loadConfig, hasConfig, joinWithInvite, useExistingKey, DEFAULT_SERVER } = require('./daybook/router');
const learning = require('./daybook/preferences');
const intro = require('./daybook/intro');
const link = require('./daybook/link');
const whisperCpp = require('./daybook-whisper'); // cross-platform voice (host addition)

// Packaged Electron apps inherit a minimal PATH that usually omits ~/.local/bin,
// Homebrew, etc. — where the user's `claude` CLI lives. The vendored reflect.js /
// intro.js / draft.js spawn `claude` with {...process.env}, so we augment the
// process PATH once here, process-wide, INSTEAD of editing those files (keeping
// daybook/ byte-identical to upstream). See daybook/VENDOR.md.
(function ensureClaudeOnPath() {
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin',
    path.join(os.homedir(), '.bun', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let changed = false;
  for (const p of extra) if (!parts.includes(p)) { parts.push(p); changed = true; }
  if (changed) process.env.PATH = parts.join(path.delimiter);
})();

let routerWin = null;
let session = {};  // last digest generation's inputs, reused for in-place revision
let introCtx = {}; // onboarding context (history/projects/feed), reused across intro steps

// ── pop-out window ─────────────────────────────────────────────────────────
// Router opens as its own focused window running the verbatim source renderer
// behind the shim preload. Single-instance: re-invoking just focuses it.
function openRouterWindow() {
  if (routerWin && !routerWin.isDestroyed()) { routerWin.focus(); return routerWin; }
  routerWin = new BrowserWindow({
    width: 760, height: 880, minWidth: 560, minHeight: 640,
    title: 'Teleport Router',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0b1a',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'router', 'preload.js'), // the shim (window.daybook)
      // Own session partition so the mic-permission grant below is scoped to
      // THIS window only — it never touches the main OS window or easel's
      // screen-capture permission on the default session.
      partition: 'persist:teleport-router',
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  // Voice answers use getUserMedia({audio}) in the renderer to drive the shader +
  // recording. Grant ONLY 'media' on this window's session; deny everything else.
  routerWin.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
  routerWin.loadFile(path.join(__dirname, 'src', 'router', 'index.html'));
  routerWin.webContents.on('console-message', (_e, lvl, msg) => {
    process.stderr.write(`[router:${['log', 'warn', 'error'][lvl] || 'log'}] ${msg}\n`);
  });
  routerWin.on('closed', () => { routerWin = null; });
  return routerWin;
}
if (!global.__SROS_DAYBOOK_OPEN_WINDOW_REGISTERED) {
  ipcMain.handle('daybook:open-window', () => { openRouterWindow(); return { ok: true }; });
}

module.exports = { openRouterWindow };

// Push the live token count to the router window's "thinking" view (the source
// renderer listens on the un-namespaced 'gen-stream'; send to THAT window only,
// never broadcast, so the count never leaks pre-scrub text or hits other windows).
function streamTokens() {
  return (_text, tokens) => {
    if (routerWin && !routerWin.isDestroyed()) {
      try { routerWin.webContents.send('gen-stream', { tokens }); } catch { /* gone */ }
    }
  };
}

// ── voice answer: ffmpeg → resident MLX-Whisper sidecar (local, on-device) ──
// Ported verbatim from router-daybook/src/main.js. ON-DEVICE: the recorded audio
// never leaves the machine — ffmpeg transcodes to 16kHz wav and a resident
// MLX-Whisper python sidecar transcribes it; only the resulting TEXT goes back
// to the renderer (and then through the normal redaction chain as an interview
// answer). REQUIRES (NOT bundled): ffmpeg + `uv` + mlx-whisper, macOS/Apple-
// Silicon only. If any is missing, transcribe-audio returns '' and the interview
// falls back to typing (app.js treats '' as "keep typed text").
function resolveBin(candidates) {
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch { /* skip */ } }
  return candidates[candidates.length - 1];
}
// Prefer the bundled ffmpeg (shipped under Resources/whisper/ alongside
// whisper-cli) so a packaged build needs no system ffmpeg; fall back to
// Homebrew / PATH in dev.
const FFMPEG_EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const FFMPEG = resolveBin([
  process.resourcesPath ? path.join(process.resourcesPath, 'whisper', FFMPEG_EXE) : null,
  path.join(__dirname, 'build-resources', 'whisper', FFMPEG_EXE), // dev (unpacked)
  '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg',
]);
const UV = resolveBin([path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', 'uv']);
const WHISPER_PY = path.join(__dirname, 'daybook', 'whisper_server.py');

let whisper = null;
let whisperBroken = false; // toolchain unavailable (e.g. non-Apple-Silicon PC) — stop retrying
let whisperReqId = 0;
function ensureWhisper() {
  if (whisper) return whisper.ready;
  // On Windows / Linux / Intel macs the MLX-Whisper sidecar can't run; once a
  // launch fails to warm, treat voice as unavailable and resolve immediately so
  // transcribeViaSidecar returns '' (type-only fallback) WITHOUT hanging or
  // re-spawning a doomed process on every mic press.
  if (whisperBroken) return Promise.resolve();
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let proc;
  try {
    proc = spawn(UV, ['run', '--python', '3.12', '--with', 'mlx-whisper', 'python', WHISPER_PY],
      { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  } catch { whisperBroken = true; return Promise.resolve(); }
  let gotReady = false;
  whisper = { proc, ready, pending: new Map(), buf: '' };
  proc.stdout.on('data', (d) => {
    whisper.buf += d.toString();
    let i;
    while ((i = whisper.buf.indexOf('\n')) >= 0) {
      const line = whisper.buf.slice(0, i); whisper.buf = whisper.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'ready') { gotReady = true; resolveReady(); }
      else if (m.id && whisper.pending.has(m.id)) { whisper.pending.get(m.id)(m.text || ''); whisper.pending.delete(m.id); }
    }
  });
  // On crash/exit: resolve any in-flight requests to '' AND resolve `ready` so
  // an awaiting transcribeViaSidecar unblocks (the standalone app could hang
  // here). If it died before warming, the toolchain isn't usable here — mark it
  // broken so we don't relaunch on every attempt.
  const fail = () => {
    if (whisper) { for (const r of whisper.pending.values()) { try { r(''); } catch { /* */ } } }
    whisper = null;
    if (!gotReady) whisperBroken = true;
    resolveReady();
  };
  proc.on('close', fail);
  proc.on('error', fail);
  return ready;
}
async function transcribeViaSidecar(wavPath) {
  await ensureWhisper();
  if (!whisper) return '';
  const id = String(++whisperReqId);
  return new Promise((resolve) => {
    whisper.pending.set(id, resolve);
    try { whisper.proc.stdin.write(JSON.stringify({ id, path: wavPath }) + '\n'); }
    catch { resolve(''); }
  });
}
function runBin(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-300)}`))));
  });
}

// Engine selection. MLX is the fast resident path on Apple Silicon; whisper.cpp
// (daybook-whisper.js) is the cross-platform path everywhere else. Override with
// ROUTER_WHISPER=mlx|cpp (handy for testing the cpp path on a mac).
const WHISPER_PREF = (process.env.ROUTER_WHISPER || '').toLowerCase();
function useMlx() {
  if (WHISPER_PREF === 'cpp') return false;
  if (WHISPER_PREF === 'mlx') return true;
  return process.platform === 'darwin' && process.arch === 'arm64';
}

// transcribe a recorded answer LOCALLY (ffmpeg → MLX Whisper on Apple Silicon,
// else whisper.cpp). Returns '' on any failure so the renderer keeps typed text.
ipcMain.handle('transcribe-audio', async (_evt, { base64 } = {}) => {
  if (!base64) return '';
  const id = 'router-ans-' + Date.now();
  const inPath = path.join(os.tmpdir(), id + '.webm');
  const wavPath = path.join(os.tmpdir(), id + '.wav');
  try {
    fs.writeFileSync(inPath, Buffer.from(base64, 'base64'));
    await runBin(FFMPEG, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', wavPath]);
    if (useMlx()) {
      const t = await transcribeViaSidecar(wavPath); // resident model — fast after warmup
      if (t) return t;
      // MLX produced nothing (toolchain missing) — fall back to whisper.cpp if it's available here.
      if (whisperCpp.available()) return await whisperCpp.transcribeWav(wavPath);
      return '';
    }
    return await whisperCpp.transcribeWav(wavPath);
  } catch {
    return ''; // ffmpeg/whisper not available → type-only fallback
  } finally {
    for (const p of [inPath, wavPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
});

// Pre-warm the model so the first spoken answer transcribes fast. MLX has a
// resident sidecar to warm; whisper.cpp loads per-call (nothing to pre-warm).
ipcMain.handle('warm-whisper', async () => { try { if (useMlx()) ensureWhisper(); } catch { /* */ } return { ok: true }; });

// ── IPC: first-run check + identity (decides onboarding vs digest) ────────
ipcMain.handle('bootstrap', async () => {
  const name = resolveName();
  const hasKey = hasConfig();
  let handle = null, server = DEFAULT_SERVER, configError = null;
  try { server = loadConfig().server; } catch (e) { configError = e.message; }
  if (hasKey) { try { const who = await whoami(); handle = who && who.handle; } catch { /* offline */ } }
  return { hasKey, introduced: intro.isIntroduced(), name, handle, server, configError };
});

ipcMain.handle('join', async (_evt, { invite, handle }) => {
  let server = DEFAULT_SERVER, inviteCode = (invite || '').trim();
  try {
    const u = new URL(invite);
    server = u.origin;
    inviteCode = u.searchParams.get('invite') || u.searchParams.get('code') || inviteCode;
  } catch { /* not a URL — treat input as a bare code on the default server */ }
  return await joinWithInvite({ server, inviteCode, handle });
});

// Already have a key (router CLI, another machine)? Paste it instead of joining.
ipcMain.handle('use-key', async (_evt, { key } = {}) => useExistingKey({ key }));

// ── IPC: onboarding ───────────────────────────────────────────────────────
ipcMain.handle('discover-projects', async () => intro.discoverProjects());

ipcMain.handle('intro-start', async () => {
  const name = resolveName();
  let handle = null, feedEntries = [];
  try { const who = await whoami(); handle = who && who.handle; } catch { /* offline */ }
  try { const f = await fetchFeed({ days: 30, limit: 40 }); if (f.ok) feedEntries = f.entries; } catch { /* feedless */ }
  const projects = await intro.discoverProjects();
  const history = await collectRecent(30);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  introCtx = { name, handle, projects, history: history.digest, feedEntries, projectCount: history.projectCount || projects.length, stamp };
  const q = await intro.firstQuestion({ name, projects, history: history.digest, feedEntries, model: 'haiku' });
  return { ...q, projectCount: introCtx.projectCount };
});

ipcMain.handle('intro-next', async (_evt, { transcript }) => {
  if (!introCtx.name) throw new Error('Start the intro first.');
  return await intro.nextQuestion({ ...introCtx, transcript: transcript || [], timeoutMs: 60000, onChunk: streamTokens() });
});

ipcMain.handle('intro-write', async (_evt, { transcript }) => {
  if (!introCtx.name) throw new Error('Start the intro first.');
  const res = await intro.generateIntro({ ...introCtx, interview: transcript || [], onChunk: streamTokens() });
  intro.saveInterview({
    transcript: transcript || [], post: res.post,
    name: introCtx.name, handle: introCtx.handle, stamp: introCtx.stamp,
  });
  return { ...res, projectCount: introCtx.projectCount };
});

ipcMain.handle('mark-introduced', async () => { intro.markIntroduced(); return { ok: true }; });

ipcMain.handle('welcome-message', async () => {
  const name = resolveName();
  const r = await collectMostRecentDay();
  return { message: await intro.welcomeMessage({ name, recent: r.digest, dayLabel: r.date }) };
});

// ── IPC: the daily draft via the buildDraft spine + on-disk cache ─────────
ipcMain.handle('draft:cached', async () => {
  const record = readDraftCache();
  if (!record) return { usable: false };
  const usable = !!(record.hasActivity && record.result && record.result.post
    && record.localDate === localDateStr());
  // Hydrate session so in-place revise/refine work right after an instant paint.
  if (usable && record.sessionInputs) session = record.sessionInputs;
  return { usable, fresh: draftIsFresh(record), record };
});

ipcMain.handle('draft:build', async (_evt, { reason } = {}) => {
  const record = await buildDraft({ reason: reason || 'open', onChunk: streamTokens() });
  if (record && record.sessionInputs) session = record.sessionInputs;
  return record;
});

// Pattern derivation runs OFF the interactive path — fire-and-forget after a
// post or revise — so the draft never waits on a second `claude -p`.
function derivePatternsInBackground() {
  if (!learning.shouldDerive()) return;
  Promise.resolve().then(async () => {
    try {
      const patterns = await extractPatterns(learning.notesWindow(), { name: resolveName(), model: 'haiku' });
      learning.savePatterns(learning.readNotes().length, patterns);
    } catch { /* keep prior cache */ }
  });
}

// ── IPC: revise THE CURRENT draft in place; the note is logged silently ────
ipcMain.handle('revise', async (_evt, { currentDraft, instruction }) => {
  if (!instruction || !instruction.trim()) throw new Error('Tell me what to change.');
  if (!session.digest) throw new Error('Nothing to revise yet.');
  learning.recordNote(instruction.trim(), session.dateLabel);
  const result = await generate(session.digest, { ...session, currentDraft, instruction });
  derivePatternsInBackground();
  return { ...result, learned: learning.learned().patterns };
});

// ── IPC: "refine in interview" — sharpen the CURRENT draft via the interview
// engine; answers become ONE revise instruction fed to the SAME generate()
// revise path, so every safety scrub still runs.
const REFINE_PURPOSE = (name) => `This is a SHORT interview to help ${name} sharpen the daily-update draft below before he shares it with the cohort. You are NOT re-interviewing him about who he is — you are helping THIS draft. Find what he most wants to get across, or most wants to hear back from the cohort, that the draft is missing, overstating, or framing wrong. Aim at substance and at what would make the post more useful to him and to readers.`;
const REFINE_OPENING = `Ask the FIRST question. Read the current draft and ask the single most useful thing that would sharpen it — what he most wants the cohort to know or respond to, what feels off or missing, or whether the ask (if there is one) is the thing he actually wants help with. One question, grounded in the draft.`;
const REFINE_GOALS = `Over at most two or three questions, surface: what he most wants to land or get back from the cohort; anything the draft overstates, misses, or frames wrong; and whether the ask is the high-value one (or should change or drop). Keep it short, then end.`;

ipcMain.handle('refine:start', async (_evt, { draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const name = resolveName();
  return await intro.firstQuestion({
    name,
    history: session.digest,
    feedEntries: session.feedEntries || [],
    purpose: REFINE_PURPOSE(name),
    opening: REFINE_OPENING,
    focus: draft || '',
    model: 'haiku',
  });
});

ipcMain.handle('refine:next', async (_evt, { transcript, draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const name = resolveName();
  return await intro.nextQuestion({
    name,
    history: session.digest,
    feedEntries: session.feedEntries || [],
    transcript: transcript || [],
    maxTurns: 3,
    purpose: REFINE_PURPOSE(name),
    goals: REFINE_GOALS,
    focus: draft || '',
    timeoutMs: 60000,
    onChunk: streamTokens(),
  });
});

ipcMain.handle('refine:write', async (_evt, { transcript, draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const qa = (transcript || []).filter((t) => t && (t.a || '').trim());
  if (!qa.length) throw new Error('Nothing from the interview to apply.');
  const instruction = [
    'Refine the draft using what the author said in this short interview. Apply his intent — what he wants to land or get back, and any framing he corrected — while keeping everything that already works and obeying all the rules and the format.',
    '',
    qa.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a.trim()}`).join('\n\n'),
  ].join('\n');
  const result = await generate(session.digest, { ...session, currentDraft: draft || '', instruction });
  return { ...result, learned: learning.learned().patterns };
});

// ── IPC: view / forget what Router has learned ───────────────────────────
ipcMain.handle('get-learned', async () => learning.learned().patterns);
ipcMain.handle('clear-learned', async () => { learning.clearAll(); return { ok: true }; });

// ── IPC: post the approved digest to the cohort Router ────────────────────
// I2 final hop: re-scrub the EXACT outgoing bytes here (SAME rules as both prior
// scrubs), after any hand-edit, before the only write egress.
ipcMain.handle('post', async (_evt, content) => {
  const { masked } = redact(content, scopeMod.loadRules());
  const res = await post(masked);
  derivePatternsInBackground();
  return res;
});

// ── Device link (peer-to-peer) ────────────────────────────────────────────
ipcMain.handle('link-host-start', async (_evt, { perms } = {}) => {
  return await link.startHost({
    perms: perms || { recent: true, raw: false },
    onChange: (info) => { if (routerWin && !routerWin.isDestroyed()) { try { routerWin.webContents.send('link-host-changed', info); } catch { /* gone */ } } },
  });
});
ipcMain.handle('link-host-stop', async () => { link.stopHost(); return { ok: true }; });
ipcMain.handle('link-host-info', async () => link.hostInfo());
ipcMain.handle('link-connect', async (_evt, { code }) => link.connectPeer(code));
ipcMain.handle('link-disconnect', async () => { link.disconnectPeer(); return { ok: true }; });
ipcMain.handle('link-status', async () => ({
  host: link.hostInfo(),
  peerConnected: link.peerConnected(),
  sshConnected: link.sshConnected(),
  sshTarget: link.sshTarget(),
}));
ipcMain.handle('link-peer-projects', async () => link.peerListProjects());
ipcMain.handle('link-peer-recent', async (_evt, { days } = {}) => link.peerGetRecent(days || 30));
ipcMain.handle('link-peer-raw', async (_evt, { days } = {}) => link.peerGetRaw(days || 7));
ipcMain.handle('link-ssh-connect', async (_evt, { target } = {}) => link.sshConnect(target));
ipcMain.handle('link-ssh-disconnect', async () => { link.sshDisconnect(); return { ok: true }; });
ipcMain.handle('link-ssh-recent', async (_evt, { days } = {}) => link.sshGetRecent(days || 30));
ipcMain.handle('link-ssh-raw', async (_evt, { days } = {}) => link.sshGetRaw(days || 7));
ipcMain.handle('link-peers-list', async () => link.listPeers());
ipcMain.handle('link-peer-remove', async (_evt, { target } = {}) => link.removePeer(target));

ipcMain.handle('open-feed', async (_evt, server) => {
  await shell.openExternal((server || DEFAULT_SERVER).replace(/\/$/, ''));
});

// The in-app cohort feed: your posts + the room's, newest first. Read-only.
ipcMain.handle('feed:get', async (_evt, opts = {}) => cohortFeed(opts || {}));

// Your current posting streak (consecutive days you posted to the Router).
ipcMain.handle('streak:get', async () => {
  try { return { streak: await postStreak() }; } catch { return { streak: 0 }; }
});

// ══════════════════════════════════════════════════════════════════════════
// Scope + redaction (Invariants I1–I5). Wiring only; the decision engine lives
// in scope.js and the deterministic scrubber in redact.js.
// ══════════════════════════════════════════════════════════════════════════

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');

// Local-only cache of the most recent scope:preview findings, keyed by
// finding.id, so redaction:reveal returns the original cleartext WITHOUT
// re-running the model or re-sending anything. Never serialized, never egressed.
let lastPreviewFindings = new Map();

function p2(n) { return String(n).padStart(2, '0'); }
function dayStartMs(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime(); }

function readCodexMeta(file) {
  return new Promise((resolve) => {
    let cwd = null, sessionId = null, stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve({ cwd, sessionId }); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim(); if (!s) return;
      let obj; try { obj = JSON.parse(s); } catch { return; }
      if (obj && obj.type === 'session_meta') {
        const payload = obj.payload || {};
        cwd = payload.cwd || payload.cwd_path || cwd;
        sessionId = payload.id || payload.session_id || sessionId;
      }
    });
    rl.on('close', () => resolve({ cwd, sessionId }));
    stream.on('error', () => resolve({ cwd, sessionId }));
  });
}

async function discoverCandidates(startMs, date) {
  const byPath = new Map();
  const note = (fullPath, mtimeMs, sessionId) => {
    if (!fullPath) return;
    let e = byPath.get(fullPath);
    if (!e) { e = { mtimeMs: 0, sessions: new Set() }; byPath.set(fullPath, e); }
    if (typeof mtimeMs === 'number' && mtimeMs > e.mtimeMs) e.mtimeMs = mtimeMs;
    if (sessionId) e.sessions.add(sessionId);
  };
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    for (const dir of dirs) {
      const fullPath = claudeDirToPath(dir);
      let entries = [];
      try { entries = fs.readdirSync(path.join(CLAUDE_PROJECTS, dir)).filter((f) => f.endsWith('.jsonl')); }
      catch { continue; }
      for (const f of entries) {
        const file = path.join(CLAUDE_PROJECTS, dir, f);
        let mtimeMs; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtimeMs < startMs) continue;
        note(fullPath, mtimeMs, f.replace(/\.jsonl$/, ''));
      }
    }
  } catch { /* no claude dir */ }
  try {
    const d = new Date(date);
    const dayDir = path.join(CODEX_SESSIONS, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    const files = fs.readdirSync(dayDir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => path.join(dayDir, f));
    for (const file of files) {
      let mtimeMs; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      const meta = await readCodexMeta(file);
      const fullPath = meta.cwd || null;
      const sid = meta.sessionId || path.basename(file).replace(/\.jsonl$/, '');
      if (fullPath) note(fullPath, mtimeMs, sid);
    }
  } catch { /* no codex day dir */ }
  return byPath;
}

function ruleView(rule) {
  if (!rule || typeof rule !== 'object') return null;
  switch (rule.kind) {
    case 'excludePathPrefix': return { id: rule.id, kind: rule.kind, label: 'Never read under', value: rule.path };
    case 'includePathPrefix': return { id: rule.id, kind: rule.kind, label: 'Always read under', value: rule.path };
    case 'activeWithinDays': return { id: rule.id, kind: rule.kind, label: 'Active within', value: `${rule.days} days` };
    case 'excludePrivateRepos': return { id: rule.id, kind: rule.kind, label: 'Never read', value: 'private repos' };
    default: return { id: rule.id, kind: rule.kind || 'rule', label: rule.kind || 'rule', value: '' };
  }
}

async function buildScopeView(date = new Date()) {
  const scope = scopeMod.loadScope();
  const startMs = dayStartMs(date);
  const byPath = await discoverCandidates(startMs, date);
  const candidatePaths = [...byPath.keys()];
  const activity = {};
  for (const [fp, e] of byPath) activity[fp] = e.mtimeMs;
  const built = scopeMod.buildAllowSet(candidatePaths, scope, activity);
  const newSet = new Set(built.newRepos);
  const included = [], excluded = [], newRepos = [];
  for (const fp of candidatePaths) {
    const d = built.decisions[fp] || { included: false, reason: 'default-deny', ruleId: null, isNew: true };
    const label = path.basename(fp) || fp;
    const e = byPath.get(fp);
    if (newSet.has(fp)) newRepos.push({ fullPath: fp, label });
    if (d.included) {
      included.push({ fullPath: fp, label, convCount: e ? e.sessions.size : 0, lastActive: e ? e.mtimeMs : 0, reason: d.reason, ruleId: d.ruleId || null });
    } else {
      excluded.push({ fullPath: fp, label, reason: d.reason, ruleId: d.ruleId || null });
    }
  }
  const rules = (Array.isArray(scope.rules) ? scope.rules : []).map(ruleView).filter(Boolean);
  const inc = included.length, exc = excluded.length;
  let summary;
  if (inc === 0 && exc === 0) {
    summary = 'No project activity to read today.';
  } else {
    const incPart = inc === 1 ? '1 repo' : `${inc} repos`;
    const excPart = exc === 0 ? 'nothing excluded' : (exc === 1 ? '1 repo excluded' : `${exc} repos excluded`);
    summary = `Reading ${incPart} today; ${excPart}.`;
    if (newRepos.length) summary += ` ${newRepos.length} new repo${newRepos.length === 1 ? '' : 's'} out by default.`;
  }
  return { summary, rules, included, excluded, newRepos, collisions: built.collisions || [] };
}

ipcMain.handle('scope:get', async () => buildScopeView());

ipcMain.handle('scope:setRule', async (_evt, payload = {}) => {
  if (payload && payload.remove) scopeMod.removeRule(payload.remove);
  else if (payload && payload.rule) scopeMod.setRule(payload.rule);
  return buildScopeView();
});

ipcMain.handle('scope:override', async (_evt, payload = {}) => {
  const { fullPath, decision } = payload;
  scopeMod.setOverride(fullPath, decision === undefined ? null : decision);
  return buildScopeView();
});

ipcMain.handle('scope:setConversation', async (_evt, payload = {}) => {
  const { sessionId, decision } = payload;
  scopeMod.setConversation(sessionId, decision === undefined ? null : decision);
  return { ok: true };
});

ipcMain.handle('scope:preview', async (_evt, payload = {}) => {
  const date = (payload && payload.date) ? new Date(payload.date) : new Date();
  const scope = scopeMod.loadScope();
  if (payload && typeof payload.draft === 'string') {
    const rules = scopeMod.loadRules();
    const scrub = redact(payload.draft, rules);
    const postFindings = Array.isArray(scrub.findings) ? scrub.findings : [];
    const cache = new Map();
    for (const f of postFindings) if (f && f.id) cache.set(f.id, f);
    lastPreviewFindings = cache;
    return { post: scrub.masked, headline: '', digestFindings: [], postFindings, readFiles: [], excludedCount: 0, held: [] };
  }
  const collected = await collectToday(date, scope);
  const digestFindings = Array.isArray(collected.redactions) ? collected.redactions : [];
  const held = Array.isArray(collected.held) ? collected.held : [];
  const excludedCount = typeof collected.excludedCount === 'number' ? collected.excludedCount : 0;
  const readFiles = (collected.stats && Array.isArray(collected.stats.projects))
    ? collected.stats.projects.map((p) => ({
        fullPath: p.fullPath, label: p.name,
        files: Array.isArray(p.sources) ? p.sources : [],
        convCount: typeof p.messages === 'number' ? p.messages : 0,
      }))
    : [];
  let post2 = '', headline = '', postFindings = [];
  if (collected.hasActivity && collected.digest && collected.digest.trim()) {
    const dateLabel = (collected.stats && collected.stats.date)
      ? collected.stats.date
      : date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const gen = await generate(collected.digest, { name: resolveName(), dateLabel });
    post2 = gen.post || '';
    headline = gen.headline || '';
    postFindings = Array.isArray(gen.postFindings) ? gen.postFindings : [];
  }
  const cache = new Map();
  for (const f of digestFindings) if (f && f.id) cache.set(f.id, f);
  for (const f of postFindings) if (f && f.id) cache.set(f.id, f);
  lastPreviewFindings = cache;
  return { post: post2, headline, digestFindings, postFindings, readFiles, excludedCount, held };
});

ipcMain.handle('redaction:rule', async (_evt, payload = {}) => {
  const rules = scopeMod.loadRules();
  const hide = Array.isArray(rules.hide) ? rules.hide.slice() : [];
  const abstractions = Array.isArray(rules.abstractions) ? rules.abstractions.slice() : [];
  const { op, term, from, to, index } = payload || {};
  const isAbstraction = (from !== undefined && from !== null) || (to !== undefined && to !== null);
  if (op === 'add') {
    if (isAbstraction) { if (from) abstractions.push({ from: String(from), to: String(to == null ? 'a client' : to) }); }
    else if (term) hide.push(String(term));
  } else if (op === 'edit') {
    if (isAbstraction && typeof index === 'number' && index >= 0 && index < abstractions.length) {
      const cur = abstractions[index] || {};
      abstractions[index] = { from: from != null ? String(from) : cur.from, to: to != null ? String(to) : cur.to };
    } else if (term && typeof index === 'number' && index >= 0 && index < hide.length) {
      hide[index] = String(term);
    }
  } else if (op === 'remove') {
    if (typeof index === 'number' && index >= 0) {
      if (isAbstraction) { if (index < abstractions.length) abstractions.splice(index, 1); }
      else if (index < hide.length) hide.splice(index, 1);
    }
  }
  const next = { version: rules.version || 1, hide, abstractions };
  scopeMod.saveRules(next);
  return { hide: next.hide, abstractions: next.abstractions };
});

ipcMain.handle('redaction:reveal', async (_evt, payload = {}) => {
  const id = payload && payload.findingId;
  const f = id ? lastPreviewFindings.get(id) : null;
  return { original: f && typeof f.original === 'string' ? f.original : '' };
});
