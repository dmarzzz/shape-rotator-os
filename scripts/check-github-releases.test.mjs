import test from "node:test";
import assert from "node:assert/strict";

import { isRateLimited, buildReleaseArtifact } from "./check-github-releases.mjs";

const REL = (over = {}) => ({
  tagName: "v1.0.0",
  name: "v1.0.0",
  publishedAt: "2026-06-01T00:00:00Z",
  isPrerelease: false,
  isDraft: false,
  isLatest: true,
  ...over,
});

test("isRateLimited detects primary + secondary rate-limit signatures", () => {
  for (const s of [
    "API rate limit exceeded for 1.2.3.4",
    "You have exceeded a secondary rate limit",
    "abuse detection mechanism triggered",
    "HTTP 403: rate limit",
    "HTTP 429 Too Many Requests",
    "was submitted too quickly",
    "please retry after 60 seconds",
  ]) {
    assert.equal(isRateLimited(s), true, `should flag: ${s}`);
  }
});

test("isRateLimited ignores ordinary failures (no false retries)", () => {
  for (const s of [
    "could not resolve host github.com",
    "repository not found",
    "gh: command not found",
    "",
    undefined,
  ]) {
    assert.equal(isRateLimited(s), false, `should NOT flag: ${s}`);
  }
});

test("buildReleaseArtifact stays byte-identical (no capped field) when not truncated", () => {
  const a = buildReleaseArtifact("acme/widget", "team-acme", [REL()]);
  assert.equal("release_count_capped" in a, false);
  assert.equal(a.release_count, 1);
  assert.equal(a.artifact_id, "github-releases:team-acme:acme-widget");
});

test("buildReleaseArtifact flags truncation only when the fetch hit the cap", () => {
  const capped = buildReleaseArtifact("acme/widget", "team-acme", [REL()], { capped: true });
  assert.equal(capped.release_count_capped, true);

  const uncapped = buildReleaseArtifact("acme/widget", "team-acme", [REL()], { capped: false });
  assert.equal("release_count_capped" in uncapped, false);
});
