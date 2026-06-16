import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscriptVaultImportPlan,
  canonicalTranscriptName,
  driveRouteForSessionType,
  inferDateFromName,
  inferSessionType,
  inferTranscriptSourceSystem,
  stripCopyPrefix,
  vaultIdForName,
} from "./prepare-transcript-vault-import.mjs";

const POLICY = {
  policy_key: "transcript-routing",
  version: "test",
  transcript_naming: {
    preferred_pattern: "type_project_name_date",
    type_slugs: {
      weekly_standup: "weekly_standup",
      office_hours: "office_hours",
      private_1on1: "private_1on1",
      salon: "salon",
      rd_jam: "rd_jam",
      demo_presentation: "demo_presentation",
      user_interview: "user_interview",
      planning_strategy: "planning_strategy",
    },
  },
  drive_vault: {
    shared_drive_name: "Shape Rotator Transcript Vault",
    admin_role: "manager",
    admins: [
      { name: "Tina", email: "admin-one@example.com" },
      { name: "Andrew", email: "admin-two@example.com" },
      { name: "Dmarz", email: "admin-three@example.com" },
      { name: "Michael", email: "admin-four@example.com" },
      { name: "Fred", email: "admin-five@example.com" },
      { name: "Albi", email: "admin-six@example.com" },
    ],
    folder_routes: {
      weekly_standup: { path: "raw_transcripts/weekly_standup", derived_path: "operator_review_exports/weekly_standup" },
      office_hours: { path: "raw_transcripts/office_hours", derived_path: "operator_review_exports/office_hours" },
      private_1on1: { path: "do_not_publish/private_1on1", derived_path: "do_not_publish/private_1on1" },
      salon: { path: "raw_transcripts/salon", derived_path: "operator_review_exports/salon" },
      rd_jam: { path: "raw_transcripts/rd_jam", derived_path: "operator_review_exports/rd_jam" },
      demo_presentation: { path: "raw_transcripts/demo_presentation", derived_path: "operator_review_exports/demo_presentation" },
      user_interview: { path: "raw_transcripts/user_interview", derived_path: "operator_review_exports/user_interview" },
      planning_strategy: { path: "do_not_publish/planning_strategy", derived_path: "do_not_publish/planning_strategy" },
      unknown: { path: "needs_calendar_match", derived_path: "needs_calendar_match" },
    },
  },
  session_types: {
    weekly_standup: {
      max_tier: "T2",
      cohort_mode: "aggregate_only",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
    },
    office_hours: {
      max_tier: "T2",
      cohort_mode: "distilled_readout",
      public_allowed: false,
      default_auto_transcript: true,
      required_public_approvals: [],
    },
    private_1on1: {
      max_tier: "T1",
      cohort_mode: "never",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
    },
    salon: {
      max_tier: "T3",
      cohort_mode: "distilled_readout",
      public_allowed: true,
      default_auto_transcript: true,
      required_public_approvals: ["editorial_pass"],
    },
    rd_jam: {
      max_tier: "T2",
      cohort_mode: "team_call_required",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
    },
    demo_presentation: {
      max_tier: "T3",
      cohort_mode: "distilled_readout",
      public_allowed: true,
      default_auto_transcript: true,
      required_public_approvals: ["presenter_ok"],
    },
    user_interview: {
      max_tier: "T2",
      cohort_mode: "aggregate_only",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
    },
    planning_strategy: {
      max_tier: "T1",
      cohort_mode: "never",
      public_allowed: false,
      default_auto_transcript: false,
      required_public_approvals: [],
    },
  },
};

const CALENDAR = {
  tabs: {
    "May 18 Start": [
      ["Week", "Dates", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      ["", "", "", "", "", "", "", "", ""],
      [
        "4",
        "Jun 8-13",
        "Mon Jun 8:\n11:30-13:00 Agentic Organizations with Sreeram @EigenLabs\n16:00-17:00 WDYDLW with Shaw as Moderator",
        "Tue Jun 9:\n20:00-22:30 Info Markets Design Hosted by Vinny / Vishesh / Tina. Enterprise B2B in Agentic Time",
        "Wed Jun 10:\nprotected build time",
        "Thu Jun 11:\nDesign Thinking Workshop Notes",
        "",
        "",
        "",
      ],
    ],
  },
};

test("normalizes Drive copies and infers dates/session types from filenames", () => {
  const name = "Copy of WDYDLW with Shaw Transcript Jun 8.txt";
  assert.equal(stripCopyPrefix(name), "WDYDLW with Shaw Transcript Jun 8.txt");
  assert.equal(inferDateFromName(name).date, "2026-06-08");
  assert.equal(inferDateFromName("Copy of 2026-05-19__group-room__day1-project-intros.txt").date, "2026-05-19");
  assert.equal(inferSessionType(name), "weekly_standup");
  assert.equal(inferSessionType("Copy of Product Whiteboarding Jam Jun 9.txt"), "rd_jam");
  assert.equal(inferSessionType("Copy of 1-1 May 29 Transcript.txt"), "private_1on1");
  assert.equal(inferSessionType("Copy of Quarterly 1-1 Coaching Notes.txt"), "private_1on1");
  assert.equal(inferSessionType("Copy of 2026-01-15__1on1__strategy-sync.txt"), "private_1on1");
  assert.equal(vaultIdForName(name), "wdydlw-shaw-8");
});

test("routes a named coordinator coaching session to private_1on1 when private hosts are configured", () => {
  const prev = process.env.TRANSCRIPT_PRIVATE_HOSTS;
  process.env.TRANSCRIPT_PRIVATE_HOSTS = "casey, devon";
  try {
    // configured host name + private-context signal -> do-not-publish route
    assert.equal(inferSessionType("Casey positioning checkpoint Jun 10.txt"), "private_1on1");
    // a generic office-hours title (no configured host) is unaffected
    assert.equal(inferSessionType("Conclave office hours feedback Jun 10.txt"), "office_hours");
  } finally {
    if (prev === undefined) delete process.env.TRANSCRIPT_PRIVATE_HOSTS;
    else process.env.TRANSCRIPT_PRIVATE_HOSTS = prev;
  }
});

test("builds preferred transcript names and drive routes from policy", () => {
  assert.equal(
    canonicalTranscriptName({
      name: "Copy of WDYDLW with Shaw Transcript Jun 8.txt",
      sessionType: "weekly_standup",
      date: "2026-06-08",
      policy: POLICY,
    }),
    "weekly_standup_shaw_2026-06-08.txt",
  );
  assert.equal(
    canonicalTranscriptName({
      name: "Copy of Conclave Office Hours Jun 10.md",
      sessionType: "office_hours",
      date: "2026-06-10",
      policy: POLICY,
    }),
    "office_hours_conclave_2026-06-10.md",
  );
  assert.equal(
    canonicalTranscriptName({
      name: "Copy of Roadmap Review Coaching w/ Jordan feedback private.txt",
      sessionType: "private_1on1",
      date: "2026-01-15",
      policy: POLICY,
    }),
    "private_1on1_roadmap-review-jordan_2026-01-15.txt",
  );
  assert.equal(
    canonicalTranscriptName({
      name: "Copy of 2026-05-27__flashnet__part-2-of-3.txt",
      sessionType: "rd_jam",
      date: "2026-05-27",
      policy: POLICY,
    }),
    "rd_jam_flashnet-part-2-of-3_2026-05-27.txt",
  );
  assert.equal(driveRouteForSessionType(POLICY, "planning_strategy").path, "do_not_publish/planning_strategy");
  assert.equal(driveRouteForSessionType(POLICY, "private_1on1").path, "do_not_publish/private_1on1");
  assert.equal(driveRouteForSessionType(POLICY, "salon").path, "raw_transcripts/salon");
});

test("builds external-ref manifest rows and corrects outside-cohort filename dates", () => {
  const plan = buildTranscriptVaultImportPlan({
    generatedAt: "2026-06-13T00:00:00.000Z",
    calendar: CALENDAR,
    policy: POLICY,
    files: [
      {
        drive_file_id: "drive_index",
        name: "Copy of _TRANSCRIPT-INDEX__public-private-map.md",
      },
      {
        drive_file_id: "drive_wdydlw",
        name: "Copy of WDYDLW with Shaw Transcript Jun 8.txt",
      },
      {
        drive_file_id: "drive_info_markets",
        name: "Copy of Info Markets Design B2B Transcript Jan 10.txt",
      },
    ],
  });

  assert.equal(plan.counts.total_files, 3);
  assert.equal(plan.counts.transcript_files, 2);
  assert.equal(plan.counts.matched, 2);
  assert.equal(plan.counts.rename_recommended, 2);
  assert.equal(plan.drive_permissions.admins.find((admin) => admin.name === "Dmarz").email, "admin-three@example.com");
  assert.equal(plan.manual_artifact_manifest.artifacts[0].storage_mode, "external_ref");
  assert.equal(plan.manual_artifact_manifest.artifacts[0].storage_ref, "drive://drive_wdydlw");
  assert.equal(plan.manual_artifact_manifest.artifacts[0].raw_available_to_server, false);

  const wdydlw = plan.files.find((file) => file.drive_file_id === "drive_wdydlw");
  assert.equal(wdydlw.calendar_match.status, "matched");
  assert.equal(wdydlw.calendar_match.confidence_pct >= 70, true);
  assert.equal(wdydlw.inferred_session_type, "weekly_standup");
  assert.equal(wdydlw.preferred_drive_name, "weekly_standup_shaw_2026-06-08.txt");
  assert.equal(wdydlw.drive_route.path, "raw_transcripts/weekly_standup");
  assert.equal(wdydlw.needs_manual_review, false);
  assert.equal(wdydlw.type_confidence_pct >= 70, true);
  assert.equal(wdydlw.group_confidence_pct >= 70, true);
  assert.equal(wdydlw.understanding_confidence_pct >= 70, true);
  assert.equal(wdydlw.source_artifact_manifest.type_confidence_pct, wdydlw.type_confidence_pct);
  assert.equal(wdydlw.source_artifact_manifest.understanding_confidence_pct, wdydlw.understanding_confidence_pct);

  const infoMarkets = plan.files.find((file) => file.drive_file_id === "drive_info_markets");
  assert.equal(infoMarkets.inferred_date, "2026-06-09");
  assert.equal(infoMarkets.calendar_match.status, "matched");
  assert.equal(infoMarkets.calendar_match.original_inferred_date, "2026-01-10");
  assert.equal(infoMarkets.calendar_match.candidate.date, "2026-06-09");
  assert.equal(infoMarkets.calendar_match.date_correction.reason, "filename_date_outside_cohort_but_title_matches_calendar");
  assert.equal(infoMarkets.preferred_drive_name, "salon_info-markets-design-b2b_2026-06-09.txt");
  assert.equal(infoMarkets.drive_route.path, "raw_transcripts/salon");
  assert.equal(infoMarkets.needs_manual_review, false);
});

test("classifies vault file source systems from metadata without raw transcript text", () => {
  assert.deepEqual(
    inferTranscriptSourceSystem({
      original_name: "Otter.ai Agentic Organizations Summary Jun 8.txt",
      source_system: "otter",
    }),
    {
      source_system: "otter",
      provider: "otter",
      source_kind: "otter_summary",
      confidence: "high",
      confidence_pct: 92,
      signals: ["explicit_otter_source", "otter_metadata_marker"],
    },
  );
  assert.equal(
    inferTranscriptSourceSystem({
      original_name: "Google Meet transcript abc-defg-hij",
      description: "conferenceRecords/demo/transcripts/123",
      mime_type: "application/vnd.google-apps.document",
    }).source_kind,
    "meet_transcript",
  );
  assert.equal(
    inferTranscriptSourceSystem({
      original_name: "Otter export from Google Meet transcript.txt",
    }).source_system,
    "ambiguous",
  );

  const plan = buildTranscriptVaultImportPlan({
    generatedAt: "2026-06-13T00:00:00.000Z",
    calendar: CALENDAR,
    policy: POLICY,
    files: [
      {
        drive_file_id: "drive_otter",
        name: "Otter.ai WDYDLW with Shaw Summary Jun 8.txt",
        source_system: "otter",
      },
      {
        drive_file_id: "drive_gmeet",
        name: "Google Meet WDYDLW with Shaw transcript Jun 8",
        description: "conferenceRecords/demo/transcripts/123",
        mimeType: "application/vnd.google-apps.document",
      },
    ],
  });

  assert.equal(plan.counts.by_source_system.otter, 1);
  assert.equal(plan.counts.by_source_system.google_meet, 1);
  assert.equal(plan.counts.confidence_summary.avg_understanding_confidence_pct > 0, true);
  assert.deepEqual(
    plan.manual_artifact_manifest.artifacts.map((artifact) => artifact.source_kind),
    ["otter_summary", "meet_transcript"],
  );
  assert.ok(plan.manual_artifact_manifest.artifacts.every((artifact) => Number.isFinite(artifact.source_confidence_pct)));
  assert.ok(plan.files.every((file) => file.source_artifact_manifest.raw_available_to_server === false));
});
