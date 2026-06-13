const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_REDIRECT_URI,
  DEFAULT_SCOPES,
  buildGoogleOAuthUrl,
  exchangeAuthCode,
  formatTokenPayload,
  formatTokenSummary,
  listenForOAuthCallback,
  parseScopes,
  refreshAccessToken,
  tokenRequestBody,
  updateEnvFile,
} = require("./google-calendar-oauth.js");

test("Google Calendar OAuth URL requests offline calendar access", () => {
  const url = new URL(buildGoogleOAuthUrl({
    clientId: "client-id",
    redirectUri: DEFAULT_REDIRECT_URI,
    state: "state-1",
  }));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), DEFAULT_REDIRECT_URI);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), DEFAULT_SCOPES.join(" "));
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.equal(url.searchParams.get("state"), "state-1");
});

test("Google Calendar OAuth scopes parse comma and whitespace lists", () => {
  assert.deepEqual(parseScopes("scope-a, scope-b\nscope-c"), ["scope-a", "scope-b", "scope-c"]);
  assert.deepEqual(parseScopes(""), DEFAULT_SCOPES);
});

test("Google Calendar OAuth code exchange posts expected token body", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = Object.fromEntries(options.body.entries());
    calls.push({ url: String(url), method: options.method, headers: options.headers, body });
    return Response.json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3599,
      token_type: "Bearer",
      scope: DEFAULT_SCOPES.join(" "),
    });
  };

  const token = await exchangeAuthCode({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: DEFAULT_REDIRECT_URI,
    code: "code-1",
    fetchImpl,
  });

  assert.equal(token.access_token, "access-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(calls[0].body, {
    client_id: "client-id",
    client_secret: "client-secret",
    code: "code-1",
    redirect_uri: DEFAULT_REDIRECT_URI,
    grant_type: "authorization_code",
  });
});

test("Google Calendar OAuth refresh posts expected token body", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(Object.fromEntries(options.body.entries()));
    return Response.json({
      access_token: "fresh-access-token",
      expires_in: 3599,
      token_type: "Bearer",
    });
  };

  const token = await refreshAccessToken({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    fetchImpl,
  });

  assert.equal(token.access_token, "fresh-access-token");
  assert.deepEqual(calls[0], {
    client_id: "client-id",
    client_secret: "client-secret",
    refresh_token: "refresh-token",
    grant_type: "refresh_token",
  });
});

test("Google Calendar OAuth token body requires one grant input", () => {
  assert.throws(
    () => tokenRequestBody({ clientId: "client-id", clientSecret: "client-secret" }),
    /code or refreshToken is required/,
  );
});

test("Google Calendar OAuth env output is ready for local worksheet", () => {
  const output = formatTokenPayload({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
    scope: DEFAULT_SCOPES.join(" "),
  }, "env");

  assert.match(output, /GOOGLE_CALENDAR_ACCESS_TOKEN="access-token"/);
  assert.match(output, /GOOGLE_OAUTH_REFRESH_TOKEN="refresh-token"/);
  assert.match(output, /GOOGLE_OAUTH_ACCESS_TOKEN_EXPIRES_IN="3599"/);
  assert.match(output, /GOOGLE_OAUTH_TOKEN_TYPE="Bearer"/);
  assert.match(output, /GOOGLE_OAUTH_SCOPES="https:\/\/www\.googleapis\.com\/auth\/calendar https:\/\/www\.googleapis\.com\/auth\/drive https:\/\/www\.googleapis\.com\/auth\/meetings\.space\.settings https:\/\/www\.googleapis\.com\/auth\/meetings\.space\.readonly https:\/\/www\.googleapis\.com\/auth\/userinfo\.email openid"/);
});

test("Google Calendar OAuth summary does not include secret token values", () => {
  const output = formatTokenSummary({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
    scope: "scope-a scope-b",
  });

  assert.doesNotMatch(output, /access-token|refresh-token/);
  assert.match(output, /"access_token": "set"/);
  assert.match(output, /"refresh_token": "set"/);
  assert.match(output, /"scope-a"/);
});

test("Google Calendar OAuth env file update replaces token keys and preserves comments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shape-oauth-env-"));
  const file = path.join(dir, ".env.calendar.local");
  fs.writeFileSync(file, [
    "# keep comment",
    "GOOGLE_CALENDAR_ACCESS_TOKEN=\"old-token\"",
    "UNCHANGED=value",
    "GOOGLE_OAUTH_SCOPES=\"old-scope\"",
    "",
  ].join("\n"), "utf8");

  const result = updateEnvFile(file, {
    access_token: "new-token",
    refresh_token: "refresh-token",
    expires_in: 3599,
    token_type: "Bearer",
    scope: DEFAULT_SCOPES.join(" "),
  });
  const next = fs.readFileSync(file, "utf8");

  assert.deepEqual(result.updated_keys, [
    "GOOGLE_CALENDAR_ACCESS_TOKEN",
    "GOOGLE_OAUTH_SCOPES",
  ]);
  assert.deepEqual(result.appended_keys, [
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_OAUTH_ACCESS_TOKEN_EXPIRES_IN",
    "GOOGLE_OAUTH_TOKEN_TYPE",
  ]);
  assert.match(next, /^# keep comment/m);
  assert.match(next, /^UNCHANGED=value/m);
  assert.match(next, /^GOOGLE_CALENDAR_ACCESS_TOKEN="new-token"$/m);
  assert.match(next, /^GOOGLE_OAUTH_REFRESH_TOKEN="refresh-token"$/m);
  assert.match(next, /meetings\.space\.settings/);
});

test("Google Calendar OAuth listener generates state when caller omits it", async () => {
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  const promise = listenForOAuthCallback({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:18787/oauth2callback",
    port: 18787,
    stderr,
    fetchImpl: async () => Response.json({ access_token: "token" }),
  });

  await new Promise((resolve) => {
    const started = () => stderr.text.includes("https://accounts.google.com")
      ? resolve()
      : setTimeout(started, 5);
    started();
  });

  const url = new URL(stderr.text.match(/https:\/\/accounts\.google\.com[^\s]+/)[0]);
  const state = url.searchParams.get("state");
  assert.ok(state);
  const callback = `http://127.0.0.1:18787/oauth2callback?code=code-1&state=${encodeURIComponent(state)}`;
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  const token = await promise;
  assert.equal(token.access_token, "token");
});
