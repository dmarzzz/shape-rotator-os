// cohort-chat.js — the "chat with the cohort" panel controller.
//
// Streams a conversation with the member's OWN local AI CLI (Claude Code /
// Codex / Ollama, supervised by apps/os/cohort-chat-node.js), grounded in the
// live cohort surface. The renderer builds the full prompt (cohort context +
// connection edges + history + question) via cohort-chat-context.mjs and pipes
// it to the CLI's stdin through the fg:cohort-chat:* IPC; tokens stream back
// into the assistant bubble. No API key — nothing leaves the box except whatever
// that local agent itself does.

import { loadStylesheetOnce } from "./stylesheet-loader.js";
import { getCohortSurface } from "./cohort-source.js";
import { buildChatPrompt } from "./cohort-chat-context.mjs";

let stylesheetPromise = null;
let controller = null;

function $(id) { return document.getElementById(id); }

// Strip ANSI escape / control sequences a CLI may emit.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\r/g, "");
}

export function warmCohortChat() {
  if (!stylesheetPromise) stylesheetPromise = loadStylesheetOnce("renderer/cohort-chat.css");
  return stylesheetPromise;
}

function createController() {
  const panel = $("cohort-chat-panel");
  if (!panel) return null;

  const log         = $("cohort-chat-log");
  const empty       = $("cohort-chat-empty");
  const form        = $("cohort-chat-form");
  const input       = $("cohort-chat-input");
  const sendBtn     = $("cohort-chat-send");
  const stopBtn     = $("cohort-chat-stop");
  const dot         = $("cohort-chat-dot");
  const statusLine  = $("cohort-chat-status-line");
  const preMsg      = $("cohort-chat-pre-message");
  const settingsBtn = $("cohort-chat-settings-btn");
  const settingsEl  = $("cohort-chat-settings");
  const settingsClose = $("cohort-chat-settings-close");
  const cmdInput    = $("cohort-chat-cmd");
  const detectedEl  = $("cohort-chat-detected");
  const saveBtn     = $("cohort-chat-settings-save");
  const settingsStat= $("cohort-chat-settings-status");

  if (!log || !form || !input || !sendBtn || !stopBtn || !dot || !statusLine
    || !preMsg || !settingsBtn || !settingsEl || !settingsClose || !cmdInput
    || !detectedEl || !saveBtn || !settingsStat) {
    return null;
  }

  const history = [];          // [{role:'user'|'assistant', content}]
  let currentRequestId = null;
  let outputDispose = null;
  let statusDispose = null;
  let activeBubbleBody = null;  // the streaming assistant <div> being filled
  let activeBuffer = "";

  function open() {
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    window.addEventListener("keydown", onKey, true);
    setTimeout(() => input.focus(), 60);
    refreshReadiness();
  }
  function close() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    window.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    if (!settingsEl.hidden) { closeSettings(); return; }
    close();
  }

  function setStatus(state, line) { dot.dataset.state = state; statusLine.textContent = line; }
  function setPreMsg(msg, kind) {
    preMsg.textContent = msg || "";
    preMsg.className = "cohort-chat-pre-message" + (kind ? ` is-${kind}` : "");
  }

  async function refreshReadiness() {
    try {
      const cfg = await window.api.getCohortChatConfig();
      cmdInput.value = cfg.chatCmd || "";
      detectedEl.textContent = cfg.available && cfg.available.length
        ? `detected on PATH: ${cfg.available.join(", ")}${cfg.resolved ? ` · will run: ${cfg.resolved}` : ""}`
        : "no local AI CLI detected on PATH";
      if (!cfg.ready) {
        setPreMsg("No local AI found. Install Claude Code, Codex, or Ollama (or set a command in settings ⚙).", "info");
      } else {
        setPreMsg("");
      }
    } catch (e) {
      setPreMsg(`config check failed: ${e.message}`, "error");
    }
  }

  function appendBubble(role, text) {
    if (empty && empty.parentNode) empty.remove();
    const row = document.createElement("div");
    row.className = `cc-msg is-${role}`;
    const body = document.createElement("div");
    body.className = "cc-msg-body";
    body.textContent = text || "";
    row.appendChild(body);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function openSettings() {
    settingsEl.hidden = false;
    settingsEl.setAttribute("aria-hidden", "false");
    settingsStat.textContent = "";
    settingsStat.className = "cohort-chat-settings-status";
    refreshReadiness();
    setTimeout(() => cmdInput.focus(), 60);
  }
  function closeSettings() {
    settingsEl.hidden = true;
    settingsEl.setAttribute("aria-hidden", "true");
  }

  function finishRun(label) {
    setStatus("idle", label || "idle");
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    if (activeBuffer != null && activeBubbleBody) {
      const finalText = stripAnsi(activeBuffer).trim();
      activeBubbleBody.textContent = finalText || "(no output — check the local AI command in settings ⚙)";
      history.push({ role: "assistant", content: finalText });
    }
    activeBubbleBody = null;
    activeBuffer = "";
    if (outputDispose) { outputDispose(); outputDispose = null; }
    if (statusDispose) { statusDispose(); statusDispose = null; }
  }

  async function send(e) {
    if (e) e.preventDefault();
    const q = (input.value || "").trim();
    if (!q) return;
    setPreMsg("");

    appendBubble("user", q);
    history.push({ role: "user", content: q });
    input.value = "";
    autosize();

    let surface = null;
    try { surface = await getCohortSurface(); } catch {}
    if (!surface) { setPreMsg("cohort data isn't loaded yet — try again in a moment.", "error"); return; }

    const prompt = buildChatPrompt({ surface, history: history.slice(0, -1), question: q });
    const requestId = `chat_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
    currentRequestId = requestId;

    activeBubbleBody = appendBubble("assistant", "");
    activeBubbleBody.classList.add("is-streaming");
    activeBuffer = "";
    setStatus("running", "thinking…");
    sendBtn.hidden = true;
    stopBtn.hidden = false;

    if (outputDispose) outputDispose();
    if (statusDispose) statusDispose();
    outputDispose = window.api.onCohortChatOutput((p) => {
      if (p.requestId !== currentRequestId) return;
      if (p.stream === "stdout") {
        activeBuffer += p.chunk;
        if (activeBubbleBody) {
          activeBubbleBody.textContent = stripAnsi(activeBuffer);
          log.scrollTop = log.scrollHeight;
        }
      }
    });
    statusDispose = window.api.onCohortChatStatus((s) => {
      if (s.state !== "idle") return;
      if (activeBubbleBody) activeBubbleBody.classList.remove("is-streaming");
      if (s.exitCode === 0 || (activeBuffer && activeBuffer.trim())) {
        finishRun(`done · ${Math.round((s.durationMs || 0) / 1000)}s`);
      } else if (s.signal === "SIGTERM" || s.signal === "SIGKILL") {
        finishRun("stopped");
      } else {
        finishRun(`exited code=${s.exitCode}`);
        setPreMsg("the local AI exited without output — check the command in settings ⚙", "error");
      }
    });

    try {
      const res = await window.api.cohortChatStart({ requestId, prompt });
      if (!res || !res.ok) {
        if (activeBubbleBody) activeBubbleBody.classList.remove("is-streaming");
        setStatus("error", "failed");
        setPreMsg(res?.detail || res?.reason || "failed to start local AI", "error");
        sendBtn.hidden = false;
        stopBtn.hidden = true;
      }
    } catch (err) {
      setStatus("error", "failed");
      setPreMsg(`start threw: ${err.message}`, "error");
      sendBtn.hidden = false;
      stopBtn.hidden = true;
    }
  }

  async function stop() { try { await window.api.cohortChatStop(); } catch {} }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  }

  panel.querySelectorAll("[data-cohort-chat-close]").forEach((el) => el.addEventListener("click", close));
  form.addEventListener("submit", send);
  stopBtn.addEventListener("click", stop);
  settingsBtn.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  saveBtn.addEventListener("click", async () => {
    try {
      const res = await window.api.setCohortChatConfig({ chatCmd: cmdInput.value.trim() });
      if (res && res.ok) {
        settingsStat.textContent = "saved.";
        settingsStat.className = "cohort-chat-settings-status is-saved";
        setTimeout(closeSettings, 600);
        refreshReadiness();
      } else {
        settingsStat.textContent = "save failed";
        settingsStat.className = "cohort-chat-settings-status is-error";
      }
    } catch (e) {
      settingsStat.textContent = `save failed: ${e.message}`;
      settingsStat.className = "cohort-chat-settings-status is-error";
    }
  });

  return { open };
}

function getController() {
  if (!controller) controller = createController();
  return controller;
}

export async function openCohortChat() {
  await warmCohortChat();
  const c = getController();
  if (!c) { console.warn("[cohort-chat] panel markup missing"); return; }
  c.open();
}
