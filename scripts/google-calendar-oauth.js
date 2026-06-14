#!/usr/bin/env node
const crypto = require("node:crypto");
const http = require("node:http");
const { loadEnvFile } = require("./lib/env-file.cjs");

const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8787/oauth2callback";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function usage() {
  return [
    "Usage:",
    "  node scripts/google-calendar-oauth.js --auth-url --client-id CLIENT_ID",
    "  node scripts/google-calendar-oauth.js --listen --client-id CLIENT_ID --client-secret CLIENT_SECRET",
    "  node scripts/google-calendar-oauth.js --code CODE --client-id CLIENT_ID --client-secret CLIENT_SECRET",
    "  node scripts/google-calendar-oauth.js --refresh-token REFRESH_TOKEN --client-id CLIENT_ID --client-secret CLIENT_SECRET",
    "",
    "Options:",
    "  --auth-url                  Print a consent URL and exit.",
    "  --listen                    Start a local callback server, exchange the returned code, and print token JSON.",
    "  --code CODE                 Exchange an authorization code for tokens.",
    "  --refresh-token TOKEN       Refresh an access token.",
    "  --client-id ID              OAuth client ID.",
    "  --client-secret SECRET      OAuth client secret.",
    `  --redirect-uri URI          Default: ${DEFAULT_REDIRECT_URI}`,
    "  --scopes SCOPES             Space/comma separated OAuth scopes. Default: Calendar and Drive full scopes.",
    "  --state STATE               Optional OAuth state. A random value is used for --listen.",
    "  --port PORT                 Local listener port. Default: port from redirect URI.",
    "  --format json|env|summary   Default: json. env prints .env.calendar.local lines.",
    "  --env-file FILE             Load local KEY=value secrets before env fallbacks.",
    "  --update-env-file FILE      Update token/scopes in FILE without printing secret values.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_OAUTH_CLIENT_ID",
    "  GOOGLE_OAUTH_CLIENT_SECRET",
    "  GOOGLE_OAUTH_REDIRECT_URI",
    "  GOOGLE_OAUTH_REFRESH_TOKEN",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function parseScopes(value = DEFAULT_SCOPES) {
  const input = Array.isArray(value) ? value.join(" ") : String(value || "");
  const scopes = input.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return scopes.length ? scopes : DEFAULT_SCOPES;
}

function required(value, label) {
  if (!String(value || "").trim()) throw new Error(`${label} is required`);
  return value;
}

function buildGoogleOAuthUrl({
  clientId,
  redirectUri = DEFAULT_REDIRECT_URI,
  scopes = DEFAULT_SCOPES,
  state,
  accessType = "offline",
  prompt = "consent",
  includeGrantedScopes = true,
} = {}) {
  required(clientId, "clientId");
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", parseScopes(scopes).join(" "));
  url.searchParams.set("access_type", accessType);
  url.searchParams.set("prompt", prompt);
  url.searchParams.set("include_granted_scopes", includeGrantedScopes ? "true" : "false");
  if (state) url.searchParams.set("state", state);
  return String(url);
}

function tokenRequestBody({
  clientId,
  clientSecret,
  redirectUri = DEFAULT_REDIRECT_URI,
  code,
  refreshToken,
} = {}) {
  required(clientId, "clientId");
  required(clientSecret, "clientSecret");
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  if (code) {
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("grant_type", "authorization_code");
  } else if (refreshToken) {
    body.set("refresh_token", refreshToken);
    body.set("grant_type", "refresh_token");
  } else {
    throw new Error("code or refreshToken is required");
  }
  return body;
}

async function requestGoogleToken({ body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google OAuth token request ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function exchangeAuthCode({
  clientId,
  clientSecret,
  redirectUri = DEFAULT_REDIRECT_URI,
  code,
  fetchImpl = fetch,
} = {}) {
  return requestGoogleToken({
    body: tokenRequestBody({ clientId, clientSecret, redirectUri, code }),
    fetchImpl,
  });
}

async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
} = {}) {
  return requestGoogleToken({
    body: tokenRequestBody({ clientId, clientSecret, refreshToken }),
    fetchImpl,
  });
}

function shellQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function tokenEnvMap(tokenPayload = {}) {
  const entries = {};
  if (tokenPayload.access_token) entries.GOOGLE_CALENDAR_ACCESS_TOKEN = tokenPayload.access_token;
  if (tokenPayload.refresh_token) entries.GOOGLE_OAUTH_REFRESH_TOKEN = tokenPayload.refresh_token;
  if (tokenPayload.expires_in != null) entries.GOOGLE_OAUTH_ACCESS_TOKEN_EXPIRES_IN = String(tokenPayload.expires_in);
  if (tokenPayload.scope) entries.GOOGLE_OAUTH_SCOPES = tokenPayload.scope;
  if (tokenPayload.token_type) entries.GOOGLE_OAUTH_TOKEN_TYPE = tokenPayload.token_type;
  return entries;
}

function tokenEnvLines(tokenPayload = {}) {
  const lines = Object.entries(tokenEnvMap(tokenPayload))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function formatTokenSummary(payload = {}) {
  return JSON.stringify({
    access_token: payload.access_token ? "set" : "missing",
    refresh_token: payload.refresh_token ? "set" : "not_returned",
    expires_in: payload.expires_in ?? null,
    token_type: payload.token_type || null,
    scopes: payload.scope ? parseScopes(payload.scope) : [],
  }, null, 2) + "\n";
}

function formatTokenPayload(payload, format = "json") {
  if (format === "env") return tokenEnvLines(payload);
  if (format === "summary") return formatTokenSummary(payload);
  if (format !== "json") throw new Error(`unsupported output format: ${format}`);
  return JSON.stringify(payload, null, 2) + "\n";
}

function updateEnvFile(filePath, tokenPayload = {}, fsImpl = require("node:fs")) {
  required(filePath, "filePath");
  const updates = tokenEnvMap(tokenPayload);
  const updateKeys = new Set(Object.keys(updates));
  if (!updateKeys.size) {
    return {
      file: filePath,
      updated_keys: [],
      appended_keys: [],
      skipped: "token payload contained no env keys",
    };
  }

  const original = fsImpl.existsSync(filePath) ? fsImpl.readFileSync(filePath, "utf8") : "";
  const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original ? original.split(/\r?\n/) : [];
  const updated = [];
  const seen = new Set();
  const keyPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const nextLines = lines.map((line) => {
    const match = line.match(keyPattern);
    const key = match?.[1] || "";
    if (!updateKeys.has(key)) return line;
    seen.add(key);
    updated.push(key);
    return `${key}=${shellQuote(updates[key])}`;
  });
  const appended = [];
  for (const key of Object.keys(updates)) {
    if (seen.has(key)) continue;
    appended.push(key);
    nextLines.push(`${key}=${shellQuote(updates[key])}`);
  }
  while (nextLines.length && nextLines[nextLines.length - 1] === "") nextLines.pop();
  fsImpl.writeFileSync(filePath, nextLines.join(lineEnding) + lineEnding, "utf8");
  return {
    file: filePath,
    updated_keys: updated,
    appended_keys: appended,
  };
}

function assertLocalRedirect(redirectUri) {
  const url = new URL(redirectUri);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("--listen only supports localhost or 127.0.0.1 redirect URIs");
  }
  return url;
}

async function listenForOAuthCallback({
  clientId,
  clientSecret,
  redirectUri = DEFAULT_REDIRECT_URI,
  scopes = DEFAULT_SCOPES,
  state,
  port,
  fetchImpl = fetch,
  stderr = process.stderr,
} = {}) {
  required(clientId, "clientId");
  required(clientSecret, "clientSecret");
  const redirect = assertLocalRedirect(redirectUri);
  const listenPort = Number(port || redirect.port || 80);
  const expectedState = state || crypto.randomBytes(16).toString("hex");
  const authUrl = buildGoogleOAuthUrl({ clientId, redirectUri, scopes, state: expectedState });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url, redirect.origin);
        if (requestUrl.pathname !== redirect.pathname) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
          return;
        }
        const returnedState = requestUrl.searchParams.get("state") || "";
        if (returnedState !== expectedState) throw new Error("OAuth state mismatch");
        const code = requestUrl.searchParams.get("code") || "";
        const error = requestUrl.searchParams.get("error") || "";
        if (error) throw new Error(`Google OAuth error: ${error}`);
        if (!code) throw new Error("OAuth callback missing code");
        const token = await exchangeAuthCode({ clientId, clientSecret, redirectUri, code, fetchImpl });
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Shape Rotator OAuth</title><p>Token received. You can close this tab.</p>");
        server.close(() => resolve(token));
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(error.message || String(error));
        server.close(() => reject(error));
      }
    });
    server.on("error", reject);
    server.listen(listenPort, redirect.hostname, () => {
      stderr.write(`Open this URL in the Google organizer account:\n${authUrl}\n`);
    });
  });
}

function envOrArg(name, envKey, argv = process.argv) {
  return arg(name, argv) || process.env[envKey] || "";
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const clientId = envOrArg("--client-id", "GOOGLE_OAUTH_CLIENT_ID", argv);
  const clientSecret = envOrArg("--client-secret", "GOOGLE_OAUTH_CLIENT_SECRET", argv);
  const redirectUri = envOrArg("--redirect-uri", "GOOGLE_OAUTH_REDIRECT_URI", argv) || DEFAULT_REDIRECT_URI;
  const scopes = parseScopes(arg("--scopes", argv) || process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_SCOPES);
  const state = arg("--state", argv);
  const format = arg("--format", argv) || "json";
  const updateEnvFilePath = arg("--update-env-file", argv);

  function writeTokenResult(token) {
    if (updateEnvFilePath) {
      const result = updateEnvFile(updateEnvFilePath, token);
      process.stdout.write(JSON.stringify({
        updated_env_file: result.file,
        updated_keys: result.updated_keys,
        appended_keys: result.appended_keys,
        refresh_token: token.refresh_token ? "set" : "not_returned",
      }, null, 2) + "\n");
      if (format !== "summary") process.stdout.write(formatTokenPayload(token, format));
      return;
    }
    process.stdout.write(formatTokenPayload(token, format));
  }

  if (flag("--auth-url", argv)) {
    process.stdout.write(buildGoogleOAuthUrl({ clientId, redirectUri, scopes, state }) + "\n");
    return;
  }
  if (flag("--listen", argv)) {
    const token = await listenForOAuthCallback({
      clientId,
      clientSecret,
      redirectUri,
      scopes,
      state,
      port: arg("--port", argv),
    });
    writeTokenResult(token);
    return;
  }
  if (arg("--code", argv)) {
    const token = await exchangeAuthCode({
      clientId,
      clientSecret,
      redirectUri,
      code: arg("--code", argv),
    });
    writeTokenResult(token);
    return;
  }
  const refreshToken = arg("--refresh-token", argv) || process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
    });
    writeTokenResult(token);
    return;
  }
  console.error(usage());
  process.exit(2);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_REDIRECT_URI,
  DEFAULT_SCOPES,
  buildGoogleOAuthUrl,
  exchangeAuthCode,
  formatTokenPayload,
  formatTokenSummary,
  listenForOAuthCallback,
  parseScopes,
  refreshAccessToken,
  tokenEnvMap,
  tokenEnvLines,
  tokenRequestBody,
  updateEnvFile,
};
