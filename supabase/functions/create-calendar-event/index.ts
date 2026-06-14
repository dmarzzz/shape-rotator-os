import { buildGoogleCalendarEvent, DEFAULT_ROUTING_POLICY, extractMeetingCode, googleEventAttendeeRows, googleEventToSessionRow } from "../_shared/calendar.ts";
import { requireOrgRole } from "../_shared/auth.ts";
import { corsHeaders, envJson, errorResponse, jsonResponse, optionalEnv, readJson, requiredEnv } from "../_shared/http.ts";
import { supabaseRest, upsertRows } from "../_shared/supabase_rest.ts";

function statusError(message, status) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

async function resolveCalendarConnection({ supabaseUrl, serviceRoleKey, orgId, calendarConnectionId }) {
  if (!calendarConnectionId) throw statusError("calendar_connection_id is required", 400);
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
      select: "id,policy_json",
      org_id: `eq.${orgId}`,
      policy_key: "eq.transcript-routing",
      active: "eq.true",
      order: "created_at.desc",
      limit: "1",
    },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  const envPolicy = envJson("ROUTING_POLICY_JSON", null);
  return {
    policy: row?.policy_json || envPolicy || DEFAULT_ROUTING_POLICY,
    policyId: row?.id || null,
  };
}

async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }) {
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

async function resolveGoogleAccessToken() {
  const refreshToken = optionalEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (refreshToken && clientId && clientSecret) {
    return await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken });
  }

  const googleAccessToken = optionalEnv("GOOGLE_CALENDAR_ACCESS_TOKEN") || optionalEnv("GOOGLE_ACCESS_TOKEN");
  if (googleAccessToken) return googleAccessToken;
  throw new Error("GOOGLE_OAUTH_REFRESH_TOKEN with GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET or GOOGLE_CALENDAR_ACCESS_TOKEN is required");
}

function autoGeneration(value) {
  return value ? "ON" : "OFF";
}

const MEET_ARTIFACT_UPDATE_FIELDS = {
  recording: "config.artifactConfig.recordingConfig.autoRecordingGeneration",
  transcript: "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  smartNotes: "config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
};

function buildMeetAutoArtifactPatch({ transcript = true, recording = false, smartNotes = null } = {}) {
  const artifactConfig: Record<string, unknown> = {};
  const updateFields: string[] = [];
  if (recording !== null) {
    artifactConfig.recordingConfig = {
      autoRecordingGeneration: autoGeneration(recording),
    };
    updateFields.push(MEET_ARTIFACT_UPDATE_FIELDS.recording);
  }
  if (transcript !== null) {
    artifactConfig.transcriptionConfig = {
      autoTranscriptionGeneration: autoGeneration(transcript),
    };
    updateFields.push(MEET_ARTIFACT_UPDATE_FIELDS.transcript);
  }
  if (smartNotes !== null) {
    artifactConfig.smartNotesConfig = {
      autoSmartNotesGeneration: autoGeneration(smartNotes),
    };
    updateFields.push(MEET_ARTIFACT_UPDATE_FIELDS.smartNotes);
  }
  return {
    body: {
      config: {
        artifactConfig,
      },
    },
    updateMask: updateFields.join(","),
  };
}

async function configureMeetAutoArtifacts({ googleEvent, accessToken, transcript, recording, smartNotes }) {
  const meetUrl = googleEvent?.hangoutLink
    || googleEvent?.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri
    || null;
  const meetingCode = extractMeetingCode(meetUrl || googleEvent?.conferenceData?.conferenceId);
  if (!meetingCode) return { requested: false, configured: false, reason: "missing_meeting_code" };

  const getResponse = await fetch(`https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const space = await getResponse.json().catch(() => null);
  if (!getResponse.ok) {
    return {
      requested: true,
      configured: false,
      meeting_code: meetingCode,
      error: `Google Meet spaces.get ${getResponse.status}`,
      body: space,
    };
  }

  const patch = buildMeetAutoArtifactPatch({ transcript, recording, smartNotes });
  const patchUrl = new URL(`https://meet.googleapis.com/v2/${space?.name || `spaces/${meetingCode}`}`);
  patchUrl.searchParams.set("updateMask", patch.updateMask);
  const patchResponse = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(patch.body),
  });
  const patched = await patchResponse.json().catch(() => null);
  if (!patchResponse.ok) {
    return {
      requested: true,
      configured: false,
      meeting_code: meetingCode,
      space_name: space?.name || null,
      error: `Google Meet spaces.patch ${patchResponse.status}`,
      body: patched,
    };
  }
  return {
    requested: true,
    configured: true,
    meeting_code: meetingCode,
    space_name: patched?.name || space?.name || null,
    artifact_config: patched?.config?.artifactConfig || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  try {
    const body = await readJson(req);
    const orgId = body.org_id;
    if (!orgId) throw statusError("org_id is required", 400);
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    await requireOrgRole({
      req,
      supabaseUrl,
      serviceRoleKey,
      orgId,
      roles: ["coordinator", "admin"],
    });
    const calendarConnection = await resolveCalendarConnection({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      calendarConnectionId: body.calendar_connection_id,
    });
    const { policy, policyId } = await resolveRoutingPolicy({ supabaseUrl, serviceRoleKey, orgId });
    const calendarId = calendarConnection.calendar_id;

    const session = { ...(body.session || {}), bot_requested: true };
    const autoRecording = body.auto_recording ?? body.autoRecording ?? false;
    const autoSmartNotes = body.auto_smart_notes ?? body.autoSmartNotes ?? null;
    const built = buildGoogleCalendarEvent({
      session,
      attendees: body.attendees || [],
      policy,
      botEmail: body.bot_email || optionalEnv("SHAPE_CALENDAR_BOT_EMAIL"),
    });
    const googleUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    googleUrl.searchParams.set("sendUpdates", built.query.sendUpdates);
    googleUrl.searchParams.set("conferenceDataVersion", String(built.query.conferenceDataVersion));

    if (body.dry_run === true) {
      return jsonResponse({
        dry_run: true,
        google_request: { method: "POST", url: String(googleUrl), body: built.body },
        decision: built.decision,
        meet_auto_artifacts_policy: {
          transcript: "required",
          recording: autoRecording === true ? "on" : "off",
          smart_notes: autoSmartNotes === true ? "on" : "off",
        },
        calendar_connection_id: calendarConnection.id,
      });
    }

    const googleAccessToken = await resolveGoogleAccessToken();
    const persist = body.persist !== false;
    if (persist && !(body.session?.id || body.session?.session_id)) {
      throw new Error("session.id is required when persist is enabled");
    }

    const googleResponse = await fetch(googleUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${googleAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(built.body),
    });
    let googleEvent = await googleResponse.json().catch(() => null);
    if (!googleResponse.ok) {
      // C4-1: the event id is deterministic (stableGoogleEventId(session.id)), so a
      // prior run that created the Google event but then failed before the Supabase
      // write leaves a split-brain. On the resulting 409 conflict, fetch the existing
      // event and continue — the re-run is now idempotent and completes the Supabase
      // side instead of being permanently stuck.
      if (googleResponse.status === 409 && built.body.id) {
        const existingResponse = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(built.body.id))}`,
          { headers: { authorization: `Bearer ${googleAccessToken}` } },
        );
        const existingEvent = await existingResponse.json().catch(() => null);
        if (!existingResponse.ok || !existingEvent?.id) {
          const error = new Error(`Google Calendar events.insert 409 then events.get ${existingResponse.status}`) as Error & { status?: number; body?: unknown };
          error.status = existingResponse.status || 409;
          error.body = existingEvent ?? googleEvent;
          throw error;
        }
        googleEvent = existingEvent;
      } else {
        const error = new Error(`Google Calendar events.insert ${googleResponse.status}`) as Error & { status?: number; body?: unknown };
        error.status = googleResponse.status;
        error.body = googleEvent;
        throw error;
      }
    }

    let meetAutoArtifacts = { requested: false, configured: false, reason: "not_requested" };
    meetAutoArtifacts = await configureMeetAutoArtifacts({
      googleEvent,
      accessToken: googleAccessToken,
      transcript: true,
      recording: autoRecording === true,
      smartNotes: autoSmartNotes === true,
    });
    if (!meetAutoArtifacts.configured) {
      const error = new Error(meetAutoArtifacts.error || meetAutoArtifacts.reason || "Meet auto artifacts were not configured") as Error & { status?: number; body?: unknown };
      error.status = 502;
      error.body = meetAutoArtifacts;
      throw error;
    }

    const sessionRow = googleEventToSessionRow(googleEvent, {
      orgId,
      calendarConnectionId: calendarConnection.id,
      policy,
    });
    if (policyId) sessionRow.policy_id = policyId;
    const attendeeRows = googleEventAttendeeRows(googleEvent, {
      orgId,
      sessionId: sessionRow.id,
      botEmail: body.bot_email || optionalEnv("SHAPE_CALENDAR_BOT_EMAIL"),
    });

    let persisted = null;
    if (persist) {
      if (!sessionRow.id) throw new Error("session.id is required to persist attendees after Google event creation");
      const sessions = await upsertRows({
        supabaseUrl,
        serviceRoleKey,
        table: "sessions",
        rows: [sessionRow],
        onConflict: "id",
      });
      const attendees = await upsertRows({
        supabaseUrl,
        serviceRoleKey,
        table: "session_attendees",
        rows: attendeeRows,
        onConflict: "session_id,email",
      });
      let eventRequests = [];
      if (body.event_request_id) {
        eventRequests = await supabaseRest({
          supabaseUrl,
          serviceRoleKey,
          table: "event_requests",
          method: "PATCH",
          query: {
            id: `eq.${body.event_request_id}`,
            org_id: `eq.${orgId}`,
          },
          body: {
            status: "approved",
            session_id: sessionRow.id,
            reviewed_at: new Date().toISOString(),
            ...(body.review_notes ? { review_notes: body.review_notes } : {}),
          },
          prefer: "return=representation",
        });
      }
      persisted = { sessions, attendees, eventRequests };
    }

    return jsonResponse({ google_event: googleEvent, meet_auto_artifacts: meetAutoArtifacts, session: sessionRow, attendees: attendeeRows, persisted });
  } catch (error) {
    return errorResponse(error);
  }
});
