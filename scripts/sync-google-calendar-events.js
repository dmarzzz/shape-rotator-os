#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  googleEventsToSupabaseRows,
  loadRoutingPolicy,
  defaultPolicyPath,
  stableSessionIdForGoogleEvent,
} = require("./lib/calendar-integration.cjs");
const {
  buildSupabaseUpsertRequests,
  executeSupabaseRequests,
  supabaseServiceRequest,
} = require("./lib/supabase-rest.cjs");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

const DEFAULT_MAX_RESULTS = 2500;

function usage() {
  return [
    "Usage:",
    "  node scripts/sync-google-calendar-events.js --events google-events.json",
    "  node scripts/sync-google-calendar-events.js --calendar-id CALENDAR_ID --access-token TOKEN",
    "  node scripts/sync-google-calendar-events.js --calendar-connection-id CONNECTION_ID --org-id ORG_ID --apply",
    "",
    "Options:",
    "  --apply                         Write sessions, attendees, cancellations, and sync state to Supabase",
    "  --full                          Ignore stored/manual sync token and run a full sync",
    "  --org-id ORG_ID",
    "  --calendar-connection-id CONNECTION_ID",
    "  --calendar-id CALENDAR_ID",
    "  --sync-token GOOGLE_SYNC_TOKEN",
    "  --time-min ISO_DATETIME          Full-sync/export filter only; not valid with syncToken",
    "  --time-max ISO_DATETIME          Full-sync/export filter only; not valid with syncToken",
    "  --max-results N                  Google page size, default 2500",
    "  --bot-email bot@example.com",
    "  --supabase-url URL",
    "  --service-role-key KEY",
    "  --env-file FILE                  Load local KEY=value secrets before env fallbacks",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN",
    "  SHAPE_SUPABASE_URL or SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  ORG_ID",
    "  CALENDAR_CONNECTION_ID",
    "  GOOGLE_CALENDAR_SYNC_TOKEN or GOOGLE_SYNC_TOKEN",
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

function readJson(filePath) {
  if (filePath === "-") return JSON.parse(fs.readFileSync(0, "utf8"));
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function normalizeFixturePayload(fixture) {
  return Array.isArray(fixture)
    ? { items: fixture, nextSyncToken: null }
    : { items: fixture.items || fixture.events || [], nextSyncToken: fixture.nextSyncToken || null };
}

function buildGoogleEventsListUrl({
  calendarId,
  syncToken,
  pageToken,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if (syncToken && (timeMin || timeMax)) {
    throw new Error("timeMin/timeMax cannot be used with syncToken; run a full sync without token first");
  }
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("showDeleted", "true");
  if (syncToken) {
    url.searchParams.set("syncToken", syncToken);
  } else {
    if (timeMin) url.searchParams.set("timeMin", timeMin);
    if (timeMax) url.searchParams.set("timeMax", timeMax);
  }
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

async function fetchGoogleEvents({
  calendarId,
  accessToken,
  syncToken,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  fetchImpl = fetch,
} = {}) {
  if (!calendarId || !accessToken) throw new Error("calendarId and accessToken are required for live sync");
  const items = [];
  let nextPageToken = null;
  let nextSyncToken = null;
  do {
    const url = buildGoogleEventsListUrl({
      calendarId,
      syncToken,
      pageToken: nextPageToken,
      timeMin,
      timeMax,
      maxResults,
    });
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const err = new Error(`Google Calendar events.list ${response.status}`);
      err.status = response.status;
      err.body = data;
      throw err;
    }
    items.push(...(data.items || []));
    nextPageToken = data.nextPageToken || null;
    nextSyncToken = data.nextSyncToken || nextSyncToken;
  } while (nextPageToken);
  return { items, nextSyncToken };
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
    if (String(token?.access_token || "").trim()) return token.access_token;
  }
  throw new Error("accessToken or GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REFRESH_TOKEN is required");
}

function isExpiredGoogleSyncError(error) {
  return error?.status === 410 || error?.body?.error?.code === 410;
}

function compactError(error) {
  const message = error?.message || String(error);
  const reason = error?.body?.error?.message || error?.body?.message || null;
  return [message, reason].filter(Boolean).join(": ").slice(0, 1000);
}

function hasUsableEventTimes(event) {
  return !!(
    (event?.start?.dateTime || event?.start?.date)
    && (event?.end?.dateTime || event?.end?.date)
  );
}

function isCancellationTombstone(event) {
  return event?.status === "cancelled" && !hasUsableEventTimes(event);
}

function cancellationPatchForEvent(event, { orgId, calendarConnectionId, now = new Date().toISOString() } = {}) {
  return {
    id: stableSessionIdForGoogleEvent(event, { orgId, calendarConnectionId }),
    org_id: orgId,
    calendar_connection_id: calendarConnectionId,
    google_event_id: event?.id || null,
    google_etag: event?.etag || null,
    status: "cancelled",
    updated_at: now,
  };
}

function googleSessionKey(row) {
  if (!row?.calendar_connection_id || !row?.google_event_id) return null;
  return `${row.calendar_connection_id}\u0000${row.google_event_id}`;
}

async function fetchExistingGoogleSessionRows({
  supabaseUrl,
  serviceRoleKey,
  sessions = [],
  fetchImpl = fetch,
} = {}) {
  const connectionIds = Array.from(new Set((sessions || [])
    .map((session) => session?.calendar_connection_id)
    .filter(Boolean)));
  if (!supabaseUrl || !serviceRoleKey || !connectionIds.length) return [];
  const rows = [];
  for (const calendarConnectionId of connectionIds) {
    const batch = await supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      query: {
        select: "id,calendar_connection_id,google_event_id",
        calendar_connection_id: `eq.${calendarConnectionId}`,
        google_event_id: "not.is.null",
        limit: "10000",
      },
      fetchImpl,
    });
    rows.push(...(Array.isArray(batch) ? batch : []));
  }
  return rows;
}

async function alignSessionRowsToExistingGoogleEvents({
  supabaseUrl,
  serviceRoleKey,
  sessions = [],
  attendees = [],
  fetchImpl = fetch,
} = {}) {
  const existingRows = await fetchExistingGoogleSessionRows({
    supabaseUrl,
    serviceRoleKey,
    sessions,
    fetchImpl,
  });
  const existingByGoogleEvent = new Map();
  for (const row of existingRows) {
    const key = googleSessionKey(row);
    if (key && row.id) existingByGoogleEvent.set(key, row.id);
  }

  const sessionIdMap = new Map();
  const alignedSessions = (sessions || []).map((session) => {
    const existingId = existingByGoogleEvent.get(googleSessionKey(session));
    if (!existingId || existingId === session.id) return session;
    if (session.id) sessionIdMap.set(session.id, existingId);
    return { ...session, id: existingId };
  });
  const alignedAttendees = (attendees || []).map((attendee) => {
    const alignedSessionId = sessionIdMap.get(attendee?.session_id);
    return alignedSessionId ? { ...attendee, session_id: alignedSessionId } : attendee;
  });

  return {
    sessions: alignedSessions,
    attendees: alignedAttendees,
    sessionIdAlignment: Array.from(sessionIdMap, ([from_id, to_id]) => ({ from_id, to_id })),
  };
}

function googleEventsToSyncRows(events, {
  orgId,
  calendarConnectionId,
  policy,
  botEmail,
  now = new Date().toISOString(),
} = {}) {
  const importable = [];
  const cancellationPatches = [];
  const skippedEvents = [];
  for (const event of events || []) {
    if (isCancellationTombstone(event)) {
      cancellationPatches.push(cancellationPatchForEvent(event, { orgId, calendarConnectionId, now }));
    } else if (!hasUsableEventTimes(event)) {
      skippedEvents.push({
        google_event_id: event?.id || null,
        status: event?.status || null,
        reason: "missing start/end times",
      });
    } else {
      importable.push(event);
    }
  }
  return {
    ...googleEventsToSupabaseRows(importable, {
      orgId,
      calendarConnectionId,
      policy,
      botEmail,
    }),
    cancellationPatches,
    skippedEvents,
  };
}

async function fetchCalendarConnection({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  fetchImpl = fetch,
} = {}) {
  if (!calendarConnectionId) return null;
  const query = {
    select: "id,org_id,calendar_id,organizer_email,status,token_ref",
    id: `eq.${calendarConnectionId}`,
    limit: "1",
  };
  if (orgId) query.org_id = `eq.${orgId}`;
  const rows = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_connections",
    query,
    fetchImpl,
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchCalendarSyncState({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  fetchImpl = fetch,
} = {}) {
  if (!calendarConnectionId) return null;
  const query = {
    select: "id,org_id,calendar_connection_id,google_sync_token,sync_status,sync_requested_at,last_full_sync_at,last_incremental_sync_at,last_sync_error",
    calendar_connection_id: `eq.${calendarConnectionId}`,
    limit: "1",
  };
  if (orgId) query.org_id = `eq.${orgId}`;
  const rows = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    query,
    fetchImpl,
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchActiveRoutingPolicy({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  fetchImpl = fetch,
} = {}) {
  if (!orgId) return null;
  const rows = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "routing_policies",
    query: {
      select: "policy_json",
      org_id: `eq.${orgId}`,
      active: "eq.true",
      limit: "1",
    },
    fetchImpl,
  });
  const value = Array.isArray(rows) ? rows[0]?.policy_json : null;
  if (!value) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function upsertCalendarSyncState({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  patch,
  fetchImpl = fetch,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey || !orgId || !calendarConnectionId) return [];
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    method: "POST",
    query: { on_conflict: "calendar_connection_id" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: [{
      org_id: orgId,
      calendar_connection_id: calendarConnectionId,
      ...patch,
      updated_at: patch?.updated_at || new Date().toISOString(),
    }],
    fetchImpl,
  });
}

async function applyCancellationPatches({
  supabaseUrl,
  serviceRoleKey,
  cancellationPatches = [],
  fetchImpl = fetch,
} = {}) {
  const results = [];
  for (const patch of cancellationPatches) {
    // Cancel by the (calendar_connection_id, google_event_id) natural key — the
    // table's unique constraint — so we also tombstone sessions whose stored id
    // differs from the deterministic id (webhook-created rows, or rows with an
    // explicit shape_session_id). Fall back to the deterministic id only when the
    // natural key is unavailable. (C1-01)
    const query = (patch.calendar_connection_id && patch.google_event_id)
      ? {
          calendar_connection_id: `eq.${patch.calendar_connection_id}`,
          google_event_id: `eq.${patch.google_event_id}`,
        }
      : { id: `eq.${patch.id}` };
    const rows = await supabaseServiceRequest({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      method: "PATCH",
      query,
      body: {
        status: "cancelled",
        google_etag: patch.google_etag,
        updated_at: patch.updated_at,
      },
      fetchImpl,
    });
    results.push({ google_event_id: patch.google_event_id, rows });
  }
  return results;
}

async function applySessionRows({
  supabaseUrl,
  serviceRoleKey,
  rows,
  cancellationPatches = [],
  fetchImpl = fetch,
} = {}) {
  const alignedRows = await alignSessionRowsToExistingGoogleEvents({
    supabaseUrl,
    serviceRoleKey,
    sessions: rows.sessions,
    attendees: rows.attendees,
    fetchImpl,
  });
  const requests = buildSupabaseUpsertRequests({
    supabaseUrl,
    sessions: alignedRows.sessions,
    attendees: alignedRows.attendees.filter((attendee) => attendee.session_id),
  });
  const skippedAttendees = alignedRows.attendees.filter((attendee) => !attendee.session_id);
  const results = requests.length
    ? await executeSupabaseRequests({ requests, serviceRoleKey, fetchImpl })
    : [];
  const cancellationResults = await applyCancellationPatches({
    supabaseUrl,
    serviceRoleKey,
    cancellationPatches,
    fetchImpl,
  });
  return {
    results,
    cancellationResults,
    skippedAttendees,
    sessionIdAlignment: alignedRows.sessionIdAlignment,
  };
}

async function hydrateSupabaseContext({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  calendarId,
  syncToken,
  policy,
  fetchImpl,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey || !calendarConnectionId) {
    return { orgId, calendarId, syncToken, policy, connection: null, syncState: null };
  }
  const connection = await fetchCalendarConnection({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    calendarConnectionId,
    fetchImpl,
  });
  const resolvedOrgId = orgId || connection?.org_id || null;
  const syncState = await fetchCalendarSyncState({
    supabaseUrl,
    serviceRoleKey,
    orgId: resolvedOrgId,
    calendarConnectionId,
    fetchImpl,
  });
  const activePolicy = await fetchActiveRoutingPolicy({
    supabaseUrl,
    serviceRoleKey,
    orgId: resolvedOrgId,
    fetchImpl,
  }).catch(() => null);
  return {
    orgId: resolvedOrgId,
    calendarId: calendarId || connection?.calendar_id || null,
    syncToken: syncToken || syncState?.google_sync_token || null,
    policy: activePolicy || policy,
    connection,
    syncState,
  };
}

async function fetchPayloadWithFallback({
  calendarId,
  accessToken,
  syncToken,
  timeMin,
  timeMax,
  maxResults,
  apply,
  supabaseUrl,
  serviceRoleKey,
  orgId,
  calendarConnectionId,
  fetchImpl,
} = {}) {
  try {
    const payload = await fetchGoogleEvents({
      calendarId,
      accessToken,
      syncToken,
      timeMin,
      timeMax,
      maxResults,
      fetchImpl,
    });
    return {
      payload,
      mode: syncToken ? "incremental" : "full",
      recoveredFromExpiredSyncToken: false,
    };
  } catch (error) {
    if (!syncToken || !isExpiredGoogleSyncError(error)) throw error;
    const now = new Date().toISOString();
    if (apply) {
      await upsertCalendarSyncState({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        calendarConnectionId,
        patch: {
          google_sync_token: null,
          sync_status: "expired",
          last_sync_error: "Google Calendar sync token expired; running full sync.",
          updated_at: now,
        },
        fetchImpl,
      });
    }
    const payload = await fetchGoogleEvents({
      calendarId,
      accessToken,
      syncToken: null,
      timeMin: null,
      timeMax: null,
      maxResults,
      fetchImpl,
    });
    return {
      payload,
      mode: "full_after_expired_token",
      recoveredFromExpiredSyncToken: true,
    };
  }
}

async function runGoogleCalendarSync({
  events,
  calendarId,
  accessToken,
  oauthClientId,
  oauthClientSecret,
  oauthRefreshToken,
  syncToken,
  timeMin,
  timeMax,
  maxResults = DEFAULT_MAX_RESULTS,
  orgId,
  calendarConnectionId,
  policy = loadRoutingPolicy(),
  botEmail,
  supabaseUrl,
  serviceRoleKey,
  apply = false,
  forceFull = false,
  loadSupabaseState = true,
  fetchImpl = fetch,
} = {}) {
  if (apply && (!supabaseUrl || !serviceRoleKey)) {
    throw new Error("--apply requires --supabase-url and --service-role-key or their env fallbacks");
  }
  const fixtureMode = !!events;
  const context = fixtureMode || !loadSupabaseState
    ? { orgId, calendarId, syncToken, policy, connection: null, syncState: null }
    : await hydrateSupabaseContext({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        calendarConnectionId,
        calendarId,
        syncToken,
        policy,
        fetchImpl,
      });
  const resolvedOrgId = context.orgId || orgId || null;
  const resolvedCalendarId = context.calendarId || calendarId || null;
  const effectiveSyncToken = forceFull ? null : context.syncToken || syncToken || null;
  const effectivePolicy = context.policy || policy;
  const startedAt = new Date().toISOString();

  if (apply && !fixtureMode && (!resolvedOrgId || !calendarConnectionId)) {
    throw new Error("--apply live sync requires org_id and calendar_connection_id");
  }

  if (apply && !fixtureMode) {
    await upsertCalendarSyncState({
      supabaseUrl,
      serviceRoleKey,
      orgId: resolvedOrgId,
      calendarConnectionId,
      patch: {
        sync_status: "running",
        last_sync_started_at: startedAt,
        last_sync_error: null,
      },
      fetchImpl,
    });
  }

  try {
    const googleAccessToken = fixtureMode
      ? accessToken
      : await resolveGoogleAccessToken({
          accessToken,
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          refreshToken: oauthRefreshToken,
          fetchImpl,
        });
    const fetched = fixtureMode
      ? { payload: normalizeFixturePayload(events), mode: "fixture", recoveredFromExpiredSyncToken: false }
      : await fetchPayloadWithFallback({
          calendarId: resolvedCalendarId,
          accessToken: googleAccessToken,
          syncToken: effectiveSyncToken,
          timeMin,
          timeMax,
          maxResults,
          apply,
          supabaseUrl,
          serviceRoleKey,
          orgId: resolvedOrgId,
          calendarConnectionId,
          fetchImpl,
        });

    const rowPayload = googleEventsToSyncRows(fetched.payload.items, {
      orgId: resolvedOrgId,
      calendarConnectionId,
      policy: effectivePolicy,
      botEmail,
    });
    const requests = supabaseUrl
      ? buildSupabaseUpsertRequests({
          supabaseUrl,
          sessions: rowPayload.sessions,
          attendees: rowPayload.attendees.filter((attendee) => attendee.session_id),
        })
      : [];
    const applied = apply
      ? await applySessionRows({
          supabaseUrl,
          serviceRoleKey,
          rows: rowPayload,
          cancellationPatches: rowPayload.cancellationPatches,
          fetchImpl,
        })
      : null;

    let syncStateRows = [];
    if (apply && !fixtureMode) {
      const finishedAt = new Date().toISOString();
      syncStateRows = await upsertCalendarSyncState({
        supabaseUrl,
        serviceRoleKey,
        orgId: resolvedOrgId,
        calendarConnectionId,
        patch: {
          google_sync_token: fetched.payload.nextSyncToken || null,
          sync_requested_at: null,
          sync_status: "ok",
          last_sync_finished_at: finishedAt,
          last_sync_error: null,
          ...(fetched.mode === "incremental"
            ? { last_incremental_sync_at: finishedAt }
            : { last_full_sync_at: finishedAt }),
        },
        fetchImpl,
      });
    }

    return {
      source: {
        calendar_id: resolvedCalendarId || null,
        live: !fixtureMode,
        calendar_connection_id: calendarConnectionId || null,
      },
      sync: {
        mode: fetched.mode,
        stored_sync_token_used: !!effectiveSyncToken,
        recovered_from_expired_sync_token: fetched.recoveredFromExpiredSyncToken,
        next_sync_token_saved: !!(apply && !fixtureMode && fetched.payload.nextSyncToken),
      },
      nextSyncToken: fetched.payload.nextSyncToken || null,
      sessions: rowPayload.sessions,
      attendees: rowPayload.attendees,
      cancellationPatches: rowPayload.cancellationPatches,
      skippedEvents: rowPayload.skippedEvents,
      dryRunRequests: !apply && supabaseUrl ? requests : undefined,
      applied: applied || undefined,
      syncStateRows: syncStateRows.length ? syncStateRows : undefined,
    };
  } catch (error) {
    if (apply && !fixtureMode) {
      await upsertCalendarSyncState({
        supabaseUrl,
        serviceRoleKey,
        orgId: resolvedOrgId,
        calendarConnectionId,
        patch: {
          sync_status: "error",
          last_sync_finished_at: new Date().toISOString(),
          last_sync_error: compactError(error),
        },
        fetchImpl,
      }).catch(() => null);
    }
    throw error;
  }
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const eventsPath = arg("--events", argv);
  const policy = loadRoutingPolicy(arg("--policy", argv) || defaultPolicyPath());
  const supabaseUrl = arg("--supabase-url", argv) || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL;
  const result = await runGoogleCalendarSync({
    events: eventsPath ? readJson(eventsPath) : null,
    policy,
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    syncToken: arg("--sync-token", argv) || process.env.GOOGLE_CALENDAR_SYNC_TOKEN || process.env.GOOGLE_SYNC_TOKEN,
    timeMin: arg("--time-min", argv),
    timeMax: arg("--time-max", argv),
    maxResults: numberArg("--max-results", DEFAULT_MAX_RESULTS, argv),
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    calendarConnectionId: arg("--calendar-connection-id", argv) || process.env.CALENDAR_CONNECTION_ID,
    botEmail: arg("--bot-email", argv) || process.env.SHAPE_CALENDAR_BOT_EMAIL,
    supabaseUrl,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    apply: flag("--apply", argv),
    forceFull: flag("--full", argv),
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
  alignSessionRowsToExistingGoogleEvents,
  applyCancellationPatches,
  buildGoogleEventsListUrl,
  fetchGoogleEvents,
  googleEventsToSyncRows,
  resolveGoogleAccessToken,
  runGoogleCalendarSync,
  isExpiredGoogleSyncError,
};
