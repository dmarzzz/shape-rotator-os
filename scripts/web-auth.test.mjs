import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WEB_AUTH_PKCE_KEY,
  WEB_AUTH_RETURN_KEY,
  WEB_AUTH_SESSION_KEY,
  buildAuthorizeUrl,
  fetchMyMembership,
  gateState,
  parseMembership,
  readWebAuthConfig,
  restoreOAuthRedirect,
  sessionEmail,
  sessionFromTokenResponse,
  signInWithGoogle,
} from "../apps/web/scripts/auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAV_SCRIPT = path.join(ROOT, "apps", "web", "scripts", "nav.js");
const APP_SIDE_CONTEXT_PAGE = path.join(ROOT, "apps", "web", "context", "index.html");
const PUBLIC_WEB_PAGES = [
  path.join(ROOT, "apps", "web", "index.html"),
  path.join(ROOT, "apps", "web", "cohort", "index.html"),
  path.join(ROOT, "apps", "web", "calendar", "index.html"),
  path.join(ROOT, "apps", "web", "availability", "index.html"),
  path.join(ROOT, "apps", "web", "links", "index.html"),
];

function jwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}

function storage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map.entries()),
  };
}

test("shared public nav mounts Google auth only on app-side opt-in pages", () => {
  const navSource = fs.readFileSync(NAV_SCRIPT, "utf8");
  assert.doesNotMatch(navSource, /import\s+\{\s*mountWebAuth\s*\}\s+from\s+["']\.\/auth\.js["']/);
  assert.match(navSource, /shouldMountWebAuth/);
  assert.match(navSource, /import\(["']\.\/auth\.js["']\)/);

  const appSideHtml = fs.readFileSync(APP_SIDE_CONTEXT_PAGE, "utf8");
  assert.match(appSideHtml, /<body[^>]*data-web-app-auth/);

  for (const page of PUBLIC_WEB_PAGES) {
    const html = fs.readFileSync(page, "utf8");
    assert.doesNotMatch(html, /data-web-app-auth/, page);
  }
});

test("buildAuthorizeUrl targets Supabase Google with PKCE and explicit redirect", () => {
  const url = buildAuthorizeUrl({
    config: { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "anon" },
    redirectTo: "https://os-web.shaperotator.xyz/",
    challenge: "challenge-123",
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://project.supabase.co");
  assert.equal(parsed.pathname, "/auth/v1/authorize");
  assert.equal(parsed.searchParams.get("provider"), "google");
  assert.equal(parsed.searchParams.get("redirect_to"), "https://os-web.shaperotator.xyz/");
  assert.equal(parsed.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "s256");
});

test("session and membership helpers normalize the Google identity gate", () => {
  const token = jwt({ sub: "user-1", email: "ALICE@EXAMPLE.COM", exp: 2000 });
  const session = sessionFromTokenResponse({ access_token: token, refresh_token: "refresh", expires_at: 2000 });
  assert.equal(sessionEmail(session), "alice@example.com");
  assert.equal(gateState({ session, membership: null, nowSec: 100 }), "unapproved");
  const membership = parseMembership([{ email: "alice@example.com", status: "approved", record_id: "alice", role: "member" }]);
  assert.equal(gateState({ session, membership, nowSec: 100 }), "approved");
});

test("signInWithGoogle stores PKCE verifier and redirects to Supabase", async () => {
  const store = storage();
  const assigned = [];
  const cryptoImpl = {
    getRandomValues: (bytes) => bytes.fill(7),
    subtle: { digest: async () => new Uint8Array([1, 2, 3, 4]).buffer },
  };
  await signInWithGoogle({
    storage: store,
    cryptoImpl,
    config: { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "anon" },
    windowRef: {
      location: {
        origin: "https://os-web.shaperotator.xyz",
        pathname: "/context",
        search: "?v=test",
        hash: "#team-a",
        assign: (url) => assigned.push(url),
      },
    },
  });
  assert.equal(assigned.length, 1);
  assert.match(assigned[0], /\/auth\/v1\/authorize/);
  assert.equal(JSON.parse(store.getItem(WEB_AUTH_PKCE_KEY)).verifier.length > 40, true);
  assert.equal(store.getItem(WEB_AUTH_RETURN_KEY), "/context?v=test#team-a");
});

test("restoreOAuthRedirect exchanges PKCE code, stores session, and returns to the saved page", async () => {
  const store = storage({
    [WEB_AUTH_PKCE_KEY]: JSON.stringify({ verifier: "verifier-123" }),
    [WEB_AUTH_RETURN_KEY]: "/context#shape-rotator-os",
  });
  const replaced = [];
  const token = jwt({ sub: "user-1", email: "alice@example.com", exp: 2200 });
  const result = await restoreOAuthRedirect({
    storage: store,
    config: { supabaseUrl: "https://project.supabase.co", supabaseAnonKey: "anon" },
    windowRef: {
      location: {
        href: "https://os-web.shaperotator.xyz/?code=abc&state=xyz",
        origin: "https://os-web.shaperotator.xyz",
        pathname: "/",
        search: "?code=abc&state=xyz",
        hash: "",
        replace: (path) => replaced.push(path),
      },
      history: { replaceState: () => {} },
    },
    fetchImpl: async (url, opts) => {
      assert.match(String(url), /grant_type=pkce/);
      assert.deepEqual(JSON.parse(opts.body), { auth_code: "abc", code_verifier: "verifier-123" });
      return { ok: true, json: async () => ({ access_token: token, refresh_token: "refresh", expires_at: 2200 }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(store.getItem(WEB_AUTH_SESSION_KEY)).refresh_token, "refresh");
  assert.equal(store.getItem(WEB_AUTH_PKCE_KEY), null);
  assert.equal(replaced[0], "/context#shape-rotator-os");
});

test("fetchMyMembership reads the caller-scoped roster row with the session bearer", async () => {
  const token = jwt({ sub: "user-1", email: "alice@example.com", exp: Math.floor(Date.now() / 1000) + 3600 });
  const membership = await fetchMyMembership({
    session: sessionFromTokenResponse({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    config: readWebAuthConfig({ storage: storage() }),
    fetchImpl: async (url, opts) => {
      assert.match(String(url), /app_my_membership/);
      assert.equal(opts.headers.authorization, `Bearer ${token}`);
      return {
        ok: true,
        json: async () => [{ email: "alice@example.com", status: "approved", record_id: "alice", role: "member" }],
      };
    },
  });
  assert.equal(membership.approved, true);
  assert.equal(membership.record_id, "alice");
});
