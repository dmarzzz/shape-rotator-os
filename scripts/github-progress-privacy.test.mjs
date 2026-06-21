import assert from "node:assert/strict";
import test from "node:test";

import { compactCommit } from "./check-github-progress.mjs";

test("github progress report commit snapshots omit raw author emails", () => {
  const snapshot = compactCommit({
    sha: "abc123",
    date: "2026-06-21T12:00:00Z",
    author: "Ada Lovelace",
    author_email: "ada@example.com",
    refs: "HEAD -> main",
    subject: "feat: add private report scrubber",
    category: "feature",
    topic_tags: ["privacy"],
    matched_person: { person_id: "ada", confidence: "high" },
  });

  assert.equal(Object.hasOwn(snapshot, "author_email"), false);
  assert.deepEqual(snapshot, {
    sha: "abc123",
    date: "2026-06-21T12:00:00Z",
    author: "Ada Lovelace",
    refs: "HEAD -> main",
    subject: "feat: add private report scrubber",
    category: "feature",
    topic_tags: ["privacy"],
    matched_person: { person_id: "ada", confidence: "high" },
  });
});

test("github progress public snapshots preserve branch latest metadata", () => {
  const snapshot = compactCommit({
    name: "main",
    sha: "def456",
    tip_date: "2026-06-21T12:00:00Z",
  });

  assert.deepEqual(snapshot, {
    name: "main",
    sha: "def456",
    tip_date: "2026-06-21T12:00:00Z",
  });
});
