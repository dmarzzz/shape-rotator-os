// Hermes PoC — local-first cohort Q&A via Ollama.
//
// Detects an Ollama daemon at http://127.0.0.1:11434, lists installed
// models, and (if a Hermes-family one is present) lets the user ask
// questions grounded in the bundled cohort surface. All inference is
// local; the only network calls are to Ollama on loopback and to
// GitHub (for the live cohort surface — falls back to the bundled
// fixture).
//
// This window is opened from the app menu via main.js → createHermesWindow.

const OLLAMA = "http://127.0.0.1:11434";

const els = {
  ollamaChip:  document.getElementById("ollama-chip"),
  modelChip:   document.getElementById("model-chip"),
  dataChip:    document.getElementById("data-chip"),
  setupPanel:  document.getElementById("setup-panel"),
  setupBody:   document.getElementById("setup-body"),
  askPanel:    document.getElementById("ask-panel"),
  modelSelect: document.getElementById("model-select"),
  detectBtn:   document.getElementById("detect-again"),
  question:    document.getElementById("question"),
  askBtn:      document.getElementById("ask"),
  stopBtn:     document.getElementById("stop"),
  response:    document.getElementById("response"),
  footer:      document.getElementById("footer-stats"),
};

let cohort = null;
let chosenModel = null;
let abortController = null;

// ─── ollama discovery ─────────────────────────────────────────────────

async function detectOllama() {
  els.ollamaChip.className = "chip";
  els.ollamaChip.textContent = "ollama: checking…";
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return { ok: true, models: data.models || [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function classifyModels(models) {
  // Hermes-family models on the Ollama registry: "hermes3", "nous-hermes2",
  // "openhermes", etc. Anything with "hermes" in the name counts.
  const hermes = models.filter(m => /hermes/i.test(m.name));
  const others = models.filter(m => !/hermes/i.test(m.name));
  return { hermes, others };
}

function renderSetup(state) {
  els.setupPanel.hidden = false;
  els.askPanel.hidden = true;
  els.setupBody.innerHTML = "";

  if (state.kind === "no-ollama") {
    els.ollamaChip.className = "chip bad";
    els.ollamaChip.textContent = "ollama: not running";
    els.setupBody.innerHTML = `
      <p>Hermes runs on top of <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> — a local inference daemon. Install once, then any Hermes (or other open-weight) model runs entirely on your machine.</p>
      <ol>
        <li>install Ollama: <code>brew install ollama</code> (or download from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a>)</li>
        <li>start it: <code>ollama serve</code> (runs on 127.0.0.1:11434)</li>
        <li>pull a Hermes model: <code>ollama pull hermes3:8b</code> (~4.7 GB)</li>
        <li>click <strong>re-detect</strong> above</li>
      </ol>
    `;
  } else if (state.kind === "no-hermes") {
    els.ollamaChip.className = "chip ok";
    els.ollamaChip.textContent = "ollama: running";
    const list = state.models.map(m => `<li><code>${m.name}</code></li>`).join("");
    els.setupBody.innerHTML = `
      <p>Ollama is running, but you don't have any Hermes-family models installed.</p>
      <p>Pull one:</p>
      <ol>
        <li><code>ollama pull hermes3:8b</code> — Nous Hermes 3 on Llama 3.1 8B (~4.7 GB, fastest)</li>
        <li><code>ollama pull hermes3:70b</code> — bigger but slower (~40 GB; needs ~48 GB RAM)</li>
        <li><code>ollama pull nous-hermes2:34b</code> — older Hermes 2 on Yi 34B (~19 GB)</li>
      </ol>
      <p>Installed models you have: <code>${list || "(none)"}</code></p>
      <p>The PoC also works with any non-Hermes Ollama model if you'd prefer to pick from the dropdown after re-detecting.</p>
    `;
  }
}

function renderAsk(models, preferredName) {
  els.setupPanel.hidden = true;
  els.askPanel.hidden = false;
  els.ollamaChip.className = "chip ok";
  els.ollamaChip.textContent = "ollama: running";
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
  els.modelChip.textContent = `model: ${chosenModel}`;
}

async function runDetection() {
  const probe = await detectOllama();
  if (!probe.ok) {
    renderSetup({ kind: "no-ollama" });
    return;
  }
  const { hermes, others } = classifyModels(probe.models);
  const usable = hermes.length ? hermes : [];
  if (!hermes.length && others.length) {
    // User has Ollama + non-Hermes models. Show setup with the install
    // hint, but also surface the existing models in the dropdown so the
    // PoC is usable with whatever they've got.
    renderAsk([...hermes, ...others], others[0]?.name);
    renderSetupInlineHint(others);
    return;
  }
  if (!hermes.length) {
    renderSetup({ kind: "no-hermes", models: probe.models });
    return;
  }
  renderAsk([...hermes, ...others], hermes[0]?.name);
}

function renderSetupInlineHint(others) {
  els.setupPanel.hidden = false;
  els.setupBody.innerHTML = `
    <p>No Hermes-family model detected, but you have <code>${others.map(m => m.name).join(", ")}</code> installed. The dropdown above will use those for now.</p>
    <p>To get the real thing: <code>ollama pull hermes3:8b</code></p>
  `;
}

// ─── cohort surface loading ───────────────────────────────────────────

async function loadCohort() {
  els.dataChip.textContent = "cohort: loading…";
  try {
    // Try the bundled fixture first — it ships with the app and is
    // always present. The renderer's cohort-source.js does a live fetch
    // from GitHub on top of this, but for the PoC the fixture is fine.
    const r = await fetch("../cohort-surface.json");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const surface = await r.json();
    cohort = surface;
    const ppl = surface.people?.length || 0;
    const tms = surface.teams?.length || 0;
    els.dataChip.className = "chip ok";
    els.dataChip.textContent = `cohort: ${ppl}p / ${tms}t`;
  } catch (e) {
    els.dataChip.className = "chip bad";
    els.dataChip.textContent = "cohort: failed to load";
    console.error("cohort load failed:", e);
  }
}

// ─── prompt building ──────────────────────────────────────────────────

function buildContext() {
  // Hand Hermes a compact JSON view of the cohort. We deliberately strip
  // the heavier fields (bios, long-form `now`, etc.) for the PoC to keep
  // the context under most local-model context windows. The schema
  // whitelisting already happened upstream so there's no privacy
  // concern — everything in surface is cohort-public.
  if (!cohort) return "(no cohort data loaded)";
  const people = (cohort.people || []).map(p => ({
    name: p.name,
    team: p.team,
    role: p.role,
    skills: p.skills,
    skill_areas: p.skill_areas,
    offering: p.offering,
    seeking: p.seeking,
    now: p.now,
    weekly_intention: p.weekly_intention,
  }));
  const teams = (cohort.teams || []).map(t => ({
    name: t.name,
    focus: t.focus,
    skill_areas: t.skill_areas,
    seeking: t.seeking,
    offering: t.offering,
  }));
  return JSON.stringify({ people, teams }, null, 0);
}

function buildPrompt(question) {
  return [
    "You are a research companion for the Shape Rotator cohort. You have read-only access to the cohort's public profile data (names, teams, skills, what they're working on, what they're seeking, what they offer).",
    "",
    "Answer the user's question by citing specific cohort members or teams by name when relevant. Quote short snippets from their profiles when useful. If the data doesn't contain an answer, say so plainly — don't invent participants.",
    "",
    "<cohort_data>",
    buildContext(),
    "</cohort_data>",
    "",
    `User question: ${question}`,
  ].join("\n");
}

// ─── inference call (streaming) ───────────────────────────────────────

async function ask(question) {
  if (!chosenModel) { els.response.textContent = "no model selected"; return; }
  els.response.className = "response-wrap";
  els.response.textContent = "";
  els.askBtn.disabled = true;
  els.stopBtn.hidden = false;
  abortController = new AbortController();

  const started = Date.now();
  let tokens = 0;

  const body = {
    model: chosenModel,
    prompt: buildPrompt(question),
    stream: true,
    options: { temperature: 0.5, num_ctx: 8192 },
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
      // Ollama streams newline-delimited JSON.
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) {
            els.response.textContent += obj.response;
            tokens++;
            els.response.scrollTop = els.response.scrollHeight;
          }
        } catch {}
      }
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    els.footer.textContent = `${tokens} chunks · ${elapsed}s · ${chosenModel}`;
  } catch (e) {
    if (e.name === "AbortError") {
      els.response.textContent += "\n\n[stopped]";
    } else {
      els.response.textContent += `\n\n[error: ${e.message}]`;
    }
  } finally {
    els.askBtn.disabled = false;
    els.stopBtn.hidden = true;
    abortController = null;
  }
}

// ─── event wiring ─────────────────────────────────────────────────────

els.detectBtn.addEventListener("click", () => runDetection());
els.modelSelect.addEventListener("change", () => {
  chosenModel = els.modelSelect.value;
  els.modelChip.textContent = `model: ${chosenModel}`;
});
els.askBtn.addEventListener("click", () => {
  const q = els.question.value.trim();
  if (q) ask(q);
});
els.stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});
els.question.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    const q = els.question.value.trim();
    if (q) ask(q);
  }
});

// ─── boot ─────────────────────────────────────────────────────────────

(async () => {
  await loadCohort();
  await runDetection();
})();
