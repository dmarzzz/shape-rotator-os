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
      card_signals: {
        teams: [{
          record_id: "team-a",
          signal_type: "ask",
          label: "needs",
          text: "Needs a sharper partner handoff.",
          confidence: "medium",
          evidence_card_count: 1,
          claim_count: 1,
          sharing_boundary: { max_surface: "cohort", raw_allowed: false },
        }],
        people: [],
      },
      field_notes: [{
        note_id: "cohort-field-note:2026-06-08",
        note_kind: "cohort_field_note",
        week_start: "2026-06-08",
        title: "Cohort field note: week of 2026-06-08",
        summary: "Generated operator summary from reviewed evidence.",
        evidence_card_count: 1,
        claim_count: 1,
        confidence: "medium",
        themes: ["routing"],
        source_card_ids: ["source-artifact-1"],
        review_status: "generated",
        sharing_boundary: { max_surface: "cohort", raw_allowed: false },
        sections: [{
          title: "asks and edges",
          claims: [{
            claim_type: "ask",
            label: "needs",
            text: "Needs a sharper partner handoff.",
            confidence: "medium",
            evidence_level: "inferred",
          }],
        }],
        markdown: "# Cohort field note: week of 2026-06-08\n\n## asks and edges\n\n- Needs a sharper partner handoff.",
      }],
      session_notes: [{
        note_id: "cohort-session-note:session-1",
        note_kind: "cohort_session_note",
        title: "Session note: routing review",
        summary: "Article-style note from one transcript evidence card.",
        date: "2026-06-08",
        week_start: "2026-06-08",
        session_kind: "review",
        claim_count: 1,
        question_count: 1,
        confidence: "medium",
        review_status: "generated",
        source_card_ids: ["source-artifact-1"],
        sharing_boundary: { max_surface: "cohort", raw_allowed: false },
        teams: ["team-a"],
        people: ["person-a"],
        themes: ["routing"],
        sections: [{
          title: "questions from the room",
          qa: [{
            question: "What should the card carry?",
            answer: "Only the sharpest generated signal; the article note carries depth.",
            confidence: "medium",
            evidence_level: "inferred",
          }],
        }],
        markdown: "# Session note: routing review",
      }],
      signal_inventory: {
        schema_version: 1,
        source_card_count: 1,
        total_signal_count: 2,
        claim_signal_count: 1,
        qa_signal_count: 1,
        signal_type_counts: { ask: 1 },
        review_status_counts: { generated: 1 },
        coverage: {
          sources_without_claims: [],
          sources_without_questions: [],
          min_signals_per_source: 2,
          max_signals_per_source: 2,
        },
        sources: [{
          source_card_id: "source-artifact-1",
          session_id: "session-1",
          title: "Session signal inventory",
          summary: "Full internal signal inventory for one transcript.",
          date: "2026-06-08",
          week_start: "2026-06-08",
          session_kind: "review",
          consent: "cohort-internal",
          confidence: "medium",
          review_status: "generated",
          sharing_boundary: { max_surface: "cohort", raw_allowed: false },
          claim_signal_count: 1,
          qa_signal_count: 1,
          total_signal_count: 2,
          signal_type_counts: { ask: 1 },
          teams: ["team-a"],
          people: ["person-a"],
          themes: ["routing"],
          signals: [{
            signal_id: "source-artifact-1:claim:1",
            signal_kind: "claim",
            signal_type: "ask",
            label: "needs",
            text: "Needs a sharper partner handoff.",
            source_card_id: "source-artifact-1",
            confidence: "medium",
            evidence_level: "inferred",
          }, {
            signal_id: "source-artifact-1:qa:1",
            signal_kind: "qa",
            signal_type: "question",
            label: "question",
            text: "What should the card carry?",
            answer: "Only the sharpest generated signal.",
            source_card_id: "source-artifact-1",
            confidence: "medium",
            evidence_level: "inferred",
          }],
        }],
      },
      data_contract: {
        card_signal_inputs: ["record_id", "claim_type"],
        field_note_inputs: ["weekly top_claims by type"],
        session_note_inputs: ["transcript evidence card Q&A"],
        signal_inventory_inputs: ["every transcript evidence card claim"],
        quality: {
          source_transcript_count: 1,
          total_signal_count: 2,
          claim_signal_count: 1,
          qa_signal_count: 1,
          team_signal_count: 1,
          person_signal_count: 0,
          field_note_count: 1,
          session_note_count: 1,
          missing_team_signal_count: 0,
          missing_person_signal_count: 1,
          missing_session_note_count: 0,
          sources_without_claims: 0,
          sources_without_questions: 0,
        },
        promotion_rule: "Review before promotion.",
      },
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
  assert.match(html, /Cohort field note: week of 2026-06-08/);
  assert.match(html, /copyable field note markdown/);
  assert.match(html, /Session note: routing review/);
  assert.match(html, /copyable session note markdown/);
  assert.match(html, /What should the card carry/);
  assert.match(html, /signal inventory/);
  assert.match(html, /Session signal inventory/);
  assert.match(html, /2 extracted transcript signals/);
  assert.match(html, /data contract/);
  assert.match(html, /session note inputs/);
  assert.match(html, /signal inventory inputs/);
  assert.match(html, /team signals/);
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
  assert.equal(surface.cohort_intel.card_signals.teams.length, 0);
  assert.equal(surface.cohort_intel.card_signals.people.length, 0);
  assert.equal(surface.cohort_intel.field_notes.length, 0);
  assert.equal(surface.cohort_intel.session_notes.length, 0);
  assert.equal(surface.cohort_intel.signal_inventory.total_signal_count, 0);
  assert.equal(surface.transcript_evidence.source_artifact_count, 0);
  assert.ok(Array.isArray(surface.transcript_distillations.artifacts));
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.surface === "public"));
});
