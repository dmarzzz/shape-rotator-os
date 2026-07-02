import test from "node:test";
import assert from "node:assert/strict";

import {
  MANUAL_SELF_REPORT_QUESTIONS,
  splitManualList,
  buildManualAgentPrompt,
  parseManualAgentDraft,
  buildManualSelfReportDelta,
  buildManualUsefulness,
} from "./self-report-manual.mjs";

test("manual update questions cover concrete profile fields", () => {
  const fields = MANUAL_SELF_REPORT_QUESTIONS.map((q) => q.field);
  assert.ok(fields.includes("now"));
  assert.ok(fields.includes("weekly_intention"));
  assert.ok(fields.includes("seeking"));
  assert.ok(fields.includes("offering"));
  assert.ok(fields.includes("prior_work"));
  assert.equal(new Set(fields).size, fields.length, "question fields should not repeat");
});

test("splitManualList accepts lines, semicolons, and compact comma lists", () => {
  assert.deepEqual(
    splitManualList("intros\nfrontend review; user testing, launch notes"),
    ["intros", "frontend review", "user testing", "launch notes"],
  );
});

test("buildManualSelfReportDelta ignores empties and drops off-question input", () => {
  const delta = buildManualSelfReportDelta({
    now: "  building a private update flow  ",
    seeking: "design partners\n",
    skills: "Supabase, Electron",
    links: { github: "should-drop" },
    team: "should-drop",
  });
  assert.deepEqual(delta, {
    now: "building a private update flow",
    seeking: ["design partners"],
    skills: ["Supabase", "Electron"],
  });
});

test("buildManualAgentPrompt gives an agent a public-safe JSON contract", () => {
  const prompt = buildManualAgentPrompt({ person: { now: "old", skills: ["TypeScript"], email: "private@example.com" } });
  assert.ok(prompt.includes("public Shape Rotator OS profile update"));
  assert.ok(prompt.includes("Return STRICT JSON only"));
  assert.ok(prompt.includes("now"));
  assert.ok(prompt.includes("weekly_intention"));
  assert.ok(prompt.includes("old"));
  assert.ok(!prompt.includes("private@example.com"));
});

test("parseManualAgentDraft accepts fenced JSON and drops unsafe fields", () => {
  const raw = [
    "```json",
    JSON.stringify({
      person: {
        now: "shipping the manual update lane",
        seeking: ["two design partners"],
        email: "private@example.com",
        links: { github: "should-drop" },
      },
    }),
    "```",
  ].join("\n");
  const result = parseManualAgentDraft(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.delta, {
    now: "shipping the manual update lane",
    seeking: ["two design partners"],
  });
  assert.equal(result.answers.now, "shipping the manual update lane");
  assert.equal(result.answers.seeking, "two design partners");
});

test("parseManualAgentDraft reports empty drafts", () => {
  assert.deepEqual(parseManualAgentDraft('{"person":{"email":"private@example.com"}}'), { ok: false, error: "empty_delta" });
});

test("buildManualUsefulness marks why the manual update helps the app", () => {
  const report = buildManualUsefulness({
    now: "shipping",
    seeking: ["users"],
    prior_work: ["demo"],
  });
  assert.equal(report.areas.current_state, "improved");
  assert.equal(report.areas.collaboration, "improved");
  assert.equal(report.areas.proof_history, "improved");
  assert.equal(report.areas.review_readiness, "auto_applied");
  assert.deepEqual(report.suggested_actions, ["suggest_connections"]);
});
