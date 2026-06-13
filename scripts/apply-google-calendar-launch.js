#!/usr/bin/env node

const path = require("node:path");
const {
  runGoogleCalendarBackfill,
} = require("./backfill-google-calendar.js");
const {
  DEFAULT_EDITOR_EMAILS,
  parseEmails,
  runGoogleCalendarAclSetup,
} = require("./setup-google-calendar-acl.js");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { inspectGoogleCalendarToken } = require("./lib/google-calendar-token-guard.cjs");

const DEFAULT_SOURCE = path.resolve(__dirname, "..", "cohort-data", "calendar.json");
const DEFAULT_MAX_EVENTS = 2500;
const DEFAULT_TIME_ZONE = "America/New_York";

function usage() {
  return [
    "Usage:",
    "  node scripts/apply-google-calendar-launch.js --calendar-id CALENDAR_ID [--apply] [--access-token TOKEN]",
    "",
    "What it does:",
    "  1. Backfills cohort-data/calendar.json into the managed Google Calendar.",
    "  2. Grants the configured editor emails calendar owner/admin access.",
    "  3. With --apply, reruns both operations to prove they are idempotent.",
    "",
    "Options:",
    "  --apply                    Write to Google Calendar. Default is dry-run.",
    "  --dry-run                  Print the combined plan without writing. This is the default.",
    "  --source FILE              calendar.json source. Default: cohort-data/calendar.json",
    "  --calendar-id ID           Google Calendar ID.",
    "  --access-token TOKEN       OAuth token with Calendar event and ACL write access.",
    "  --organizer-email EMAIL    Expected Google organizer account for token verification.",
    "  --env-file FILE            Load local KEY=value secrets before env fallbacks.",
    "  --time-zone ZONE           Timezone for parsed timed backfill events. Default: America/New_York.",
    "  --emails EMAILS            Comma, semicolon, or whitespace separated editor emails.",
    "  --role ROLE                ACL role. Default: owner.",
    "  --scope-type TYPE          ACL scope type. Default: user. Use group for Google Groups.",
    "  --send-notifications       Ask Google to notify newly shared users/groups.",
    "  --max-events N             Backfill safety cap. Default: 2500.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_TIMEZONE",
    "  GOOGLE_CALENDAR_EDITOR_EMAILS",
    "  GOOGLE_CALENDAR_ORGANIZER_EMAIL",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function numberArg(name, fallback, argv = process.argv) {
  const value = arg(name, argv);
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function backfillIsVerified(result) {
  return result?.apply === true
    && result.planned > 0
    && result.unchanged === result.planned
    && result.inserted === 0
    && result.updated === 0;
}

function aclIsVerified(result) {
  return result?.apply === true
    && result.planned > 0
    && result.unchanged === result.planned
    && result.inserted === 0
    && result.updated === 0;
}

async function runGoogleCalendarLaunch({
  sourcePath = DEFAULT_SOURCE,
  calendarId,
  accessToken,
  emails = DEFAULT_EDITOR_EMAILS,
  role = "owner",
  scopeType = "user",
  sendNotifications = false,
  apply = false,
  maxEvents = DEFAULT_MAX_EVENTS,
  timeZone = DEFAULT_TIME_ZONE,
  organizerEmail,
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  const editorEmails = parseEmails(emails);
  if (!editorEmails.length) throw new Error("at least one valid editor email is required");
  if (apply && !accessToken) throw new Error("accessToken is required with apply=true");

  const tokenGuard = apply
    ? await inspectGoogleCalendarToken({
      calendarId,
      accessToken,
      expectedEmail: organizerEmail,
      requiredAccessRole: "owner",
      fetchImpl,
    })
    : null;

  const backfill = await runGoogleCalendarBackfill({
    sourcePath,
    calendarId,
    accessToken,
    apply,
    maxEvents,
    timeZone,
    fetchImpl,
  });
  const acl = await runGoogleCalendarAclSetup({
    calendarId,
    accessToken,
    emails: editorEmails,
    role,
    scopeType,
    sendNotifications,
    apply,
    fetchImpl,
  });

  let verification = null;
  if (apply) {
    const backfillVerify = await runGoogleCalendarBackfill({
      sourcePath,
      calendarId,
      accessToken,
      apply: true,
      maxEvents,
      timeZone,
      fetchImpl,
    });
    const aclVerify = await runGoogleCalendarAclSetup({
      calendarId,
      accessToken,
      emails: editorEmails,
      role,
      scopeType,
      sendNotifications: false,
      apply: true,
      fetchImpl,
    });
    verification = {
      backfill: backfillVerify,
      acl: aclVerify,
      passed: backfillIsVerified(backfillVerify) && aclIsVerified(aclVerify),
    };
  }

  return {
    calendar_id: calendarId,
    apply: !!apply,
    source: path.resolve(sourcePath),
    editor_emails: editorEmails,
    token_guard: tokenGuard,
    backfill,
    acl,
    verification,
    ready: !!verification?.passed,
  };
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const result = await runGoogleCalendarLaunch({
    sourcePath: arg("--source", argv) || DEFAULT_SOURCE,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    emails: arg("--emails", argv) || process.env.GOOGLE_CALENDAR_EDITOR_EMAILS || DEFAULT_EDITOR_EMAILS,
    role: arg("--role", argv) || "owner",
    scopeType: arg("--scope-type", argv) || "user",
    sendNotifications: flag("--send-notifications", argv),
    apply,
    maxEvents: numberArg("--max-events", DEFAULT_MAX_EVENTS, argv),
    timeZone: arg("--time-zone", argv) || process.env.GOOGLE_CALENDAR_TIMEZONE || DEFAULT_TIME_ZONE,
    organizerEmail: arg("--organizer-email", argv) || process.env.GOOGLE_CALENDAR_ORGANIZER_EMAIL,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  aclIsVerified,
  backfillIsVerified,
  runGoogleCalendarLaunch,
};
