const fs = require("node:fs");
const path = require("node:path");
const { validateRoutingPolicy } = require("./calendar-integration.cjs");

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CALENDAR_ID",
  "GOOGLE_CALENDAR_WEBHOOK_TOKEN",
];

const REQUIRED_ONE_OF = [
  ["GOOGLE_CALENDAR_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN"],
];

const POST_SEED_ENV = [
  "ORG_ID",
  "CALENDAR_CONNECTION_ID",
];

const MEET_SETTINGS_SCOPE = "https://www.googleapis.com/auth/meetings.space.settings";

const REQUIRED_SCOPES = [
  {
    key: "GOOGLE_OAUTH_SCOPES",
    scope: MEET_SETTINGS_SCOPE,
    purpose: "pre-enable Meet auto transcripts/recordings",
  },
];

const LIVE_CLIENT_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "GOOGLE_CALENDAR_ID",
];

const OPTIONAL_ENV = [
  "SUPABASE_PROJECT_REF",
  "ADMIN_USER_ID",
  "GOOGLE_CALENDAR_ORGANIZER_EMAIL",
  "GOOGLE_CALENDAR_EDITOR_EMAILS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_SCOPES",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "SHAPE_CALENDAR_BOT_EMAIL",
  "GOOGLE_DRIVE_ARTIFACT_FOLDER_ID",
  "GOOGLE_DRIVE_ID",
  "ROUTING_POLICY_JSON",
  "TRANSCRIPT_ROOT",
];

const REQUIRED_FILES = [
  "cohort-data/policies/transcript-routing-policy.json",
  "supabase/migrations/20260612_calendar_meet_sessions.sql",
  "supabase/migrations/202606130000_calendar_ingress_api_grants.sql",
  "supabase/migrations/202606130001_transcript_worker_schedule.sql",
  "supabase/migrations/202606130002_transcript_worker_half_hour_schedule.sql",
  "supabase/migrations/202606130003_transcript_publication_guards.sql",
  "supabase/functions/create-calendar-event/index.ts",
  "supabase/functions/google-calendar-webhook/index.ts",
  "supabase/functions/ingest-artifacts/index.ts",
  "supabase/functions/process-transcript-jobs/index.ts",
  "supabase/functions/review-transcript-artifact/index.ts",
  "scripts/run-local-distillation-worker.js",
  "scripts/poll-google-drive-artifacts.js",
  "apps/web/scripts/calendar-ingress-client.mjs",
  "apps/os/src/renderer/calendar-ingress.mjs",
];

const EDGE_FUNCTIONS = [
  "create-calendar-event",
  "google-calendar-webhook",
  "ingest-artifacts",
  "process-transcript-jobs",
  "review-transcript-artifact",
];

const FUNCTION_SECRET_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CALENDAR_ACCESS_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "SHAPE_CALENDAR_BOT_EMAIL",
  "GOOGLE_CALENDAR_WEBHOOK_TOKEN",
  "TRANSCRIPT_WORKER_TOKEN",
  "ROUTING_POLICY_JSON",
];

function stripQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const clean = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const idx = clean.indexOf("=");
    if (idx === -1) continue;
    const key = clean.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = stripQuotes(clean.slice(idx + 1));
  }
  return out;
}

function readEnvFile(filePath) {
  if (!filePath) return {};
  return parseEnvText(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function mergeEnv({ envFile, baseEnv = process.env } = {}) {
  return {
    ...readEnvFile(envFile),
    ...baseEnv,
  };
}

function hasValue(env, key) {
  return String(env?.[key] || "").trim() !== "";
}

function checkEnv(env) {
  const required = REQUIRED_ENV.map((key) => ({
    key,
    ok: hasValue(env, key),
  }));
  const oneOf = REQUIRED_ONE_OF.map((keys) => ({
    keys,
    ok: keys.some((key) => hasValue(env, key)),
  }));
  const postSeed = POST_SEED_ENV.map((key) => ({
    key,
    ok: hasValue(env, key),
  }));
  const scopes = REQUIRED_SCOPES.map((item) => ({
    ...item,
    ok: String(env?.[item.key] || "").split(/[\s,]+/).includes(item.scope),
  }));
  const optional = OPTIONAL_ENV.map((key) => ({
    key,
    ok: hasValue(env, key),
  }));
  return { required, oneOf, postSeed, scopes, optional };
}

function loadPolicy(repoRoot) {
  const filePath = path.join(repoRoot, "cohort-data", "policies", "transcript-routing-policy.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function checkFiles(repoRoot) {
  return REQUIRED_FILES.map((relativePath) => ({
    path: relativePath,
    ok: fs.existsSync(path.join(repoRoot, relativePath)),
  }));
}

function buildSetupReport({ repoRoot = path.resolve(__dirname, "..", ".."), env = process.env } = {}) {
  const files = checkFiles(repoRoot);
  let policyErrors = [];
  try {
    policyErrors = validateRoutingPolicy(loadPolicy(repoRoot));
  } catch (error) {
    policyErrors = [error.message || String(error)];
  }
  const envReport = checkEnv(env);
  const ok = files.every((item) => item.ok)
    && policyErrors.length === 0
    && envReport.required.every((item) => item.ok)
    && envReport.oneOf.every((item) => item.ok)
    && envReport.scopes.every((item) => item.ok);
  const readyForLiveClient = files.every((item) => item.ok)
    && policyErrors.length === 0
    && envReport.required
      .filter((item) => LIVE_CLIENT_ENV.includes(item.key))
      .every((item) => item.ok)
    && envReport.postSeed.every((item) => item.ok);
  return {
    ok,
    readyForLiveClient,
    files,
    policy: {
      ok: policyErrors.length === 0,
      errors: policyErrors,
    },
    env: envReport,
  };
}

function statusMark(ok) {
  return ok ? "ok" : "missing";
}

function renderSetupReport(report) {
  const lines = [];
  lines.push("Calendar ingress setup check");
  lines.push("");
  lines.push("Files:");
  for (const item of report.files) lines.push(`- ${statusMark(item.ok)} ${item.path}`);
  lines.push("");
  lines.push(`Routing policy: ${statusMark(report.policy.ok)}`);
  for (const error of report.policy.errors) lines.push(`- ${error}`);
  lines.push("");
  lines.push("Required secrets/config:");
  for (const item of report.env.required) lines.push(`- ${statusMark(item.ok)} ${item.key}`);
  for (const item of report.env.oneOf) lines.push(`- ${statusMark(item.ok)} one of ${item.keys.join(", ")}`);
  lines.push("");
  lines.push("OAuth scopes:");
  for (const item of report.env.scopes) lines.push(`- ${statusMark(item.ok)} ${item.scope} (${item.purpose})`);
  lines.push("");
  lines.push("Post-seed client config:");
  for (const item of report.env.postSeed) lines.push(`- ${statusMark(item.ok)} ${item.key}`);
  lines.push("");
  lines.push("Optional:");
  for (const item of report.env.optional) lines.push(`- ${statusMark(item.ok)} ${item.key}`);
  lines.push("");
  lines.push(`Credential baseline: ${report.ok ? "ready" : "not ready"}`);
  lines.push(`Live client config: ${report.readyForLiveClient ? "ready" : "needs seeded IDs"}`);
  return lines.join("\n");
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function envValue(env, key, fallback = "") {
  return String(env?.[key] || fallback).trim();
}

function buildCalendarIngressSeedSql({
  env = process.env,
  repoRoot = path.resolve(__dirname, "..", ".."),
  policy = loadPolicy(repoRoot),
} = {}) {
  const orgSlug = envValue(env, "ORG_SLUG", "shape-rotator");
  const orgName = envValue(env, "ORG_NAME", "Shape Rotator");
  const adminUserId = envValue(env, "ADMIN_USER_ID");
  const calendarId = envValue(env, "GOOGLE_CALENDAR_ID", "GOOGLE_CALENDAR_ID");
  const organizerEmail = envValue(env, "GOOGLE_CALENDAR_ORGANIZER_EMAIL", "calendar@your-domain.example");
  const authMode = envValue(env, "GOOGLE_CALENDAR_AUTH_MODE", "oauth_organizer");
  const policyKey = policy.policy_key || "transcript-routing";
  const policyVersion = policy.version || "2026-06-13";
  const lines = [];

  lines.push("-- Calendar ingress seed SQL.");
  lines.push("-- Safe to inspect and rerun after applying the calendar ingress migrations.");
  lines.push("-- Fill ADMIN_USER_ID in the env file to emit the admin membership insert.");
  lines.push("");
  lines.push("begin;");
  lines.push("");
  lines.push("insert into public.orgs (slug, name)");
  lines.push(`values (${sqlString(orgSlug)}, ${sqlString(orgName)})`);
  lines.push("on conflict (slug) do update set name = excluded.name;");
  lines.push("");
  lines.push("with org_ref as (");
  lines.push(`  select id from public.orgs where slug = ${sqlString(orgSlug)}`);
  lines.push(")");
  lines.push("insert into public.routing_policies (org_id, policy_key, version, policy_json, active)");
  lines.push(`select id, ${sqlString(policyKey)}, ${sqlString(policyVersion)}, ${sqlJson(policy)}, true from org_ref`);
  lines.push("on conflict (org_id, policy_key, version) do update");
  lines.push("set policy_json = excluded.policy_json, active = true;");
  lines.push("");
  lines.push("with org_ref as (");
  lines.push(`  select id from public.orgs where slug = ${sqlString(orgSlug)}`);
  lines.push(")");
  lines.push("update public.routing_policies");
  lines.push("set active = false");
  lines.push("where org_id = (select id from org_ref)");
  lines.push(`  and policy_key = ${sqlString(policyKey)}`);
  lines.push(`  and version <> ${sqlString(policyVersion)};`);
  lines.push("");

  if (adminUserId) {
    lines.push("with org_ref as (");
    lines.push(`  select id from public.orgs where slug = ${sqlString(orgSlug)}`);
    lines.push(")");
    lines.push("insert into public.org_memberships (org_id, user_id, role)");
    lines.push(`select id, ${sqlString(adminUserId)}::uuid, 'admin' from org_ref`);
    lines.push("on conflict (org_id, user_id) do update set role = excluded.role;");
    lines.push("");
  } else {
    lines.push("-- Admin membership skipped: set ADMIN_USER_ID to the Supabase auth.users.id for the first admin.");
    lines.push("");
  }

  lines.push("with org_ref as (");
  lines.push(`  select id from public.orgs where slug = ${sqlString(orgSlug)}`);
  lines.push(")");
  lines.push("insert into public.calendar_connections (");
  lines.push("  org_id, provider, calendar_id, organizer_email, auth_mode, status");
  lines.push(")");
  lines.push("select");
  lines.push(`  id, 'google', ${sqlString(calendarId)}, ${sqlString(organizerEmail)}, ${sqlString(authMode)}, 'active'`);
  lines.push("from org_ref");
  lines.push("on conflict (org_id, provider, calendar_id) do update");
  lines.push("set organizer_email = excluded.organizer_email,");
  lines.push("    auth_mode = excluded.auth_mode,");
  lines.push("    status = excluded.status;");
  lines.push("");
  lines.push("select");
  lines.push("  o.id as org_id,");
  lines.push("  cc.id as calendar_connection_id,");
  lines.push("  cc.calendar_id,");
  lines.push("  cc.organizer_email");
  lines.push("from public.orgs o");
  lines.push("join public.calendar_connections cc on cc.org_id = o.id");
  lines.push(`where o.slug = ${sqlString(orgSlug)}`);
  lines.push(`  and cc.calendar_id = ${sqlString(calendarId)};`);
  lines.push("");
  lines.push("commit;");
  lines.push("");
  return lines.join("\n");
}

function valueStatus(env, key) {
  return hasValue(env, key) ? "set" : "missing";
}

function renderDeployPlan({
  env = process.env,
  envFile = ".env.calendar.local",
  report,
  projectRef = envValue(env, "SUPABASE_PROJECT_REF", "<project-ref>"),
} = {}) {
  const setupReport = report || buildSetupReport({ env });
  const resolvedProjectRef = projectRef || "<project-ref>";
  const worksheetTarget = /calendar-ingress\.env\.example$/i.test(String(envFile || ""))
    ? ".env.calendar.local"
    : envFile;
  const functionSecrets = FUNCTION_SECRET_KEYS
    .filter((key) => key !== "GOOGLE_ACCESS_TOKEN" || !hasValue(env, "GOOGLE_CALENDAR_ACCESS_TOKEN"))
    .filter((key) => key !== "GOOGLE_CALENDAR_ACCESS_TOKEN" || !hasValue(env, "GOOGLE_ACCESS_TOKEN"));
  const lines = [];

  lines.push("# Calendar Ingress Deploy Plan");
  lines.push("");
  lines.push("This plan intentionally does not print secret values.");
  lines.push("");
  lines.push("## Current Readiness");
  lines.push("");
  lines.push(`- Code and credential baseline: ${setupReport.ok ? "ready" : "not ready"}`);
  lines.push(`- Live client config: ${setupReport.readyForLiveClient ? "ready" : "needs ORG_ID and CALENDAR_CONNECTION_ID"}`);
  lines.push("");
  lines.push("Required values:");
  for (const item of setupReport.env.required) lines.push(`- ${item.key}: ${item.ok ? "set" : "missing"}`);
  for (const item of setupReport.env.oneOf) lines.push(`- one of ${item.keys.join(", ")}: ${item.ok ? "set" : "missing"}`);
  for (const item of setupReport.env.scopes) lines.push(`- ${item.scope}: ${item.ok ? "granted" : "missing from GOOGLE_OAUTH_SCOPES"}`);
  for (const item of setupReport.env.postSeed) lines.push(`- ${item.key}: ${item.ok ? "set" : "missing"}`);
  lines.push("");

  lines.push("## Human Inputs Still Needed");
  lines.push("");
  const missing = [
    ...setupReport.env.required.filter((item) => !item.ok).map((item) => item.key),
    ...setupReport.env.oneOf.filter((item) => !item.ok).map((item) => `one of ${item.keys.join(" / ")}`),
    ...setupReport.env.scopes.filter((item) => !item.ok).map((item) => `${item.scope} in ${item.key}`),
    ...setupReport.env.postSeed.filter((item) => !item.ok).map((item) => item.key),
  ];
  if (missing.length) {
    for (const key of missing) lines.push(`- ${key}`);
  } else {
    lines.push("- none for the scaffold; proceed to live verification");
  }
  lines.push("");

  lines.push("## Run Order");
  lines.push("");
  lines.push("1. Fill the env worksheet.");
  lines.push("");
  lines.push("```bash");
  lines.push(`cp docs/calendar-ingress.env.example ${worksheetTarget}`);
  lines.push(`npm run calendar:setup:check -- --env-file ${worksheetTarget} --allow-missing`);
  lines.push("```");
  lines.push("");
  lines.push("2. Generate or refresh the Google Calendar access token.");
  lines.push("");
  lines.push("For first consent, create a Google OAuth client with the redirect URI in the worksheet, then run:");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run calendar:oauth:google -- --env-file ${worksheetTarget} --listen --format summary --update-env-file ${worksheetTarget}`);
  lines.push("```");
  lines.push("");
  lines.push("Confirm the command updated token/scopes in the local worksheet without printing secret values. To refresh later:");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run calendar:oauth:google -- --env-file ${worksheetTarget} --refresh-token "$GOOGLE_OAUTH_REFRESH_TOKEN" --format summary --update-env-file ${worksheetTarget}`);
  lines.push("```");
  lines.push("");
  lines.push("3. Apply the Supabase migrations.");
  lines.push("");
  lines.push("Use the Supabase dashboard SQL editor or your Supabase CLI workflow to apply these in order:");
  lines.push("");
  lines.push("```text");
  lines.push("supabase/migrations/20260612_calendar_meet_sessions.sql");
  lines.push("supabase/migrations/202606130000_calendar_ingress_api_grants.sql");
  lines.push("supabase/migrations/202606130001_transcript_worker_schedule.sql");
  lines.push("supabase/migrations/202606130002_transcript_worker_half_hour_schedule.sql");
  lines.push("supabase/migrations/202606130003_transcript_publication_guards.sql");
  lines.push("```");
  lines.push("");
  lines.push("4. Generate and inspect seed SQL.");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run calendar:setup:seed-sql -- --env-file ${worksheetTarget} --out calendar-ingress-seed.sql`);
  lines.push("```");
  lines.push("");
  lines.push("Run `calendar-ingress-seed.sql` in the Supabase SQL editor. Copy the returned `org_id` and `calendar_connection_id` back into the env worksheet.");
  lines.push("");
  lines.push("5. Deploy Edge Functions.");
  lines.push("");
  lines.push("```bash");
  for (const fn of EDGE_FUNCTIONS) {
    const noVerify = fn === "process-transcript-jobs" ? " --no-verify-jwt --use-api" : "";
    lines.push(`supabase functions deploy ${fn} --project-ref ${resolvedProjectRef}${noVerify}`);
  }
  lines.push("```");
  lines.push("");
  lines.push("6. Set Edge Function secrets.");
  lines.push("");
  lines.push("Set these in Supabase function secrets from the filled env worksheet:");
  lines.push("");
  for (const key of functionSecrets) lines.push(`- ${key}: ${valueStatus(env, key)}`);
  lines.push("");
  lines.push("Do not paste the Supabase service-role key into the web or Electron app. Only Edge Functions get it.");
  lines.push("");
  lines.push("7. Seed transcript worker Vault secrets.");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run transcripts:worker:vault-sql -- --env-file ${worksheetTarget}`);
  lines.push("```");
  lines.push("");
  lines.push("Run the generated private SQL from `cohort-data/.private/transcript-vault/transcript-worker-vault-secrets.sql` in the Supabase SQL editor. Do not commit or print that SQL.");
  lines.push("");
  lines.push("8. Configure browser-safe app fields.");
  lines.push("");
  lines.push("Use these values in the web/Electron connection panel:");
  lines.push("");
  lines.push(`- SUPABASE_URL: ${valueStatus(env, "SUPABASE_URL")}`);
  lines.push(`- SUPABASE_ANON_KEY: ${valueStatus(env, "SUPABASE_ANON_KEY")}`);
  lines.push("- signed-in access token: from Supabase Auth at runtime");
  lines.push(`- ORG_ID: ${valueStatus(env, "ORG_ID")}`);
  lines.push(`- CALENDAR_CONNECTION_ID: ${valueStatus(env, "CALENDAR_CONNECTION_ID")}`);
  lines.push("");
  lines.push("9. Verify live behavior.");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run calendar:setup:check -- --env-file ${worksheetTarget}`);
  lines.push("npm test");
  lines.push("npm --workspace @shape-rotator/os run bundle:check");
  lines.push("```");
  lines.push("");
  lines.push("Then create one non-sensitive test session in dry-run mode, one pending request as a member, and one real invite as a coordinator/admin.");
  lines.push("");
  lines.push("Backfill the generated app/web schedule and grant editor access from the trusted operator shell:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run calendar:launch:google -- --calendar-id \"$GOOGLE_CALENDAR_ID\" --emails \"$GOOGLE_CALENDAR_EDITOR_EMAILS\" --role owner --scope-type user --send-notifications --apply");
  lines.push("# Optional piece-by-piece path:");
  lines.push("npm run calendar:backfill:google -- --calendar-id \"$GOOGLE_CALENDAR_ID\" --dry-run");
  lines.push("npm run calendar:backfill:google -- --calendar-id \"$GOOGLE_CALENDAR_ID\" --apply");
  lines.push("npm run calendar:acl:google -- --calendar-id \"$GOOGLE_CALENDAR_ID\" --dry-run");
  lines.push("npm run calendar:acl:google -- --calendar-id \"$GOOGLE_CALENDAR_ID\" --apply");
  lines.push("```");
  lines.push("");
  lines.push("Verify organizer calendar import/sync from a trusted operator shell:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run calendar:sync:google -- --org-id \"$ORG_ID\" --calendar-connection-id \"$CALENDAR_CONNECTION_ID\" --full --apply");
  lines.push("npm run calendar:sync:google -- --org-id \"$ORG_ID\" --calendar-connection-id \"$CALENDAR_CONNECTION_ID\" --apply");
  lines.push("```");
  lines.push("");
  lines.push("Verify post-meeting Drive artifact detection if GOOGLE_DRIVE_ARTIFACT_FOLDER_ID is configured:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run artifacts:drive -- --org-id \"$ORG_ID\" --drive-folder-id \"$GOOGLE_DRIVE_ARTIFACT_FOLDER_ID\"");
  lines.push("npm run artifacts:drive -- --org-id \"$ORG_ID\" --drive-folder-id \"$GOOGLE_DRIVE_ARTIFACT_FOLDER_ID\" --apply");
  lines.push("```");
  lines.push("");
  lines.push("After a source artifact exists, verify the cloud transcript worker without raw transcript output:");
  lines.push("");
  lines.push("```bash");
  lines.push("curl -sS -X POST \"$SUPABASE_URL/functions/v1/process-transcript-jobs\" \\");
  lines.push("  -H \"Authorization: Bearer $TRANSCRIPT_WORKER_TOKEN\" \\");
  lines.push("  -H \"Content-Type: application/json\" \\");
  lines.push("  -d '{\"org_id\":\"'\"$ORG_ID\"'\",\"limit\":1,\"dry_run\":true}'");
  lines.push("```");
  lines.push("");
  lines.push("Verify the local worker only against a non-sensitive fixture or emergency replay:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run artifacts:distill -- --transcript transcript.txt --session session.json --source-artifact source-artifact.json --processing-job processing-job.json");
  lines.push("npm run artifacts:worker -- --input worker-batch.json --transcript-root ./private-transcripts --out worker-output.json");
  lines.push("```");
  lines.push("");
  lines.push("## Non-Code Decisions To Make");
  lines.push("");
  lines.push("- OAuth refresh-token storage versus Workspace domain-wide delegation.");
  lines.push("- Calendar watch renewal owner and retry policy.");
  lines.push("- Meet artifact watcher: Workspace Events versus polling.");
  lines.push("- Transcript worker retry/backoff policy and operator alerts.");
  lines.push("- Derived artifact reviewer roles and public T3 approval checklist.");
  lines.push("");

  return lines.join("\n");
}

module.exports = {
  REQUIRED_ENV,
  REQUIRED_ONE_OF,
  POST_SEED_ENV,
  OPTIONAL_ENV,
  EDGE_FUNCTIONS,
  FUNCTION_SECRET_KEYS,
  parseEnvText,
  readEnvFile,
  mergeEnv,
  checkEnv,
  buildSetupReport,
  renderSetupReport,
  buildCalendarIngressSeedSql,
  renderDeployPlan,
};
