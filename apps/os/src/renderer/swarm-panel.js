import { loadStylesheetOnce } from "./stylesheet-loader.js";

let stylesheetPromise = null;
let controller = null;

function $(id) {
  return document.getElementById(id);
}

export function warmSwarmPanel() {
  if (!stylesheetPromise) {
    stylesheetPromise = loadStylesheetOnce("renderer/swarm-panel.css");
  }
  return stylesheetPromise;
}

function createSwarmPanelController() {
  const panel        = $("swarm-panel");
  if (!panel) return null;

  const form         = $("swarm-form");
  const queryEl      = $("swarm-query");
  const modelEl      = $("swarm-model");
  const parallelEl   = $("swarm-parallel");
  const startBtn     = $("swarm-start-btn");
  const stopBtn      = $("swarm-stop-btn");
  const statusDot    = $("swarm-status-dot");
  const statusLine   = $("swarm-status-line");
  const traceEl      = $("swarm-trace");
  const preMsg       = $("swarm-pre-message");
  const settingsBtn  = $("swarm-settings-btn");
  const settingsEl   = $("swarm-settings");
  const settingsClose= $("swarm-settings-close");
  const keyInput     = $("swarm-anthropic-key");
  const baseInput    = $("swarm-ollama-base");
  const saveBtn      = $("swarm-settings-save");
  const settingsStat = $("swarm-settings-status");

  if (!form || !queryEl || !modelEl || !parallelEl || !startBtn || !stopBtn
    || !statusDot || !statusLine || !traceEl || !preMsg || !settingsBtn
    || !settingsEl || !settingsClose || !keyInput || !baseInput || !saveBtn
    || !settingsStat) {
    return null;
  }

  let currentRequestId = null;
  let outputDispose = null;
  let statusDispose = null;

  function open() {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    try {
      const searchInput = document.getElementById("search-input");
      if (searchInput && searchInput.value && !queryEl.value) {
        queryEl.value = searchInput.value;
      }
    } catch {}
    setTimeout(() => queryEl.focus(), 60);
    window.addEventListener("keydown", onKey, true);
    refreshAgentReadiness();
  }

  function close() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    window.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    if (!settingsEl.hidden) {
      closeSettings();
      return;
    }
    close();
  }

  function openSettings() {
    settingsEl.hidden = false;
    settingsEl.setAttribute("aria-hidden", "false");
    settingsStat.textContent = "";
    settingsStat.className = "swarm-settings-status";
    window.api.getSwarmConfig().then((cfg) => {
      keyInput.value = "";
      keyInput.placeholder = cfg.hasApiKey
        ? "sk-ant-... (saved · type new key to replace)"
        : "sk-ant-...  (stored encrypted in your keychain)";
      baseInput.value = cfg.lmApiBase || "";
      if (!cfg.safeStorageAvailable) {
        settingsStat.textContent = "warning · safeStorage not available; key would be stored plaintext";
        settingsStat.className = "swarm-settings-status is-error";
      }
    }).catch(() => {});
    setTimeout(() => keyInput.focus(), 60);
  }

  function closeSettings() {
    settingsEl.hidden = true;
    settingsEl.setAttribute("aria-hidden", "true");
  }

  async function refreshAgentReadiness() {
    try {
      const cfg = await window.api.getSwarmConfig();
      if (cfg.lmModel) {
        const opt = [...modelEl.options].find((o) => o.value === cfg.lmModel);
        if (opt) modelEl.value = cfg.lmModel;
      }
      if (!cfg.agent.binFound) {
        startBtn.disabled = true;
        setPreMsg("research-agent binary not found. Install at ~/research-swarm (git clone dmarzzz/research-swarm; uv sync) or set RESEARCH_AGENT_BIN. The swarm needs the Python CLI to run.", "error");
        return;
      }
      startBtn.disabled = false;
      if (modelEl.value.startsWith("anthropic/") && !cfg.hasApiKey) {
        setPreMsg("Anthropic model selected but no API key configured. Click the settings icon to add one.", "info");
      } else {
        setPreMsg("");
      }
    } catch (e) {
      setPreMsg(`config check failed: ${e.message}`, "error");
    }
  }

  function setStatus(state, line) {
    statusDot.dataset.state = state;
    statusLine.textContent = line;
  }

  function setPreMsg(msg, kind) {
    preMsg.textContent = msg || "";
    preMsg.className = "swarm-pre-message" + (kind ? ` is-${kind}` : "");
  }

  function clearTrace() {
    traceEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "swarm-trace-empty";
    empty.id = "swarm-trace-empty";
    empty.textContent = "starting swarm...";
    traceEl.appendChild(empty);
  }

  function appendTraceLine(stream, text) {
    const empty = traceEl.querySelector("#swarm-trace-empty");
    if (empty) empty.remove();
    const line = document.createElement("span");
    line.className = "swarm-trace-line" + (stream === "stderr" ? " is-stderr" : "");
    line.textContent = text;
    traceEl.appendChild(line);
    traceEl.appendChild(document.createTextNode("\n"));
    const nearBottom = (traceEl.scrollHeight - traceEl.scrollTop - traceEl.clientHeight) < 80;
    if (nearBottom) traceEl.scrollTop = traceEl.scrollHeight;
  }

  function appendDivider() {
    const div = document.createElement("div");
    div.className = "swarm-trace-line is-divider";
    traceEl.appendChild(div);
  }

  async function startRun(e) {
    if (e) e.preventDefault();
    const q = (queryEl.value || "").trim();
    if (!q) {
      setPreMsg("type a question first.", "info");
      return;
    }
    setPreMsg("");

    if (outputDispose) {
      outputDispose();
      outputDispose = null;
    }
    if (statusDispose) {
      statusDispose();
      statusDispose = null;
    }
    clearTrace();
    setStatus("running", "spawning...");
    startBtn.hidden = true;
    stopBtn.hidden = false;

    const requestId = `req_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    currentRequestId = requestId;

    try { await window.api.setSwarmConfig({ lmModel: modelEl.value }); } catch {}

    outputDispose = window.api.onSwarmOutput((p) => {
      if (p.requestId !== currentRequestId) return;
      appendTraceLine(p.stream, p.line);
    });
    statusDispose = window.api.onSwarmStatus((s) => {
      if (s.state === "running") {
        setStatus("running", `running · ${s.requestId.slice(0, 16)}`);
      } else if (s.state === "idle") {
        if (s.exitCode === 0) {
          setStatus("done", `done · ${Math.round((s.durationMs || 0) / 1000)}s`);
        } else if (s.signal === "SIGTERM" || s.signal === "SIGKILL") {
          setStatus("idle", `cancelled · ${s.signal}`);
        } else {
          setStatus("error", `exited code=${s.exitCode}`);
        }
        startBtn.hidden = false;
        stopBtn.hidden = true;
        appendDivider();
      }
    });

    try {
      const res = await window.api.swarmStart({
        requestId,
        query: q,
        lmModel: modelEl.value,
        parallel: !!parallelEl.checked,
        workers: 3,
      });
      if (!res || !res.ok) {
        setStatus("error", `failed · ${res?.reason || "unknown"}`);
        setPreMsg(`start failed: ${res?.detail || res?.reason || "unknown"}`, "error");
        startBtn.hidden = false;
        stopBtn.hidden = true;
      }
    } catch (err) {
      setStatus("error", `failed · ${err.message}`);
      setPreMsg(`start threw: ${err.message}`, "error");
      startBtn.hidden = false;
      stopBtn.hidden = true;
    }
  }

  async function stopRun() {
    try { await window.api.swarmStop(); } catch {}
  }

  panel.querySelectorAll("[data-swarm-close]").forEach((el) => {
    el.addEventListener("click", close);
  });
  form.addEventListener("submit", startRun);
  stopBtn.addEventListener("click", stopRun);
  settingsBtn.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  saveBtn.addEventListener("click", async () => {
    const opts = { lmApiBase: baseInput.value.trim() };
    const keyVal = keyInput.value.trim();
    if (keyVal) opts.lmApiKey = keyVal;
    try {
      const res = await window.api.setSwarmConfig(opts);
      if (res && res.ok) {
        settingsStat.textContent = "saved.";
        settingsStat.className = "swarm-settings-status is-saved";
        keyInput.value = "";
        setTimeout(closeSettings, 700);
        refreshAgentReadiness();
      } else {
        settingsStat.textContent = "save failed";
        settingsStat.className = "swarm-settings-status is-error";
      }
    } catch (e) {
      settingsStat.textContent = `save failed: ${e.message}`;
      settingsStat.className = "swarm-settings-status is-error";
    }
  });
  modelEl.addEventListener("change", () => {
    refreshAgentReadiness();
  });

  return { open };
}

function getController() {
  if (!controller) controller = createSwarmPanelController();
  return controller;
}

export async function openSwarmPanel() {
  await warmSwarmPanel();
  const activeController = getController();
  if (!activeController) {
    console.warn("[swarm] panel markup missing");
    return;
  }
  activeController.open();
}
