// matrix-oauth.js — password-free "approve on your phone" login for matrix.org.
//
// matrix.org runs MAS (Matrix Authentication Service, OAuth2 / MSC3861). This
// module drives the OAuth 2.0 Device Authorization Grant (RFC 8628): the app
// shows a short code + a URL, the user opens it on a device they're already
// signed in on, types the code and approves, and the app polls for the token.
// No password is ever typed into the app, and no redirect/loopback is needed.
//
// All values/quirks here were verified live against matrix.org (2026-06):
//   • discovery → /.well-known/matrix/client → /_matrix/client/v1/auth_metadata
//   • dynamic client registration is open (no secret); client_uri MUST be https
//   • device grant is live; the device-id is client-chosen and rides the scope
//   • "authorization_pending" comes back as HTTP 403 — branch on JSON `error`
//   • matrix.org omits verification_uri_complete (user types the code)
//   • access tokens live ~5 min — refresh handling lives in matrix.js
//
// Pure logic; no persistence and no UI. matrix.js owns the session + storage.

const { net } = require("electron");
const fetch = (...args) => net.fetch(...args);
const cryptoNode = require("node:crypto");

// Matrix Client-Server API + device scopes (MAS still uses the unstable prefix).
const API_SCOPE = "urn:matrix:org.matrix.msc2967.client:api:*";
const DEVICE_SCOPE_PREFIX = "urn:matrix:org.matrix.msc2967.client:device:";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, v);
  return p.toString();
}

async function postForm(url, obj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form(obj),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// A Matrix device id we control: 16 chars from [A-Za-z0-9-] (MAS requires ≥10
// and that charset). Becomes the session's device_id used by /sync + E2EE.
function newDeviceId() {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-";
  const bytes = cryptoNode.randomBytes(16);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += charset[bytes[i] % charset.length];
  return out;
}

// Resolve the homeserver C-S base URL and the OAuth endpoints for a server name
// (default matrix.org). Reads the auth metadata the Matrix way, falling back to
// the OAuth well-known.
async function discover(serverName = "matrix.org") {
  const wkRes = await fetch(`https://${serverName}/.well-known/matrix/client`, { headers: { Accept: "application/json" } });
  if (!wkRes.ok) throw new Error(`well-known lookup failed (HTTP ${wkRes.status})`);
  const wk = await wkRes.json();
  const homeserver = wk?.["m.homeserver"]?.base_url?.replace(/\/+$/, "");
  const issuer = wk?.["org.matrix.msc2965.authentication"]?.issuer?.replace(/\/+$/, "");
  if (!homeserver) throw new Error("no homeserver in well-known");
  if (!issuer) throw new Error("this server doesn't use OAuth/MAS sign-in");

  let meta = null;
  try {
    const m = await fetch(`${homeserver}/_matrix/client/v1/auth_metadata`, { headers: { Accept: "application/json" } });
    if (m.ok) meta = await m.json();
  } catch {}
  if (!meta) {
    const m = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: "application/json" } });
    if (!m.ok) throw new Error(`auth metadata lookup failed (HTTP ${m.status})`);
    meta = await m.json();
  }
  if (!meta.device_authorization_endpoint) throw new Error("this server doesn't support phone-approve (no device endpoint)");
  return {
    homeserver,
    issuer,
    registrationEndpoint: meta.registration_endpoint,
    deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
  };
}

// Dynamic client registration (RFC 7591). Public native client, no secret.
// client_uri MUST be https (MAS rejects http/localhost). Returns the client_id,
// which the caller persists and reuses.
async function registerClient({ registrationEndpoint, clientName, clientUri }) {
  if (!registrationEndpoint) throw new Error("server has no client registration endpoint");
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      client_uri: clientUri,
      application_type: "native",
      token_endpoint_auth_method: "none",
      // Support both the device grant (phone code) and authorization_code (the
      // computer's-browser flow). Loopback redirect is registered WITHOUT a port
      // — MAS then accepts any ephemeral port we listen on at runtime.
      grant_types: [DEVICE_GRANT, "authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: ["http://127.0.0.1/callback"],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201 || !body.client_id) {
    throw new Error(body.error_description || body.error || `client registration failed (HTTP ${res.status})`);
  }
  return body.client_id;
}

// Ask the server to start a device-grant. Returns the code the user enters and
// the URL they open on their phone.
async function startDeviceAuthorization({ deviceAuthorizationEndpoint, clientId, deviceId }) {
  const scope = `${API_SCOPE} ${DEVICE_SCOPE_PREFIX}${deviceId}`;
  const { status, body } = await postForm(deviceAuthorizationEndpoint, { client_id: clientId, scope });
  if (!body.device_code || !body.user_code) {
    throw new Error(body.error_description || body.error || `couldn't start sign-in (HTTP ${status})`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete || null,
    interval: Number(body.interval) || 5,
    expiresIn: Number(body.expires_in) || 1200,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll the token endpoint until the user approves (or it's denied / expires /
// cancelled). matrix.org returns pending as HTTP 403, so we branch on the JSON
// `error`, never the status. Returns { accessToken, refreshToken, expiresIn }.
async function pollForToken({ tokenEndpoint, clientId, deviceCode, interval, expiresIn, isCancelled, onPoll }) {
  let wait = Math.max(1, interval || 5);
  const deadline = Date.now() + (expiresIn || 1200) * 1000;
  for (;;) {
    if (isCancelled && isCancelled()) return { cancelled: true };
    if (Date.now() > deadline) return { expired: true };
    await sleep(wait * 1000);
    if (isCancelled && isCancelled()) return { cancelled: true };
    if (onPoll) { try { onPoll(); } catch {} }
    let status, body;
    try {
      ({ status, body } = await postForm(tokenEndpoint, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }));
    } catch {
      continue; // transient network error — keep polling
    }
    if (body.access_token) {
      return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresIn: Number(body.expires_in) || 0 };
    }
    switch (body.error) {
      case "authorization_pending": break;          // keep waiting
      case "slow_down": wait += 5; break;            // back off per RFC 8628
      case "access_denied": return { denied: true };
      case "expired_token": return { expired: true };
      default:
        if (status >= 500) break;                    // server hiccup — retry
        return { error: body.error_description || body.error || `sign-in failed (HTTP ${status})` };
    }
  }
}

// Exchange a refresh token for a fresh access token. MAS rotates the refresh
// token, so the caller MUST persist the returned refreshToken (reusing the old
// one logs the user out). Returns { accessToken, refreshToken, expiresIn }.
async function refresh({ tokenEndpoint, clientId, refreshToken }) {
  const { status, body } = await postForm(tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  if (!body.access_token) throw new Error(body.error_description || body.error || `token refresh failed (HTTP ${status})`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token || refreshToken, expiresIn: Number(body.expires_in) || 0 };
}

// ── authorization-code (computer's browser) flow ────────────────────────────
function base64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

// PKCE pair (RFC 7636) + an anti-CSRF state value.
function pkce() {
  const verifier = base64url(cryptoNode.randomBytes(32));
  const challenge = base64url(cryptoNode.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function randomState() { return base64url(cryptoNode.randomBytes(16)); }

// The URL we open in the user's browser to sign in / approve on matrix.org.
function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, deviceId, codeChallenge, state }) {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", `${API_SCOPE} ${DEVICE_SCOPE_PREFIX}${deviceId}`);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// Exchange the authorization code (caught on the loopback redirect) for tokens.
async function exchangeCode({ tokenEndpoint, clientId, code, redirectUri, codeVerifier }) {
  const { status, body } = await postForm(tokenEndpoint, {
    grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier,
  });
  if (!body.access_token) throw new Error(body.error_description || body.error || `token exchange failed (HTTP ${status})`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresIn: Number(body.expires_in) || 0 };
}

module.exports = {
  discover, registerClient, newDeviceId, startDeviceAuthorization, pollForToken, refresh,
  pkce, randomState, buildAuthorizationUrl, exchangeCode,
};
