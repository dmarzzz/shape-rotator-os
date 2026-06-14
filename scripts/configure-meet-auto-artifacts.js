#!/usr/bin/env node
const { extractMeetingCode } = require("./lib/calendar-integration.cjs");
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

const MEET_SETTINGS_SCOPE = "https://www.googleapis.com/auth/meetings.space.settings";
const ARTIFACT_UPDATE_FIELDS = {
  recording: "config.artifactConfig.recordingConfig.autoRecordingGeneration",
  transcript: "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  smartNotes: "config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration",
};
const ARTIFACT_UPDATE_MASK = [
  ARTIFACT_UPDATE_FIELDS.recording,
  ARTIFACT_UPDATE_FIELDS.transcript,
  ARTIFACT_UPDATE_FIELDS.smartNotes,
].join(",");

function usage() {
  return [
    "Usage:",
    "  node scripts/configure-meet-auto-artifacts.js --meeting-code abc-defg-hij --apply",
    "  node scripts/configure-meet-auto-artifacts.js --session-id SESSION_ID --env-file .env.calendar.local --apply",
    "",
    "Default mode is dry-run. Default artifact policy is transcript ON, smart",
    "notes OFF, recording OFF.",
    "",
    "Options:",
    "  --meeting-code CODE",
    "  --meet-url URL",
    "  --session-id SESSION_ID",
    "  --transcript / --no-transcript",
    "  --smart-notes / --no-smart-notes",
    "  --recording / --no-recording",
    "  --apply",
    "  --env-file FILE",
    "",
    "Environment fallbacks:",
    "  GOOGLE_OAUTH_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_SCOPES",
    "  SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
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

function boolOption({ argv = process.argv, yes, no, fallback }) {
  if (flag(no, argv)) return false;
  if (flag(yes, argv)) return true;
  return fallback;
}

function parseGrantedScopes(value) {
  return String(value || "").split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
}

function hasMeetSettingsScope(value) {
  return parseGrantedScopes(value).includes(MEET_SETTINGS_SCOPE);
}

function meetingCodeFromInput({ meetingCode, meetUrl } = {}) {
  const code = meetingCode || extractMeetingCode(meetUrl);
  if (!code) throw new Error("meeting code is required; pass --meeting-code, --meet-url, or --session-id");
  return code.toLowerCase();
}

function autoGeneration(value) {
  return value ? "ON" : "OFF";
}

function buildMeetAutoArtifactPatch({
  recording = false,
  transcript = true,
  smartNotes = null,
} = {}) {
  const artifactConfig = {};
  const updateFields = [];
  if (recording !== null) {
    artifactConfig.recordingConfig = { autoRecordingGeneration: autoGeneration(recording) };
    updateFields.push(ARTIFACT_UPDATE_FIELDS.recording);
  }
  if (transcript !== null) {
    artifactConfig.transcriptionConfig = { autoTranscriptionGeneration: autoGeneration(transcript) };
    updateFields.push(ARTIFACT_UPDATE_FIELDS.transcript);
  }
  if (smartNotes !== null) {
    artifactConfig.smartNotesConfig = { autoSmartNotesGeneration: autoGeneration(smartNotes) };
    updateFields.push(ARTIFACT_UPDATE_FIELDS.smartNotes);
  }
  return {
    body: { config: { artifactConfig } },
    updateMask: updateFields.join(","),
  };
}

function buildMeetAutoArtifactBody(options = {}) {
  return buildMeetAutoArtifactPatch({
    smartNotes: options.smartNotes ?? false,
    recording: options.recording,
    transcript: options.transcript,
  }).body;
}

function meetSpaceGetUrl(meetingCode) {
  return `https://meet.googleapis.com/v2/spaces/${encodeURIComponent(meetingCode)}`;
}

function meetSpacePatchUrl(spaceName, updateMask = ARTIFACT_UPDATE_MASK) {
  const url = new URL(`https://meet.googleapis.com/v2/${required(spaceName, "spaceName")}`);
  url.searchParams.set("updateMask", updateMask);
  return String(url);
}

async function resolveGoogleAccessToken({ accessToken, env = process.env, fetchImpl = fetch, requireMeetSettingsScope = true } = {}) {
  if (requireMeetSettingsScope && env.GOOGLE_OAUTH_SCOPES && !hasMeetSettingsScope(env.GOOGLE_OAUTH_SCOPES)) {
    throw new Error(`${MEET_SETTINGS_SCOPE} is missing from GOOGLE_OAUTH_SCOPES; re-consent Cube before applying Meet auto artifacts`);
  }
  if (accessToken) return accessToken;
  if (env.GOOGLE_OAUTH_REFRESH_TOKEN && env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    const token = await refreshAccessToken({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      fetchImpl,
    });
    return token.access_token;
  }
  const token = env.GOOGLE_CALENDAR_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN;
  if (token) return token;
  throw new Error("Google access token or refresh credentials are required");
}

async function getMeetSpace({ meetingCode, accessToken, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(meetSpaceGetUrl(required(meetingCode, "meetingCode")), {
    headers: { authorization: `Bearer ${required(accessToken, "accessToken")}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Meet spaces.get ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function patchMeetSpace({ spaceName, accessToken, body, updateMask = ARTIFACT_UPDATE_MASK, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(meetSpacePatchUrl(spaceName, updateMask), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${required(accessToken, "accessToken")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Meet spaces.patch ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchSessionMeetingCode({ supabaseUrl, serviceRoleKey, sessionId, fetchImpl = fetch } = {}) {
  const rows = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "sessions",
    query: {
      select: "id,google_meeting_code,google_meet_url",
      id: `eq.${required(sessionId, "sessionId")}`,
      limit: "1",
    },
    fetchImpl,
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error(`session not found: ${sessionId}`);
  return meetingCodeFromInput({
    meetingCode: row.google_meeting_code,
    meetUrl: row.google_meet_url,
  });
}

async function runMeetAutoArtifactConfig({
  meetingCode,
  meetUrl,
  sessionId,
  accessToken,
  supabaseUrl,
  serviceRoleKey,
  recording = false,
  transcript = true,
  smartNotes = null,
  apply = false,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const resolvedCode = sessionId
    ? await fetchSessionMeetingCode({ supabaseUrl, serviceRoleKey, sessionId, fetchImpl })
    : meetingCodeFromInput({ meetingCode, meetUrl });
  const patch = buildMeetAutoArtifactPatch({ recording, transcript, smartNotes });
  const plan = {
    meeting_code: resolvedCode,
    apply: !!apply,
    get_url: meetSpaceGetUrl(resolvedCode),
    update_mask: patch.updateMask,
    request_body: patch.body,
  };
  if (!apply) return { ...plan, space: null, patched: null };
  const token = await resolveGoogleAccessToken({ accessToken, env, fetchImpl });
  const space = await getMeetSpace({ meetingCode: resolvedCode, accessToken: token, fetchImpl });
  const patched = await patchMeetSpace({
    spaceName: space.name || `spaces/${resolvedCode}`,
    accessToken: token,
    body: patch.body,
    updateMask: patch.updateMask,
    fetchImpl,
  });
  return {
    ...plan,
    space: {
      name: space.name || null,
      meetingCode: space.meetingCode || null,
      meetingUri: space.meetingUri || null,
    },
    patched,
  };
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const result = await runMeetAutoArtifactConfig({
    meetingCode: arg("--meeting-code", argv),
    meetUrl: arg("--meet-url", argv),
    sessionId: arg("--session-id", argv),
    accessToken: arg("--access-token", argv),
    supabaseUrl: arg("--supabase-url", argv) || process.env.SHAPE_SUPABASE_URL || process.env.SUPABASE_URL,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    recording: boolOption({ argv, yes: "--recording", no: "--no-recording", fallback: false }),
    transcript: boolOption({ argv, yes: "--transcript", no: "--no-transcript", fallback: true }),
    smartNotes: boolOption({ argv, yes: "--smart-notes", no: "--no-smart-notes", fallback: null }),
    apply: flag("--apply", argv),
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
  ARTIFACT_UPDATE_MASK,
  ARTIFACT_UPDATE_FIELDS,
  MEET_SETTINGS_SCOPE,
  buildMeetAutoArtifactBody,
  buildMeetAutoArtifactPatch,
  hasMeetSettingsScope,
  meetSpaceGetUrl,
  meetSpacePatchUrl,
  meetingCodeFromInput,
  runMeetAutoArtifactConfig,
};
