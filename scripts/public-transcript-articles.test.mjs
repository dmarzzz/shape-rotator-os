import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPublicTranscriptArticles,
  publicArtifacts,
  writeArticles,
} from "./build-public-transcript-articles.mjs";

function artifact(overrides = {}) {
  return {
    artifact_id: "public-artifact-1",
    artifact_kind: "public_candidate",
    session_title: "Contexto salon with Tina",
    tier: "T3",
    surface: "public",
    review_status: "published",
    approval_state: "approved",
    confidence: 0.8,
    summary: ["Contexto and Tina surfaced a reusable insight about evidence cards before weekly synthesis."],
    themes: ["Contexto evidence workflows", "Tina's review boundary"],
    action_items: ["Turn Contexto's named recap into a general workflow pattern."],
    open_questions: ["How should Tina approve future public drafts?"],
    provenance: {
      source_artifact_id: "source-private-id",
      raw_allowed: false,
    },
    ...overrides,
  };
}

test("publicArtifacts only selects published and approved T3 public distillations", () => {
  const selected = publicArtifacts({
    artifacts: [
      artifact(),
      artifact({ artifact_id: "cohort", surface: "cohort", tier: "T2" }),
      artifact({ artifact_id: "pending", review_status: "needs_review", approval_state: "pending" }),
      artifact({ artifact_id: "reviewed", review_status: "reviewed", approval_state: "approved" }),
    ],
  });

  assert.deepEqual(selected.map((item) => item.artifact_id), ["public-artifact-1"]);
});

test("public transcript articles are generalized and no-named", () => {
  const bundle = buildPublicTranscriptArticles({
    generatedAt: "2026-06-13T00:00:00.000Z",
    manifest: { artifacts: [artifact()] },
    blockedNames: [
      { text: "Contexto", kind: "team" },
      { text: "Tina", kind: "person" },
    ],
  });

  assert.equal(bundle.article_count, 1);
  assert.equal(bundle.named_entities_allowed, false);
  assert.equal(bundle.raw_allowed, false);
  const article = bundle.articles[0];
  assert.equal(article.article_mode, "generalized_no_named_insights");
  assert.equal(article.named_entities_allowed, false);
  assert.equal(article.raw_allowed, false);
  assert.doesNotMatch(article.body, /Contexto|Tina|source-private-id|private-vault|Speaker \d+/);
  assert.match(article.body, /a cohort team/);
  assert.match(article.body, /a participant/);
  assert.match(article.body, /Do not quote transcript text/);
});

test("writeArticles writes draft markdown and a body-free manifest", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "public-transcript-articles-"));
  const bundle = buildPublicTranscriptArticles({
    generatedAt: "2026-06-13T00:00:00.000Z",
    manifest: { artifacts: [artifact()] },
    blockedNames: [
      { text: "Contexto", kind: "team" },
      { text: "Tina", kind: "person" },
    ],
  });

  const manifest = writeArticles(outDir, bundle);

  assert.equal(fs.existsSync(path.join(outDir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, manifest.articles[0].file)), true);
  assert.equal(Object.hasOwn(manifest.articles[0], "body"), false);
});
