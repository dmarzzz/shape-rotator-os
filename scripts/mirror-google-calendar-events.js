#!/usr/bin/env node
const crypto = require("node:crypto");
const {
  supabaseServiceRequest,
} = require("./lib/supabase-rest.cjs");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

const DEFAULT_LIMIT = 10000;
const DEFAULT_TIME_ZONE = "America/New_York";

// Session types that must never reach the PUBLIC guest calendar (do_not_publish
// routes per cohort-data/policies/transcript-routing-policy.json). The guest mirror
// is automated, so this is the gate that keeps private/coordinator sessions off it.
const DO_NOT_PUBLISH_SESSION_TYPES = new Set(["private_1on1", "planning_strategy"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/mirror-google-calendar-events.js --source-calendar-connection-id ADMIN_CONNECTION_ID --mirror-calendar-connection-id GUEST_CONNECTION_ID --mirror-calendar-id GUEST_CALENDAR_ID",
    "  node scripts/mirror-google-calendar-events.js --env-file .env.calendar.local --apply",
    "",
    "What it does:",
    "  Mirrors canonical/admin Supabase sessions into a guest Google Calendar.",
    "  Guest events keep the same public time/title and Meet URL, but do not carry",
    "  attendees, conferenceData, attachments, or transcript ownership.",
    "",
    "Options:",
    "  --apply                                  Write to Google and Supabase. Default is dry-run.",
    "  --dry-run                                Print actions without writing. This is the default.",
    "  --skip-if-unconfigured                   Return a skipped result when guest calendar env is absent.",
    "  --source-calendar-connection-id ID       Admin/canonical calendar connection ID.",
    "  --mirror-calendar-connection-id ID       Guest mirror calendar connection ID.",
    "  --mirror-calendar-id ID                  Guest Google Calendar ID.",
    "  --time-min ISO_DATETIME                  Only mirror sessions starting at or after this time.",
    "  --time-max ISO_DATETIME                  Only mirror sessions starting before this time.",
    "  --limit N                                Supabase session/mapping limit. Default 10000.",
    "  --force                                  Patch existing mirrors even when source etag is unchanged.",
    "  --stateless                              Use deterministic mirror event IDs without the mapping table.",
    "  --stateless-if-missing                   Fall back to stateless mode if the mirror table is absent.",
    "  --access-token TOKEN                     OAuth token with write access to the guest calendar.",
    "  --env-file FILE                          Load local KEY=value secrets before env fallbacks.",
    "",
    "Environment fallbacks:",
    "  SHAPE_SUPABASE_URL or SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  CALENDAR_CONNECTION_ID",
    "  GUEST_CALENDAR_CONNECTION_ID",
    "  GOOGLE_GUEST_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN",
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

function stableMirrorEventId(session) {
  const key = [
    "shape-rotator-guest-mirror",
    session?.org_id || "",
    session?.calendar_connection_id || "",
    session?.google_event_id || session?.id || "",
  ].join(":");
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  return `srosm${hash}`.slice(0, 1024);
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function googleDate(value, timeZone = DEFAULT_TIME_ZONE) {
  if (isDateOnly(value)) return { date: value };
  return { dateTime: value, timeZone };
}

function meetUrlForSession(session) {
  if (session?.google_meet_url) return session.google_meet_url;
  if (session?.google_meeting_code) return `https://meet.google.com/${session.google_meeting_code}`;
  return null;
}

function guestDescriptionForSession(session) {
  const meetUrl = meetUrlForSession(session);
  const lines = [
    "Managed by Shape Rotator OS.",
    "Public calendar mirror.",
  ];
  if (meetUrl) lines.push("", `Join: ${meetUrl}`);
  return lines.join("\n");
}

function buildGuestMirrorEventBody({
  session,
  mirrorCalendarId,
} = {}) {
  if (!session?.google_event_id) throw new Error("session.google_event_id is required");
  if (!session?.starts_at || !session?.ends_at) throw new Error("session starts_at and ends_at are required");
  const timeZone = session.timezone || DEFAULT_TIME_ZONE;
  const meetUrl = meetUrlForSession(session);
  const body = {
    id: stableMirrorEventId(session),
    summary: session.public_title || session.title || "Shape Rotator session",
    description: guestDescriptionForSession(session),
    start: googleDate(session.starts_at, timeZone),
    end: googleDate(session.ends_at, timeZone),
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    visibility: "public",
    extendedProperties: {
      private: {
        shape_mirror_kind: "guest_calendar",
        shape_source_session_id: String(session.id || ""),
        shape_source_calendar_connection_id: String(session.calendar_connection_id || ""),
        shape_source_google_event_id: String(session.google_event_id || ""),
        shape_mirror_calendar_id: String(mirrorCalendarId || ""),
      },
    },
  };
  if (meetUrl) {
    body.location = session.location && session.location !== meetUrl
      ? session.location
      : meetUrl;
  } else if (session.location) {
    body.location = session.location;
  }
  return body;
}

function eventPatchFromBody(body) {
  return {
    summary: body.summary,
    description: body.description,
    start: body.start,
    end: body.end,
    location: body.location || null,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    visibility: body.visibility,
    extendedProperties: body.extendedProperties,
  };
}

function googleEventsUrl(calendarId, suffix = "") {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${suffix}`);
}

async function googleRequest({ url, accessToken, method = "GET", body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Calendar ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function insertMirrorEvent({ calendarId, accessToken, body, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId);
  url.searchParams.set("sendUpdates", "none");
  url.searchParams.set("conferenceDataVersion", "0");
  return googleRequest({ url, accessToken, method: "POST", body, fetchImpl });
}

async function patchMirrorEvent({ calendarId, accessToken, eventId, body, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId, `/${encodeURIComponent(eventId)}`);
  url.searchParams.set("sendUpdates", "none");
  url.searchParams.set("conferenceDataVersion", "0");
  return googleRequest({
    url,
    accessToken,
    method: "PATCH",
    body: eventPatchFromBody(body),
    fetchImpl,
  });
}

async function deleteMirrorEvent({ calendarId, accessToken, eventId, fetchImpl = fetch }) {
  const url = googleEventsUrl(calendarId, `/${encodeURIComponent(eventId)}`);
  url.searchParams.set("sendUpdates", "none");
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    const data = await response.json().catch(() => null);
    const error = new Error(`Google Calendar DELETE ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return { deleted: true };
}

async function fetchSourceSessions({
  supabaseUrl,
  serviceRoleKey,
  sourceCalendarConnectionId,
  timeMin,
  timeMax,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
} = {}) {
  const query = {
    select: [
      "id",
      "org_id",
      "calendar_connection_id",
      "title",
      "public_title",
      "session_type",
      "max_tier",
      "status",
      "starts_at",
      "ends_at",
      "timezone",
      "location",
      "google_calendar_id",
      "google_event_id",
      "google_etag",
      "google_meet_url",
      "google_meeting_code",
    ].join(","),
    calendar_connection_id: `eq.${sourceCalendarConnectionId}`,
    google_event_id: "not.is.null",
    status: "in.(scheduled,completed,cancelled)",
    order: "starts_at.asc",
    limit: String(limit),
  };
  if (timeMin && timeMax) {
    query.and = `(starts_at.gte.${timeMin},starts_at.lt.${timeMax})`;
  } else if (timeMin) {
    query.starts_at = `gte.${timeMin}`;
  } else if (timeMax) {
    query.starts_at = `lt.${timeMax}`;
  }
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    query,
    fetchImpl,
  });
}

async function fetchMirrorMappings({
  supabaseUrl,
  serviceRoleKey,
  sourceCalendarConnectionId,
  mirrorCalendarConnectionId,
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
} = {}) {
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_event_mirrors",
    query: {
      select: [
        "id",
        "org_id",
        "source_calendar_connection_id",
        "source_session_id",
        "source_google_event_id",
        "source_google_etag",
        "mirror_calendar_connection_id",
        "mirror_google_calendar_id",
        "mirror_google_event_id",
        "mirror_google_etag",
        "mirror_status",
      ].join(","),
      source_calendar_connection_id: `eq.${sourceCalendarConnectionId}`,
      mirror_calendar_connection_id: `eq.${mirrorCalendarConnectionId}`,
      limit: String(limit),
    },
    fetchImpl,
  });
}

async function upsertMirrorMappings({
  supabaseUrl,
  serviceRoleKey,
  rows,
  fetchImpl = fetch,
} = {}) {
  const compact = (rows || []).filter(Boolean);
  if (!compact.length) return [];
  return supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "calendar_event_mirrors",
    method: "POST",
    query: { on_conflict: "source_calendar_connection_id,source_google_event_id,mirror_calendar_connection_id" },
    prefer: "resolution=merge-duplicates,return=representation",
    body: compact,
    fetchImpl,
  });
}

function mappingRowForSession({
  session,
  mapping,
  mirrorCalendarConnectionId,
  mirrorCalendarId,
  mirrorEvent,
  status,
  error,
  now = new Date().toISOString(),
} = {}) {
  return {
    id: mapping?.id || undefined,
    org_id: session?.org_id || mapping?.org_id,
    source_calendar_connection_id: session?.calendar_connection_id || mapping?.source_calendar_connection_id,
    source_session_id: session?.id || mapping?.source_session_id || null,
    source_google_calendar_id: session?.google_calendar_id || null,
    source_google_event_id: session?.google_event_id || mapping?.source_google_event_id,
    source_google_etag: session?.google_etag || null,
    mirror_calendar_connection_id: mirrorCalendarConnectionId || mapping?.mirror_calendar_connection_id,
    mirror_google_calendar_id: mirrorCalendarId || mapping?.mirror_google_calendar_id,
    mirror_google_event_id: mirrorEvent?.id || mapping?.mirror_google_event_id || stableMirrorEventId(session),
    mirror_google_etag: mirrorEvent?.etag || mapping?.mirror_google_etag || null,
    mirror_google_html_link: mirrorEvent?.htmlLink || mapping?.mirror_google_html_link || null,
    mirror_status: status,
    last_mirrored_at: status === "error" ? mapping?.last_mirrored_at || null : now,
    last_error: error || null,
    updated_at: now,
  };
}

function needsMirrorUpdate({ session, mapping, force = false }) {
  if (force) return true;
  if (!mapping?.mirror_google_event_id) return true;
  if (mapping.mirror_status !== "active") return true;
  if (!session.google_etag) return true;
  return mapping.source_google_etag !== session.google_etag;
}

async function runGuestCalendarMirror({
  sessions,
  mappings,
  supabaseUrl,
  serviceRoleKey,
  sourceCalendarConnectionId,
  mirrorCalendarConnectionId,
  mirrorCalendarId,
  accessToken,
  oauthClientId,
  oauthClientSecret,
  oauthRefreshToken,
  timeMin,
  timeMax,
  limit = DEFAULT_LIMIT,
  apply = false,
  force = false,
  stateless = false,
  statelessIfMissing = false,
  skipIfUnconfigured = false,
  fetchImpl = fetch,
} = {}) {
  const missingConfig = [
    ["sourceCalendarConnectionId", sourceCalendarConnectionId],
    ["mirrorCalendarConnectionId", mirrorCalendarConnectionId],
    ["mirrorCalendarId", mirrorCalendarId],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missingConfig.length) {
    if (skipIfUnconfigured) {
      return {
        configured: false,
        skipped: true,
        reason: `missing ${missingConfig.join(", ")}`,
        actions: [],
      };
    }
    throw new Error(`${missingConfig.join(", ")} required`);
  }
  if (!Array.isArray(sessions)) {
    if (!supabaseUrl || !serviceRoleKey) throw new Error("supabaseUrl and serviceRoleKey are required when sessions are not provided");
    sessions = await fetchSourceSessions({
      supabaseUrl,
      serviceRoleKey,
      sourceCalendarConnectionId,
      timeMin,
      timeMax,
      limit,
      fetchImpl,
    });
  }
  let statelessMode = !!stateless;
  if (!Array.isArray(mappings) && !statelessMode) {
    if (supabaseUrl && serviceRoleKey) {
      try {
        mappings = await fetchMirrorMappings({
          supabaseUrl,
          serviceRoleKey,
          sourceCalendarConnectionId,
          mirrorCalendarConnectionId,
          limit,
          fetchImpl,
        });
      } catch (error) {
        if (!statelessIfMissing || error?.status !== 404) throw error;
        statelessMode = true;
        mappings = [];
      }
    } else {
      mappings = [];
    }
  }

  const token = apply
    ? await resolveGoogleAccessToken({
      accessToken,
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      refreshToken: oauthRefreshToken,
      fetchImpl,
    })
    : null;
  const mappingBySourceEventId = new Map((mappings || []).map((row) => [row.source_google_event_id, row]));
  const actions = [];
  const rowsToUpsert = [];
  const now = new Date().toISOString();

  for (const session of sessions || []) {
    if (!session?.google_event_id) continue;
    const mapping = mappingBySourceEventId.get(session.google_event_id) || null;
    const doNotPublish = DO_NOT_PUBLISH_SESSION_TYPES.has(session.session_type);
    const desiredBody = session.status === "cancelled" || doNotPublish
      ? null
      : buildGuestMirrorEventBody({ session, mirrorCalendarId });

    if (session.status === "cancelled" || doNotPublish) {
      const mirrorEventId = mapping?.mirror_google_event_id || (statelessMode ? stableMirrorEventId(session) : null);
      if (!mirrorEventId) {
        actions.push(doNotPublish
          ? {
              action: "skip-do-not-publish-session-type",
              source_google_event_id: session.google_event_id,
              session_type: session.session_type,
            }
          : { action: "skip-cancelled-without-mirror", source_google_event_id: session.google_event_id });
        continue;
      }
      if (apply) {
        await deleteMirrorEvent({
          calendarId: mirrorCalendarId,
          accessToken: token,
          eventId: mirrorEventId,
          fetchImpl,
        });
      }
      actions.push({
        action: apply ? "deleted" : "delete",
        source_google_event_id: session.google_event_id,
        mirror_google_event_id: mirrorEventId,
        reason: doNotPublish ? "do-not-publish-session-type" : "cancelled",
        session_type: session.session_type,
      });
      if (!statelessMode) {
        rowsToUpsert.push(mappingRowForSession({
          session,
          mapping,
          mirrorCalendarConnectionId,
          mirrorCalendarId,
          mirrorEvent: { id: mirrorEventId, etag: mapping?.mirror_google_etag || null },
          status: "cancelled",
          now,
        }));
      }
      continue;
    }

    if (!needsMirrorUpdate({ session, mapping, force })) {
      actions.push({
        action: "unchanged",
        source_google_event_id: session.google_event_id,
        mirror_google_event_id: mapping.mirror_google_event_id,
      });
      continue;
    }

    const existingMirrorId = mapping?.mirror_google_event_id || desiredBody.id;
    let mirrorEvent = null;
    let action = mapping?.mirror_google_event_id ? "updated" : "inserted";
    if (apply) {
      if (mapping?.mirror_google_event_id) {
        mirrorEvent = await patchMirrorEvent({
          calendarId: mirrorCalendarId,
          accessToken: token,
          eventId: existingMirrorId,
          body: desiredBody,
          fetchImpl,
        });
      } else {
        try {
          mirrorEvent = await insertMirrorEvent({
            calendarId: mirrorCalendarId,
            accessToken: token,
            body: desiredBody,
            fetchImpl,
          });
        } catch (error) {
          if (error?.status !== 409) throw error;
          action = "relinked";
          mirrorEvent = await patchMirrorEvent({
            calendarId: mirrorCalendarId,
            accessToken: token,
            eventId: existingMirrorId,
            body: desiredBody,
            fetchImpl,
          });
        }
      }
    } else {
      mirrorEvent = {
        id: existingMirrorId,
        etag: mapping?.mirror_google_etag || null,
        htmlLink: mapping?.mirror_google_html_link || null,
      };
      action = mapping?.mirror_google_event_id ? "update" : "insert";
    }

    actions.push({
      action,
      source_google_event_id: session.google_event_id,
      source_google_etag: session.google_etag || null,
      mirror_google_event_id: mirrorEvent?.id || existingMirrorId,
      summary: desiredBody.summary,
      has_meet_link: !!meetUrlForSession(session),
      strips_attendees: true,
      strips_conference_data: true,
      strips_attachments: true,
    });
    if (!statelessMode) {
      rowsToUpsert.push(mappingRowForSession({
        session,
        mapping,
        mirrorCalendarConnectionId,
        mirrorCalendarId,
        mirrorEvent,
        status: "active",
        now,
      }));
    }
  }

  const persisted = apply && !statelessMode && supabaseUrl && serviceRoleKey
    ? await upsertMirrorMappings({
      supabaseUrl,
      serviceRoleKey,
      rows: rowsToUpsert,
      fetchImpl,
    })
    : [];

  return {
    configured: true,
    apply: !!apply,
    stateless: statelessMode,
    source_calendar_connection_id: sourceCalendarConnectionId,
    mirror_calendar_connection_id: mirrorCalendarConnectionId,
    mirror_calendar_id: mirrorCalendarId,
    sessions_seen: sessions.length,
    planned: actions.length,
    inserted: actions.filter((action) => action.action === "inserted" || action.action === "insert").length,
    updated: actions.filter((action) => action.action === "updated" || action.action === "update" || action.action === "relinked").length,
    deleted: actions.filter((action) => action.action === "deleted" || action.action === "delete").length,
    unchanged: actions.filter((action) => action.action === "unchanged").length,
    actions,
    persisted,
  };
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const supabaseUrl = arg("--supabase-url", argv) || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL;
  const explicitAccessToken = arg("--access-token", argv);
  const hasRefreshCredentials = !!(
    process.env.GOOGLE_OAUTH_CLIENT_ID
    && process.env.GOOGLE_OAUTH_CLIENT_SECRET
    && process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  const result = await runGuestCalendarMirror({
    supabaseUrl,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    sourceCalendarConnectionId: arg("--source-calendar-connection-id", argv) || process.env.CALENDAR_CONNECTION_ID,
    mirrorCalendarConnectionId: arg("--mirror-calendar-connection-id", argv) || process.env.GUEST_CALENDAR_CONNECTION_ID,
    mirrorCalendarId: arg("--mirror-calendar-id", argv) || process.env.GOOGLE_GUEST_CALENDAR_ID,
    accessToken: explicitAccessToken
      || (hasRefreshCredentials ? null : process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN),
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    timeMin: arg("--time-min", argv),
    timeMax: arg("--time-max", argv),
    limit: numberArg("--limit", DEFAULT_LIMIT, argv),
    apply,
    force: flag("--force", argv),
    stateless: flag("--stateless", argv),
    statelessIfMissing: flag("--stateless-if-missing", argv),
    skipIfUnconfigured: flag("--skip-if-unconfigured", argv),
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
  buildGuestMirrorEventBody,
  fetchMirrorMappings,
  fetchSourceSessions,
  guestDescriptionForSession,
  meetUrlForSession,
  needsMirrorUpdate,
  runGuestCalendarMirror,
  stableMirrorEventId,
};
