// local-ai-cli.mjs — run the operator's OWN local AI CLI (Claude Code, Codex,
// Ollama, …) one-shot, feeding a prompt on stdin and capturing stdout. No API
// keys: it shells out to whatever agent the operator already has installed and
// authenticated. Used by scripts/build-cohort-connections.mjs (the daily
// connection routine). The in-app cohort chat uses a sibling CommonJS version
// (apps/os/cohort-chat-node.js) with the same conventions.
//
// Command resolution (first match wins):
//   1. COHORT_LLM_CMD env — a full command line, e.g. `claude -p` /
//      `codex exec` / `ollama run qwen2.5`. The prompt is piped to its stdin.
//   2. Auto-detect on PATH: claude -> codex -> ollama.
// Returns { ok, text, cmd } or { ok:false, reason } — never throws.

import { spawn, spawnSync } from "node:child_process";

const DEFAULTS = [
  { bin: "claude", args: ["-p"] },
  { bin: "codex", args: ["exec"] },
  { bin: "ollama", args: ["run", process.env.OLLAMA_MODEL || "qwen2.5"] },
];

function onPath(bin) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(probe, [bin], { encoding: "utf8" });
    return r.status === 0 && String(r.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

// Split a command string into argv. Minimal shell-like splitter: respects single
// and double quotes, no variable expansion (the operator controls the value).
export function splitCommand(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Resolve the command argv to run. Returns null when no CLI is available.
export function resolveLlmCommand(env = process.env) {
  if (env.COHORT_LLM_CMD && env.COHORT_LLM_CMD.trim()) {
    const argv = splitCommand(env.COHORT_LLM_CMD.trim());
    if (argv.length) return argv;
  }
  for (const d of DEFAULTS) {
    if (onPath(d.bin)) return [d.bin, ...d.args];
  }
  return null;
}

// Run the resolved CLI with `prompt` on stdin; resolve with the collected stdout.
// Provider credentials never ride this process into the member's CLI — it must
// use their own login/subscription, never a key inherited from us. Strip them
// from the spawn env unless the operator deliberately opts in (matches the
// app-side cohort-chat-node.js spawnEnv).
const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_API_KEY_PATH",
];
export function stripProviderKeys(env = process.env) {
  const out = { ...env };
  if (env.COHORT_CHAT_USE_ENV_KEYS !== "1") {
    for (const k of PROVIDER_CREDENTIAL_ENV) delete out[k];
  }
  return out;
}

export function runLocalAi(prompt, { env = process.env, timeoutMs = 180000, cmd = null } = {}) {
  const argv = cmd || resolveLlmCommand(env);
  if (!argv || !argv.length) {
    return Promise.resolve({ ok: false, reason: "no_local_ai_cli", detail: "Set COHORT_LLM_CMD or install claude / codex / ollama on PATH." });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: { ...stripProviderKeys(env), PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, reason: "spawn_failed", detail: e.message, cmd: argv });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: "timeout", detail: `no completion in ${timeoutMs}ms`, text: out, cmd: argv });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, reason: "spawn_error", detail: e.message, cmd: argv }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) finish({ ok: true, text: out, cmd: argv });
      else finish({ ok: false, reason: "nonzero_exit", detail: `code=${code} ${err.slice(0, 400)}`, text: out, cmd: argv });
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch {}
  });
}
