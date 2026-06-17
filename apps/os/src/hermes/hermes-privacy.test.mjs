// hermes-privacy.test.mjs — locks the brain's privacy-critical invariants so
// they can't silently regress: the data-mode gate, the dataMode-from-actual-
// grounding derivation (no false-pass / no false-block), the GitHub-handle
// validation that guards the one shell:true command, and the grounding bound.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildPrompt, buildShapeGrounding, buildContext, parseShapeJson } from "./prompt.mjs";

const require = createRequire(import.meta.url);
const engine = require("./engine.js");
const scanner = require("./shape-scanner.js");

// ── the gate: only PUBLIC grounding may reach a REMOTE backend ────────────────
test("assertBackendAllowed: public allowed to remote, private/raw/unknown rejected", () => {
  assert.equal(engine.assertBackendAllowed("public", "claude").ok, true);
  assert.equal(engine.assertBackendAllowed("public", "codex").ok, true);
  assert.equal(engine.assertBackendAllowed("private_distilled", "claude").ok, false);
  assert.equal(engine.assertBackendAllowed("raw_local", "codex").ok, false);
  // unknown modes are treated as the safest (non-public) → rejected to remote
  assert.equal(engine.assertBackendAllowed("whatever", "claude").ok, false);
});

test("detectBackends reports remote locality for the CLI backends", async () => {
  const b = await engine.detectBackends();
  assert.equal(b.codex.locality, "remote");
  assert.equal(b.claude.locality, "remote");
  assert.equal(b.codex.transport, "cli");
});

// ── dataMode is derived from what the prompt ACTUALLY contains ────────────────
const cohort = { people: [{ name: "A", skills: ["rust"] }], teams: [{ name: "T" }] };
const shapeWithCodex = {
  github: { ok: true, login: "mike", languages: [{ lang: "TS", repos: 3 }] },
  codex: { ok: true, total_sessions: 100, project_count: 5, date_range: { first: "2026-01", last: "2026-06" }, top_projects: [{ project: "p", sessions: 50 }] },
};
const shapeNoCodex = { github: { ok: true, login: "mike" }, codex: { ok: false } };

test("buildPrompt: remote (includePrivate=false) → public, no private content", () => {
  const { prompt, dataMode } = buildPrompt({ question: "who?", cohort, shape: shapeWithCodex, includePrivate: false });
  assert.equal(dataMode, "public");
  assert.ok(!/Codex/.test(prompt), "no private Codex content in a public prompt");
});

test("buildPrompt: local with Codex data → private_distilled, private content present", () => {
  const { prompt, dataMode } = buildPrompt({ question: "who?", cohort, shape: shapeWithCodex, includePrivate: true });
  assert.equal(dataMode, "private_distilled");
  assert.ok(/Codex/.test(prompt), "private Codex content present");
});

test("buildPrompt: local but NO Codex data → public (no false-pass)", () => {
  // The critical case: includePrivate requested, but nothing private to include,
  // so dataMode must stay public — neither leaks nor falsely blocks.
  const { prompt, dataMode } = buildPrompt({ question: "who?", cohort, shape: shapeNoCodex, includePrivate: true });
  assert.equal(dataMode, "public");
  assert.ok(!/Codex/.test(prompt));
});

test("buildShapeGrounding hasPrivate tracks actual private content", () => {
  assert.equal(buildShapeGrounding(shapeWithCodex, false).hasPrivate, false);
  assert.equal(buildShapeGrounding(shapeWithCodex, true).hasPrivate, true);
  assert.equal(buildShapeGrounding(shapeNoCodex, true).hasPrivate, false);
  assert.deepEqual(buildShapeGrounding(null, true), { text: "", hasPrivate: false });
});

// ── input validation guarding the one shell:true gh command ───────────────────
test("validGithubHandle accepts real handles, rejects shell metacharacters", () => {
  for (const ok of ["mike", "a", "octocat-99", "A1b2"]) assert.equal(scanner.validGithubHandle(ok), true, ok);
  for (const bad of ["", "-leading", "a".repeat(40), "a;rm -rf", "a`whoami`", "a$(id)", "a b", "a|b", "a&&b", "a>b", null, undefined, 42]) {
    assert.equal(scanner.validGithubHandle(bad), false, JSON.stringify(bad));
  }
});

// ── grounding bound: a growing cohort can't silently overflow context ─────────
test("buildContext bounds + annotates an oversized cohort, leaves a small one intact", () => {
  const big = { people: Array.from({ length: 5000 }, (_, i) => ({ name: "P" + i, skills: ["x".repeat(40)], now: "y".repeat(40) })), teams: [] };
  const ctx = buildContext(big);
  assert.ok(ctx.length <= 62000, `bounded (${ctx.length})`);
  assert.match(ctx, /showing \d+ of 5000 members/);
  assert.ok(!/_note/.test(buildContext(cohort)), "small cohort untouched");
});

test("parseShapeJson tolerates fences and rejects non-JSON", () => {
  assert.deepEqual(parseShapeJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseShapeJson("no json"), null);
});
