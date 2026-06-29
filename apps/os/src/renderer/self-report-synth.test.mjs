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
  sanitizeUsefulness,
  mergeDelta,
  assessSelfReportCoverage,
  stripAnsi,
} from "./self-report-synth.mjs";

test("prompt is the member's own AI: names fields, evidence, gh/git, a question, strict JSON", () => {
  const p = buildSelfReportPrompt({
    person: { name: "Dmarz", now: "old now", record_id: "dmarz" },
    appContextDigest: "App currently links Dmarz to Shape OS and says prior_work has the existing mirror.",
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
  assert.ok(p.includes("PROFILE COVERAGE PASS")); // pushed to audit all sections
  assert.ok(p.includes("APP RELEVANCE / CORRECTION PASS")); // app context is correction input
  assert.ok(p.includes("PROJECT / TEAM EVIDENCE PASS")); // project lane is separate
  assert.ok(p.includes("APP USEFULNESS REPORT")); // section health is requested
  assert.ok(p.includes("\"person\"") && p.includes("\"team\"")); // mature nested output shape
  assert.ok(p.includes("\"usefulness\""));        // usefulness shape is requested
  assert.ok(p.includes("App currently links Dmarz")); // app-understanding digest folded in
  assert.ok(p.includes("Do not backdate or rewrite older timeline items"));
  assert.ok(p.includes("prior_work"));            // durable shipped-work section called out
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

test("parses nested person/team proposal objects", () => {
  const r = parseSelfReportDelta('{"person":{"working_style":"fast with users"},"team":{"traction":"10 pilots"},"usefulness":{"findability":"improved"}}');
  assert.ok(r.ok);
  assert.equal(r.delta.person.working_style, "fast with users");
  assert.equal(r.delta.team.traction, "10 pilots");
  assert.equal(r.delta.usefulness.findability, "improved");
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

test("sanitize allows richer collaboration profile fields", () => {
  const clean = sanitizeDelta({
    comm_style: "async first",
    contribute_interests: ["user research", "demo feedback"],
    availability_pref: "mornings",
    go_to_them_for: ["speech practice loops"],
    recurring_themes: ["practice as product"],
    working_style: "ships fast with user loops",
    best_contexts: ["ambiguous consumer product discovery"],
  });
  assert.equal(clean.comm_style, "async first");
  assert.deepEqual(clean.contribute_interests, ["user research", "demo feedback"]);
  assert.equal(clean.availability_pref, "mornings");
  assert.deepEqual(clean.go_to_them_for, ["speech practice loops"]);
  assert.deepEqual(clean.recurring_themes, ["practice as product"]);
  assert.equal(clean.working_style, "ships fast with user loops");
  assert.deepEqual(clean.best_contexts, ["ambiguous consumer product discovery"]);
});

test("sanitizeUsefulness keeps fixed statuses/actions and missing evidence", () => {
  const clean = sanitizeUsefulness({
    findability: "improved",
    collaboration: "made-up",
    areas: { timeline: "current_state_refresh", project_evidence: "queued_review" },
    missing_evidence: ["private repo shipping detail", { bad: true }, "usage proof"],
    suggested_actions: ["Ask Member", "queue-project-evidence", "unknown-action", "ask_member"],
  });
  assert.deepEqual(clean.areas, {
    timeline: "current_state_refresh",
    project_evidence: "queued_review",
  });
  assert.deepEqual(clean.missing_evidence, ["private repo shipping detail", "usage proof"]);
  assert.deepEqual(clean.suggested_actions, ["ask_member", "queue_project_evidence"]);
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

test("merge appends prior_work instead of replacing existing history", () => {
  const person = { prior_work: ["old shipped artifact", "Reusable kit"] };
  const { merged, changed } = mergeDelta(person, {
    prior_work: ["Reusable kit", "new private repo launch"],
  });
  assert.deepEqual(changed, ["prior_work"]);
  assert.deepEqual(merged.prior_work, ["old shipped artifact", "Reusable kit", "new private repo launch"]);
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

test("assessSelfReportCoverage flags skinny updates and empty durable sections", () => {
  const person = { now: "old", weekly_intention: "old" };
  const coverage = assessSelfReportCoverage(person, ["now", "weekly_intention", "seeking", "offering"]);
  assert.equal(coverage.status, "thin");
  assert.deepEqual(coverage.missingEmptyDurableFields.sort(), ["prior_work", "skill_areas", "skills"]);
});

test("assessSelfReportCoverage treats durable profile changes as broad enough", () => {
  const person = { now: "old", skills: ["js"], skill_areas: ["agentic"], prior_work: ["demo"] };
  const coverage = assessSelfReportCoverage(person, ["now", "weekly_intention", "skills", "seeking", "offering"]);
  assert.equal(coverage.status, "broad");
  assert.equal(coverage.durableTouched, true);
  assert.deepEqual(coverage.missingEmptyDurableFields, []);
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

test("the self-report whitelist agrees across SELF_REPORT_FIELDS, the latest migration, and schema.yml (drift guard)", () => {
  const fields = Object.keys(SELF_REPORT_FIELDS).sort();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260629120000_os_profile_updates_collaboration_fields.sql"), "utf8");
  const marker = "delta - array[";
  const at = sql.indexOf(marker);
  assert.ok(at >= 0, "migration whitelist array not found");
  const list = sql.slice(at + marker.length, sql.indexOf("]", at));
  const sqlFields = list.split("'").filter((_, i) => i % 2 === 1).filter((f) => !["geo", "links"].includes(f)).sort(); // odd splits = quoted values
  assert.deepEqual(sqlFields, fields, "migration person whitelist CHECK drifted from SELF_REPORT_FIELDS");
  const schema = fs.readFileSync(path.join(root, "cohort-data/schema.yml"), "utf8");
  for (const f of fields) assert.ok(schema.includes(f), `${f} missing from schema.yml`);
});
