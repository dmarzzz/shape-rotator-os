'use strict';

const $ = (id) => document.getElementById(id);

// ── a tiny faux-3D disco ball: facets projected on a sphere, depth-sorted,
// sparkling, spinning forever. Lives in the header, so it's on every page. ──
function startDiscoBall(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const S = canvas.clientWidth || 34;
  canvas.width = S * DPR; canvas.height = S * DPR; ctx.scale(DPR, DPR);
  const cx = S / 2, cy = S / 2, R = S * 0.40, ROWS = 13, TILT = 0.34, dh = Math.PI / ROWS;
  const facets = [];
  for (let i = 0; i < ROWS; i++) {
    const lat = -Math.PI / 2 + Math.PI * (i + 0.5) / ROWS;
    const cols = Math.max(3, Math.round(Math.cos(lat) * ROWS * 2.2));
    for (let j = 0; j < cols; j++) {
      facets.push({ lat, lon: 2 * Math.PI * (j + 0.5) / cols, ph: Math.random() * 6.283, dw: 2 * Math.PI / cols });
    }
  }
  let t = 0;
  function frame() {
    t += 0.011;
    ctx.clearRect(0, 0, S, S);
    // solid sphere base so gaps between tiles read as a ball
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.15, cx, cy, R);
    g.addColorStop(0, 'rgba(64,66,84,0.96)'); g.addColorStop(1, 'rgba(14,14,22,0.94)');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fillStyle = g; ctx.fill();
    const vis = [];
    for (const f of facets) {
      const cl = Math.cos(f.lat), sl = Math.sin(f.lat);
      const x0 = cl * Math.cos(f.lon + t), y0 = sl, z0 = cl * Math.sin(f.lon + t);
      const y = y0 * Math.cos(TILT) - z0 * Math.sin(TILT);
      const z = y0 * Math.sin(TILT) + z0 * Math.cos(TILT);
      if (z < 0) continue; // cull the back hemisphere
      vis.push({ x: x0, y, z, cl, ph: f.ph, dw: f.dw });
    }
    vis.sort((a, b) => a.z - b.z);
    // hard neon palette — quantized, no smooth gradient (glitch, not sparkle)
    const GP = ['#00e6d2', '#ff7a00', '#b6ff1a', '#ff3030', '#0a6cff', '#ffd000'];
    const dx = 1.1 + 0.7 * Math.sin(t * 3.3); // chromatic-aberration offset, breathing
    for (const d of vis) {
      let px = cx + d.x * R; const py = cy - d.y * R;
      const fw = Math.max(1.3, R * d.dw * d.cl * 0.98), fh = Math.max(1.3, R * dh * 0.98);
      // datamosh: a rare horizontal tear yanks a band of facets sideways
      if (Math.sin(t * 7 + Math.floor(py / 5) * 1.7) > 0.965) px += (Math.sin(t * 90 + py) * 5) | 0;
      // hard flicker between palette entries — digital, not a smooth shimmer
      const ci = (Math.floor(d.ph * 6 + t * 2.6) + (Math.sin(t * 9 + d.ph * 5) > 0.9 ? 3 : 0)) % GP.length;
      const x0 = px - fw / 2, y0 = py - fh / 2;
      // RGB channel split: red/magenta ghost one way, cyan/blue the other
      ctx.fillStyle = 'rgba(255,40,40,0.55)'; ctx.fillRect(x0 + dx, y0, fw, fh);
      ctx.fillStyle = 'rgba(0,210,255,0.55)'; ctx.fillRect(x0 - dx, y0, fw, fh);
      ctx.globalAlpha = 0.6 + 0.4 * d.z;
      ctx.fillStyle = GP[ci]; ctx.fillRect(x0, y0, fw, fh);
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  }
  frame();
}

const els = {
  date: $('date'),
  discoball: $('discoball'),
  discoballWelcome: $('discoball-welcome'),
  stats: $('stats'),
  sProjects: $('s-projects'),
  sMessages: $('s-messages'),
  sFiles: $('s-files'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  empty: $('empty'),
  error: $('error'),
  errorText: $('error-text'),
  retry: $('retry'),
  thinkStream: $('think-stream'),
  eyebrow: $('eyebrow'),
  connect: $('connect'),
  connectInvite: $('connect-invite'),
  connectHandle: $('connect-handle'),
  connectJoin: $('connect-join'),
  connectErr: $('connect-err'),
  connectHaveKey: $('connect-have-key'),
  connectKeyRow: $('connect-key-row'),
  connectKey: $('connect-key'),
  connectUseKey: $('connect-use-key'),
  welcome: $('welcome'),
  welcomeBody: $('welcome-body'),
  welcomeBegin: $('welcome-begin'),
  welcomeSkip: $('welcome-skip'),
  interview: $('interview'),
  ivProgress: $('iv-progress'),
  ivQuestion: $('iv-question'),
  ivHint: $('iv-hint'),
  ivAnswer: $('iv-answer'),
  ivBack: $('iv-back'),
  ivNext: $('iv-next'),
  ivMic: $('iv-mic'),
  ivAnswerArea: $('iv-answer-area'),
  ivType: $('iv-type'),
  ivRedo: $('iv-redo'),
  voiceShader: $('voice-shader'),
  ivSkip: $('iv-skip'),
  reflect: $('reflect'),
  quiet: $('quiet'),
  emptyStatus: $('empty-status'),
  emptySub: $('empty-sub'),
  emptyOpenScope: $('empty-open-scope'),
  editor: $('editor'),
  refinePrompt: $('refine-prompt'),
  refineQ: $('refine-q'),
  refineCta: $('refine-cta'),
  startover: $('startover'),
  projlist: $('projlist'),
  success: $('success'),
  successSub: $('success-sub'),
  successFeed: $('success-feed'),
  openFeed: $('open-feed'),
  openFeedView: $('open-feedview'),
  feed: $('feed'),
  feedBack: $('feed-back'),
  feedList: $('feed-list'),
  actions: $('actions'),
  postingAs: $('posting-as'),
  skip: $('skip'),
  post: $('post'),
  openScope: $('open-scope'),
  scope: $('scope'),
  scopeBack: $('scope-back'),
  scopeList: $('scope-list'),
  scopeSave: $('scope-save'),
  openLink: $('open-link'),
  link: $('link'),
  linkBack: $('link-back'),
  hostIdle: $('host-idle'),
  hostActive: $('host-active'),
  permRecent: $('perm-recent'),
  permRaw: $('perm-raw'),
  hostStart: $('host-start'),
  hostCode: $('host-code'),
  hostStatus: $('host-status'),
  hostStop: $('host-stop'),
  peerIdle: $('peer-idle'),
  peerActive: $('peer-active'),
  peerCode: $('peer-code'),
  peerConnect: $('peer-connect'),
  peerErr: $('peer-err'),
  peerStatus: $('peer-status'),
  peerPullRecent: $('peer-pull-recent'),
  peerPullRaw: $('peer-pull-raw'),
  peerResult: $('peer-result'),
  peerDisconnect: $('peer-disconnect'),
  tabCode: $('tab-code'),
  tabSsh: $('tab-ssh'),
  peerPaneCode: $('peer-pane-code'),
  peerPaneSsh: $('peer-pane-ssh'),
  peerSsh: $('peer-ssh'),
  peerSshConnect: $('peer-ssh-connect'),
  sshSaved: $('ssh-saved'),
  sshSavedList: $('ssh-saved-list'),
};

let ctx = { digest: '', name: 'you', dateLabel: 'today', server: '' };
let cur = { text: '', generated: '', fnMap: {}, editing: false };
let mode = 'digest';            // 'digest' | 'intro'
let welcomeBallOn = false;      // start the big welcome disco ball only once

// last scope:preview for the day — chips/counts bind to its postFindings (I2).
let preview = null;             // { post, headline, postFindings, readFiles, excludedCount, held }
let findingById = {};           // postFindings keyed by id, for tooltips + local reveal
let scopeState = null;          // last scope:get payload (for the #scope manager)
let scopeReturnView = 'reflect';// where ← back returns to from #scope
let feedReturnView = 'reflect'; // where ← back returns to from #feed

const SUP = { '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };

let _view = 'loading';
const currentView = () => _view;
function setView(view) {
  _view = view;
  for (const k of ['connect', 'welcome', 'interview', 'loading', 'empty', 'error', 'reflect', 'success', 'link', 'scope', 'feed']) {
    els[k].hidden = k !== view;
  }
  els.actions.hidden = view !== 'reflect';
  els.stats.hidden = view !== 'reflect';
  const card = els[view];
  if (card) { card.classList.remove('fade'); void card.offsetWidth; card.classList.add('fade'); }
}

const hostLabel = (url) => { try { return new URL(url).host; } catch { return url || ''; } };

// Undo toast — exclusions & rule-adds ONLY (never inclusion; you can't un-send).
let toastTimer = 0, toastEl = null;
function showToast(text, onUndo) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  toastEl = document.createElement('div');
  toastEl.className = 'toast';
  const span = document.createElement('span');
  span.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = 'undo';
  btn.addEventListener('click', async () => {
    clearTimeout(toastTimer);
    if (toastEl) { toastEl.remove(); toastEl = null; }
    try { await onUndo(); } catch { /* */ }
  });
  toastEl.appendChild(span); toastEl.appendChild(btn);
  document.body.appendChild(toastEl);
  toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 6000);
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// ── markdown rendering (native) with hoverable footnote markers ────────────
const SUP_RE = /[¹²³⁴⁵⁶⁷⁸⁹]/g;

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="md-link" title="$2">$1</span>');
}

// A small, safe markdown → HTML pass (escapes first). Handles headings,
// bold/italic/code/links, and unordered/ordered lists.
function renderMarkdown(raw) {
  const lines = escapeHtml(raw).split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>` + list.items.map((i) => `<li>${mdInline(i)}</li>`).join('') + `</${list.type}>`); list = null; }
  };
  const flush = () => { flushPara(); flushList(); };

  for (const line of lines) {
    const t = line.trim();
    let m;
    if (!t) { flush(); }
    else if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { flush(); const lvl = Math.min(m[1].length + 1, 4); out.push(`<h${lvl}>${mdInline(m[2])}</h${lvl}>`); }
    else if (/^(---+|—)$/.test(t)) { flush(); out.push('<hr>'); }
    else if ((m = t.match(/^[-*]\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = t.match(/^\d+\.\s+(.*)$/))) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); }
    else { flushList(); para.push(t); }
  }
  flush();
  return out.join('');
}

const currentText = () => els.editor.value;

// ── live "thinking" view: a token counter that climbs as the model works ───
// claude -p flushes its stream-json mostly at the end, so the real count lands
// late. We climb by elapsed time during the wait and let the real count (when
// it arrives) raise the floor and set the finish — so it animates throughout.
let thinkUnsub = null;
let thinkRaf = 0, thinkActive = false, thinkT0 = 0, thinkDisplayed = 0, thinkReal = 0;
const TOKEN_RATE = 34; // approx tokens/sec for the live climb

function thinkLoop(ts) {
  if (!thinkActive) return;
  if (!thinkT0) thinkT0 = ts;
  const elapsed = (ts - thinkT0) / 1000;
  // monotonic: climb by time, but never below a real count we've observed
  thinkDisplayed = Math.max(thinkDisplayed, elapsed * TOKEN_RATE, thinkReal);
  const n = Math.round(thinkDisplayed);
  els.thinkStream.innerHTML = `${n.toLocaleString()}<span class="unit">tokens</span>`;
  thinkRaf = requestAnimationFrame(thinkLoop);
}

function startThinking(label) {
  els.loadingText.textContent = label;
  thinkActive = true; thinkT0 = 0; thinkDisplayed = 0; thinkReal = 0;
  els.thinkStream.innerHTML = `0<span class="unit">tokens</span>`;
  els.thinkStream.hidden = false;
  setView('loading');
  thinkUnsub = window.daybook.onGenStream(({ tokens }) => {
    if (typeof tokens === 'number' && tokens > thinkReal) thinkReal = tokens;
  });
  thinkRaf = requestAnimationFrame(thinkLoop);
}
function stopThinking() {
  thinkActive = false;
  if (thinkUnsub) { thinkUnsub(); thinkUnsub = null; }
  cancelAnimationFrame(thinkRaf);
  els.thinkStream.hidden = true;
}

// ── boot: first run → introduce from history; else → daily digest ──────────
async function boot() {
  setView('loading');
  els.loadingText.textContent = 'Getting set up…';
  let b;
  try { b = await window.daybook.bootstrap(); } catch (e) { return fail(e.message || String(e)); }
  ctx.name = b.name || b.handle || 'you';
  ctx.server = b.server || '';
  els.postingAs.innerHTML = `posting to <b>${hostLabel(b.server)}</b>`;
  if (!b.hasKey) return showConnect(); // no identity yet — join the Router first
  if (b.hasKey) setStreak(); // header streak — non-blocking
  if (b.introduced) return run();
  // Pre-fetch the intro context + first question now, while they read the
  // welcome, so clicking Begin is instant.
  introPrefetch = window.daybook.introStart().catch((e) => ({ error: e.message || String(e) }));
  window.daybook.warmWhisper(); // load the transcription model now, so speaking is fast later
  showWelcome();
}

// The header streak: consecutive days you've posted to the Router. Set at boot
// and refreshed after each post. Non-blocking; a failed fetch just shows blank.
async function setStreak() {
  let n = 0;
  try { const r = await window.daybook.getStreak(); n = (r && r.streak) || 0; }
  catch { n = 0; }
  els.date.innerHTML = n >= 1
    ? `<span class="streak-n">${n}</span> day streak`
    : '<span class="streak-zero">start a streak</span>';
}

// No identity yet: join the Router in-app (generate → register → save rc).
function showConnect() {
  els.connectErr.hidden = true;
  setView('connect');
  setTimeout(() => els.connectInvite.focus(), 0);
}
async function doJoin() {
  const invite = els.connectInvite.value.trim();
  const handle = els.connectHandle.value.trim().replace(/^@/, '');
  els.connectErr.hidden = true;
  if (!handle) { els.connectErr.textContent = 'Choose a handle.'; els.connectErr.hidden = false; return; }
  els.connectJoin.disabled = true; els.connectJoin.textContent = 'Joining…';
  try {
    await window.daybook.join({ invite, handle });
    boot(); // re-bootstrap — now that we have a key, proceed to the welcome
  } catch (e) {
    els.connectErr.textContent = e.message || String(e);
    els.connectErr.hidden = false;
  } finally {
    els.connectJoin.disabled = false; els.connectJoin.textContent = 'Join the Router →';
  }
}

// Already have a key? Validate + save it (no new identity, no handle needed).
async function doUseKey() {
  const key = els.connectKey.value.trim();
  els.connectErr.hidden = true;
  if (!key) { els.connectKey.focus(); return; }
  els.connectUseKey.disabled = true; els.connectUseKey.textContent = 'Checking…';
  try {
    await window.daybook.useKey({ key });
    boot(); // re-bootstrap — we now have a valid key
  } catch (e) {
    els.connectErr.textContent = e.message || String(e);
    els.connectErr.hidden = false;
  } finally {
    els.connectUseKey.disabled = false; els.connectUseKey.textContent = 'Use key →';
  }
}

const MAX_TURNS = 5;
let ivTranscript = [];   // [{ q, hint, a }]
let ivIndex = 0;
let ivProjectCount = 0;
let ivMode = 'intro';    // 'intro' (onboarding) | 'refine' (sharpen a daily draft)
let ivMax = MAX_TURNS;   // turn cap for the active interview (intro 5, refine 3)
let refineDraft = '';    // the draft the refine interview is sharpening
let introPrefetch = null; // promise of intro-start, warmed during the welcome

// First run: one natural welcome note, grounded in your recent work. Shows
// instantly with a soft placeholder; the full message fills in a beat later.
function showWelcome() {
  const fallback =
    'The Router is the cohort’s shared notebook — a live feed where the builders around you post what they’re making, wrestling with, and looking for. You’ll answer a few questions about your work, and they become an introduction you approve before anything posts.';
  els.welcomeBody.innerHTML = '<span class="shimmer">reading your work…</span>';
  setView('welcome');
  // start the big welcome disco ball once the card is visible (sized)
  if (!welcomeBallOn) { welcomeBallOn = true; requestAnimationFrame(() => startDiscoBall(els.discoballWelcome)); }
  window.daybook.welcomeMessage()
    .then((r) => { els.welcomeBody.textContent = (r && r.message) ? r.message : fallback; })
    .catch(() => { els.welcomeBody.textContent = fallback; });
}

// Dynamic, archive-style interview: an opening question, then real follow-ups,
// all generated through the Claude Code SDK (claude -p).
async function startInterview() {
  mode = 'intro';
  ivMode = 'intro';
  ivMax = MAX_TURNS;
  ivTranscript = [];
  ivIndex = 0;
  setView('loading');
  els.loadingText.textContent = 'Reading your recent work…';
  try {
    const q = await (introPrefetch || window.daybook.introStart());
    introPrefetch = null;
    if (q && q.error) throw new Error(q.error);
    ivProjectCount = q.projectCount || 0;
    if (!q.question) return buildIntro();
    ivTranscript.push({ q: q.question, hint: q.hint || '', a: '' });
    showQuestion(0);
    setView('interview');
  } catch (e) { fail(e.message || String(e)); }
}

function showQuestion(i) {
  if (answerState === 'recording') stopRecording();
  const item = ivTranscript[i];
  els.ivProgress.textContent = `Question ${i + 1}`;
  els.ivQuestion.textContent = item.q;
  els.ivHint.textContent = item.hint || '';
  els.ivHint.hidden = !item.hint;
  els.ivAnswer.value = item.a || '';
  setAnswer(item.a && item.a.trim() ? 'text' : 'speak'); // speech-first by default
  els.ivBack.style.visibility = i === 0 ? 'hidden' : 'visible';
  // We don't know if this is the last question until the model says done, but
  // offer to wrap up from the last turn onward.
  const wrapLabel = ivMode === 'refine' ? 'Rewrite the draft →' : 'Write my introduction →';
  els.ivNext.textContent = i >= ivMax - 1 ? wrapLabel : 'Next →';
  if (answerState === 'text') setTimeout(() => els.ivAnswer.focus(), 0);
}

function ivStore() { if (ivTranscript[ivIndex]) ivTranscript[ivIndex].a = els.ivAnswer.value; }

let advancing = false; // guard so stop-to-submit + the Next button can't double-fire
async function ivNext() {
  if (advancing) return;
  advancing = true;
  try {
    await finishVoiceInput(); // capture any in-flight recording/transcription — never lose it
    ivStore();
    const wrap = () => (ivMode === 'refine' ? applyRefine() : buildIntro());
    // Going forward from an already-seen question?
    if (ivIndex < ivTranscript.length - 1) { ivIndex++; return showQuestion(ivIndex); }
    if (ivIndex >= ivMax - 1) return wrap();

    // Ask the model for a natural follow-up — show the token count climb live.
    startThinking('Thinking of the next question…');
    const qa = ivTranscript.map(({ q, a }) => ({ q, a }));
    // If the question hangs or errors, DON'T trap them on the loading screen —
    // fall through to writing from what we have so far.
    let res;
    try {
      res = ivMode === 'refine'
        ? await window.daybook.refineNext({ transcript: qa, draft: refineDraft })
        : await window.daybook.introNext({ transcript: qa });
    } catch { stopThinking(); return wrap(); }
    stopThinking();
    if (!res || res.done || !res.question) return wrap();
    ivTranscript.push({ q: res.question, hint: res.hint || '', a: '' });
    ivIndex++;
    showQuestion(ivIndex);
    setView('interview');
  } catch (e) {
    stopThinking();
    fail(e.message || String(e));
  } finally {
    advancing = false;
  }
}

async function ivBack() {
  await finishVoiceInput();
  ivStore();
  if (ivIndex > 0) { ivIndex--; showQuestion(ivIndex); }
}

// ── voice-reactive shader: a field that moves with your voice while recording ─
const VOICE_VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
const VOICE_FRAG = `precision highp float;
uniform vec2 u_res; uniform float u_time; uniform float u_level;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p*=2.0; a*=0.5; } return v; }
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;
  float lvl = u_level;
  float t = u_time * 0.25;
  vec2 q = uv * 2.4;
  q += 0.6 * vec2(fbm(q + t), fbm(q - t + 3.0));
  float n = fbm(q + lvl * 2.2);
  float r = length(uv);
  float pulse = sin(r * 12.0 - u_time * 3.5 - lvl * 9.0) * 0.5 + 0.5;
  float intensity = (n * 0.72 + pulse * 0.28) * (0.18 + lvl * 1.7);
  vec3 base = vec3(0.09, 0.06, 0.16);
  vec3 accent = vec3(0.55, 0.42, 1.0);
  vec3 col = base + accent * intensity;
  float alpha = clamp(intensity * 1.25, 0.0, 0.82);
  gl_FragColor = vec4(col, alpha);
}`;

let shader = null;

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
  return s;
}

function startVoiceShader(stream) {
  const canvas = els.voiceShader;
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true });
  if (!gl) return;
  const vs = compileShader(gl, gl.VERTEX_SHADER, VOICE_VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, VOICE_FRAG);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const u = {
    res: gl.getUniformLocation(prog, 'u_res'),
    time: gl.getUniformLocation(prog, 'u_time'),
    level: gl.getUniformLocation(prog, 'u_level'),
  };

  // audio analysis off the same mic stream (no playback)
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.8;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  els.voiceShader.hidden = false;
  // Reflow so the fade-in transition runs, then light up the whole app.
  void els.voiceShader.offsetWidth;
  els.voiceShader.classList.add('live');
  document.body.classList.add('recording'); // UI fades back, field reads across the app
  const t0 = performance.now();
  let level = 0;
  shader = { audioCtx, raf: 0 };
  const loop = () => {
    resize();
    analyser.getByteFrequencyData(data);
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length) / 255;
    level += (rms - level) * 0.3;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.res, canvas.width, canvas.height);
    gl.uniform1f(u.time, (performance.now() - t0) / 1000);
    gl.uniform1f(u.level, Math.min(level * 2.4, 1.0));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    shader.raf = requestAnimationFrame(loop);
  };
  shader.raf = requestAnimationFrame(loop);
}

function stopVoiceShader() {
  if (!shader) return;
  cancelAnimationFrame(shader.raf);
  try { shader.audioCtx.close(); } catch { /* */ }
  shader = null;
  els.voiceShader.classList.remove('live');
  document.body.classList.remove('recording'); // bring the UI back
  setTimeout(() => { els.voiceShader.hidden = true; }, 450);
}

// ── voice answer (speech-first): record → local MLX Whisper → fill box ─────
// States: speak (Speak CTA) | recording | transcribing | text (textarea shown)
let answerState = 'speak';
let micStream = null, micRecorder = null, micChunks = [];
let transcribeDone = null, transcribeResolve = null;

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
}

function renderAnswer() {
  const a = answerState;
  els.ivMic.hidden = (a === 'text');
  els.ivType.hidden = (a !== 'speak');
  els.ivAnswer.hidden = (a !== 'text');
  els.ivRedo.hidden = (a !== 'text');
  els.ivMic.classList.toggle('recording', a === 'recording');
  els.ivMic.disabled = (a === 'transcribing');
  els.ivMic.textContent = a === 'recording' ? '■ Stop & continue →'
    : a === 'transcribing' ? 'Transcribing…' : '🎙 Speak your answer';
  els.ivAnswerArea.classList.toggle('mode-text', a === 'text');
}
function setAnswer(a) { answerState = a; renderAnswer(); }

async function startRecording() {
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch {
    els.ivHint.hidden = false; els.ivHint.textContent = 'Microphone unavailable — type instead.';
    setAnswer('text'); els.ivAnswer.focus(); return;
  }
  const base = els.ivAnswer.value.trim();
  micChunks = [];
  transcribeDone = new Promise((r) => { transcribeResolve = r; });
  micRecorder = new MediaRecorder(micStream);
  micRecorder.ondataavailable = (e) => { if (e.data && e.data.size) micChunks.push(e.data); };
  micRecorder.onstop = async () => {
    stopVoiceShader();
    micStream.getTracks().forEach((t) => t.stop());
    setAnswer('transcribing');
    let text = '';
    try {
      const blob = new Blob(micChunks, { type: micRecorder.mimeType || 'audio/webm' });
      text = await window.daybook.transcribeAudio({ base64: await blobToBase64(blob) });
    } catch { /* keep what we have */ }
    els.ivAnswer.value = text ? (base ? base + ' ' + text : text) : base;
    setAnswer('text');
    els.ivAnswer.focus();
    const done = transcribeResolve; transcribeResolve = null; transcribeDone = null;
    if (done) done();
  };
  micRecorder.start();
  startVoiceShader(micStream);
  setAnswer('recording');
}

function stopRecording() {
  if (micRecorder && answerState === 'recording') { try { micRecorder.stop(); } catch { /* */ } }
}

function micToggle() {
  if (answerState === 'recording') ivNext();   // stop = transcribe + submit
  else if (answerState !== 'transcribing') startRecording();
}

// Never advance with an answer still recording or transcribing — wait for it.
async function finishVoiceInput() {
  if (answerState === 'recording') stopRecording();
  if (transcribeDone) await transcribeDone;
}

// Write the full intro from the interview transcript (connections from answers).
async function buildIntro() {
  mode = 'intro';
  await finishVoiceInput(); // don't write the intro while an answer is still transcribing
  ivStore();
  els.post.textContent = 'Post introduction →';
  els.skip.textContent = 'Skip for now';
  startThinking('Writing your introduction…');
  try {
    const res = await window.daybook.introWrite({ transcript: ivTranscript.map(({ q, a }) => ({ q, a })) });
    stopThinking();
    applyResult(res);
    els.quiet.hidden = true;
    els.eyebrow.textContent = ivProjectCount
      ? `Your introduction · from ${ivProjectCount} projects`
      : 'Your introduction';
  } catch (e) { stopThinking(); fail(e.message || String(e)); }
}

// OPTIONAL: jump into the interview engine to sharpen the CURRENT daily draft.
// Reuses the same interview view; on wrap-up the answers rewrite the draft via
// the normal revise path. Only offered for daily digests, never the intro.
// `seed` is the bundled first question (from generate) — when present the
// interview opens INSTANTLY on it, no round-trip. Falls back to refine:start.
async function startRefine(seed) {
  if (mode === 'intro') return;
  refineDraft = currentText();
  if (!refineDraft.trim()) return;
  ivMode = 'refine';
  ivMax = 3;
  ivIndex = 0;
  if (seed && typeof seed === 'string') {
    ivTranscript = [{ q: seed, hint: '', a: '' }];
    showQuestion(0);
    return setView('interview');
  }
  ivTranscript = [];
  setView('loading');
  els.loadingText.textContent = 'Reading your draft…';
  try {
    const q = await window.daybook.refineStart({ draft: refineDraft });
    if (q && q.error) throw new Error(q.error);
    if (!q.question) return applyRefine();
    ivTranscript.push({ q: q.question, hint: q.hint || '', a: '' });
    showQuestion(0);
    setView('interview');
  } catch (e) { fail(e.message || String(e)); }
}

async function applyRefine() {
  await finishVoiceInput();
  ivStore();
  ivMode = 'intro'; // revert to the default once we leave the interview
  const qa = ivTranscript.map(({ q, a }) => ({ q, a })).filter((t) => (t.a || '').trim());
  if (!qa.length) return setView('reflect'); // nothing said — keep the draft as-is
  startThinking('Rewriting the draft…');
  try {
    const res = await window.daybook.refineWrite({ transcript: qa, draft: refineDraft });
    stopThinking();
    applyResult(res);
  } catch (e) { stopThinking(); fail(e.message || String(e)); }
}

// ── flow ───────────────────────────────────────────────────────────────────
// Instant-open: a finished draft is precomputed (on a schedule + in the
// background) and cached. If today's cache is usable, paint it immediately —
// no ~20-50s wait — and only regenerate in the background when it's stale.
async function run() {
  mode = 'digest';
  els.eyebrow.textContent = 'Cohort digest';
  els.post.textContent = 'Post to cohort →';
  els.skip.textContent = 'Skip';

  let cache = null;
  try { cache = await window.daybook.getCachedDraft(); }
  catch { /* no cache → cold build below */ }
  if (cache && cache.usable) {
    paintRecord(cache.record);
    if (!cache.fresh) silentRefresh(); // newer work since precompute → refresh quietly
    return;
  }

  // Cold path (first draft of the day, or stale-day cache): build it now,
  // showing real streamed model progress.
  await rebuildDraft('open');
}

// Fill the recessed stats strip + project pills (shared by the cached and cold
// paths). `stats` and `peers` come straight off a draft record.
function fillStats(stats, peers) {
  if (!stats) return;
  els.sProjects.textContent = stats.projectCount;
  els.sMessages.textContent = stats.messageCount;
  els.sFiles.textContent = stats.fileCount;
  els.projlist.innerHTML = '';
  for (const p of (stats.projects || [])) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.innerHTML = `<b>${escapeHtml(p.name)}</b> · ${p.messages} msg`;
    els.projlist.appendChild(pill);
  }
  // linked machines folded into today's digest over SSH
  for (const peer of (peers || [])) {
    if (!(peer.projectCount > 0)) continue;
    const pill = document.createElement('span');
    pill.className = 'pill pill-peer';
    pill.title = `Linked over SSH · ${(peer.projects || []).join(', ')}`;
    pill.innerHTML = `⛓ <b>${escapeHtml(peer.target)}</b> · ${peer.projectCount} project${peer.projectCount === 1 ? '' : 's'}`;
    els.projlist.appendChild(pill);
  }
}

// Paint a complete draft record (from cache or a fresh build) onto the reflect
// surface. A quiet/empty day has no result → the empty screen.
function paintRecord(record) {
  ctx = {
    digest: record.sessionInputs ? record.sessionInputs.digest : '',
    name: record.name || 'you',
    dateLabel: (record.stats && record.stats.date) || 'today',
    server: record.server || '',
  };
  els.postingAs.innerHTML = `posting to <b>${hostLabel(record.server)}</b>`;
  fillStats(record.stats, record.peers);
  if (!record.hasActivity || !record.result) return showEmpty(record);
  applyResult(record.result);
}

// Silent background refresh of a stale cache: rebuild, then swap in the result
// ONLY if the user hasn't started editing (so we never clobber their edits).
async function silentRefresh() {
  let record;
  try { record = await window.daybook.buildDraft({ reason: 'refresh' }); }
  catch { return; }
  if (!record || !record.hasActivity || !record.result) return;
  if (currentText() !== cur.generated) return; // user is editing — leave it alone
  paintRecord(record);
}

// The empty state. Distinguishes a genuinely quiet day from zero-scope (repos
// were active but none are granted) — the latter gets the §6 zero-scope copy
// and a one-click "Open Scope →" affordance.
function showEmpty(collected) {
  const excluded = collected && typeof collected.excludedCount === 'number' ? collected.excludedCount : 0;
  if (excluded > 0) {
    els.emptyStatus.textContent = 'Quiet scope — no repos granted yet.';
    els.emptySub.textContent =
      'Nothing to post means nothing leaves. Open Scope to let the Router see a repo when you\'re ready.';
    els.emptyOpenScope.hidden = false;
  } else {
    els.emptyStatus.textContent = 'No new Claude or Codex activity since your last post — yet.';
    els.emptySub.textContent = 'Come back after some work and the Router will have a reflection ready.';
    els.emptyOpenScope.hidden = true;
  }
  setView('empty');
}
els.emptyOpenScope.addEventListener('click', () => showScope('reflect'));

function applyResult(res) {
  cur.text = res.post || '';
  cur.generated = res.post || '';
  // The draft IS the editor — drop the text straight in, editable.
  els.editor.value = cur.text;
  // Bundled refine opener: show the question + CTA under the draft (daily
  // drafts only, and only when the model offered a question).
  ctx.firstQuestion = (mode === 'intro') ? '' : (res.firstQuestion || '');
  if (ctx.firstQuestion) els.refineQ.textContent = ctx.firstQuestion;
  els.refinePrompt.hidden = !ctx.firstQuestion;
  els.quiet.hidden = !res.quietDay;
  if (res.quietDay) {
    els.quiet.querySelector('span').textContent =
      "Quiet day — what's in scope didn't have much worth a cohort post. Nothing posts.";
  }
  setView('reflect');
}

// Build (or rebuild) the draft now, showing the live token counter as the model
// writes (real stream-json progress, not a fabricated number).
async function rebuildDraft(reason) {
  startThinking('Reading your work and writing the update…');
  let record;
  try { record = await window.daybook.buildDraft({ reason }); }
  catch (e) { stopThinking(); return fail(e.message || String(e)); }
  stopThinking();
  paintRecord(record);
}

function fail(msg) { els.errorText.textContent = msg; setView('error'); }

// ── actions ────────────────────────────────────────────────────────────────
// The actual public egress. Posts the (already twice-scrubbed) draft.
async function doPost() {
  const content = currentText().trim();
  if (!content) return;
  els.post.disabled = true; els.skip.disabled = true;
  els.post.textContent = 'Posting…';
  try {
    const res = await window.daybook.post(content);
    if (mode === 'intro') await window.daybook.markIntroduced();
    const who = res.handle ? '@' + res.handle : (res.pseudonym || 'you');
    const what = mode === 'intro' ? 'Your introduction is posted' : 'Posted';
    els.successSub.textContent =
      `${what} as ${who} to ${hostLabel(res.server)}. It’s held in staging and stays deletable for a while before it goes public.`;
    setView('success');
    setStreak(); // you just posted — the streak may have ticked up
    // Show the feed you just joined — your post and the room's, newest first.
    loadFeed(els.successFeed, { limit: 8, emptyMsg: 'Your post is staged — it’ll appear here once it’s live.' });
  } catch (e) {
    fail(e.message || String(e));
  } finally {
    els.post.disabled = false; els.skip.disabled = false;
    els.post.textContent = 'Post to cohort →';
  }
}

els.post.addEventListener('click', () => {
  const content = currentText().trim();
  if (!content) return;
  // Secrets are scrubbed deterministically in the post handler (main.js) before
  // anything leaves; no confirm step.
  doPost();
});

els.connectJoin.addEventListener('click', doJoin);
els.connectHandle.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
els.connectHaveKey.addEventListener('click', () => {
  els.connectKeyRow.hidden = false;
  els.connectHaveKey.hidden = true;
  els.connectKey.focus();
});
els.connectUseKey.addEventListener('click', doUseKey);
els.connectKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUseKey(); });
els.connectInvite.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
els.welcomeBegin.addEventListener('click', startInterview);
els.welcomeSkip.addEventListener('click', async () => { await window.daybook.markIntroduced(); run(); });
els.ivNext.addEventListener('click', ivNext);
els.ivBack.addEventListener('click', ivBack);
els.ivMic.addEventListener('click', micToggle);
els.ivType.addEventListener('click', () => { setAnswer('text'); els.ivAnswer.focus(); });
els.ivRedo.addEventListener('click', startRecording);
els.ivAnswer.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ivNext();
});
els.ivSkip.addEventListener('click', () => (ivMode === 'refine' ? applyRefine() : buildIntro())); // "Wrap up →"
els.refineCta.addEventListener('click', () => startRefine(ctx.firstQuestion));
els.startover.addEventListener('click', () => (mode === 'intro' ? buildIntro() : rebuildDraft('manual')));
els.skip.addEventListener('click', async () => {
  if (mode === 'intro') { await window.daybook.markIntroduced(); return run(); }
  // Skipping today's post isn't a dead end — drop into the cohort feed (back
  // returns to the draft if you change your mind) rather than closing.
  showFeed('reflect');
});

// ── scope manager (#scope) — pick which repos the Router can see ──────────────
async function showScope(returnTo) {
  scopeReturnView = returnTo || 'reflect';
  setView('scope');
  try { scopeState = await window.daybook.scopeGet(); }
  catch (e) { scopeState = null; }
  renderScopeManager();
}

// One flat, alphabetical list of every repo with recent activity. A checkbox
// per repo = in scope or not. That's the whole control surface.
function renderScopeManager() {
  const s = scopeState || { included: [], excluded: [], newRepos: [] };
  const rows = []
    .concat((s.included || []).map((r) => ({ r, included: true })))
    .concat((s.newRepos || []).map((r) => ({ r, included: false })))
    .concat((s.excluded || []).map((r) => ({ r, included: false })));
  rows.sort((a, b) => (a.r.label || '').localeCompare(b.r.label || ''));

  els.scopeList.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'scope-empty';
    empty.textContent = 'No repos with recent activity yet.';
    els.scopeList.appendChild(empty);
    return;
  }
  for (const { r, included } of rows) els.scopeList.appendChild(repoRow(r, included));
}

// A repo row is a checkbox + name + path. Toggling writes an explicit
// include/exclude override (which wins over everything). No live re-render, so
// the row doesn't jump as you click; the next open reloads fresh.
function repoRow(r, included) {
  const row = document.createElement('label');
  row.className = 'scope-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = included;
  cb.addEventListener('change', async () => {
    try {
      scopeState = await window.daybook.scopeOverride({
        fullPath: r.fullPath, decision: cb.checked ? 'include' : 'exclude',
      });
    } catch (e) { cb.checked = !cb.checked; } // revert on failure
  });
  const text = document.createElement('span');
  text.className = 'sx-text';
  text.innerHTML =
    `<span class="sx-name">${escapeHtml(r.label)}</span>` +
    `<span class="sx-path">${escapeHtml(r.fullPath)}</span>`;
  row.appendChild(cb);
  row.appendChild(text);
  return row;
}

els.openScope.addEventListener('click', () => showScope('reflect'));
els.scopeBack.addEventListener('click', () => setView(scopeReturnView));
els.scopeSave.addEventListener('click', () => setView(scopeReturnView));

// ── cohort feed (#feed + inline on success) ─────────────────────────────────
// One reading surface: your posts and the room's, newest first, yours marked.
// Renders into any container so the persistent view and the post-success card
// share the same row markup.
function feedRow(e) {
  const row = document.createElement('div');
  row.className = 'feed-item' + (e.mine ? ' feed-mine' : '');
  const who = e.mine ? 'you' : (e.handle ? '@' + e.handle : (e.pseudonym || 'someone'));
  const head = document.createElement('div');
  head.className = 'feed-item-head';
  head.innerHTML =
    `<span class="feed-who">${escapeHtml(who)}</span>` +
    `<span class="feed-date">${escapeHtml(e.date || '')}</span>`;
  const body = document.createElement('div');
  body.className = 'feed-item-body';
  body.textContent = e.content || '';
  row.appendChild(head);
  row.appendChild(body);
  return row;
}

// Fetch + paint the feed into `container`. `limit` caps how many rows show
// (the success card shows a short peek; the full view shows more). Failures and
// emptiness render a calm one-liner rather than throwing.
async function loadFeed(container, { limit = 50, emptyMsg = 'No posts in the feed yet.' } = {}) {
  if (!container) return;
  container.innerHTML = '<div class="feed-empty">Loading the feed…</div>';
  let res;
  try { res = await window.daybook.getFeed({ days: 30, limit: 100 }); }
  catch (e) { res = { ok: false, error: e.message || String(e) }; }
  container.innerHTML = '';
  if (!res || !res.ok) {
    const err = document.createElement('div');
    err.className = 'feed-empty';
    err.textContent = (res && res.error) ? res.error : 'Could not reach the feed.';
    container.appendChild(err);
    return;
  }
  const entries = (res.entries || []).slice(0, limit);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'feed-empty';
    empty.textContent = emptyMsg;
    container.appendChild(empty);
    return;
  }
  for (const e of entries) container.appendChild(feedRow(e));
}

async function showFeed(returnTo) {
  // Return to where we came from, but only if it's a stable surface — never
  // back into a transient/onboarding view.
  feedReturnView = ['reflect', 'success', 'empty'].includes(returnTo) ? returnTo : 'reflect';
  setView('feed');
  await loadFeed(els.feedList, { limit: 100 });
}

els.openFeedView.addEventListener('click', () => showFeed(currentView()));
els.feedBack.addEventListener('click', () => setView(feedReturnView));

// ── device link panel ───────────────────────────────────────────────────────
let linkHostUnsub = null;
let peerMode = 'code'; // 'code' (pairing-code TCP) | 'ssh'
function setPeerMode(m) {
  peerMode = m;
  els.tabCode.classList.toggle('is-on', m === 'code');
  els.tabSsh.classList.toggle('is-on', m === 'ssh');
  els.peerPaneCode.hidden = m !== 'code';
  els.peerPaneSsh.hidden = m !== 'ssh';
  els.peerErr.hidden = true;
}
async function renderSavedPeers() {
  const peers = await window.daybook.linkPeersList();
  els.sshSavedList.innerHTML = '';
  if (!peers.length) { els.sshSaved.hidden = true; return; }
  els.sshSaved.hidden = false;
  for (const p of peers) {
    const row = document.createElement('div');
    row.className = 'ssh-saved-row';
    const name = document.createElement('span');
    name.className = 'ssh-saved-name';
    name.textContent = p.target;
    const rm = document.createElement('button');
    rm.className = 'ssh-saved-rm';
    rm.title = 'Stop including this machine';
    rm.setAttribute('aria-label', 'Stop including ' + p.target);
    rm.textContent = '×';
    rm.addEventListener('click', async () => { await window.daybook.linkPeerRemove(p.target); renderSavedPeers(); });
    row.appendChild(name); row.appendChild(rm);
    els.sshSavedList.appendChild(row);
  }
}
async function showLink() {
  setView('link');
  renderSavedPeers();
  const st = await window.daybook.linkStatus();
  if (st.host && st.host.running) { els.hostCode.value = st.host.code; els.hostStatus.textContent = `${st.host.peers} peer${st.host.peers === 1 ? '' : 's'} connected`; els.hostIdle.hidden = true; els.hostActive.hidden = false; }
  else { els.hostIdle.hidden = false; els.hostActive.hidden = true; }
  if (st.sshConnected) { peerMode = 'ssh'; els.peerIdle.hidden = true; els.peerActive.hidden = false; els.peerStatus.textContent = `Connected over SSH · ${st.sshTarget || ''}`; }
  else if (st.peerConnected) { peerMode = 'code'; els.peerIdle.hidden = true; els.peerActive.hidden = false; els.peerStatus.textContent = 'Connected to this machine.'; }
  else { els.peerIdle.hidden = false; els.peerActive.hidden = true; setPeerMode(peerMode); }
}
els.tabCode.addEventListener('click', () => setPeerMode('code'));
els.tabSsh.addEventListener('click', () => setPeerMode('ssh'));
els.openLink.addEventListener('click', showLink);
els.linkBack.addEventListener('click', boot);

els.hostStart.addEventListener('click', async () => {
  els.hostStart.disabled = true;
  const info = await window.daybook.linkHostStart({ recent: els.permRecent.checked, raw: els.permRaw.checked });
  els.hostStart.disabled = false;
  if (!info) { els.hostStatus.textContent = 'Could not start sharing.'; return; }
  els.hostCode.value = info.code;
  els.hostStatus.textContent = `${info.peers} peer${info.peers === 1 ? '' : 's'} connected · ${info.ip}:${info.port}`;
  els.hostIdle.hidden = true; els.hostActive.hidden = false;
  if (linkHostUnsub) linkHostUnsub();
  linkHostUnsub = window.daybook.onLinkHostChanged((i) => { if (i) els.hostStatus.textContent = `${i.peers} peer${i.peers === 1 ? '' : 's'} connected · ${i.ip}:${i.port}`; });
});
els.hostStop.addEventListener('click', async () => { await window.daybook.linkHostStop(); if (linkHostUnsub) { linkHostUnsub(); linkHostUnsub = null; } els.hostIdle.hidden = false; els.hostActive.hidden = true; });
els.hostCode.addEventListener('focus', () => els.hostCode.select());

els.peerConnect.addEventListener('click', async () => {
  els.peerErr.hidden = true;
  const code = els.peerCode.value.trim();
  if (!code) return;
  els.peerConnect.disabled = true; els.peerConnect.textContent = 'Connecting…';
  try {
    await window.daybook.linkConnect(code);
    peerMode = 'code';
    els.peerIdle.hidden = true; els.peerActive.hidden = false; els.peerResult.textContent = '';
    els.peerStatus.textContent = 'Connected to this machine.';
  } catch (e) { els.peerErr.textContent = e.message || String(e); els.peerErr.hidden = false; }
  finally { els.peerConnect.disabled = false; els.peerConnect.textContent = 'Connect →'; }
});
els.peerSshConnect.addEventListener('click', async () => {
  els.peerErr.hidden = true;
  const target = els.peerSsh.value.trim();
  if (!target) return;
  els.peerSshConnect.disabled = true; els.peerSshConnect.textContent = 'Connecting…';
  try {
    const r = await window.daybook.linkSshConnect(target);
    peerMode = 'ssh';
    els.peerIdle.hidden = true; els.peerActive.hidden = false; els.peerResult.textContent = '';
    const has = [r.hasClaude && 'Claude', r.hasCodex && 'Codex'].filter(Boolean).join(' + ');
    els.peerStatus.textContent = `Connected over SSH · ${r.target}${has ? ` (${has} logs)` : ''}`;
    renderSavedPeers();
  } catch (e) { els.peerErr.textContent = e.message || String(e); els.peerErr.hidden = false; }
  finally { els.peerSshConnect.disabled = false; els.peerSshConnect.textContent = 'Connect over SSH →'; }
});
els.peerSsh.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.peerSshConnect.click(); });
els.peerPullRecent.addEventListener('click', async () => {
  els.peerResult.textContent = 'Pulling recent work…';
  try {
    const r = peerMode === 'ssh' ? await window.daybook.linkSshRecent(30) : await window.daybook.linkPeerRecent(30);
    if (r.type === 'error') { els.peerResult.textContent = r.error; return; }
    const cap = r.truncated ? ' (capped)' : '';
    els.peerResult.textContent = `Recent work — ${r.projectCount} projects${cap}:\n${(r.projects || []).join(', ')}\n\n${(r.digest || '').slice(0, 600)}…`;
  } catch (e) { els.peerResult.textContent = e.message || String(e); }
});
els.peerPullRaw.addEventListener('click', async () => {
  els.peerResult.textContent = 'Pulling raw logs…';
  try {
    const r = peerMode === 'ssh' ? await window.daybook.linkSshRaw(7) : await window.daybook.linkPeerRaw(7);
    if (r.type === 'error') { els.peerResult.textContent = r.error; return; }
    const kb = Math.round((r.totalBytes || 0) / 1024);
    els.peerResult.textContent = `Raw logs — ${r.files.length} session files, ${kb} KB${r.truncated ? ' (capped)' : ''}:\n` + r.files.slice(0, 12).map((f) => `• ${f.source}/${f.name}`).join('\n');
  } catch (e) { els.peerResult.textContent = e.message || String(e); }
});
els.peerDisconnect.addEventListener('click', async () => {
  if (peerMode === 'ssh') await window.daybook.linkSshDisconnect();
  else await window.daybook.linkDisconnect();
  els.peerIdle.hidden = false; els.peerActive.hidden = true; setPeerMode(peerMode);
});
els.retry.addEventListener('click', boot);
els.openFeed.addEventListener('click', () => window.daybook.openFeed(ctx.server));

// When the daily precompute finishes (or its notification is clicked), pick up
// the freshly-cached draft — but only on the daily flow, never mid-onboarding.
window.daybook.onPrecomputeReady(() => {
  if (mode === 'digest' && ['reflect', 'empty', 'success', 'loading'].includes(currentView())) run();
});

startDiscoBall(els.discoball);
boot();
