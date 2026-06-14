#!/usr/bin/env node

const crypto = require("node:crypto");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-google-calendar-watch.js --calendar-id CALENDAR_ID --webhook-url URL [--apply]",
    "",
    "Options:",
    "  --apply                         Register a Google Calendar events.watch channel.",
    "  --dry-run                       Print the request plan without writing. Default.",
    "  --calendar-id ID                Google Calendar ID.",
    "  --calendar-connection-id ID     Supabase calendar connection ID.",
    "  --org-id ID                     Supabase org ID.",
    "  --webhook-url URL               Deployed google-calendar-webhook URL.",
    "  --channel-id ID                 Stable channel ID. Default: generated.",
    "  --ttl-seconds N                 Requested watch TTL. Default: 604800.",
    "  --access-token TOKEN            OAuth token with Calendar watch access.",
    "  --env-file FILE                 Load local KEY=value secrets before env fallbacks.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN",
    "  GOOGLE_CALENDAR_WEBHOOK_TOKEN",
    "  SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  ORG_ID",
    "  CALENDAR_CONNECTION_ID",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function required(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function defaultWebhookUrl(supabaseUrl) {
  return supabaseUrl ? `${String(supabaseUrl).replace(/\/+$/, "")}/functions/v1/google-calendar-webhook` : null;
}

function buildWatchAddress({ webhookUrl, orgId, calendarConnectionId }) {
  const url = new URL(required(webhookUrl, "webhookUrl"));
  url.searchParams.set("org_id", required(orgId, "orgId"));
  url.searchParams.set("calendar_connection_id", required(calendarConnectionId, "calendarConnectionId"));
  return String(url);
}

function buildWatchBody({
  channelId,
  webhookUrl,
  orgId,
  calendarConnectionId,
  channelToken,
  ttlSeconds = 604800,
} = {}) {
  return {
    id: channelId || `shape-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    type: "web_hook",
    address: buildWatchAddress({ webhookUrl, orgId, calendarConnectionId }),
    token: required(channelToken, "channelToken"),
    params: {
      ttl: String(ttlSeconds || 604800),
    },
  };
}

function googleWatchUrl(calendarId) {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`);
}

async function registerCalendarWatch({
  calendarId,
  accessToken,
  body,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(googleWatchUrl(required(calendarId, "calendarId")), {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(accessToken, "accessToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Calendar events.watch ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function resolveGoogleAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  if (String(accessToken || "").trim()) return accessToken;
  if (clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    return required(token?.access_token, "Google OAuth access_token");
  }
  throw new Error("accessToken or GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REFRESH_TOKEN is required");
}

function googleExpirationToIso(value) {
  if (!value) return null;
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function persistWatchState({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  watch,
  fetchImpl = fetch,
} = {}) {
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    method: "POST",
    query: { on_conflict: "calendar_connection_id" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: [{
      org_id: required(orgId, "orgId"),
      calendar_connection_id: required(calendarConnectionId, "calendarConnectionId"),
      watch_channel_id: required(watch?.id, "watch.id"),
      watch_resource_id: required(watch?.resourceId, "watch.resourceId"),
      watch_expiration: googleExpirationToIso(watch?.expiration),
      sync_status: "ok",
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    }],
    fetchImpl,
  });
}

function redactPersistedWatchRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    google_sync_token: row.google_sync_token ? "<redacted>" : row.google_sync_token,
  }));
}

async function runGoogleCalendarWatchSetup({
  calendarId,
  accessToken,
  oauthClientId,
  oauthClientSecret,
  oauthRefreshToken,
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  webhookUrl = defaultWebhookUrl(supabaseUrl),
  channelToken,
  channelId,
  ttlSeconds = 604800,
  apply = false,
  fetchImpl = fetch,
} = {}) {
  const body = buildWatchBody({
    channelId,
    webhookUrl,
    orgId,
    calendarConnectionId,
    channelToken,
    ttlSeconds,
  });
  const plan = {
    calendar_id: required(calendarId, "calendarId"),
    calendar_connection_id: required(calendarConnectionId, "calendarConnectionId"),
    org_id: required(orgId, "orgId"),
    webhook_url: body.address,
    apply: !!apply,
    request: {
      ...body,
      token: body.token ? "<redacted>" : null,
    },
  };
  if (!apply) return { ...plan, watch: null, persisted: null };
  const googleAccessToken = await resolveGoogleAccessToken({
    accessToken,
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    refreshToken: oauthRefreshToken,
    fetchImpl,
  });
  const watch = await registerCalendarWatch({ calendarId, accessToken: googleAccessToken, body, fetchImpl });
  const persisted = await persistWatchState({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    calendarConnectionId,
    watch,
    fetchImpl,
  });
  return {
    ...plan,
    watch: {
      id: watch.id,
      resourceId: watch.resourceId,
      resourceUri: watch.resourceUri,
      expiration: watch.expiration || null,
      expiration_iso: googleExpirationToIso(watch.expiration),
    },
    persisted: redactPersistedWatchRows(persisted),
  };
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const result = await runGoogleCalendarWatchSetup({
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    supabaseUrl: arg("--supabase-url", argv) || process.env.SUPABASE_URL,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    calendarConnectionId: arg("--calendar-connection-id", argv) || process.env.CALENDAR_CONNECTION_ID,
    webhookUrl: arg("--webhook-url", argv) || defaultWebhookUrl(process.env.SUPABASE_URL),
    channelToken: arg("--channel-token", argv) || process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN,
    channelId: arg("--channel-id", argv),
    ttlSeconds: Number(arg("--ttl-seconds", argv) || 604800),
    apply,
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
  buildWatchAddress,
  buildWatchBody,
  redactPersistedWatchRows,
  resolveGoogleAccessToken,
  runGoogleCalendarWatchSetup,
};
