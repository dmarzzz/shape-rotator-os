import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscriptSessionMap,
  renderTranscriptSessionMapSummary,
} from "./prepare-transcript-session-map.mjs";

const IMPORT_PLAN = {
  generated_at: "2026-06-13T00:00:00.000Z",
  files: [
    {
      drive_file_id: "drive_agentic",
      vault_id: "agentic-organizations-sreeram",
      preferred_drive_name: "salon_agentic-organizations-sreeram_2026-06-08.txt",
      inferred_date: "2026-06-08",
      inferred_session_type: "salon",
      calendar_match: { status: "matched", matched_tokens: ["agentic", "organizations"] },
      source_artifact_manifest: { storage_ref: "drive://drive_agentic" },
      needs_manual_review: false,
    },
    {
      drive_file_id: "drive_wdydlw",
      vault_id: "wdydlw-shaw",
      preferred_drive_name: "weekly_standup_shaw_2026-06-08.txt",
      inferred_date: "2026-06-08",
      inferred_session_type: "weekly_standup",
      calendar_match: { status: "matched", matched_tokens: ["shaw"] },
      source_artifact_manifest: { storage_ref: "drive://drive_wdydlw" },
      needs_manual_review: false,
    },
    {
      drive_file_id: "drive_review",
      vault_id: "info-markets",
      preferred_drive_name: "salon_info-markets_2026-01-10.txt",
      inferred_date: "2026-01-10",
      inferred_session_type: "salon",
      calendar_match: { status: "date_conflict_title_candidate" },
      source_artifact_manifest: { storage_ref: "drive://drive_review" },
      needs_manual_review: true,
    },
  ],
};

const SESSIONS = [
  {
    id: "session_agentic",
    title: "11:30-13:00 Agentic Organizations with Sreeram",
    public_title: "Agentic Organizations with Sreeram",
    session_type: "salon",
    starts_at: "2026-06-08T15:30:00.000Z",
  },
  {
    id: "session_tea",
    title: "16:00-16:30 tea on roof",
    public_title: "tea on roof",
    session_type: "office_hours",
    starts_at: "2026-06-08T20:00:00.000Z",
  },
];

test("builds safe session map only for high-confidence same-day title matches", () => {
  const plan = buildTranscriptSessionMap(IMPORT_PLAN, SESSIONS, {
    generatedAt: "2026-06-13T00:00:00.000Z",
  });

  assert.equal(plan.counts.transcript_candidates, 2);
  assert.equal(plan.counts.safe_links, 1);
  assert.equal(plan.counts.review_links, 1);
  assert.equal(plan.session_map.by_drive_file_id.drive_agentic, "session_agentic");
  assert.equal(plan.session_map.by_storage_ref["drive://drive_agentic"], "session_agentic");
  assert.equal(plan.session_map.by_preferred_drive_name["salon_agentic-organizations-sreeram_2026-06-08.txt"], "session_agentic");
  assert.equal(plan.session_map.by_vault_id["agentic-organizations-sreeram"], "session_agentic");

  const review = plan.review_links[0];
  assert.equal(review.drive_file_id, "drive_wdydlw");
  assert.equal(review.review_reason, "date_bucket_session_only");
  assert.equal(review.candidates[0].session_id, "session_agentic");
});

test("holds same-day generic calendar rows for review", () => {
  const genericOnly = [{ ...SESSIONS[1] }];
  const plan = buildTranscriptSessionMap(IMPORT_PLAN, genericOnly, {
    generatedAt: "2026-06-13T00:00:00.000Z",
  });

  assert.equal(plan.counts.safe_links, 0);
  assert.equal(plan.counts.review_links, 2);
  assert.ok(plan.review_links.every((item) => item.review_reason === "date_bucket_session_only"));
});

test("renders a human-readable summary", () => {
  const plan = buildTranscriptSessionMap(IMPORT_PLAN, SESSIONS, {
    generatedAt: "2026-06-13T00:00:00.000Z",
  });
  const summary = renderTranscriptSessionMapSummary(plan);

  assert.match(summary, /Transcript Session Map Plan/);
  assert.match(summary, /salon_agentic-organizations-sreeram_2026-06-08\.txt/);
  assert.match(summary, /date_bucket_session_only/);
});
