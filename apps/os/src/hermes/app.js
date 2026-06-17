// Hermes / "brain" — local-first cohort Q&A with a pick-your-engine backend.
//
// Three backends, auto-detected, chosen in the "engine" dropdown:
//   • Ollama — a local open-weight model on 127.0.0.1:11434. The renderer talks
//              to it directly; nothing ever leaves the machine.
//   • Codex  — the user's `codex` CLI (ChatGPT Plus/Pro sub), via the main process.
//   • Claude — the user's `claude` CLI (Claude sub), via the main process.
//
// Codex and Claude are REMOTE (a hosted model on the user's own subscription),
// so the privacy gate in engine.js only lets PUBLIC cohort grounding
// reach them. The grounding here is cohort-surface.json — already the cohort-
// public projection — so the gate passes. No API key is pasted; nothing is
// stored or sent to our servers; the chat is not persisted. The footer line
// reflects the active backend's locality.

const OLLAMA = "http://127.0.0.1:11434";
const OLLAMA_PROBE_MS = 1200;  // bound the detection probe — a missing daemon fails fast
// Ollama generate options, one home for both call sites. Synthesis (define my
// shape) runs cooler than open chat for steadier JSON.
const OLLAMA_OPTS = { num_ctx: 8192, temperature: { chat: 0.5, synth: 0.4 } };

const els = {
  ollamaChip:   document.getElementById("ollama-chip"),
  modelChip:    document.getElementById("model-chip"),
  dataChip:     document.getElementById("data-chip"),
  shapeChip:    document.getElementById("shape-chip"),
  setupPanel:     document.getElementById("setup-panel"),
  engineCards:    document.getElementById("engine-cards"),
  connectRecheck: document.getElementById("connect-recheck"),
  connectStart:   document.getElementById("connect-start"),
  askPanel:       document.getElementById("ask-panel"),
  backendSelect:document.getElementById("backend-select"),
  modelLabel:   document.getElementById("model-label"),
  modelSelect:  document.getElementById("model-select"),
  detectBtn:    document.getElementById("detect-again"),
  scanShapeBtn: document.getElementById("scan-shape"),
  defineShapeBtn: document.getElementById("define-shape"),
  question:     document.getElementById("question"),
  starterChips: document.getElementById("starter-chips"),
  askBtn:       document.getElementById("ask"),
  stopBtn:      document.getElementById("stop"),
  response:     document.getElementById("response"),
  footer:       document.getElementById("footer-stats"),
  privacyNote:  document.getElementById("privacy-note"),
};

let cohort = null;
let chosenModel = null;
let abortController = null;      // ollama streaming fetch
let backend = "ollama";         // "ollama" | "codex" | "claude"
let tinaBackends = {};          // { codex: {label, available, version}, claude: {...} }
let tinaOff = null;             // active tina onChunk unsubscribe
let shape = null;               // the user's self-shape (github + codex), if scanned
let ollamaStatus = { running: false, models: [], hermes: [] };
let inFlight = false;            // a run (ask / define / scan) is active — gate re-entry

// ─── ollama discovery ─────────────────────────────────────────────────

async function detectOllama() {
  els.ollamaChip.className = "chip";
  els.ollamaChip.textContent = "ollama: checking…";
  // Bound the probe: a missing daemon should fail in ~1s, not hang ~2.6s on a
  // slow connection-refused (keeps first paint fast).
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_MS);
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { method: "GET", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return { ok: true, models: data.models || [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function classifyModels(models) {
  // Hermes-family models on the Ollama registry: "hermes3", "nous-hermes2",
  // "openhermes", etc. Anything with "hermes" in the name counts.
  const hermes = models.filter(m => /hermes/i.test(m.name));
  const others = models.filter(m => !/hermes/i.test(m.name));
  return { hermes, others };
}

// ─── codex / claude discovery (main process) ──────────────────────────

async function detectTina() {
  if (!window.api || !window.api.tina) { tinaBackends = {}; return tinaBackends; }
  try { tinaBackends = (await window.api.tina.backends()) || {}; }
  catch { tinaBackends = {}; }
  return tinaBackends;
}

// ─── setup panel (shown only when NO engine is available) ─────────────

// ── onboarding: "connect your engine" ─────────────────────────────────

const CONNECT_STEPS = {
  codex: 'Uses your ChatGPT Plus/Pro. In a terminal: <code>npm i -g @openai/codex</code>, then <code>codex login</code>.',
  claude: 'Uses your Claude subscription. In a terminal: <code>npm i -g @anthropic-ai/claude-code</code>, then run <code>claude</code> and sign in.',
  ollama: 'A model on your own machine, fully offline. Install from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>, then <code>ollama pull hermes3:8b</code>.',
};

function engineState() {
  // detectBackends omits a version string (a cold `--version` is too slow), so
  // the CLI detail is a fixed, honest line rather than a phantom version field.
  const cli = (key, label) => {
    const connected = !!(tinaBackends[key] && tinaBackends[key].available);
    return { key, label, connected, detail: connected ? "uses your subscription" : null };
  };
  return [
    cli("codex", "Codex"),
    cli("claude", "Claude"),
    { key: "ollama", label: "Ollama", connected: !!(ollamaStatus.running && ollamaStatus.models.length), detail: ollamaStatus.running ? `${ollamaStatus.models.length} model(s)` : null },
  ];
}

// The engine's locality map is authoritative (surfaced over the detection IPC).
// 'local' backends (Ollama) may receive private grounding; 'remote' ones
// (codex/claude) get public only. Reading it here gives the privacy rule ONE
// source instead of a hand-maintained `backend === "ollama"` re-derivation.
function localityOf(b) {
  if (b === "ollama") return "local";
  return (tinaBackends[b] && tinaBackends[b].locality) || "remote";
}

function renderConnectPanel() {
  els.setupPanel.hidden = false;
  els.askPanel.hidden = true;
  // Clear any boot "connecting…" placeholder while the connect panel is up.
  if (els.response.classList.contains("empty")) els.response.textContent = "responses appear here.";
  const states = engineState();
  els.engineCards.innerHTML = states.map((e) => `
    <div class="engine-card ${e.connected ? "on" : ""}">
      <div class="engine-head"><span class="engine-name">${e.label}</span><span class="engine-status">${e.connected ? "✓ connected" : "not connected"}</span></div>
      ${e.connected
        ? `<div class="engine-detail">${e.detail || ""}</div>`
        : `<div class="engine-steps">${CONNECT_STEPS[e.key]} <strong>Then click re-check.</strong></div>`}
    </div>`).join("");
  els.connectStart.disabled = !states.some((e) => e.connected);
}

function showAsk() {
  els.setupPanel.hidden = true;
  els.askPanel.hidden = false;
  const ollamaUsable = !!(ollamaStatus.running && ollamaStatus.models.length);
  if (ollamaUsable) {
    const preferred = ollamaStatus.hermes[0] || ollamaStatus.models[0];
    fillOllamaModels(ollamaStatus.models, preferred && preferred.name);
  }
  renderBackendSelector(ollamaUsable);
  renderStarters();
  // The welcome is the empty-state of the chat box: it onboards the member in
  // place and is replaced by the first real answer.
  const empty = !els.response.textContent.trim() || els.response.classList.contains("empty") || els.response.classList.contains("welcome");
  if (empty) renderWelcome();
}

// ─── in-chat onboarding ───────────────────────────────────────────────
// The chat box onboards a new member itself: a conversational welcome (the
// empty-state), clickable starter questions, and a deterministic meta-intercept
// ("help", "hi", "what can you do?") that orients them WITHOUT spending an LLM
// call — so it works even before an engine is connected.

const STARTERS = [
  "I'm new here — who should I meet first?",
  "Who can help me with TEE attestation?",
  "Find someone to pair with on Rust",
  "Who's working on prediction markets, and what should I ask them?",
];

// Matches a STANDALONE greeting/orientation utterance only — anchored to the
// whole message (+ optional trailing punctuation) so a real query that merely
// BEGINS with one of these tokens ("help me find someone on Rust", "what is
// this team building?") falls through to the engine instead of being eaten as
// onboarding.
const META_RE = /^\s*(help|\?|hi|hey|hello|yo|who are you|what are you|what (is|are) (this|you)|what can (you|i) (do|ask)|what do you do|how (do i|do|does) (this|it) (work|do)|how (do i|to) use( (this|it))?|get(ting)? started|onboard|tour)\s*[?.!]*\s*$/i;

function usableEngines() { return engineState().filter((e) => e.connected); }

function activeEngineLabel() {
  if (backend === "ollama") return "Ollama (local)";
  return (tinaBackends[backend] && tinaBackends[backend].label) || backend;
}

function engineStatusLine() {
  const usable = usableEngines().map((e) => e.label);
  if (!usable.length) return 'No engine connected yet — click "engines" above to set up Codex, Claude, or Ollama.';
  const active = activeEngineLabel();
  const others = usable.filter((l) => !active.startsWith(l));
  return `Engine: ${active}${others.length ? `  ·  also available: ${others.join(", ")}` : ""}  ·  switch via "engines".`;
}

function renderStarters() {
  if (!els.starterChips) return;
  els.starterChips.innerHTML = "";
  for (const q of STARTERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter-chip";
    b.textContent = q;
    b.addEventListener("click", () => { els.question.value = q; dispatchAsk(); });
    els.starterChips.appendChild(b);
  }
}

function renderWelcome() {
  const shapeLine = (shape && shape.github)
    ? "Your shape is scanned, so I can tailor answers to what you're working on."
    : 'Tip: click "scan my shape" and I\'ll tailor answers to what you work on.';
  els.response.className = "response-wrap welcome";
  els.response.textContent = [
    "ask cohort — your cohort connector",
    "",
    "I help you find the right people in the Shape Rotator cohort and how to engage them.",
    "Ask in plain language and I'll name who to talk to, what to go to them for, and a good",
    "opener. You reach out yourself — I never message anyone for you, and nothing is stored.",
    "",
    'Tap a starter below to begin, or type your own question. (Type "help" anytime for this.)',
    "",
    engineStatusLine(),
    shapeLine,
  ].join("\n");
}

// ─── engine + model selectors ─────────────────────────────────────────

function fillOllamaModels(models, preferredName) {
  els.modelSelect.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.name;
    const size = m.details?.parameter_size || "";
    opt.textContent = size ? `${m.name}  ·  ${size}` : m.name;
    els.modelSelect.appendChild(opt);
  }
  if (preferredName) els.modelSelect.value = preferredName;
  chosenModel = els.modelSelect.value;
}

function renderBackendSelector(ollamaUsable) {
  const opts = [];
  if (ollamaUsable) opts.push({ value: "ollama", label: "Ollama · local" });
  for (const key of ["codex", "claude"]) {
    const bk = tinaBackends[key];
    if (bk && bk.available) opts.push({ value: key, label: `${bk.label} · your sub` });
  }
  els.backendSelect.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    els.backendSelect.appendChild(opt);
  }
  // Keep the current backend if it's still available, else fall to the first.
  if (!opts.some(o => o.value === backend)) backend = opts[0] ? opts[0].value : "ollama";
  els.backendSelect.value = backend;
  setBackend(backend);
}

function setBackend(b) {
  backend = b;
  const isOllama = b === "ollama";
  els.modelSelect.hidden = !isOllama;
  els.modelLabel.hidden = !isOllama;
  if (isOllama) {
    els.modelChip.textContent = `model: ${chosenModel || "—"}`;
    els.privacyNote.innerHTML = "<strong>local-only</strong> · prompts + responses never leave your machine";
  } else {
    const label = (tinaBackends[b] && tinaBackends[b].label) || b;
    els.modelChip.textContent = `engine: ${label}`;
    els.privacyNote.innerHTML = `<strong>via your ${label} subscription</strong> · public cohort data only · nothing stored, nothing sent to our servers`;
  }
}

async function refreshDetection() {
  // Probe Ollama and the CLIs concurrently — they're independent, so first paint
  // waits on the slower one (~2.5s), not their sum (~7s).
  const [probe] = await Promise.all([detectOllama(), detectTina()]);
  if (probe.ok) {
    const { hermes, others } = classifyModels(probe.models);
    ollamaStatus = { running: true, models: [...hermes, ...others], hermes };
    els.ollamaChip.className = "chip ok";
    els.ollamaChip.textContent = "ollama: running";
  } else {
    const tinaUsable = Object.values(tinaBackends).some((b) => b && b.available);
    ollamaStatus = { running: false, models: [], hermes: [] };
    els.ollamaChip.className = tinaUsable ? "chip" : "chip bad";
    els.ollamaChip.textContent = "ollama: not running";
  }
}

async function runDetection() {
  await refreshDetection();
  const anyEngine = engineState().some((e) => e.connected);
  // No engine at all → the connect panel (the one mechanical step we can't skip).
  // Otherwise land directly in the chat box, which onboards the member itself
  // (welcome empty-state + starters + "help").
  if (!anyEngine) { renderConnectPanel(); return; }
  showAsk();
}

// Reachable anytime via the ask-panel "engines" button — refresh status + show
// the connect screen (so a member can connect/switch engine without a restart).
async function openConnect() { await refreshDetection(); renderConnectPanel(); }

// ─── cohort surface loading ───────────────────────────────────────────

async function loadCohort() {
  els.dataChip.textContent = "cohort: loading…";
  try {
    const r = await fetch("../cohort-surface.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const surface = await r.json();
    cohort = surface;
    const ppl = surface.people?.length || 0;
    const tms = surface.teams?.length || 0;
    els.dataChip.className = "chip ok";
    els.dataChip.textContent = `cohort: ${ppl}p / ${tms}t`;
  } catch {
    // The data-chip already surfaces the failure to the user; no console in
    // committed code (and it would forward to the host's stderr).
    els.dataChip.className = "chip bad";
    els.dataChip.textContent = "cohort: failed to load";
  }
}

// ─── prompt building (cohort-public projection only) ──────────────────

function buildContext() {
  if (!cohort) return "(no cohort data loaded)";
  const people = (cohort.people || []).map(p => ({
    name: p.name, team: p.team, role: p.role,
    skills: p.skills, skill_areas: p.skill_areas,
    offering: p.offering, seeking: p.seeking,
    now: p.now, weekly_intention: p.weekly_intention,
  }));
  const teams = (cohort.teams || []).map(t => ({
    name: t.name, focus: t.focus, skill_areas: t.skill_areas,
    seeking: t.seeking, offering: t.offering,
  }));
  return JSON.stringify({ people, teams }, null, 0);
}

function buildPrompt(question) {
  const parts = [
    "You are a connector for the Shape Rotator cohort — you help members FIND the right people and understand how to ENGAGE them. You have read-only access to the cohort's public profile data (names, teams, skills, what they're working on, what they're seeking, what they offer).",
    "",
    "When the question is about finding people or teams (who can help with X, who's working on Y, who to talk to about Z, who to pair with), name the specific members or teams and, for EACH one, give: WHAT TO GO TO THEM FOR (grounded in a short quote from their profile) and a good CONVERSATION OPENER. For other questions, cite specific members or teams by name and quote short snippets when useful.",
    "",
    "You only surface who and why — never draft an outreach message, offer to contact anyone, or imply you can reach them; the member reaches out themselves. If the data doesn't contain an answer, say so plainly — don't invent participants.",
  ];
  // The user's own "shape" (their GitHub + Codex work history), if scanned. The
  // public GitHub section is always safe; the private Codex section is included
  // only for a LOCAL backend — never sent to a remote one (codex/claude).
  const includePrivate = localityOf(backend) === "local";
  const sg = buildShapeGrounding(shape, includePrivate);
  if (sg.text) {
    parts.push(
      "",
      "The person asking is the OS user — the following is THEIR OWN shape (you are their assistant). Use it to answer questions about their work, focus, strengths, or trajectory:",
      "<user_shape>", sg.text, "</user_shape>",
    );
  }
  parts.push("", "<cohort_data>", buildContext(), "</cohort_data>", "", `User question: ${question}`);
  // dataMode reflects what the prompt ACTUALLY contains (hasPrivate can only be
  // true on a local backend), so the engine's assertBackendAllowed gate is a real
  // backstop against private→remote, not a rubber stamp.
  return { prompt: parts.join("\n"), dataMode: sg.hasPrivate ? "private_distilled" : "public" };
}

// ─── self-shape (github + codex) ──────────────────────────────────────

// Format a scanned shape for the prompt → { text, hasPrivate }. Public GitHub is
// always safe; the private Codex section is added only when includePrivate (a
// local backend). hasPrivate reports whether private content was actually
// emitted, so the caller can tag dataMode honestly. Sole owner of this format
// (the main-process scanner no longer duplicates it).
function buildShapeGrounding(s, includePrivate) {
  if (!s) return { text: "", hasPrivate: false };
  const g = s.github || {}, c = s.codex || {};
  const lines = [];
  if (g.ok) {
    lines.push(`GitHub (public): ${g.name || g.login}${g.company ? " · " + g.company : ""}${g.bio ? " — " + String(g.bio).replace(/\s+/g, " ").trim() : ""}`);
    if (g.languages && g.languages.length) lines.push(`Languages: ${g.languages.slice(0, 6).map(l => `${l.lang}(${l.repos})`).join(", ")}`);
    if (g.recent_repos && g.recent_repos.length) lines.push(`Recent repos: ${g.recent_repos.slice(0, 10).map(r => `${r.name}${r.lang ? "/" + r.lang : ""}`).join(", ")}`);
  }
  let hasPrivate = false;
  if (includePrivate && c.ok && c.total_sessions) {
    hasPrivate = true;
    lines.push(`Local work focus (private — Codex ${c.date_range.first}→${c.date_range.last}, ${c.total_sessions} sessions / ${c.project_count} projects):`);
    lines.push(c.top_projects.slice(0, 10).map(p => `${p.project} (${p.sessions})`).join(", "));
  }
  return { text: lines.join("\n"), hasPrivate };
}

function updateShapeChip() {
  if (!shape || !shape.github) { els.shapeChip.className = "chip"; els.shapeChip.textContent = "shape: not scanned"; return; }
  const g = shape.github, c = shape.codex || {};
  const repos = g.ok ? ((g.recent_repos && g.recent_repos.length) || g.public_repos || 0) : 0;
  els.shapeChip.className = "chip ok";
  els.shapeChip.textContent = `shape: ${repos} repos / ${c.total_sessions || 0} sess`;
}

async function loadShape() {
  if (!window.api || !window.api.shape) { els.shapeChip.textContent = "shape: —"; return; }
  try { shape = await window.api.shape.get(); } catch { shape = null; }
  updateShapeChip();
}

async function scanShape() {
  if (inFlight) return;
  if (!window.api || !window.api.shape) return;
  inFlight = true;
  setBusy(true);
  const label = els.scanShapeBtn.textContent;
  els.scanShapeBtn.textContent = "scanning…";
  els.shapeChip.textContent = "shape: scanning…";
  try {
    shape = await window.api.shape.scan();
    updateShapeChip();
    const g = shape.github || {}, c = shape.codex || {};
    els.response.className = "response-wrap";
    els.response.textContent =
      `shape updated — GitHub: ${(g.recent_repos || []).length} public repos (${(g.languages || []).slice(0, 4).map(l => l.lang).join(", ")}); ` +
      `Codex: ${c.total_sessions || 0} sessions across ${c.project_count || 0} projects (${c.date_range && c.date_range.first}→${c.date_range && c.date_range.last}).\n\n` +
      `Ask "what's my shape?" or "what should I focus on?" and I'll use this. (Private Codex detail only goes to a local model.)`;
  } catch (e) {
    els.shapeChip.textContent = "shape: scan failed";
    els.response.className = "response-wrap";
    els.response.textContent = `[shape scan failed: ${e.message || e}]`;
  } finally {
    inFlight = false;
    setBusy(false);
    els.scanShapeBtn.textContent = label;
  }
}

// Run one prompt through the CURRENT backend (non-streaming) → { ok, text }.
// Ollama goes direct (local); codex/claude via the main process + privacy gate.
async function runPrompt(prompt, { dataMode = "public" } = {}) {
  if (backend === "ollama") {
    if (!chosenModel) return { ok: false, error: "no model selected" };
    try {
      const r = await fetch(`${OLLAMA}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: chosenModel, prompt, stream: false, options: { temperature: OLLAMA_OPTS.temperature.synth, num_ctx: OLLAMA_OPTS.num_ctx } }),
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, text: String(j.response || "").trim() };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  if (!window.api || !window.api.tina) return { ok: false, error: "backend unavailable" };
  return window.api.tina.run({ backend, prompt, dataMode, requestId: `syn-${Date.now()}` });
}

function buildSynthesisPrompt(grounding) {
  return [
    "You are defining the OS user's professional \"shape\" from their OWN work data below. Be concrete and base every claim on the data; do not invent.",
    "Respond with ONLY a JSON object — no prose, no markdown fences — with exactly these keys:",
    '{"headline": "one-line shape summary", "current_focus": "what they are working on now", "likely_roles": ["..."], "strengths": ["..."], "what_to_go_to_them_for": ["..."], "conversation_affordances": ["good things to talk to them about"], "trajectory": "how their focus is shifting over time", "confidence": "low|medium|high"}',
    "Keep each array to 3-5 short items. If something isn't supported by the data, use an empty array or \"unknown\".",
    "",
    "<shape_data>",
    grounding,
    "</shape_data>",
  ].join("\n");
}

function parseShapeJson(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function renderShapeCard(m, includePrivate) {
  const list = (x) => (Array.isArray(x) && x.length) ? x.map(s => "  • " + s).join("\n") : "  —";
  els.response.className = "response-wrap";
  els.response.textContent = [
    `YOUR SHAPE${m.confidence ? `  (confidence: ${m.confidence})` : ""}  ·  ${includePrivate ? "incl. local Codex work" : "public GitHub only"}`,
    "",
    m.headline || "",
    "",
    `Current focus:  ${m.current_focus || "unknown"}`,
    `Trajectory:     ${m.trajectory || "unknown"}`,
    "",
    "Likely roles:", list(m.likely_roles),
    "Strengths:", list(m.strengths),
    "Go to them for:", list(m.what_to_go_to_them_for),
    "Talk to them about:", list(m.conversation_affordances),
  ].join("\n");
}

async function defineMyShape() {
  if (inFlight) return;
  if (!shape) { els.response.className = "response-wrap"; els.response.textContent = 'Click "scan my shape" first.'; return; }
  const includePrivate = localityOf(backend) === "local";
  const grounding = buildShapeGrounding(shape, includePrivate);
  if (!grounding.text) { els.response.className = "response-wrap"; els.response.textContent = "No shape data yet — scan first."; return; }

  inFlight = true;
  setBusy(true);
  const label = els.defineShapeBtn.textContent;
  els.defineShapeBtn.textContent = "reading…";
  els.response.className = "response-wrap";
  els.response.textContent = "defining your shape…";

  try {
    // dataMode tracks the actual grounding: private only when we included the
    // local Codex tier (local backend), which the gate then allows; public for a
    // remote backend, which the gate enforces.
    const r = await runPrompt(buildSynthesisPrompt(grounding.text), { dataMode: grounding.hasPrivate ? "private_distilled" : "public" });
    if (!r || !r.ok) { els.response.textContent = `[${(r && r.error) || "failed"}]`; return; }
    const mapping = parseShapeJson(r.text);
    if (!mapping) { els.response.textContent = `couldn't parse a shape from the engine. raw:\n\n${String(r.text || "").slice(0, 600)}`; return; }
    renderShapeCard(mapping, includePrivate);
    if (window.api && window.api.shape && window.api.shape.saveSynthesis) {
      try { await window.api.shape.saveSynthesis({ synthesis: { ...mapping, tier: includePrivate ? "public+private" : "public", backend } }); } catch {}
    }
  } catch (e) {
    els.response.textContent = `[error: ${e.message || e}]`;
  } finally {
    inFlight = false;
    setBusy(false);
    els.defineShapeBtn.textContent = label;
  }
}

// ─── inference: ollama (loopback HTTP, streaming) ─────────────────────

async function askOllama(question) {
  if (!chosenModel) { els.response.textContent = "no model selected"; return; }
  inFlight = true;
  setBusy(true);
  els.response.className = "response-wrap";
  els.response.textContent = "thinking…";
  els.stopBtn.hidden = false;
  abortController = new AbortController();

  const started = Date.now();
  let tokens = 0;
  let streamed = false;
  const { prompt } = buildPrompt(question);
  const body = {
    model: chosenModel,
    prompt,
    stream: true,
    options: { temperature: OLLAMA_OPTS.temperature.chat, num_ctx: OLLAMA_OPTS.num_ctx },
  };

  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) {
            if (!streamed) { els.response.textContent = ""; streamed = true; }
            els.response.textContent += obj.response;
            tokens++;
            els.response.scrollTop = els.response.scrollHeight;
          }
        } catch {}
      }
    }
    if (!streamed) els.response.textContent = "(no output)"; // empty stream — don't strand "thinking…"
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    els.footer.textContent = `${tokens} chunks · ${elapsed}s · ${chosenModel}`;
  } catch (e) {
    if (!streamed) els.response.textContent = ""; // drop the "thinking…" placeholder
    els.response.textContent += e.name === "AbortError" ? "[stopped]" : `[error: ${e.message}]`;
  } finally {
    inFlight = false;
    setBusy(false);
    els.stopBtn.hidden = true;
    abortController = null;
  }
}

// ─── inference: codex / claude (main process CLI, via window.api.tina) ─

async function askTina(question, b) {
  if (!window.api || !window.api.tina) { els.response.textContent = "[brain backend unavailable — relaunch the app]"; return; }
  els.response.className = "response-wrap";
  // The CLI cold-starts (~10s) and claude text-mode often flushes once at the
  // end, so show activity until the first real output arrives.
  els.response.textContent = "thinking… your engine is starting up (the first answer can take ~10s).";
  inFlight = true;
  setBusy(true);
  els.stopBtn.hidden = false;
  const requestId = `tina-${Date.now()}`;
  const started = Date.now();
  let streamed = false;

  if (tinaOff) { tinaOff(); tinaOff = null; }
  tinaOff = window.api.tina.onChunk((p) => {
    if (!p || p.requestId !== requestId) return;
    if (!streamed) { els.response.textContent = ""; streamed = true; }
    els.response.textContent += p.chunk;
    els.response.scrollTop = els.response.scrollHeight;
  });

  try {
    // dataMode is derived from the prompt's actual grounding (public unless
    // private shape detail was included, which only happens on a local backend),
    // so the main-process gate enforces the same fact that controls inclusion.
    const { prompt, dataMode } = buildPrompt(question);
    const r = await window.api.tina.run({ backend: b, prompt, dataMode, requestId });
    if (!streamed) els.response.textContent = ""; // drop the "thinking…" placeholder
    if (!r || !r.ok) {
      const msg = (r && r.error) || "request failed";
      els.response.textContent += (els.response.textContent ? "\n\n" : "") + `[${msg}]`;
    } else if (!streamed) {
      els.response.textContent = r.text || "(no output)";
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    els.footer.textContent = `${elapsed}s · ${(tinaBackends[b] && tinaBackends[b].label) || b}`;
  } catch (e) {
    els.response.textContent += `\n\n[error: ${e.message || e}]`;
  } finally {
    if (tinaOff) { tinaOff(); tinaOff = null; }
    inFlight = false;
    setBusy(false);
    els.stopBtn.hidden = true;
  }
}

// Disable every run-initiating control while a run is active, so a starter
// chip, scan, or define click can't clobber a streaming answer or fight over
// the shared askBtn/stopBtn/abortController state.
function setBusy(busy) {
  els.askBtn.disabled = busy;
  els.scanShapeBtn.disabled = busy;
  els.defineShapeBtn.disabled = busy;
  for (const chip of els.starterChips.querySelectorAll(".starter-chip")) chip.disabled = busy;
}

function dispatchAsk() {
  if (inFlight) return;
  const q = els.question.value.trim();
  if (!q) return;
  // Onboarding / meta questions ("help", "hi", "what can you do?") are answered
  // in-box, instantly, with no engine round-trip — so newcomers get oriented
  // even before connecting an engine.
  if (META_RE.test(q)) { renderWelcome(); els.question.value = ""; return; }
  if (!usableEngines().length) {
    els.response.className = "response-wrap";
    els.response.textContent = 'Connect an engine first — click "engines" above to set up Codex, Claude, or Ollama, then ask again.';
    return;
  }
  if (backend === "ollama") askOllama(q); else askTina(q, backend);
}

function dispatchStop() {
  if (backend === "ollama") { if (abortController) abortController.abort(); }
  else if (window.api && window.api.tina) window.api.tina.stop();
}

// ─── event wiring ─────────────────────────────────────────────────────

els.detectBtn.addEventListener("click", () => openConnect());
els.connectRecheck.addEventListener("click", () => openConnect());
els.connectStart.addEventListener("click", () => showAsk());
els.scanShapeBtn.addEventListener("click", scanShape);
els.defineShapeBtn.addEventListener("click", defineMyShape);
els.backendSelect.addEventListener("change", () => setBackend(els.backendSelect.value));
els.modelSelect.addEventListener("change", () => {
  chosenModel = els.modelSelect.value;
  if (backend === "ollama") els.modelChip.textContent = `model: ${chosenModel}`;
});
els.askBtn.addEventListener("click", dispatchAsk);
els.stopBtn.addEventListener("click", dispatchStop);
els.question.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); dispatchAsk(); }
});

// ─── boot ─────────────────────────────────────────────────────────────

(async () => {
  // Reads as activity (not a frozen box) during the ~2.5s engine detection;
  // runDetection() replaces it with the welcome (showAsk) or the connect panel.
  els.response.className = "response-wrap empty";
  els.response.textContent = "connecting to your engine…";
  await loadCohort();
  await runDetection();
  await loadShape();
})();
