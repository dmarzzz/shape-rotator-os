#!/usr/bin/env node

const { loadEnvFile } = require("./lib/env-file.cjs");

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-supabase-admin-organizers.js --env-file .env.calendar.local [--apply]",
    "",
    "Maps GOOGLE_CALENDAR_EDITOR_EMAILS to Supabase auth users and upserts",
    "org_memberships rows so admin organizers can use Shape Rotator OS event creation.",
    "",
    "Options:",
    "  --apply                    Upsert org_memberships. Default is dry-run.",
    "  --dry-run                  Print the plan without writing. This is the default.",
    "  --env-file FILE            Load local KEY=value secrets before env fallbacks.",
    "  --emails EMAILS            Editor/admin emails. Defaults to GOOGLE_CALENDAR_EDITOR_EMAILS.",
    "  --org-id UUID              Defaults to ORG_ID.",
    "  --role ROLE                Membership role. Default: admin. Use coordinator only deliberately.",
    "  --json                     Print JSON instead of a short summary.",
    "",
    "Environment fallbacks:",
    "  SUPABASE_URL",
    "  SUPABASE_SERVICE_ROLE_KEY",
    "  ORG_ID",
    "  GOOGLE_CALENDAR_EDITOR_EMAILS",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function parseEmails(value = "") {
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
  const role = String(value || "admin").trim();
  if (!["admin", "coordinator"].includes(role)) {
    throw new Error(`unsupported organizer membership role: ${role}`);
  }
  return role;
}

function supabaseUrl(base, pathname) {
  if (!base) throw new Error("SUPABASE_URL is required");
  const url = new URL(base);
  url.pathname = pathname;
  url.search = "";
  return url;
}

async function supabaseRequest({ url, serviceRoleKey, method = "GET", body, prefer, fetchImpl = fetch }) {
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  const response = await fetchImpl(url, {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(prefer ? { prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Supabase ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchAuthUsers({ supabaseUrl: baseUrl, serviceRoleKey, fetchImpl = fetch, perPage = 1000 }) {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = supabaseUrl(baseUrl, "/auth/v1/admin/users");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const data = await supabaseRequest({ url, serviceRoleKey, fetchImpl });
    const pageUsers = Array.isArray(data?.users) ? data.users : [];
    users.push(...pageUsers);
    if (pageUsers.length < perPage) break;
  }
  return users;
}

function matchOrganizerUsers({ emails, users }) {
  const byEmail = new Map();
  for (const user of users || []) {
    const email = String(user?.email || "").trim().toLowerCase();
    if (!email || !user?.id || byEmail.has(email)) continue;
    byEmail.set(email, { id: String(user.id), email });
  }
  const matched = [];
  const missing = [];
  for (const email of emails || []) {
    const user = byEmail.get(email);
    if (user) matched.push(user);
    else missing.push(email);
  }
  return { matched, missing };
}

function buildMembershipRows({ orgId, users, role = "admin" }) {
  if (!orgId) throw new Error("ORG_ID is required");
  const normalizedRole = normalizeRole(role);
  return (users || []).map((user) => ({
    org_id: orgId,
    user_id: user.id,
    role: normalizedRole,
  }));
}

async function upsertOrgMemberships({
  supabaseUrl: baseUrl,
  serviceRoleKey,
  rows,
  fetchImpl = fetch,
}) {
  if (!rows?.length) return { upserted: 0 };
  const url = supabaseUrl(baseUrl, "/rest/v1/org_memberships");
  url.searchParams.set("on_conflict", "org_id,user_id");
  await supabaseRequest({
    url,
    serviceRoleKey,
    method: "POST",
    body: rows,
    prefer: "resolution=merge-duplicates,return=minimal",
    fetchImpl,
  });
  return { upserted: rows.length };
}

async function runSupabaseAdminOrganizersSetup({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  emails,
  role = "admin",
  apply = false,
  fetchImpl = fetch,
} = {}) {
  const editorEmails = parseEmails(emails);
  if (!editorEmails.length) {
    throw new Error("at least one admin organizer email is required; use --emails or GOOGLE_CALENDAR_EDITOR_EMAILS");
  }
  const normalizedRole = normalizeRole(role);
  const users = await fetchAuthUsers({ supabaseUrl, serviceRoleKey, fetchImpl });
  const { matched, missing } = matchOrganizerUsers({ emails: editorEmails, users });
  const rows = buildMembershipRows({ orgId, users: matched, role: normalizedRole });
  const result = {
    apply: !!apply,
    org_id_present: !!orgId,
    role: normalizedRole,
    auth_users_scanned: users.length,
    planned: editorEmails.length,
    matched: matched.length,
    missing: missing.length,
    upserted: 0,
    missing_emails: missing,
    matched_emails: matched.map((user) => user.email),
  };
  if (apply && rows.length) {
    const upsert = await upsertOrgMemberships({ supabaseUrl, serviceRoleKey, rows, fetchImpl });
    result.upserted = upsert.upserted;
  }
  return result;
}

function renderSummary(result) {
  const lines = [
    "Supabase admin organizer setup",
    "",
    `Mode: ${result.apply ? "apply" : "dry-run"}`,
    `Role: ${result.role}`,
    `Configured editor emails: ${result.planned}`,
    `Matched Supabase auth users: ${result.matched}`,
    `Missing Supabase auth users: ${result.missing}`,
    `Upserted org memberships: ${result.upserted}`,
  ];
  if (result.missing_emails?.length) {
    lines.push("", "Missing emails:");
    for (const email of result.missing_emails) lines.push(`- ${email}`);
  }
  return lines.join("\n");
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const result = await runSupabaseAdminOrganizersSetup({
    supabaseUrl: arg("--supabase-url", argv) || process.env.SUPABASE_URL,
    serviceRoleKey: arg("--service-role-key", argv) || process.env.SUPABASE_SERVICE_ROLE_KEY,
    orgId: arg("--org-id", argv) || process.env.ORG_ID,
    emails: arg("--emails", argv) || process.env.GOOGLE_CALENDAR_EDITOR_EMAILS,
    role: arg("--role", argv) || "admin",
    apply: flag("--apply", argv) && !flag("--dry-run", argv),
  });
  if (flag("--json", argv)) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(renderSummary(result) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildMembershipRows,
  matchOrganizerUsers,
  parseEmails,
  renderSummary,
  runSupabaseAdminOrganizersSetup,
};
