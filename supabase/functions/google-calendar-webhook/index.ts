import { corsHeaders, errorResponse, jsonResponse, requiredEnv } from "../_shared/http.ts";
import { DEFAULT_ROUTING_POLICY, googleEventAttendeeRows, googleEventToSessionRow } from "../_shared/calendar.ts";
import { supabaseRest, upsertRows } from "../_shared/supabase_rest.ts";

function statusError(message, status) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function parseGoogleExpiration(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function requireKnownWatchChannel({ supabaseUrl, serviceRoleKey, notification }) {
  if (!notification.org_id || !notification.calendar_connection_id) {
    throw statusError("org_id and calendar_connection_id query params are required", 400);
  }
  if (!notification.channel_id || !notification.resource_id) {
    throw statusError("Google channel and resource headers are required", 400);
  }
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    method: "GET",
    query: {
      select: "id,org_id,calendar_connection_id,watch_channel_id,watch_resource_id",
      org_id: `eq.${notification.org_id}`,
      calendar_connection_id: `eq.${notification.calendar_connection_id}`,
      watch_channel_id: `eq.${notification.channel_id}`,
      watch_resource_id: `eq.${notification.resource_id}`,
      limit: "1",
    },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw statusError("unknown Google Calendar watch channel", 404);
  return row;
}

async function resolveCalendarConnection({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId }) {
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_connections",
    method: "GET",
    query: {
      select: "id,org_id,calendar_id,status,provider",
      id: `eq.${calendarConnectionId}`,
      org_id: `eq.${orgId}`,
      status: "eq.active",
      provider: "eq.google",
      limit: "1",
    },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.calendar_id) throw statusError("active Google calendar connection was not found", 404);
  return row;
}

async function resolveRoutingPolicy({ supabaseUrl, serviceRoleKey, orgId }) {
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "routing_policies",
    method: "GET",
    query: {
      select: "policy_json",
      org_id: `eq.${orgId}`,
      policy_key: "eq.transcript-routing",
      active: "eq.true",
      order: "created_at.desc",
      limit: "1",
    },
  });
  const value = Array.isArray(rows) ? rows[0]?.policy_json : null;
  return value || DEFAULT_ROUTING_POLICY;
}

async function fetchSyncState({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId }) {
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    method: "GET",
    query: {
      select: "id,google_sync_token",
      org_id: `eq.${orgId}`,
      calendar_connection_id: `eq.${calendarConnectionId}`,
      limit: "1",
    },
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function refreshGoogleAccessToken() {
  const clientId = requiredEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requiredEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = requiredEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const error = new Error(`Google OAuth token refresh ${response.status}`) as Error & { status?: number; body?: unknown };
    error.status = 500;
    error.body = payload;
    throw error;
  }
  return payload.access_token;
}

function hasUsableEventTimes(event) {
  return !!((event?.start?.dateTime || event?.start?.date) && (event?.end?.dateTime || event?.end?.date));
}

function isExpiredGoogleSyncError(error) {
  return error?.status === 410 || error?.body?.error?.code === 410;
}

async function fetchGoogleEvents({ calendarId, accessToken, syncToken }) {
  const items = [];
  let nextPageToken = null;
  let nextSyncToken = null;
  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "true");
    if (syncToken) url.searchParams.set("syncToken", syncToken);
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Google Calendar events.list ${response.status}`) as Error & { status?: number; body?: unknown };
      error.status = response.status;
      error.body = payload;
      throw error;
    }
    items.push(...(payload?.items || []));
    nextPageToken = payload?.nextPageToken || null;
    nextSyncToken = payload?.nextSyncToken || nextSyncToken;
  } while (nextPageToken);
  return { items, nextSyncToken };
}

async function patchCancelledTombstone({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId, event, now }) {
  if (!event?.id) return [];
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    method: "PATCH",
    query: {
      org_id: `eq.${orgId}`,
      calendar_connection_id: `eq.${calendarConnectionId}`,
      google_event_id: `eq.${event.id}`,
    },
    body: {
      status: "cancelled",
      google_etag: event.etag || null,
      updated_at: now,
    },
  });
}

async function upsertSyncedEvents({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId, events, policy, botEmail }) {
  const now = new Date().toISOString();
  const importableEvents = [];
  const skippedEvents = [];
  const cancellationResults = [];

  for (const event of events || []) {
    if (event?.status === "cancelled" && !hasUsableEventTimes(event)) {
      cancellationResults.push(await patchCancelledTombstone({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        calendarConnectionId,
        event,
        now,
      }));
      continue;
    }
    if (!hasUsableEventTimes(event)) {
      skippedEvents.push({ google_event_id: event?.id || null, reason: "missing start/end times" });
      continue;
    }
    importableEvents.push(event);
  }

  const sessionRows = importableEvents.map((event) => googleEventToSessionRow(event, {
    orgId,
    calendarConnectionId,
    policy,
  }));
  const sessions = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    rows: sessionRows,
    onConflict: "calendar_connection_id,google_event_id",
  });
  const sessionIdByEventId = new Map((sessions || []).map((row) => [row.google_event_id, row.id]));
  const attendeeRows = importableEvents.flatMap((event) => googleEventAttendeeRows(event, {
    orgId,
    sessionId: sessionIdByEventId.get(event.id) || event?.extendedProperties?.private?.shape_session_id,
    botEmail,
  })).filter((row) => row.session_id);
  const attendees = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "session_attendees",
    rows: attendeeRows,
    onConflict: "session_id,email",
  });
  return {
    sessions,
    attendees,
    skippedEvents,
    cancellationResults,
  };
}

async function runIncrementalSync({ supabaseUrl, serviceRoleKey, notification }) {
  const orgId = notification.org_id;
  const calendarConnectionId = notification.calendar_connection_id;
  const connection = await resolveCalendarConnection({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId });
  const syncState = await fetchSyncState({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId });
  const policy = await resolveRoutingPolicy({ supabaseUrl, serviceRoleKey, orgId });
  const accessToken = await refreshGoogleAccessToken();
  const startedAt = new Date().toISOString();
  let recoveredFromExpiredSyncToken = false;
  let googleEvents;
  try {
    googleEvents = await fetchGoogleEvents({
      calendarId: connection.calendar_id,
      accessToken,
      syncToken: syncState?.google_sync_token || null,
    });
  } catch (error) {
    if (!isExpiredGoogleSyncError(error) || !syncState?.google_sync_token) throw error;
    recoveredFromExpiredSyncToken = true;
    googleEvents = await fetchGoogleEvents({
      calendarId: connection.calendar_id,
      accessToken,
      syncToken: null,
    });
  }

  const applied = await upsertSyncedEvents({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    calendarConnectionId,
    events: googleEvents.items,
    policy,
    botEmail: Deno.env.get("SHAPE_CALENDAR_BOT_EMAIL") || "",
  });
  const finishedAt = new Date().toISOString();
  const persisted = await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_sync_state",
    rows: [{
      id: syncState?.id || undefined,
      org_id: orgId,
      calendar_connection_id: calendarConnectionId,
      google_sync_token: googleEvents.nextSyncToken || syncState?.google_sync_token || null,
      watch_channel_id: notification.channel_id,
      watch_resource_id: notification.resource_id,
      watch_expiration: parseGoogleExpiration(notification.channel_expiration),
      sync_requested_at: null,
      sync_status: "ok",
      last_incremental_sync_at: finishedAt,
      last_sync_started_at: startedAt,
      last_sync_finished_at: finishedAt,
      last_sync_error: null,
      updated_at: finishedAt,
    }],
    onConflict: "calendar_connection_id",
  });

  return {
    mode: syncState?.google_sync_token && !recoveredFromExpiredSyncToken ? "incremental" : "full",
    recovered_from_expired_sync_token: recoveredFromExpiredSyncToken,
    events_seen: googleEvents.items.length,
    sessions_upserted: applied.sessions.length,
    attendees_upserted: applied.attendees.length,
    skipped_events: applied.skippedEvents,
    sync_state: persisted,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const expectedToken = requiredEnv("GOOGLE_CALENDAR_WEBHOOK_TOKEN");
    const receivedToken = req.headers.get("x-goog-channel-token");
    if (receivedToken !== expectedToken) {
      return jsonResponse({ error: "invalid Google channel token" }, 401);
    }
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    const url = new URL(req.url);
    const notification = {
      channel_id: req.headers.get("x-goog-channel-id"),
      channel_token_present: !!receivedToken,
      resource_id: req.headers.get("x-goog-resource-id"),
      resource_state: req.headers.get("x-goog-resource-state"),
      message_number: req.headers.get("x-goog-message-number"),
      channel_expiration: req.headers.get("x-goog-channel-expiration"),
      org_id: url.searchParams.get("org_id"),
      calendar_connection_id: url.searchParams.get("calendar_connection_id"),
      received_at: new Date().toISOString(),
    };

    const watch = await requireKnownWatchChannel({ supabaseUrl, serviceRoleKey, notification });
    const persisted = await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "calendar_sync_state",
      rows: [{
        id: watch.id,
        org_id: notification.org_id,
        calendar_connection_id: notification.calendar_connection_id,
        watch_channel_id: notification.channel_id,
        watch_resource_id: notification.resource_id,
        watch_expiration: parseGoogleExpiration(notification.channel_expiration),
        sync_requested_at: notification.received_at,
        sync_status: "requested",
        last_sync_error: null,
        updated_at: notification.received_at,
      }],
      onConflict: "calendar_connection_id",
    });
    let sync = null;
    try {
      sync = await runIncrementalSync({ supabaseUrl, serviceRoleKey, notification });
    } catch (syncError) {
      await upsertRows({
        supabaseUrl,
        serviceRoleKey,
        table: "calendar_sync_state",
        rows: [{
          id: watch.id,
          org_id: notification.org_id,
          calendar_connection_id: notification.calendar_connection_id,
          sync_status: "error",
          last_sync_error: syncError?.message || String(syncError),
          updated_at: new Date().toISOString(),
        }],
        onConflict: "calendar_connection_id",
      });
      throw syncError;
    }

    return jsonResponse({
      ok: true,
      needs_incremental_sync: false,
      notification,
      persisted,
      sync,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
