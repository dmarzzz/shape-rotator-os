#!/usr/bin/env node

const { loadEnvFile } = require("./lib/env-file.cjs");
const { refreshAccessToken } = require("./google-calendar-oauth.js");

const DEFAULT_EDITOR_EMAILS = [];
const ROLE_RANK = {
  none: 0,
  freeBusyReader: 1,
  reader: 2,
  writer: 3,
  owner: 4,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-google-calendar-acl.js --calendar-id CALENDAR_ID [--emails a@example.com,b@example.com] [--apply]",
    "",
    "Options:",
    "  --apply                    Create/update ACL rules. Default is dry-run.",
    "  --dry-run                  Print the plan without writing. This is the default.",
    "  --calendar-id ID           Google Calendar ID.",
    "  --emails EMAILS            Comma, semicolon, or whitespace separated editor emails.",
    "  --role ROLE                ACL role. Default: owner.",
    "  --scope-type TYPE          ACL scope type. Default: user. Use group for Google Groups or default for public calendar visibility.",
    "  --send-notifications       Ask Google to notify newly shared users/groups.",
    "  --access-token TOKEN       OAuth token with Calendar ACL write access.",
    "  --env-file FILE            Load local KEY=value secrets before env fallbacks.",
    "  --verify                   Fetch existing ACLs and report gaps without writing.",
    "  --read-existing            Alias for --verify.",
    "  --allow-downgrade          Permit lowering owner/writer roles to the requested role.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_EDITOR_EMAILS",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN",
    "",
    "Editor emails must be supplied through --emails or GOOGLE_CALENDAR_EDITOR_EMAILS unless --scope-type default is used.",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function parseEmails(value = DEFAULT_EDITOR_EMAILS) {
  const input = Array.isArray(value) ? value.join(",") : String(value || "");
  const seen = new Set();
  return input
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    .filter((email) => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
}

function normalizeRole(value) {
  const role = String(value || "owner").trim();
  if (!["none", "freeBusyReader", "reader", "writer", "owner"].includes(role)) {
    throw new Error(`unsupported ACL role: ${role}`);
  }
  return role;
}

function roleRank(role) {
  return ROLE_RANK[role] ?? -1;
}

function normalizeScopeType(value) {
  const scopeType = String(value || "user").trim();
  if (!["user", "group", "default"].includes(scopeType)) {
    throw new Error(`unsupported ACL scope type for editor setup: ${scopeType}`);
  }
  return scopeType;
}

function googleAclUrl(calendarId, suffix = "") {
  return new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl${suffix}`);
}

async function googleRequest({ url, accessToken, method = "GET", body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Calendar ACL ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchAclRules({ calendarId, accessToken, fetchImpl = fetch }) {
  const items = [];
  let pageToken = null;
  do {
    const url = googleAclUrl(calendarId);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleRequest({ url, accessToken, fetchImpl });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return items;
}

function aclBody({ email, role = "owner", scopeType = "user" }) {
  const scope = { type: scopeType };
  if (scopeType !== "default") scope.value = email;
  return {
    role,
    scope,
  };
}

function matchingAclRule(rules, { email, scopeType = "user" }) {
  if (scopeType === "default") {
    return (rules || []).find((rule) => rule?.scope?.type === "default") || null;
  }
  return (rules || []).find((rule) =>
    rule?.scope?.type === scopeType
    && String(rule?.scope?.value || "").toLowerCase() === email
  ) || null;
}

function buildAclPlan({
  calendarId,
  emails = DEFAULT_EDITOR_EMAILS,
  role = "owner",
  scopeType = "user",
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  const normalizedRole = normalizeRole(role);
  const normalizedScopeType = normalizeScopeType(scopeType);
  if (normalizedScopeType === "default" && !["none", "freeBusyReader", "reader"].includes(normalizedRole)) {
    throw new Error("default calendar ACL can only use none, freeBusyReader, or reader");
  }
  const editors = normalizedScopeType === "default" ? [""] : parseEmails(emails);
  if (normalizedScopeType !== "default" && !editors.length) {
    throw new Error("at least one editor email is required; use --emails or GOOGLE_CALENDAR_EDITOR_EMAILS");
  }
  return {
    calendar_id: calendarId,
    role: normalizedRole,
    scope_type: normalizedScopeType,
    editors,
    actions: editors.map((email) => ({
      action: "dry-run",
      ...(email ? { email } : {}),
      role: normalizedRole,
      scope_type: normalizedScopeType,
    })),
  };
}

async function insertAclRule({ calendarId, accessToken, body, sendNotifications = false, fetchImpl = fetch }) {
  const url = googleAclUrl(calendarId);
  url.searchParams.set("sendNotifications", sendNotifications ? "true" : "false");
  return googleRequest({ url, accessToken, method: "POST", body, fetchImpl });
}

async function patchAclRule({ calendarId, accessToken, ruleId, body, sendNotifications = false, fetchImpl = fetch }) {
  const url = googleAclUrl(calendarId, `/${encodeURIComponent(ruleId)}`);
  url.searchParams.set("sendNotifications", sendNotifications ? "true" : "false");
  return googleRequest({ url, accessToken, method: "PATCH", body, fetchImpl });
}

async function runGoogleCalendarAclSetup({
  calendarId,
  accessToken,
  emails = DEFAULT_EDITOR_EMAILS,
  role = "owner",
  scopeType = "user",
  apply = false,
  verify = false,
  sendNotifications = false,
  allowDowngrade = false,
  fetchImpl = fetch,
} = {}) {
  const plan = buildAclPlan({ calendarId, emails, role, scopeType });
  const result = {
    calendar_id: plan.calendar_id,
    apply: !!apply,
    verify: !!verify,
    role: plan.role,
    scope_type: plan.scope_type,
    planned: plan.editors.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    would_update: 0,
    actions: [],
  };
  if (!apply && !verify) {
    result.actions = plan.actions;
    return result;
  }
  if (!accessToken) throw new Error("accessToken is required with apply=true or verify=true");
  const existingRules = await fetchAclRules({ calendarId, accessToken, fetchImpl });
  for (const email of plan.editors) {
    const body = aclBody({ email, role: plan.role, scopeType: plan.scope_type });
    const existing = matchingAclRule(existingRules, { email, scopeType: plan.scope_type });
    const subject = email ? { email } : {};
    if (!existing) {
      if (!apply) {
        result.missing += 1;
        result.actions.push({
          action: "missing",
          ...subject,
          role: plan.role,
          scope_type: plan.scope_type,
        });
        continue;
      }
      const rule = await insertAclRule({ calendarId, accessToken, body, sendNotifications, fetchImpl });
      result.inserted += 1;
      result.actions.push({
        action: "inserted",
        ...subject,
        role: rule?.role || plan.role,
        scope_type: plan.scope_type,
        acl_id: rule?.id || null,
      });
      continue;
    }
    const existingRank = roleRank(existing.role);
    const plannedRank = roleRank(plan.role);
    const hasAtLeastRequestedRole = existing.role === plan.role
      || (existingRank > plannedRank && !allowDowngrade);
    if (hasAtLeastRequestedRole) {
      result.unchanged += 1;
      result.actions.push({
        action: "unchanged",
        ...subject,
        role: existing.role,
        requested_role: plan.role,
        scope_type: plan.scope_type,
        acl_id: existing.id || null,
      });
      continue;
    }
    if (!apply) {
      result.would_update += 1;
      result.actions.push({
        action: "would_update",
        ...subject,
        from_role: existing.role || null,
        role: plan.role,
        scope_type: plan.scope_type,
        acl_id: existing.id || null,
      });
      continue;
    }
    const rule = await patchAclRule({
      calendarId,
      accessToken,
      ruleId: existing.id,
      body,
      sendNotifications,
      fetchImpl,
    });
    result.updated += 1;
    result.actions.push({
      action: "updated",
      ...subject,
      from_role: existing.role || null,
      role: rule?.role || plan.role,
      scope_type: plan.scope_type,
      acl_id: rule?.id || existing.id || null,
    });
  }
  return result;
}

async function resolveAccessToken({
  accessToken,
  clientId,
  clientSecret,
  refreshToken,
  preferRefresh = false,
  fetchImpl = fetch,
} = {}) {
  if (preferRefresh && clientId && clientSecret && refreshToken) {
    const token = await refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      fetchImpl,
    });
    if (String(token?.access_token || "").trim()) return token.access_token;
  }
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
  return "";
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const verify = !apply && (flag("--verify", argv) || flag("--read-existing", argv));
  const cliAccessToken = arg("--access-token", argv);
  const accessToken = await resolveAccessToken({
    accessToken: cliAccessToken || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    preferRefresh: !cliAccessToken,
  });
  const result = await runGoogleCalendarAclSetup({
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken,
    emails: arg("--emails", argv) || process.env.GOOGLE_CALENDAR_EDITOR_EMAILS || DEFAULT_EDITOR_EMAILS,
    role: arg("--role", argv) || "owner",
    scopeType: arg("--scope-type", argv) || "user",
    sendNotifications: flag("--send-notifications", argv),
    allowDowngrade: flag("--allow-downgrade", argv),
    apply,
    verify,
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
  DEFAULT_EDITOR_EMAILS,
  buildAclPlan,
  parseEmails,
  resolveAccessToken,
  runGoogleCalendarAclSetup,
};
