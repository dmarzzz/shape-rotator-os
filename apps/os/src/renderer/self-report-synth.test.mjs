import test from "node:test";
import assert from "node:assert/strict";

import {
  SELF_REPORT_FIELDS,
  buildSelfReportPrompt,
  parseSelfReportDelta,
  sanitizeDelta,
  mergeDelta,
  stripAnsi,
} from "./self-report-synth.mjs";

test("prompt names every allowed field, the evidence, and demands strict JSON", () => {
  const p = buildSelfReportPrompt({
    person: { now: "old now", record_id: "dmarz" },
    sessionDigest: "wrote a calibration panel for the shipped view",
    githubDigest: "12 commits to shape-rotator-os",
  });
  for (const field of Object.keys(SELF_REPORT_FIELDS)) assert.ok(p.includes(field), `mentions ${field}`);
  assert.ok(p.includes("STRICT JSON"));
  assert.ok(p.includes("calibration panel"));   // session digest folded in
  assert.ok(p.includes("12 commits"));           // github digest folded in
  assert.ok(p.includes("old now"));              // current value given for reference
});

test("prompt tolerates no signal and no current profile", () => {
  const p = buildSelfReportPrompt({});
  assert.ok(p.includes("(no signal provided)"));
  assert.ok(typeof p === "string" && p.length > 0);
});

test("stripAnsi removes color codes", () => {
  assert.equal(stripAnsi("[32mhi[0m"), "hi");
});

test("parses a bare JSON object", () => {
  const r = parseSelfReportDelta('{"now":"shipping the mirror"}');
  assert.deepEqual(r, { ok: true, delta: { now: "shipping the mirror" } });
});

test("parses JSON wrapped in prose + a markdown fence + ANSI", () => {
  const raw = "[2mHere is your update:[0m\n```json\n{\n \"now\": \"x\",\n \"skills\": [\"a\"]\n}\n```\nhope that helps!";
  const r = parseSelfReportDelta(raw);
  assert.ok(r.ok);
  assert.deepEqual(r.delta, { now: "x", skills: ["a"] });
});

test("parses the outermost balanced object when there is no fence", () => {
  const raw = 'thinking... {"now":"a","meta":{"nested":true}} done';
  const r = parseSelfReportDelta(raw);
  assert.ok(r.ok);
  assert.equal(r.delta.now, "a");
  assert.equal(r.delta.meta.nested, true);
});

test("reports failures instead of throwing", () => {
  assert.deepEqual(parseSelfReportDelta(""), { ok: false, error: "empty" });
  assert.deepEqual(parseSelfReportDelta("no json here"), { ok: false, error: "no_json" });
  assert.equal(parseSelfReportDelta("{ broken").error, "unbalanced");
  assert.equal(parseSelfReportDelta("{ not: valid json }").error, "parse_error");
  assert.equal(parseSelfReportDelta("[1,2,3]").error, "no_json"); // array isn't an object proposal
});

test("sanitize DROPS any field outside the whitelist (record_id, team, role, links…)", () => {
  const clean = sanitizeDelta({
    now: "building",
    record_id: "evil",
    team: "takeover",
    role: "admin",
    links: { github: "x" },
    arbitrary: 1,
  });
  assert.deepEqual(clean, { now: "building" });
  assert.ok(!("record_id" in clean) && !("team" in clean) && !("links" in clean));
});

test("sanitize coerces + bounds types and drops empties", () => {
  const clean = sanitizeDelta({
    now: "   trimmed   ",
    weekly_intention: "",                 // empty → dropped
    skills: ["  a  ", "", null, "b"],     // trimmed, empties dropped
    seeking: "single-becomes-list",
    prior_work: Array.from({ length: 50 }, (_, i) => `art-${i}`), // capped
  });
  assert.equal(clean.now, "trimmed");
  assert.ok(!("weekly_intention" in clean));
  assert.deepEqual(clean.skills, ["a", "b"]);
  assert.deepEqual(clean.seeking, ["single-becomes-list"]);
  assert.equal(clean.prior_work.length, 12); // LIST_MAX
});

test("sanitize filters skill_areas to the controlled vocab when provided", () => {
  const allowed = new Set(["agentic", "tee"]);
  const clean = sanitizeDelta({ skill_areas: ["agentic", "made-up", "tee"] }, { allowedSkillAreas: allowed });
  assert.deepEqual(clean.skill_areas, ["agentic", "tee"]);
});

test("merge is non-destructive and reports only real changes", () => {
  const person = { now: "old", skills: ["a", "b"], weekly_intention: "same" };
  const { merged, changed } = mergeDelta(person, {
    now: "new",                 // changed
    skills: ["a", "b"],         // identical → not changed
    weekly_intention: "same",   // identical → not changed
    offering: ["help"],         // new field
  });
  assert.deepEqual(changed.sort(), ["now", "offering"]);
  assert.deepEqual(merged, { now: "new", offering: ["help"] });
});

test("end-to-end: messy CLI stdout → safe, minimal, approved-shaped delta", () => {
  const person = { now: "writing the spec", skills: ["rust"], record_id: "dmarz", team: "shape-rotator-os" };
  const stdout = '```json\n{"now":"wiring Your Mirror into the shipped view","skills":["rust","javascript"],"team":"hijack","record_id":"x"}\n```';
  const parsed = parseSelfReportDelta(stdout);
  assert.ok(parsed.ok);
  const clean = sanitizeDelta(parsed.delta);
  const { merged, changed } = mergeDelta(person, clean);
  assert.deepEqual(changed.sort(), ["now", "skills"]);
  assert.equal(merged.now, "wiring Your Mirror into the shipped view");
  assert.deepEqual(merged.skills, ["rust", "javascript"]);
  assert.ok(!("team" in merged) && !("record_id" in merged)); // privilege escalation blocked
});
