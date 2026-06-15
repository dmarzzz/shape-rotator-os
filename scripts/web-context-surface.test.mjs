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

function loadContextSandbox() {
  const source = fs.readFileSync(CONTEXT_SCRIPT, "utf8");
  assert.match(source, /addPreviewVersion\("\.\.\/cohort-surface\.json"\)/);
  const runnable = source.replace(/\bexport\s+(async\s+function|function)\s+/g, "$1 ");
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    location: { search: "" },
  };
  vm.runInNewContext(runnable, sandbox, { filename: CONTEXT_SCRIPT });
  assert.equal(typeof sandbox.renderContextSurface, "function");
  return sandbox;
}

function loadContextRenderer() {
  return loadContextSandbox().renderContextSurface;
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
      project_week_snapshots: [{
        snapshot_id: "project-week:team-a:2026-06-08",
        project_id: "team-a",
        project_name: "Team A",
        week_start: "2026-06-08",
        declared_state: {
          stage: 4,
          bottleneck: "GTM",
          bottleneck_category: "GTM / ICP",
          confidence: "Medium",
          now: "working non-payers toward first paid conversion",
          next_milestone: "convert the first paid user",
        },
        observed_state: {
          movement: "build/proof advanced",
          inferred_bottleneck: "Product / Workflow",
          evidence_quality: "medium",
          signal_mix: { product_signal: 1 },
          evidence_summary: "2 transcript signal(s) across 1 source card(s); 2 scored as project-specific.",
          top_observed_claims: [{
            claim_id: "source-artifact-1:claim:1",
            claim_type: "product_signal",
            label: "product signal",
            text: "The demo moved, but the paid-conversion signal is still not visible.",
            confidence: "medium",
            evidence_level: "inferred",
            source_card_id: "source-artifact-1",
            signal_score: 91,
            matched_tokens: ["demo", "conversion"],
          }],
        },
        drift: {
          status: "partial_drift",
          reason: "Declared bottleneck is GTM / ICP, while this week's observed evidence reads more like Product / Workflow.",
        },
        recommended_intervention: "Translate the observed build signal into one demoable weekly milestone.",
        evidence: {
          source_card_count: 1,
          source_card_ids: ["source-artifact-1"],
          claim_ids: ["source-artifact-1:claim:1"],
          signal_count: 2,
          project_specific_signal_count: 2,
          signal_type_counts: { product_signal: 1 },
        },
        privacy: {
          max_surface: "cohort",
          raw_allowed: false,
        },
      }],
      project_week_snapshot_quality: {
        snapshot_count: 1,
        project_count: 1,
        drift_status_counts: { partial_drift: 1 },
        weak_snapshot_count: 0,
        insufficient_snapshot_count: 0,
        cohort_only_count: 1,
      },
      project_progress_rollups: [{
        project_id: "team-a",
        project_name: "Team A",
        latest_snapshot_id: "project-week:team-a:2026-06-08",
        latest_week_start: "2026-06-08",
        current_drift_status: "partial_drift",
        current_evidence_quality: "medium",
        declared_bottleneck: "GTM",
        declared_bottleneck_category: "GTM / ICP",
        observed_bottleneck: "Product / Workflow",
        trajectory: "drift_emerged",
        intervention_priority: "medium",
        operator_question: "Observed evidence is leaning toward Product / Workflow; review whether declared GTM still describes the project.",
        recommended_next_check: "Translate the observed build signal into one demoable weekly milestone.",
        status_history: [{
          snapshot_id: "project-week:team-a:2026-06-08",
          week_start: "2026-06-08",
          drift_status: "partial_drift",
          evidence_quality: "medium",
          declared_bottleneck: "GTM / ICP",
          observed_bottleneck: "Product / Workflow",
          project_specific_signal_count: 2,
          signal_count: 2,
        }],
        coverage: {
          snapshot_count: 1,
          dated_week_count: 1,
          undated_evidence_count: 0,
          has_project_specific_evidence: true,
          project_specific_signal_count: 2,
          signal_count: 2,
        },
        privacy: {
          max_surface: "cohort",
          raw_allowed: false,
        },
      }],
      project_progress_rollup_quality: {
        rollup_count: 1,
        priority_counts: { medium: 1 },
        trajectory_counts: { drift_emerged: 1 },
        no_evidence_count: 0,
        undated_evidence_project_count: 0,
        coverage_gap_count: 0,
        cohort_only_count: 1,
      },
      data_contract: {
        card_signal_inputs: ["record_id", "claim_type"],
        field_note_inputs: ["weekly top_claims by type"],
        session_note_inputs: ["transcript evidence card Q&A"],
        signal_inventory_inputs: ["every transcript evidence card claim"],
        project_week_snapshot_inputs: ["team.journey.primary_bottleneck", "transcript evidence card claims by project"],
        project_progress_rollup_inputs: ["project_week_snapshots grouped by project_id"],
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
          project_week_snapshot_count: 1,
          project_week_project_count: 1,
          project_week_drift_count: 1,
          project_week_weak_count: 0,
          project_progress_rollup_count: 1,
          project_progress_high_priority_count: 0,
          project_progress_coverage_gap_count: 0,
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
  assert.match(html, /project trajectory rollups/);
  assert.match(html, /drift emerged/);
  assert.match(html, /operator question/);
  assert.match(html, /project-week snapshots/);
  assert.match(html, /Team A/);
  assert.match(html, /partial drift/);
  assert.match(html, /Product \/ Workflow/);
  assert.match(html, /Translate the observed build signal/);
  assert.match(html, /data contract/);
  assert.match(html, /session note inputs/);
  assert.match(html, /signal inventory inputs/);
  assert.match(html, /project week snapshot inputs/);
  assert.match(html, /project progress rollup inputs/);
  assert.match(html, /team signals/);
  assert.match(html, /source-artifact-1/);
  assert.match(html, /private-vault:session-1/);
  assert.match(html, /medium/);
  assert.match(html, /raw transcript hidden/);
  assert.match(html, /Cohort-safe synthesis/);
});

test("public Supabase evidence hydration strips entity and private provenance keys", async () => {
  const sandbox = loadContextSandbox();
  const calls = [];
  const rows = await sandbox.fetchPublicTranscriptEvidence({
    config: { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "anon" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => [{
          id: "card-1",
          claim_type: "insight",
          title: "Public-safe signal",
          claim_text: "Teams are converging on reusable coordination patterns.",
          summary: "A reusable insight from public transcript evidence.",
          evidence_level: "aggregate",
          confidence: 0.6,
          attribution_scope: "team",
          content_json: {
            week_start: "2026-06-08",
            themes: ["coordination"],
            teams: ["teleport-router"],
            people: ["person-a"],
            source_artifact_id: "source-artifact-1",
            storage_ref: "private-transcripts/session.txt",
            raw_allowed: true,
            named_entities_allowed: true,
          },
          created_at: "2026-06-10T00:00:00Z",
        }],
      };
    },
  });

  assert.match(calls[0], /\/rest\/v1\/public_transcript_evidence_cards/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attribution_scope, "anonymous_public");
  assert.equal(rows[0].content_json.raw_allowed, false);
  assert.equal(rows[0].content_json.named_entities_allowed, false);
  assert.equal(rows[0].content_json.teams, undefined);
  assert.equal(rows[0].content_json.people, undefined);
  assert.equal(rows[0].content_json.source_artifact_id, undefined);
  assert.equal(rows[0].content_json.storage_ref, undefined);

  const merged = sandbox.mergePublicTranscriptEvidence({
    cohort_intel: { weekly: [] },
    transcript_evidence: {},
  }, rows);
  assert.equal(merged.transcript_evidence.public_evidence_card_count, 1);
  assert.equal(merged.cohort_intel.weekly[0].teams.length, 0);
  assert.equal(merged.cohort_intel.weekly[0].people.length, 0);
  assert.equal(merged.cohort_intel.weekly[0].top_claims[0].teams.length, 0);
  assert.equal(merged.cohort_intel.weekly[0].top_claims[0].people.length, 0);
});

test("current web bundle exposes public-safe context intel inputs", () => {
  const renderContextSurface = loadContextRenderer();
  const surface = JSON.parse(fs.readFileSync(SURFACE_JSON, "utf8"));
  const html = renderContextSurface(surface);

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
  assert.equal(surface.cohort_intel.project_week_snapshots.length, 0);
  assert.equal(surface.cohort_intel.project_week_snapshot_quality.snapshot_count, 0);
  assert.equal(surface.cohort_intel.project_progress_rollups.length, 0);
  assert.equal(surface.cohort_intel.project_progress_rollup_quality.rollup_count, 0);
  assert.doesNotMatch(html, /project trajectory rollups/);
  assert.doesNotMatch(html, /project-week snapshots/);
  assert.equal(surface.transcript_evidence.source_artifact_count, 0);
  assert.ok(Array.isArray(surface.transcript_distillations.artifacts));
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.surface === "public"));
});
