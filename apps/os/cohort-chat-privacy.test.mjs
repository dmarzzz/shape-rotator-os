// Privacy invariants for the cohort-chat spawn path — the data-sensitivity gate
// and provider-key stripping harvested from the Hermes "Ask Cohort" PR (#417).
// Pure functions only; no spawn, so this runs headless under `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { stripProviderKeys } from "../../scripts/lib/local-ai-cli.mjs";

const require = createRequire(import.meta.url);
const chat = require("./cohort-chat-node.js");

test("gate: only PUBLIC grounding may reach a REMOTE backend", () => {
  assert.equal(chat.assertBackendAllowed("public", "claude").ok, true);
  assert.equal(chat.assertBackendAllowed("public", "codex").ok, true);
  // private / raw must never leave for a remote model
  assert.equal(chat.assertBackendAllowed("private_distilled", "claude").ok, false);
  assert.equal(chat.assertBackendAllowed("raw_local", "codex").ok, false);
  // a local model (ollama) may receive anything
  assert.equal(chat.assertBackendAllowed("private_distilled", "ollama").ok, true);
  assert.equal(chat.assertBackendAllowed("raw_local", "ollama").ok, true);
});

test("gate: unknown mode is treated as non-public; unknown backend as remote", () => {
  // an unrecognised mode must NOT be waved through to a remote backend
  assert.equal(chat.assertBackendAllowed("totally-unknown", "claude").ok, false);
  // a custom command is remote-by-default: public ok, private blocked
  assert.equal(chat.assertBackendAllowed("public", "custom").ok, true);
  assert.equal(chat.assertBackendAllowed("private_distilled", "custom").ok, false);
});

test("backendForArgv maps a binary (path/ext-agnostic) to a known backend", () => {
  assert.equal(chat.backendForArgv(["claude", "-p"]), "claude");
  assert.equal(chat.backendForArgv(["/usr/local/bin/ollama", "run", "qwen2.5"]), "ollama");
  assert.equal(chat.backendForArgv(["C:\\tools\\codex.exe", "exec"]), "codex");
  assert.equal(chat.backendForArgv(["my-own-model"]), "custom");
  assert.equal(chat.backendForArgv([]), "custom");
});

test("spawnEnv strips provider credentials by default, opt-in keeps them", () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, k: process.env.COHORT_CHAT_USE_ENV_KEYS };
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.OPENAI_API_KEY = "sk-oai-should-not-leak";
    delete process.env.COHORT_CHAT_USE_ENV_KEYS;
    const env = chat.spawnEnv({ NO_COLOR: "1" });
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "anthropic key must be stripped");
    assert.equal(env.OPENAI_API_KEY, undefined, "openai key must be stripped");
    assert.equal(env.NO_COLOR, "1", "extra env still merged");

    process.env.COHORT_CHAT_USE_ENV_KEYS = "1";
    const optedIn = chat.spawnEnv();
    assert.equal(optedIn.ANTHROPIC_API_KEY, "sk-ant-should-not-leak", "opt-in keeps the key");
  } finally {
    if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
    if (saved.k === undefined) delete process.env.COHORT_CHAT_USE_ENV_KEYS; else process.env.COHORT_CHAT_USE_ENV_KEYS = saved.k;
  }
});

test("stripProviderKeys (build side) mirrors the app-side strip", () => {
  const stripped = stripProviderKeys({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", PATH: "/usr/bin" });
  assert.equal(stripped.ANTHROPIC_API_KEY, undefined);
  assert.equal(stripped.OPENAI_API_KEY, undefined);
  assert.equal(stripped.PATH, "/usr/bin", "non-credential env is preserved");
  const optedIn = stripProviderKeys({ ANTHROPIC_API_KEY: "x", COHORT_CHAT_USE_ENV_KEYS: "1" });
  assert.equal(optedIn.ANTHROPIC_API_KEY, "x", "opt-in keeps the key");
});
