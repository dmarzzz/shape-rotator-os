import test from "node:test";
import assert from "node:assert/strict";
import { qTokens, teamBlock, buildCohortContext, buildChatPrompt } from "./cohort-chat-context.mjs";
import { splitCommand, resolveCommand } from "../../cohort-chat-node.js";

const surface = {
  teams: [
    {
      record_id: "abra", name: "Abra", focus: "formal verification · TEE Postgres",
      now: "writing the verification registry spec",
      seeking: ["TEE Postgres beta access"], offering: ["formal-verification office hours"],
      skill_areas: ["tee", "formal-verification"],
      journey: { stage: 3, primary_bottleneck: "Solution Quality", next_milestone: "validate registry against TeeSQL" },
      connections: [{ to: "teesql", toName: "TeeSQL", score: 0.9, kind: "dependency", reason: "Abra needs TEE Postgres; TeeSQL offers it." }],
    },
    { record_id: "elocute", name: "Elocute", focus: "AI speech practice", offering: ["consumer GTM"], skill_areas: ["design"] },
  ],
  people: [
    { record_id: "albiona-hoti", name: "Albiona Hoti", team: "elocute", now: "compressing user conversations into a product plan", go_to_them_for: ["speech-practice tools"], skill_areas: ["agentic", "design"] },
  ],
  transcript_evidence_cards: [
    { claim_text: "Crossroads is building a cross-chain exchange using key encumbrance", content_json: { week_start: "2026-06-14" } },
  ],
  whats_new: [{ date: "2026-06-20", label: "teesql v0.2.0", meta: "TeeSQL", kind: "release" }],
};

test("qTokens keeps meaningful question terms, drops stopwords", () => {
  const t = qTokens("who should I talk to about TEE Postgres?");
  assert.ok(t.has("tee"));
  assert.ok(t.has("postgres"));
  assert.ok(!t.has("who"));
  assert.ok(!t.has("talk"));
});

test("teamBlock surfaces focus, seeking/offering, journey, and suggested connections", () => {
  const b = teamBlock(surface.teams[0]);
  assert.match(b, /focus: formal verification/);
  assert.match(b, /seeking: TEE Postgres beta access/);
  assert.match(b, /progress: stage 3/);
  assert.match(b, /bottleneck: Solution Quality/);
  assert.match(b, /suggested connections:/);
  assert.match(b, /TeeSQL: Abra needs TEE Postgres/);
});

test("buildCohortContext ranks the question-relevant team into full detail", () => {
  const ctx = buildCohortContext(surface, { question: "who works on TEE Postgres?" });
  assert.match(ctx, /COHORT: 2 teams, 1 people/);
  // The TEE team should appear as a full block (has 'suggested connections').
  assert.match(ctx, /### Abra \(team, id:abra\)/);
  assert.match(ctx, /suggested connections/);
  // Distilled insight + activity sections present.
  assert.match(ctx, /Recent distilled session insights/);
  assert.match(ctx, /Recent activity/);
});

test("buildCohortContext respects the char budget", () => {
  const ctx = buildCohortContext(surface, { question: "x", maxChars: 200 });
  assert.ok(ctx.length <= 200 + 32);
});

test("buildChatPrompt frames the system role, embeds context + question, ends on Assistant:", () => {
  const p = buildChatPrompt({ surface, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], question: "who should I talk to about TEE Postgres?" });
  assert.match(p, /cohort assistant/i);
  assert.match(p, /COHORT CONTEXT/);
  assert.match(p, /Member: who should I talk to about TEE Postgres\?/);
  assert.match(p, /Assistant:$/);
  // prior turns carried
  assert.match(p, /Conversation so far/);
  // default (non-agent) mode does NOT carry the action contract
  assert.doesNotMatch(p, /Proposing changes/);
});

test("buildChatPrompt agent mode injects the action contract + tool results", () => {
  const p = buildChatPrompt({ surface, question: "update my profile from my work", agent: true, toolResults: "SESSIONS: shipped the agent loop" });
  assert.match(p, /Proposing changes/);
  assert.match(p, /propose_profile_update/);
  assert.match(p, /TOOL RESULTS/);
  assert.match(p, /shipped the agent loop/);
  // still ends ready for the model to answer
  assert.match(p, /Assistant:$/);
});

// ── local AI CLI resolver ──────────────────────────────────────────────────
test("splitCommand handles quotes and bare args", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand(`ollama run "qwen2.5:7b"`), ["ollama", "run", "qwen2.5:7b"]);
});

test("resolveCommand honours an explicit COHORT_CHAT_CMD override", () => {
  const argv = resolveCommand("my-llm --print");
  assert.deepEqual(argv, ["my-llm", "--print"]);
});
