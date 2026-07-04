export const DEFAULT_WEB_AUTH_CONFIG_KEY = "srfg:web_auth_config";
export const CALENDAR_CONFIG_KEY = "srfg:calendar_ingress_config";
export const WEB_AUTH_SESSION_KEY = "srfg:web_auth_session";
export const WEB_AUTH_PKCE_KEY = "srfg:web_auth_pkce";
export const WEB_AUTH_RETURN_KEY = "srfg:web_auth_return_to";
export const CLOCK_SKEW_SEC = 30;

export const DEFAULT_SUPABASE_URL = "https://txjntzwksiluvqcpccpc.supabase.co";
export const DEFAULT_PUBLIC_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4am50endrc2lsdXZxY3BjY3BjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzA1NzEsImV4cCI6MjA5Njk0NjU3MX0.XjXEUnw3jq1E7PwIOvhr7a3OpO2lyZv6S_Hn3JqogBA";

const AUTH_QUERY_KEYS = [
  "code",
  "error",
  "error_code",
  "error_description",
  "state",
];
const AUTH_HASH_KEYS = [
  "access_token",
  "refresh_token",
  "provider_token",
  "expires_at",
  "expires_in",
  "token_type",
  "type",
  "sb",
];
const sessionListeners = new Set();
let authMount = null;

function readJsonStorage(storage, key) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJsonStorage(storage, key, value) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeStorage(storage, key) {
  try { storage?.removeItem?.(key); } catch {}
}

function cleanConfigValue(value) {
  return String(value || "").trim();
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

export function readWebAuthConfig({
  windowRef = globalThis,
  storage = globalThis.localStorage,
} = {}) {
  const runtime = windowRef?.SHAPE_ROTATOR_RUNTIME?.auth
    || windowRef?.SHAPE_WEB_AUTH_CONFIG
    || windowRef?.SHAPE_ROTATOR_AUTH_CONFIG
    || {};
  const webStored = readJsonStorage(storage, DEFAULT_WEB_AUTH_CONFIG_KEY) || {};
  const calendarStored = readJsonStorage(storage, CALENDAR_CONFIG_KEY) || {};
  const source = { ...calendarStored, ...webStored, ...(runtime || {}) };
  const supabaseUrl = trimSlash(cleanConfigValue(
    source.supabaseUrl
      || source.supabase_url
      || source.url
      || DEFAULT_SUPABASE_URL
  ));
  const supabaseAnonKey = cleanConfigValue(
    source.supabaseAnonKey
      || source.supabase_anon_key
      || source.anonKey
      || source.anon_key
      || DEFAULT_PUBLIC_ANON_KEY
  );
  const redirectTo = cleanConfigValue(
    source.redirectTo
      || source.redirect_to
      || source.authRedirectTo
      || source.auth_redirect_to
      || ""
  );
  return { supabaseUrl, supabaseAnonKey, redirectTo };
}

function textEncode(value) {
  return new TextEncoder().encode(String(value || ""));
}

function base64Url(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of arr) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function makePkcePair({ cryptoImpl = globalThis.crypto } = {}) {
  if (!cryptoImpl?.getRandomValues || !cryptoImpl?.subtle?.digest) {
    throw new Error("secure browser crypto is required for Google sign-in");
  }
  const bytes = new Uint8Array(48);
  cryptoImpl.getRandomValues(bytes);
  const verifier = base64Url(bytes);
  const digest = await cryptoImpl.subtle.digest("SHA-256", textEncode(verifier));
  return { verifier, challenge: base64Url(digest) };
}

function decodeJwtClaims(jwt) {
  try {
    const seg = String(jwt || "").split(".")[1];
    if (!seg) return {};
    const normalized = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const raw = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
    const json = decodeURIComponent(Array.from(raw, c =>
      `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`
    ).join(""));
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
}

export function sessionFromTokenResponse(payload) {
  if (!payload?.access_token) return null;
  const claims = decodeJwtClaims(payload.access_token);
  const expiresAt = Number(payload.expires_at)
    || (Math.floor(Date.now() / 1000) + (Number(payload.expires_in) || 3600));
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: expiresAt,
    token_type: payload.token_type || "bearer",
    user: {
      id: payload.user?.id || claims.sub || null,
      email: payload.user?.email || claims.email || null,
      user_metadata: payload.user?.user_metadata || claims.user_metadata || {},
    },
  };
}

export function isSessionValid(session, nowSec = Math.floor(Date.now() / 1000)) {
  if (!session || typeof session !== "object" || !session.access_token) return false;
  const exp = Number(session.expires_at);
  return Number.isFinite(exp) && exp > nowSec + CLOCK_SKEW_SEC;
}

export function sessionExpiresSoon(session, nowSec = Math.floor(Date.now() / 1000), windowSec = 120) {
  if (!session?.access_token) return false;
  const exp = Number(session.expires_at);
  if (!Number.isFinite(exp)) return true;
  return exp <= nowSec + windowSec;
}

export function sessionEmail(session) {
  return session?.user?.email ? String(session.user.email).toLowerCase().trim() : "";
}

export function parseMembership(rows) {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object" || !row.email) return null;
  return {
    email: String(row.email).toLowerCase().trim(),
    record_id: row.record_id || null,
    record_type: row.record_type || "person",
    role: row.role || "member",
    status: row.status || "pending",
    display_name: row.display_name || null,
    approved: row.status === "approved",
    bound: !!row.record_id,
  };
}

export function gateState({ session, membership, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!isSessionValid(session, nowSec)) return "signed_out";
  if (!membership) return "unapproved";
  if (membership.status === "rejected") return "rejected";
  if (membership.status !== "approved") return "pending";
  if (!membership.bound) return "needs_binding";
  return "approved";
}

function currentReturnPath(windowRef = globalThis) {
  const loc = windowRef?.location;
  if (!loc) return "/";
  return `${loc.pathname || "/"}${loc.search || ""}${loc.hash || ""}`;
}

function authRedirectUrl(config, windowRef = globalThis) {
  if (config?.redirectTo) return config.redirectTo;
  const loc = windowRef?.location;
  if (!loc?.origin) return "/";
  return `${loc.origin}/`;
}

export function buildAuthorizeUrl({
  config,
  redirectTo,
  challenge,
} = {}) {
  const cfg = config || readWebAuthConfig();
  const url = new URL(`${trimSlash(cfg.supabaseUrl)}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", redirectTo || cfg.redirectTo || "");
  url.searchParams.set("code_challenge", challenge || "");
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

function notifySession(session) {
  for (const cb of sessionListeners) {
    try { cb(session || null); } catch {}
  }
}

export function onSessionChanged(cb) {
  if (typeof cb !== "function") return () => {};
  sessionListeners.add(cb);
  return () => sessionListeners.delete(cb);
}

export function readStoredSession(storage = globalThis.localStorage) {
  const session = readJsonStorage(storage, WEB_AUTH_SESSION_KEY);
  return session?.access_token ? session : null;
}

function storeSession(session, storage = globalThis.localStorage) {
  if (session) writeJsonStorage(storage, WEB_AUTH_SESSION_KEY, session);
  else removeStorage(storage, WEB_AUTH_SESSION_KEY);
  notifySession(session || null);
}

export async function refreshSession({
  config = readWebAuthConfig(),
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = readStoredSession(storage);
  if (!current?.refresh_token || typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(`${trimSlash(config.supabaseUrl)}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) storeSession(null, storage);
    return null;
  }
  const next = sessionFromTokenResponse(payload);
  if (next && !next.refresh_token) next.refresh_token = current.refresh_token;
  if (next) storeSession(next, storage);
  return next;
}

export async function getSession({
  config = readWebAuthConfig(),
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  let session = readStoredSession(storage);
  if (!session) return null;
  if (sessionExpiresSoon(session)) {
    const refreshed = await refreshSession({ config, storage, fetchImpl });
    if (refreshed) session = refreshed;
  }
  return isSessionValid(session) ? session : null;
}

export async function signInWithGoogle({
  windowRef = globalThis,
  storage = globalThis.localStorage,
  cryptoImpl = globalThis.crypto,
  config = readWebAuthConfig({ windowRef, storage }),
} = {}) {
  const pair = await makePkcePair({ cryptoImpl });
  const redirectTo = authRedirectUrl(config, windowRef);
  writeJsonStorage(storage, WEB_AUTH_PKCE_KEY, { verifier: pair.verifier, at: Date.now() });
  try { storage?.setItem?.(WEB_AUTH_RETURN_KEY, currentReturnPath(windowRef)); } catch {}
  const authorize = buildAuthorizeUrl({ config, redirectTo, challenge: pair.challenge });
  if (windowRef?.location?.assign) windowRef.location.assign(authorize);
  return { ok: true, authorize };
}

function parseImplicitSessionFromHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (!params.get("access_token")) return null;
  return sessionFromTokenResponse({
    access_token: params.get("access_token"),
    refresh_token: params.get("refresh_token"),
    expires_at: Number(params.get("expires_at")) || undefined,
    expires_in: Number(params.get("expires_in")) || undefined,
    token_type: params.get("token_type") || undefined,
  });
}

function callbackError(search, hash) {
  const qp = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const hp = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  return qp.get("error_description")
    || qp.get("error")
    || hp.get("error_description")
    || hp.get("error")
    || "";
}

export function cleanAuthCallbackUrl(url, fallbackPath = "/") {
  const parsed = new URL(url, "https://example.invalid");
  for (const key of AUTH_QUERY_KEYS) parsed.searchParams.delete(key);
  const hash = new URLSearchParams(String(parsed.hash || "").replace(/^#/, ""));
  let touchedHash = false;
  for (const key of AUTH_HASH_KEYS) {
    if (hash.has(key)) touchedHash = true;
    hash.delete(key);
  }
  parsed.hash = touchedHash && [...hash.keys()].length === 0 ? "" : (hash.toString() ? `#${hash}` : parsed.hash);
  const next = `${parsed.pathname || fallbackPath}${parsed.search || ""}${parsed.hash || ""}`;
  return next || fallbackPath;
}

export async function exchangePkceCode({
  code,
  verifier,
  config = readWebAuthConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!code || !verifier) return null;
  const response = await fetchImpl(`${trimSlash(config.supabaseUrl)}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google sign-in token exchange failed: ${response.status}`);
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return sessionFromTokenResponse(payload);
}

function sameOriginPath(value, windowRef = globalThis) {
  const fallback = "/";
  const loc = windowRef?.location;
  if (!value || !loc?.origin) return fallback;
  try {
    const parsed = new URL(value, loc.origin);
    if (parsed.origin !== loc.origin) return fallback;
    return `${parsed.pathname || "/"}${parsed.search || ""}${parsed.hash || ""}`;
  } catch {
    return fallback;
  }
}

function finishCallbackNavigation(windowRef, storage, cleanPath) {
  const returnTo = sameOriginPath(storage?.getItem?.(WEB_AUTH_RETURN_KEY), windowRef);
  removeStorage(storage, WEB_AUTH_RETURN_KEY);
  const target = returnTo || cleanPath || "/";
  const current = currentReturnPath(windowRef);
  if (target && target !== current && windowRef?.location?.replace) {
    windowRef.location.replace(target);
    return;
  }
  try { windowRef?.history?.replaceState?.(null, "", cleanPath || target || "/"); } catch {}
}

export async function restoreOAuthRedirect({
  windowRef = globalThis,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  config = readWebAuthConfig({ windowRef, storage }),
} = {}) {
  const loc = windowRef?.location;
  if (!loc) return { ok: false, reason: "no_location" };
  const error = callbackError(loc.search, loc.hash);
  const query = new URLSearchParams(String(loc.search || "").replace(/^\?/, ""));
  const code = query.get("code");
  const implicit = parseImplicitSessionFromHash(loc.hash);
  if (!code && !implicit && !error) return { ok: false, reason: "not_callback" };
  const cleanPath = cleanAuthCallbackUrl(loc.href || `${loc.pathname || "/"}${loc.search || ""}${loc.hash || ""}`);
  if (error) {
    removeStorage(storage, WEB_AUTH_PKCE_KEY);
    finishCallbackNavigation(windowRef, storage, cleanPath);
    return { ok: false, reason: "oauth_error", error };
  }
  let session = implicit;
  if (!session && code) {
    const pkce = readJsonStorage(storage, WEB_AUTH_PKCE_KEY) || {};
    session = await exchangePkceCode({ code, verifier: pkce.verifier, config, fetchImpl });
  }
  removeStorage(storage, WEB_AUTH_PKCE_KEY);
  if (session) storeSession(session, storage);
  finishCallbackNavigation(windowRef, storage, cleanPath);
  return { ok: Boolean(session), session };
}

export async function signOut({
  storage = globalThis.localStorage,
} = {}) {
  storeSession(null, storage);
  removeStorage(storage, WEB_AUTH_PKCE_KEY);
  removeStorage(storage, WEB_AUTH_RETURN_KEY);
  return { ok: true };
}

function supabaseUrl(config, table, query = {}) {
  const url = new URL(`${trimSlash(config.supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function authHeaders(config, bearer) {
  return {
    apikey: config.supabaseAnonKey,
    authorization: `Bearer ${bearer || config.supabaseAnonKey}`,
    accept: "application/json",
  };
}

export async function fetchMyMembership({
  session,
  config = readWebAuthConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!isSessionValid(session) || typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(supabaseUrl(config, "app_my_membership", {
    select: "email,record_id,record_type,role,status,display_name,approved_at",
    limit: "1",
  }), {
    headers: authHeaders(config, session.access_token),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return null;
  return parseMembership(data);
}

export async function requestAccess({
  session,
  message,
  requestedRecordId,
  displayName,
  config = readWebAuthConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!isSessionValid(session)) return { ok: false, error: "not signed in" };
  const email = sessionEmail(session);
  if (!email) return { ok: false, error: "no email on session" };
  const response = await fetchImpl(supabaseUrl(config, "app_access_requests"), {
    method: "POST",
    headers: {
      ...authHeaders(config, session.access_token),
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      email,
      display_name: displayName || session.user?.user_metadata?.full_name || null,
      requested_record_id: requestedRecordId || null,
      message: message || null,
    }),
  });
  if (!response.ok) return { ok: false, error: `request failed: ${response.status}` };
  return { ok: true };
}

export async function getAuthState({
  windowRef = globalThis,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  config = readWebAuthConfig({ windowRef, storage }),
} = {}) {
  const session = await getSession({ config, storage, fetchImpl });
  const membership = session ? await fetchMyMembership({ session, config, fetchImpl }) : null;
  return { session, membership, state: gateState({ session, membership }) };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buttonLabel(auth) {
  if (!auth?.session) return "sign in";
  if (auth.state === "approved") return "member context";
  if (auth.state === "pending") return "pending";
  if (auth.state === "rejected") return "declined";
  return "request access";
}

function renderAuthPopover(el, auth, error = "") {
  const email = sessionEmail(auth?.session);
  const state = auth?.state || "signed_out";
  if (state === "signed_out") {
    return `
      <div class="site-auth-popover" role="dialog" aria-label="Google sign-in">
        <p>Use Google to unlock member-only context.</p>
        <button type="button" class="site-auth-action" data-auth-action="signin">continue with Google</button>
        ${error ? `<span class="site-auth-error">${esc(error)}</span>` : ""}
      </div>
    `;
  }
  if (state === "approved") {
    return `
      <div class="site-auth-popover" role="dialog" aria-label="signed in">
        <p><b>Signed in.</b><br />Approved for cohort context.</p>
        <button type="button" class="site-auth-action" data-auth-action="signout">sign out</button>
      </div>
    `;
  }
  if (state === "rejected") {
    return `
      <div class="site-auth-popover" role="dialog" aria-label="access declined">
        <p><b>Access declined.</b><br />This account is not approved.</p>
        <button type="button" class="site-auth-action" data-auth-action="signout">use another account</button>
      </div>
    `;
  }
  return `
    <div class="site-auth-popover" role="dialog" aria-label="request access">
      <p><b>Request access.</b><br />Tell us who you are and an organizer can approve access.</p>
      <textarea data-auth-message placeholder="name, team/project, github handle"></textarea>
      <button type="button" class="site-auth-action" data-auth-action="request">request access</button>
      <button type="button" class="site-auth-link" data-auth-action="signout">use another account</button>
      ${error ? `<span class="site-auth-error">${esc(error)}</span>` : ""}
    </div>
  `;
}

export async function mountWebAuth({
  documentRef = globalThis.document,
  windowRef = globalThis,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  const nav = documentRef?.getElementById?.("site-nav");
  if (!nav || nav.querySelector("[data-site-auth]")) return null;
  const config = readWebAuthConfig({ windowRef, storage });
  try { await restoreOAuthRedirect({ windowRef, storage, fetchImpl, config }); } catch {}

  const host = documentRef.createElement("div");
  host.className = "site-auth";
  host.setAttribute("data-site-auth", "");
  host.innerHTML = `
    <button type="button" class="site-auth-button" aria-haspopup="dialog" aria-expanded="false">
      <span class="site-auth-dot" aria-hidden="true"></span>
      <span data-auth-label>sign in</span>
    </button>
  `;
  const version = nav.querySelector("[data-version-chip]");
  nav.insertBefore(host, version || null);

  let auth = await getAuthState({ windowRef, storage, fetchImpl, config });
  let open = false;
  let error = "";
  const paint = () => {
    host.dataset.state = auth?.state || "signed_out";
    host.querySelector("[data-auth-label]").textContent = buttonLabel(auth);
    host.querySelector(".site-auth-button")?.setAttribute("aria-expanded", open ? "true" : "false");
    host.querySelector(".site-auth-popover")?.remove();
    if (open) host.insertAdjacentHTML("beforeend", renderAuthPopover(host, auth, error));
  };
  const refresh = async () => {
    auth = await getAuthState({ windowRef, storage, fetchImpl, config });
    paint();
  };
  host.addEventListener("click", async (event) => {
    const actionEl = event.target.closest("[data-auth-action]");
    if (!actionEl) {
      if (event.target.closest(".site-auth-popover")) return;
      open = !open;
      error = "";
      paint();
      return;
    }
    const action = actionEl.dataset.authAction;
    actionEl.disabled = true;
    try {
      if (action === "signin") await signInWithGoogle({ windowRef, storage, config });
      if (action === "signout") {
        await signOut({ storage });
        open = false;
        await refresh();
      }
      if (action === "request") {
        const message = host.querySelector("[data-auth-message]")?.value || "";
        const result = await requestAccess({ session: auth.session, message, config, fetchImpl });
        if (!result.ok) throw new Error(result.error || "request failed");
        auth = { ...auth, state: "pending" };
        error = "";
        paint();
      }
    } catch (err) {
      error = err?.message || String(err);
      paint();
    } finally {
      actionEl.disabled = false;
    }
  });
  documentRef.addEventListener("click", (event) => {
    if (!open || host.contains(event.target)) return;
    open = false;
    paint();
  });
  onSessionChanged(() => { refresh(); });
  paint();
  authMount = { host, refresh };
  return authMount;
}

export const ShapeWebAuth = {
  readWebAuthConfig,
  makePkcePair,
  buildAuthorizeUrl,
  sessionFromTokenResponse,
  isSessionValid,
  sessionExpiresSoon,
  sessionEmail,
  parseMembership,
  gateState,
  signInWithGoogle,
  restoreOAuthRedirect,
  getSession,
  getAuthState,
  fetchMyMembership,
  requestAccess,
  signOut,
  onSessionChanged,
  authHeaders,
};

try {
  globalThis.ShapeWebAuth = Object.freeze(ShapeWebAuth);
} catch {}
