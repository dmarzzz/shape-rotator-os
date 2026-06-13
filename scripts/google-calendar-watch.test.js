const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWatchAddress,
  buildWatchBody,
  resolveGoogleAccessToken,
  runGoogleCalendarWatchSetup,
} = require("./setup-google-calendar-watch.js");

test("Google Calendar watch address embeds org and connection routing", () => {
  assert.equal(
    buildWatchAddress({
      webhookUrl: "https://project.supabase.co/functions/v1/google-calendar-webhook",
      orgId: "org_1",
      calendarConnectionId: "cal_1",
    }),
    "https://project.supabase.co/functions/v1/google-calendar-webhook?org_id=org_1&calendar_connection_id=cal_1",
  );
});

test("Google Calendar watch dry-run redacts channel token", async () => {
  const result = await runGoogleCalendarWatchSetup({
    calendarId: "calendar@example.com",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    supabaseUrl: "https://project.supabase.co",
    channelToken: "secret-token",
    channelId: "channel_1",
  });

  assert.equal(result.apply, false);
  assert.equal(result.watch, null);
  assert.equal(result.request.token, "<redacted>");
  assert.equal(result.request.id, "channel_1");
});

test("Google Calendar watch apply registers channel and persists ids", async () => {
  const calls = [];
  const result = await runGoogleCalendarWatchSetup({
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    webhookUrl: "https://project.supabase.co/functions/v1/google-calendar-webhook",
    channelToken: "secret-token",
    channelId: "channel_1",
    apply: true,
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url: String(url), method: options.method || "GET", headers: options.headers, body });
      if (String(url).includes("googleapis.com/calendar")) {
        assert.equal(options.headers.authorization, "Bearer google-token");
        assert.equal(body.token, "secret-token");
        return Response.json({
          id: body.id,
          resourceId: "resource_1",
          resourceUri: "https://calendar.example/resource",
          expiration: "1780000000000",
        });
      }
      assert.equal(options.headers.authorization, "Bearer service-token");
      return Response.json([{
        id: "state_1",
        watch_channel_id: body[0].watch_channel_id,
        google_sync_token: "sync-token",
      }]);
    },
  });

  assert.equal(result.watch.id, "channel_1");
  assert.equal(result.watch.resourceId, "resource_1");
  assert.equal(result.persisted[0].watch_channel_id, "channel_1");
  assert.equal(result.persisted[0].google_sync_token, "<redacted>");
  assert.equal(calls.length, 2);
});

test("Google Calendar watch apply can refresh OAuth access token", async () => {
  const calls = [];
  const result = await runGoogleCalendarWatchSetup({
    calendarId: "calendar@example.com",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthRefreshToken: "refresh-token",
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-token",
    orgId: "org_1",
    calendarConnectionId: "cal_1",
    webhookUrl: "https://project.supabase.co/functions/v1/google-calendar-webhook",
    channelToken: "secret-token",
    channelId: "channel_1",
    apply: true,
    fetchImpl: async (url, options = {}) => {
      const urlText = String(url);
      const body = options.body ? String(options.body) : "";
      calls.push({ url: urlText, method: options.method || "GET", headers: options.headers, body });
      if (urlText.includes("oauth2.googleapis.com/token")) {
        assert.match(body, /grant_type=refresh_token/);
        assert.match(body, /refresh_token=refresh-token/);
        return Response.json({ access_token: "fresh-google-token", expires_in: 3599 });
      }
      if (urlText.includes("googleapis.com/calendar")) {
        assert.equal(options.headers.authorization, "Bearer fresh-google-token");
        return Response.json({
          id: "channel_1",
          resourceId: "resource_1",
          resourceUri: "https://calendar.example/resource",
          expiration: "1780000000000",
        });
      }
      assert.equal(options.headers.authorization, "Bearer service-token");
      return Response.json([{ id: "state_1", watch_channel_id: "channel_1" }]);
    },
  });

  assert.equal(result.watch.id, "channel_1");
  assert.equal(calls.length, 3);
});

test("Google Calendar watch apply fails closed without access or refresh credentials", async () => {
  await assert.rejects(
    () => resolveGoogleAccessToken(),
    /accessToken or GOOGLE_OAUTH_CLIENT_ID/,
  );
});

test("Google Calendar watch body requires channel token", () => {
  assert.throws(
    () => buildWatchBody({
      webhookUrl: "https://project.supabase.co/functions/v1/google-calendar-webhook",
      orgId: "org_1",
      calendarConnectionId: "cal_1",
    }),
    /channelToken is required/,
  );
});
