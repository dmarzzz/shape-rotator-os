const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ARTIFACT_UPDATE_MASK,
  MEET_SETTINGS_SCOPE,
  buildMeetAutoArtifactBody,
  buildMeetAutoArtifactPatch,
  hasMeetSettingsScope,
  meetSpaceGetUrl,
  meetSpacePatchUrl,
  meetingCodeFromInput,
  runMeetAutoArtifactConfig,
} = require("./configure-meet-auto-artifacts.js");

test("Meet auto artifacts body defaults to transcript-only capture", () => {
  const defaultPatch = buildMeetAutoArtifactPatch();
  assert.deepEqual(defaultPatch.body, {
    config: {
      artifactConfig: {
        recordingConfig: { autoRecordingGeneration: "OFF" },
        transcriptionConfig: { autoTranscriptionGeneration: "ON" },
      },
    },
  });
  assert.equal(defaultPatch.updateMask, [
    "config.artifactConfig.recordingConfig.autoRecordingGeneration",
    "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  ].join(","));

  assert.deepEqual(buildMeetAutoArtifactBody(), {
    config: {
      artifactConfig: {
        recordingConfig: { autoRecordingGeneration: "OFF" },
        transcriptionConfig: { autoTranscriptionGeneration: "ON" },
        smartNotesConfig: { autoSmartNotesGeneration: "OFF" },
      },
    },
  });
  assert.deepEqual(buildMeetAutoArtifactBody({ recording: true, transcript: false, smartNotes: true }).config.artifactConfig, {
    recordingConfig: { autoRecordingGeneration: "ON" },
    transcriptionConfig: { autoTranscriptionGeneration: "OFF" },
    smartNotesConfig: { autoSmartNotesGeneration: "ON" },
  });
});

test("Meet auto artifacts helper extracts meeting codes and builds API URLs", () => {
  assert.equal(meetingCodeFromInput({ meetUrl: "https://meet.google.com/abc-defg-hij" }), "abc-defg-hij");
  assert.equal(meetSpaceGetUrl("abc-defg-hij"), "https://meet.googleapis.com/v2/spaces/abc-defg-hij");
  const patchUrl = new URL(meetSpacePatchUrl("spaces/space_1"));
  assert.equal(patchUrl.origin + patchUrl.pathname, "https://meet.googleapis.com/v2/spaces/space_1");
  assert.equal(patchUrl.searchParams.get("updateMask"), ARTIFACT_UPDATE_MASK);
});

test("Meet auto artifacts helper checks the required settings scope", () => {
  assert.equal(hasMeetSettingsScope(`${MEET_SETTINGS_SCOPE} https://www.googleapis.com/auth/calendar`), true);
  assert.equal(hasMeetSettingsScope("https://www.googleapis.com/auth/calendar"), false);
});

test("Meet auto artifacts dry-run does not require a token", async () => {
  const result = await runMeetAutoArtifactConfig({
    meetingCode: "abc-defg-hij",
    recording: false,
    transcript: true,
    smartNotes: true,
    apply: false,
    env: {},
  });

  assert.equal(result.apply, false);
  assert.equal(result.meeting_code, "abc-defg-hij");
  assert.equal(result.space, null);
  assert.equal(result.request_body.config.artifactConfig.smartNotesConfig.autoSmartNotesGeneration, "ON");
});

test("Meet auto artifacts apply gets the space then patches artifact config", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const isJson = options.headers?.["content-type"] === "application/json";
    calls.push({ url: String(url), method: options.method || "GET", body: isJson && options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("oauth2.googleapis.com")) return Response.json({ access_token: "fresh-token" });
    if ((options.method || "GET") === "GET") return Response.json({ name: "spaces/space_1", meetingCode: "abc-defg-hij" });
    return Response.json({ name: "spaces/space_1", config: options.body ? JSON.parse(options.body).config : null });
  };

  const result = await runMeetAutoArtifactConfig({
    meetingCode: "abc-defg-hij",
    apply: true,
    env: {
      GOOGLE_OAUTH_SCOPES: MEET_SETTINGS_SCOPE,
      GOOGLE_OAUTH_CLIENT_ID: "client",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
    },
    fetchImpl,
  });

  assert.equal(result.space.name, "spaces/space_1");
  assert.equal(result.patched.name, "spaces/space_1");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[2].method, "PATCH");
  assert.equal(calls[2].body.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration, "ON");
  assert.equal(calls[2].body.config.artifactConfig.smartNotesConfig, undefined);
  assert.doesNotMatch(calls[2].url, /smartNotesConfig/);
});
