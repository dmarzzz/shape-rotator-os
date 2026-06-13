import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTEXT_SCRIPT = path.join(ROOT, "apps", "web", "scripts", "context.js");
const CONTEXT_PAGE = path.join(ROOT, "apps", "web", "context", "index.html");
const SURFACE_JSON = path.join(ROOT, "apps", "web", "cohort-surface.json");

function loadContextRenderer() {
  const source = fs.readFileSync(CONTEXT_SCRIPT, "utf8");
  assert.match(source, /addPreviewVersion\("\.\.\/cohort-surface\.json"\)/);
  const runnable = source.replace(/\bexport\s+(async\s+function|function)\s+/g, "$1 ");
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: "" },
  };
  vm.runInNewContext(runnable, sandbox, { filename: CONTEXT_SCRIPT });
  assert.equal(typeof sandbox.renderContextSurface, "function");
  return sandbox.renderContextSurface;
}

test("context page is wired to the static context renderer", () => {
  const html = fs.readFileSync(CONTEXT_PAGE, "utf8");

  assert.match(html, /id="context-mount"/);
  assert.match(html, /src="\.\.\/scripts\/context\.js"/);
});

test("context renderer keeps claim provenance, confidence, and raw boundary visible", () => {
  const renderContextSurface = loadContextRenderer();
  const html = renderContextSurface({
    teams: [{ record_id: "team-a", name: "Team A" }],
    people: [{ record_id: "person-a", name: "Person A" }],
    cohort_intel: {
      raw_allowed: false,
      generated_from: "reviewed transcript evidence cards",
      context_policy_note: "Raw transcript blobs stay private.",
      weekly: [{
        week_start: "2026-06-08",
        evidence_card_count: 1,
        claim_count: 1,
        confidence: "medium",
        sharing_boundary: { max_surface: "cohort", raw_allowed: false },
        top_claims: [{
          claim_type: "decision",
          evidence_level: "inferred",
          confidence: "medium",
          text: "A reviewed claim survives as cohort-safe evidence.",
          source_artifact_id: "source-artifact-1",
          source: "private-vault:session-1",
          teams: ["team-a"],
          people: ["person-a"],
        }],
      }],
      teams: [],
      people: [],
      context_public_candidates: [],
    },
    transcript_distillations: {
      artifact_count: 1,
      cohort_count: 1,
      public_count: 0,
      operator_review_count: 0,
      default_export_policy: "T2 reviewed/published and T3 published+approved only",
      artifacts: [{
        artifact_id: "distillation-1",
        artifact_kind: "readout",
        session_title: "Cohort-safe synthesis",
        tier: "T2",
        surface: "cohort",
        review_status: "reviewed",
        approval_state: "not_required",
        confidence: 0.72,
        summary: ["Cohort-safe synthesis, not raw transcript text."],
        themes: ["routing"],
        action_items: ["Promote evidence cards after review."],
        provenance: {
          source_artifact_id: "source-artifact-1",
          source_access: "private-vault",
          raw_allowed: false,
        },
      }],
    },
  });

  assert.match(html, /Raw transcripts are not app-visible/);
  assert.match(html, /source-artifact-1/);
  assert.match(html, /private-vault:session-1/);
  assert.match(html, /medium/);
  assert.match(html, /raw transcript hidden/);
  assert.match(html, /Cohort-safe synthesis/);
});

test("current web bundle exposes public-safe context intel inputs", () => {
  const surface = JSON.parse(fs.readFileSync(SURFACE_JSON, "utf8"));

  assert.equal(surface.surface_visibility, "public-web");
  assert.equal(surface.cohort_intel.raw_allowed, false);
  assert.ok(Array.isArray(surface.cohort_intel.weekly));
  assert.ok(Array.isArray(surface.cohort_intel.teams));
  assert.ok(Array.isArray(surface.cohort_intel.people));
  assert.equal(surface.cohort_intel.weekly.length, 0);
  assert.equal(surface.cohort_intel.teams.length, 0);
  assert.equal(surface.cohort_intel.people.length, 0);
  assert.equal(surface.transcript_evidence.source_artifact_count, 0);
  assert.ok(Array.isArray(surface.transcript_distillations.artifacts));
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.surface === "public"));
});
