import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const {
  buildCalendarIngressSeedSql,
  buildSetupReport,
  parseEnvText,
  renderDeployPlan,
} = require("./lib/calendar-ingress-setup.cjs");

test("calendar ingress setup parses env files without shelling out", () => {
  const parsed = parseEnvText(`
    # comment
    export SUPABASE_URL="https://project.supabase.co"
    GOOGLE_CALENDAR_ID='calendar@example.com'
    EMPTY=
    BAD KEY=value
  `);

  assert.equal(parsed.SUPABASE_URL, "https://project.supabase.co");
  assert.equal(parsed.GOOGLE_CALENDAR_ID, "calendar@example.com");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["BAD KEY"], undefined);
});

test("calendar ingress setup report separates baseline secrets from post-seed ids", () => {
  const report = buildSetupReport({
    env: {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      GOOGLE_CALENDAR_ID: "calendar@example.com",
      GOOGLE_ACCESS_TOKEN: "google-token",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/meetings.space.settings",
      GOOGLE_CALENDAR_WEBHOOK_TOKEN: "webhook-token",
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.readyForLiveClient, false);
  assert.equal(report.env.scopes[0].ok, true);
  assert.equal(report.env.postSeed.find((item) => item.key === "ORG_ID").ok, false);
  assert.equal(report.policy.ok, true);
  assert.ok(report.files.every((item) => item.ok));
});

test("calendar ingress setup report treats live client config separately from Google OAuth", () => {
  const report = buildSetupReport({
    env: {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      GOOGLE_CALENDAR_ID: "calendar@example.com",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/calendar",
      GOOGLE_CALENDAR_WEBHOOK_TOKEN: "webhook-token",
      ORG_ID: "00000000-0000-0000-0000-000000000001",
      CALENDAR_CONNECTION_ID: "00000000-0000-0000-0000-000000000002",
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.readyForLiveClient, true);
  assert.equal(report.env.scopes[0].ok, false);
});

test("calendar ingress seed SQL is idempotent and embeds routing policy", () => {
  const sql = buildCalendarIngressSeedSql({
    env: {
      ORG_SLUG: "shape-test",
      ORG_NAME: "Shape Test",
      ADMIN_USER_ID: "00000000-0000-0000-0000-000000000001",
      GOOGLE_CALENDAR_ID: "calendar@example.com",
      GOOGLE_CALENDAR_ORGANIZER_EMAIL: "calendar@example.com",
    },
    policy: {
      schema_version: 1,
      policy_key: "transcript-routing",
      version: "2026-06-12",
      tiers: {
        T0: { label: "Room" },
        T1: { label: "Core" },
        T2: { label: "Cohort" },
        T3: { label: "Public" },
      },
      session_types: {
        office_hours: {
          label: "Office hours",
          max_tier: "T2",
          public_allowed: false,
          required_public_approvals: [],
        },
      },
    },
  });

  assert.match(sql, /on conflict \(slug\) do update/);
  assert.match(sql, /insert into public.routing_policies/);
  assert.match(sql, /insert into public.org_memberships/);
  assert.match(sql, /insert into public.calendar_connections/);
  assert.match(sql, /calendar@example.com/);
  assert.match(sql, /"policy_key":"transcript-routing"/);
  assert.match(sql, /commit;/);
});

test("calendar ingress deploy plan gives run order without leaking secret values", () => {
  const plan = renderDeployPlan({
    envFile: ".env.calendar.local",
    env: {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-secret-value",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
      GOOGLE_CALENDAR_ID: "calendar@example.com",
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-secret-value",
      GOOGLE_OAUTH_CLIENT_ID: "oauth-client-id-secret-value",
      GOOGLE_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
      GOOGLE_OAUTH_REFRESH_TOKEN: "oauth-refresh-secret-value",
      GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/meetings.space.settings",
      TRANSCRIPT_WORKER_TOKEN: "worker-token-secret-value",
      ORG_ID: "00000000-0000-0000-0000-000000000001",
      CALENDAR_CONNECTION_ID: "00000000-0000-0000-0000-000000000002",
      SUPABASE_PROJECT_REF: "project-ref",
    },
  });

  assert.match(plan, /# Calendar Ingress Deploy Plan/);
  assert.match(plan, /supabase\/migrations\/20260612_calendar_meet_sessions\.sql/);
  assert.match(plan, /supabase\/migrations\/202606130000_calendar_ingress_api_grants\.sql/);
  assert.match(plan, /supabase\/migrations\/202606130001_transcript_worker_schedule\.sql/);
  assert.match(plan, /supabase\/migrations\/202606130002_transcript_worker_half_hour_schedule\.sql/);
  assert.match(plan, /supabase\/migrations\/202606130003_transcript_publication_guards\.sql/);
  assert.match(plan, /supabase functions deploy create-calendar-event --project-ref project-ref/);
  assert.match(plan, /supabase functions deploy process-transcript-jobs --project-ref project-ref --no-verify-jwt --use-api/);
  assert.match(plan, /supabase functions deploy review-transcript-artifact --project-ref project-ref/);
  assert.match(plan, /calendar:oauth:google -- --env-file \.env\.calendar\.local --listen --format summary --update-env-file \.env\.calendar\.local/);
  assert.match(plan, /calendar:oauth:google -- --env-file \.env\.calendar\.local --refresh-token "\$GOOGLE_OAUTH_REFRESH_TOKEN" --format summary --update-env-file \.env\.calendar\.local/);
  assert.match(plan, /calendar:launch:google -- --calendar-id "\$GOOGLE_CALENDAR_ID" --emails "\$GOOGLE_CALENDAR_EDITOR_EMAILS"/);
  assert.match(plan, /--role owner --scope-type user --send-notifications --apply/);
  assert.match(plan, /calendar:backfill:google -- --calendar-id "\$GOOGLE_CALENDAR_ID" --apply/);
  assert.match(plan, /calendar:acl:google -- --calendar-id "\$GOOGLE_CALENDAR_ID" --apply/);
  assert.match(plan, /transcripts:worker:vault-sql -- --env-file \.env\.calendar\.local/);
  assert.match(plan, /curl -sS -X POST "\$SUPABASE_URL\/functions\/v1\/process-transcript-jobs"/);
  assert.match(plan, /Authorization: Bearer \$TRANSCRIPT_WORKER_TOKEN/);
  assert.match(plan, /npm run artifacts:worker -- --input worker-batch\.json/);
  assert.doesNotMatch(plan, /--supabase-url "\$SUPABASE_URL" --service-role-key/);
  assert.match(plan, /SUPABASE_SERVICE_ROLE_KEY: set/);
  assert.match(plan, /GOOGLE_CALENDAR_ACCESS_TOKEN: set/);
  assert.match(plan, /https:\/\/www\.googleapis\.com\/auth\/meetings\.space\.settings: granted/);
  assert.match(plan, /TRANSCRIPT_WORKER_TOKEN: set/);
  assert.doesNotMatch(plan, /service-role-secret-value/);
  assert.doesNotMatch(plan, /google-secret-value/);
  assert.doesNotMatch(plan, /anon-secret-value/);
  assert.doesNotMatch(plan, /oauth-client-id-secret-value/);
  assert.doesNotMatch(plan, /oauth-client-secret-value/);
  assert.doesNotMatch(plan, /oauth-refresh-secret-value/);
  assert.doesNotMatch(plan, /worker-token-secret-value/);
});

test("calendar ingress deploy plan uses a local worksheet and project-ref placeholder when needed", () => {
  const plan = renderDeployPlan({
    envFile: "docs/calendar-ingress.env.example",
    env: {},
  });

  assert.match(plan, /cp docs\/calendar-ingress\.env\.example \.env\.calendar\.local/);
  assert.match(plan, /supabase functions deploy create-calendar-event --project-ref <project-ref>/);
  assert.match(plan, /supabase functions deploy process-transcript-jobs --project-ref <project-ref> --no-verify-jwt --use-api/);
  assert.match(plan, /supabase functions deploy review-transcript-artifact --project-ref <project-ref>/);
  assert.doesNotMatch(plan, /cp docs\/calendar-ingress\.env\.example docs\/calendar-ingress\.env\.example/);
  assert.doesNotMatch(plan, /--project-ref\s*\n/);
});

test("calendar ingress Edge Functions require server-side org authorization before service-role writes", () => {
  const createFunction = fs.readFileSync(new URL("../supabase/functions/create-calendar-event/index.ts", import.meta.url), "utf8");
  const ingestFunction = fs.readFileSync(new URL("../supabase/functions/ingest-artifacts/index.ts", import.meta.url), "utf8");
  const reviewFunction = fs.readFileSync(new URL("../supabase/functions/review-transcript-artifact/index.ts", import.meta.url), "utf8");

  assert.match(createFunction, /requireOrgRole/);
  assert.match(createFunction, /roles:\s*\["coordinator", "admin"\]/);
  assert.match(createFunction, /resolveCalendarConnection/);
  assert.match(createFunction, /resolveRoutingPolicy/);
  assert.match(createFunction, /resolveGoogleAccessToken/);
  assert.match(createFunction, /GOOGLE_OAUTH_REFRESH_TOKEN/);
  assert.match(createFunction, /https:\/\/oauth2\.googleapis\.com\/token/);
  assert.match(createFunction, /configureMeetAutoArtifacts/);
  assert.match(createFunction, /meet\.googleapis\.com\/v2\/spaces/);
  assert.match(createFunction, /autoTranscriptionGeneration/);
  assert.match(createFunction, /autoSmartNotes\s*=\s*body\.auto_smart_notes\s*\?\?\s*body\.autoSmartNotes\s*\?\?\s*null/);
  assert.match(createFunction, /require_auto_artifacts/);
  assert.doesNotMatch(createFunction, /body\.policy/);
  assert.doesNotMatch(createFunction, /body\.calendar_id/);

  assert.match(ingestFunction, /requireOrgRole/);
  assert.match(ingestFunction, /provider === "manual" \? \["member", "coordinator", "admin"\] : \["coordinator", "admin"\]/);
  assert.match(ingestFunction, /enforceManualMemberGuard/);
  assert.match(ingestFunction, /raw_available_to_server !== true/);
  assert.match(ingestFunction, /ingestion_events/);
  assert.match(ingestFunction, /buildProcessingJobsFromSourceArtifacts/);
  assert.match(ingestFunction, /processing_jobs/);
  assert.match(ingestFunction, /transcript_status:\s*"source_ready"/);

  assert.match(reviewFunction, /requireOrgRole/);
  assert.match(reviewFunction, /roles:\s*\["coordinator", "admin"\]/);
  assert.match(reviewFunction, /artifact_reviews/);
  assert.match(reviewFunction, /audit_log/);
  assert.match(reviewFunction, /T3 publication requires publish_public=true/);
});

test("calendar ingress Google webhook fails closed and validates watch channels", () => {
  const webhook = fs.readFileSync(new URL("../supabase/functions/google-calendar-webhook/index.ts", import.meta.url), "utf8");

  assert.match(webhook, /requiredEnv\("GOOGLE_CALENDAR_WEBHOOK_TOKEN"\)/);
  assert.match(webhook, /requireKnownWatchChannel/);
  assert.match(webhook, /runIncrementalSync/);
  assert.match(webhook, /fetchGoogleEvents/);
  assert.match(webhook, /GOOGLE_OAUTH_REFRESH_TOKEN/);
  assert.match(webhook, /upsertSyncedEvents/);
  assert.match(webhook, /watch_channel_id/);
  assert.match(webhook, /watch_resource_id/);
  assert.doesNotMatch(webhook, /optionalEnv\("GOOGLE_CALENDAR_WEBHOOK_TOKEN"\)/);
});

test("calendar ingress RLS keeps sessions and source artifacts behind review boundaries", () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/20260612_calendar_meet_sessions.sql", import.meta.url), "utf8");
  const guardMigration = fs.readFileSync(new URL("../supabase/migrations/202606130003_transcript_publication_guards.sql", import.meta.url), "utf8");

  assert.match(migration, /create policy "coordinators read sessions"/);
  assert.doesNotMatch(migration, /create policy "members request draft sessions"/);
  assert.match(migration, /requested_by = auth\.uid\(\)/);
  assert.match(migration, /create policy "source artifact private read"/);
  assert.doesNotMatch(migration, /source_tier in \('T2', 'T3'\) and public\.is_org_member\(org_id\)/);
  assert.match(migration, /transcript_status text not null default 'not_expected'/);
  assert.match(migration, /create table if not exists public\.ingestion_events/);
  assert.match(migration, /create table if not exists public\.approval_gates/);
  assert.match(migration, /tee_required boolean not null default false/);
  assert.match(migration, /review_status = 'published'\s+and tier = 'T3'\s+and approval_state = 'approved'/);
  assert.match(guardMigration, /claim_transcript_processing_jobs/);
  assert.match(guardMigration, /for update skip locked/);
  assert.match(guardMigration, /enforce_t3_publication_gates/);
  assert.match(guardMigration, /T3 approval\/publication requires approval gates/);
  assert.match(guardMigration, /gate_status not in \('approved', 'not_required'\)/);
});

test("calendar ingress grants expose only RLS-protected tables to API roles", () => {
  const grants = fs.readFileSync(new URL("../supabase/migrations/202606130000_calendar_ingress_api_grants.sql", import.meta.url), "utf8");
  const report = buildSetupReport({ env: {} });

  assert.ok(report.files.some((item) => item.path === "supabase/migrations/202606130000_calendar_ingress_api_grants.sql"));
  assert.match(grants, /grant usage on schema public to anon, authenticated, service_role/);
  assert.match(grants, /revoke all privileges on table[\s\S]*public\.calendar_connections[\s\S]*from anon/);
  assert.match(grants, /grant select on table[\s\S]*public\.sessions[\s\S]*to authenticated/);
  assert.match(grants, /grant insert on table[\s\S]*public\.event_requests[\s\S]*to authenticated/);
  assert.match(grants, /grant update on table[\s\S]*public\.sessions[\s\S]*to authenticated/);
  assert.match(grants, /grant all privileges on table[\s\S]*public\.calendar_connections[\s\S]*to service_role/);
  assert.match(grants, /grant execute on function[\s\S]*public\.is_org_member\(uuid\)[\s\S]*to authenticated, service_role/);
  assert.doesNotMatch(grants, /grant select on table[\s\S]*to anon/);
});
