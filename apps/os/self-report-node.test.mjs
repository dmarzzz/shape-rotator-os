import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveCommand, splitCommand,
  buildAgentMemorySection, buildAlreadySharedSection,
} from "./self-report-node.js";

test("splitCommand respects single/double quotes, no expansion", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand('"C:/a b/x.exe" exec model'), ["C:/a b/x.exe", "exec", "model"]);
  assert.deepEqual(splitCommand("codex 'a b' c"), ["codex", "a b", "c"]);
  assert.deepEqual(splitCommand(""), []);
  assert.deepEqual(splitCommand(null), []);
});

test("resolveCommand prefers an explicit chatCmd (no PATH probe)", () => {
  assert.deepEqual(resolveCommand("mycli --flag"), ["mycli", "--flag"]);
  assert.deepEqual(resolveCommand('"x y/z.exe" exec -'), ["x y/z.exe", "exec", "-"]);
});

test("resolveCommand falls back to COHORT_CHAT_CMD env when chatCmd is empty", () => {
  const prev = process.env.COHORT_CHAT_CMD;
  process.env.COHORT_CHAT_CMD = "envcli run";
  try {
    assert.deepEqual(resolveCommand(""), ["envcli", "run"]);
    assert.deepEqual(resolveCommand("   "), ["envcli", "run"]);
  } finally {
    if (prev === undefined) delete process.env.COHORT_CHAT_CMD;
    else process.env.COHORT_CHAT_CMD = prev;
  }
});

// ── agent-memory section ─────────────────────────────────────────────────────

const NO_RULES = { version: 1, hide: [], abstractions: [] };

const memFile = (over = {}) => ({
  project: "Shape OS",
  name: "context-two-lens-page.md",
  mtimeMs: 2000,
  content: [
    "---",
    "name: context-two-lens-page",
    'description: "the context page architecture, merged as #547"',
    "metadata:",
    "  type: project",
    "---",
    "",
    "Stream + library lenses replaced the type views.",
  ].join("\n"),
  ...over,
});

test("buildAgentMemorySection: empty input → empty result", () => {
  assert.deepEqual(buildAgentMemorySection([], NO_RULES), { text: "", fileCount: 0, projectCount: 0 });
  assert.deepEqual(buildAgentMemorySection(null, NO_RULES), { text: "", fileCount: 0, projectCount: 0 });
});

test("buildAgentMemorySection: frontmatter description + body surface, grouped by project", () => {
  const r = buildAgentMemorySection([memFile()], NO_RULES);
  assert.equal(r.fileCount, 1);
  assert.equal(r.projectCount, 1);
  assert.match(r.text, /## Agent memory/);
  assert.match(r.text, /### Shape OS/);
  assert.match(r.text, /- context-two-lens-page: the context page architecture, merged as #547 — Stream \+ library lenses replaced the type views\./);
});

test("buildAgentMemorySection: redaction rules scrub memory content", () => {
  const rules = { version: 1, hide: ["SecretCo"], abstractions: [] };
  const r = buildAgentMemorySection([memFile({ content: "Working with SecretCo on the pilot." })], rules);
  assert.doesNotMatch(r.text, /SecretCo/);
  assert.match(r.text, /▮/);
});

test("buildAgentMemorySection: MEMORY.md index leads its project group", () => {
  const r = buildAgentMemorySection([
    memFile({ name: "newer-note.md", mtimeMs: 9000, content: "newer note body" }),
    memFile({ name: "MEMORY.md", mtimeMs: 1000, content: "- [Index](x.md) — the index" }),
  ], NO_RULES);
  const idx = r.text.indexOf("- MEMORY:");
  const note = r.text.indexOf("- newer-note:");
  assert.ok(idx >= 0 && note >= 0 && idx < note, `MEMORY.md first: ${r.text}`);
});

test("buildAgentMemorySection: caps per-file length", () => {
  const r = buildAgentMemorySection([memFile({ content: "x".repeat(9000) })], NO_RULES);
  const line = r.text.split("\n").find((l) => l.startsWith("- context-two-lens-page:"));
  assert.ok(line.length < 2600, `line capped, got ${line.length}`);
});

// ── already-shared (Router posts) section ────────────────────────────────────

test("buildAlreadySharedSection: empty input → empty string", () => {
  assert.equal(buildAlreadySharedSection([]), "");
  assert.equal(buildAlreadySharedSection(null), "");
});

test("buildAlreadySharedSection: formats posts, skips the Router-digest title line", () => {
  const s = buildAlreadySharedSection([
    { date: "Jul 2", content: "Router digest · July 2\nShipped the two-lens context page.\nmore detail" },
    { date: "Jul 1", content: "Landed the calendar door." },
  ]);
  assert.match(s, /## Already shared with the cohort/);
  assert.match(s, /- \[Jul 2\] Shipped the two-lens context page\./);
  assert.match(s, /- \[Jul 1\] Landed the calendar door\./);
  assert.doesNotMatch(s, /Router digest · July 2/);
});

test("buildAlreadySharedSection: caps post count and line length", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, content: `post ${i} ` + "y".repeat(500) }));
  const s = buildAlreadySharedSection(many);
  const bullets = s.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(bullets.length, 8);
  for (const b of bullets) assert.ok(b.length <= 240, `line capped, got ${b.length}`);
});
