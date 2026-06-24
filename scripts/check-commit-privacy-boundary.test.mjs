import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateContent,
  evaluatePath,
  loadAllowlist,
} from "./check-commit-privacy-boundary.mjs";

test("privacy boundary blocks raw transcript paths except the allowed WDYDLW recap", () => {
  assert.deepEqual(
    evaluatePath(".claude/launch.json").map((finding) => finding.label),
    ["local Claude workspace/config"],
  );
  assert.deepEqual(
    evaluatePath("apps/os/src/content/context/raw-scripts/Some Private Session.txt").map((finding) => finding.label),
    ["bundled raw transcript script"],
  );
  assert.deepEqual(
    evaluatePath("apps/os/src/content/context/raw-scripts/WDYDLW Standup Recap June 8 2026.txt"),
    [],
  );
  assert.deepEqual(
    evaluatePath("cohort-data/session-readouts/private-session.md").map((finding) => finding.label),
    ["session readouts"],
  );
});

test("privacy boundary blocks committed person PII fields", () => {
  const findings = evaluateContent(
    "cohort-data/people/example.md",
    Buffer.from([
      "---",
      "record_type: person",
      "record_id: example",
      "email: person@example.com",
      "links:",
      "  telegram: privateHandle",
      "dietary_restrictions: vegetarian",
      "---",
      "",
    ].join("\n")),
  );

  assert.deepEqual(
    findings.map((finding) => finding.label).sort(),
    [
      "private person contact link",
      "public person dietary restriction field",
      "public person email field",
    ].sort(),
  );
});

test("privacy boundary accepts cleared person private fields", () => {
  const findings = evaluateContent(
    "cohort-data/people/example.md",
    Buffer.from([
      "---",
      "record_type: person",
      "record_id: example",
      "email: null",
      "links:",
      "  telegram: null",
      "dietary_restrictions:",
      "---",
      "",
    ].join("\n")),
  );

  assert.deepEqual(findings, []);
});

test("privacy boundary blocks PII in generated public surfaces", () => {
  const findings = evaluateContent(
    "apps/os/src/cohort-timeline.json",
    Buffer.from(JSON.stringify({
      author_email: "person@example.com",
      dietary_restrictions: "low salt",
      links: { telegram: "privateHandle" },
    })),
  );

  assert.deepEqual(
    findings.map((finding) => finding.label).sort(),
    [
      "Git author email field",
      "person dietary restriction field",
      "private person contact link",
    ].sort(),
  );
});

test("privacy boundary catches GitHub tokens of varying body length (not just 36 chars)", () => {
  // Build tokens at runtime so no literal token ever appears in this source
  // file (which the gate also scans). Pre-fix bug: the rule was anchored to an
  // exact {36}-char body + a trailing \b, so gho_/ghr_ tokens of other lengths
  // slipped through the last-line privacy gate.
  const mk = (prefix, n) => `${prefix}_${"A".repeat(n)}`;
  for (const tok of [mk("ghp", 36), mk("gho", 40), mk("ghs", 30), mk("ghr", 55), mk("ghu", 36)]) {
    const findings = evaluateContent("notes.txt", Buffer.from(`gh_token = ${tok}\n`));
    assert.ok(
      findings.some((f) => f.label === "GitHub token"),
      `expected the GitHub-token rule to fire for ${tok.slice(0, 4)}…(${tok.length} chars)`,
    );
  }

  // A fine-grained PAT (github_pat_) must still be caught.
  const pat = `github_pat_${"B".repeat(50)}`;
  assert.ok(
    evaluateContent("notes.txt", Buffer.from(`gh_token = ${pat}\n`))
      .some((f) => f.label === "GitHub token"),
    "expected the GitHub-token rule to fire for a github_pat_ token",
  );
});

test("privacy boundary ignores an untracked local allowlist", () => {
  const allowlist = loadAllowlist({
    mode: "all",
    readers: {
      isTrackedFile: () => false,
      worktreeContent: () => Buffer.from("docs/false-positive.md\n"),
    },
  });

  assert.deepEqual([...allowlist], []);
});

test("privacy boundary honors the staged allowlist for staged scans", () => {
  const allowlist = loadAllowlist({
    mode: "staged",
    readers: {
      stagedStatus: () => "A\t.privacy-guard-allowlist",
      stagedContent: () => Buffer.from("# fixture\nscripts/redactor-fixture.test.mjs\n"),
      revContent: () => Buffer.from("docs/old.md\n"),
    },
  });

  assert.deepEqual([...allowlist], ["scripts/redactor-fixture.test.mjs"]);
});

test("privacy boundary treats a staged allowlist deletion as no allowlist", () => {
  const allowlist = loadAllowlist({
    mode: "staged",
    readers: {
      stagedStatus: () => "D\t.privacy-guard-allowlist",
      stagedContent: () => null,
      revContent: () => Buffer.from("docs/old.md\n"),
    },
  });

  assert.deepEqual([...allowlist], []);
});
