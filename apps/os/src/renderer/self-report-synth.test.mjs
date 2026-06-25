import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SELF_REPORT_FIELDS,
  buildSelfReportPrompt,
  parseSelfReportDelta,
  sanitizeDelta,
  mergeDelta,
  stripAnsi,
} from "./self-report-synth.mjs";

test("prompt is the member's own AI: names fields, evidence, gh/git, a question, strict JSON", () => {
  const p = buildSelfReportPrompt({
    person: { name: "Dmarz", now: "old now", record_id: "dmarz" },
    sessionDigest: "wrote a calibration panel for the shipped view",
    githubDigest: "12 commits to shape-rotator-os",
  });
  for (const field of Object.keys(SELF_REPORT_FIELDS)) assert.ok(p.includes(field), `mentions ${field}`);
  assert.ok(p.includes("STRICT JSON"));
  assert.ok(p.includes("calibration panel"));    // session digest folded in
  assert.ok(p.includes("12 commits"));            // github digest folded in
  assert.ok(p.includes("old now"));               // current value given for reference
  assert.ok(p.includes("Dmarz"));                 // personalized to the member
  assert.ok(p.includes("gh") && p.includes("git")); // told to gather first-hand
  assert.ok(p.includes("question"));              // Router-style: it ASKS
});

test("a refine answer is folded into the prompt", () => {
  const p = buildSelfReportPrompt({ person: { name: "X" }, answer: "actually I shipped the contest table too" });
  assert.ok(p.includes("THEIR ANSWER"));
  assert.ok(p.includes("contest table"));
});

test("prompt tolerates no signal and no current profile", () => {
  const p = buildSelfReportPrompt({});
  assert.ok(p.includes("gather it yourself"));
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
  assert.equal(parseSelfReportDelta("{ broken").error, "no_json");     // unbalanced tail ⇒ no usable object
  assert.equal(parseSelfReportDelta("{ not: valid json }").error, "parse_error");
  assert.equal(parseSelfReportDelta("[1,2,3]").error, "no_json");      // array isn't an object proposal
});

test("picks the model's answer, not an echoed current-profile object (C1)", () => {
  // Agentic CLIs (codex/ollama) echo the prompt — incl. the current profile {…} —
  // before answering. The parser must take the LAST answer-shaped object.
  const out = `You said your profile is:
{"now":"OLD stale value","skills":["rust"]}
Respond with the JSON object now:
{"now":"the REAL new update","skills":["rust","go"],"question":"emphasize what?"}`;
  const r = parseSelfReportDelta(out);
  assert.ok(r.ok);
  assert.equal(r.delta.now, "the REAL new update");
  assert.equal(r.delta.question, "emphasize what?");
});

test("scanner is string-aware: braces inside string values don't break it (H2)", () => {
  const out = 'noise {"now":"ship {feature} and fix }bug{","skills":["a"]} trailing';
  const r = parseSelfReportDelta(out);
  assert.ok(r.ok);
  assert.equal(r.delta.now, "ship {feature} and fix }bug{");
  assert.deepEqual(r.delta.skills, ["a"]);
});

test("falls through a non-JSON fence to the real object (C2)", () => {
  const bt = String.fromCharCode(96).repeat(3); // ```
  const out = bt + `
let me think — this part is not json
` + bt + `
` + JSON.stringify({ now: "real answer", question: "ok?" });
  const r = parseSelfReportDelta(out);
  assert.ok(r.ok);
  assert.equal(r.delta.now, "real answer");
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

test("sanitize rejects nested objects/arrays (no '[object Object]') + trims lone surrogates (M3)", () => {
  const clean = sanitizeDelta({ now: { evil: "obj" }, skills: [{ a: 1 }, ["x", "y"], "real"], weekly_intention: "ok" });
  assert.ok(!("now" in clean));              // nested object rejected, not coerced to "[object Object]"
  assert.deepEqual(clean.skills, ["real"]);  // non-primitive items dropped
  assert.equal(clean.weekly_intention, "ok");
  const c2 = sanitizeDelta({ now: "a".repeat(279) + "😀" }); // clamps at an odd UTF-16 boundary
  const last = c2.now.charCodeAt(c2.now.length - 1);
  assert.ok(!(last >= 0xD800 && last <= 0xDBFF), "left a dangling high surrogate");
});

test("the 7-field whitelist agrees across SELF_REPORT_FIELDS, the migration, and schema.yml (drift guard)", () => {
  const fields = Object.keys(SELF_REPORT_FIELDS).sort();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260625010000_os_profile_updates.sql"), "utf8");
  const marker = "delta - array[";
  const at = sql.indexOf(marker);
  assert.ok(at >= 0, "migration whitelist array not found");
  const list = sql.slice(at + marker.length, sql.indexOf("]", at));
  const sqlFields = list.split("'").filter((_, i) => i % 2 === 1).sort(); // odd splits = quoted values
  assert.deepEqual(sqlFields, fields, "migration whitelist CHECK drifted from SELF_REPORT_FIELDS");
  const schema = fs.readFileSync(path.join(root, "cohort-data/schema.yml"), "utf8");
  for (const f of fields) assert.ok(schema.includes(f), `${f} missing from schema.yml`);
});
