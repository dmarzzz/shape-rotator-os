#!/usr/bin/env node

const { loadEnvFile } = require("./lib/env-file.cjs");
const { parseEmails } = require("./setup-google-calendar-acl.js");

const DEFAULT_DRIVE_ADMIN_EMAILS = [];

const ROLE_RANK = {
  reader: 1,
  commenter: 2,
  writer: 3,
  fileOrganizer: 4,
  organizer: 5,
  owner: 6,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-google-drive-admins.js --drive-id DRIVE_ID [--emails a@example.com,b@example.com] [--apply]",
    "",
    "Options:",
    "  --apply                    Create/update Drive permissions. Default is dry-run.",
    "  --dry-run                  Print the plan without writing. This is the default.",
    "  --verify                   Fetch existing permissions and report gaps without writing.",
    "  --drive-id ID              Google Drive shared drive or folder ID.",
    "  --emails EMAILS            Comma, semicolon, or whitespace separated admin emails.",
    "  --role ROLE                Drive API role. Default: organizer.",
    "  --send-notifications       Ask Google to notify newly shared users.",
    "  --access-token TOKEN       OAuth token with Drive write access.",
    "  --env-file FILE            Load local KEY=value secrets before env fallbacks.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_DRIVE_ID",
    "  GOOGLE_DRIVE_ADMIN_EMAILS",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "",
    "Admin emails must be supplied through --emails or GOOGLE_DRIVE_ADMIN_EMAILS.",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function normalizeRole(value) {
  const role = String(value || "organizer").trim();
  if (!Object.hasOwn(ROLE_RANK, role)) throw new Error(`unsupported Drive role: ${role}`);
  return role;
}

function roleRank(role) {
  return ROLE_RANK[role] ?? -1;
}

function drivePermissionsUrl(driveId, suffix = "") {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}/permissions${suffix}`);
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

async function googleDriveRequest({ url, accessToken, method = "GET", body, fetchImpl = fetch }) {
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
    const error = new Error(`Google Drive permissions ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchDrivePermissions({ driveId, accessToken, fetchImpl = fetch }) {
  const items = [];
  let pageToken = null;
  do {
    const url = drivePermissionsUrl(driveId);
    url.searchParams.set("fields", "nextPageToken,permissions(id,type,emailAddress,role,displayName)");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleDriveRequest({ url, accessToken, fetchImpl });
    items.push(...(data.permissions || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return items;
}

function matchingPermission(permissions, email) {
  return (permissions || []).find((permission) =>
    permission?.type === "user"
    && String(permission?.emailAddress || "").toLowerCase() === email
  ) || null;
}

function permissionBody({ email, role }) {
  return {
    type: "user",
    role,
    emailAddress: email,
  };
}

async function createDrivePermission({ driveId, accessToken, body, sendNotifications = false, fetchImpl = fetch }) {
  const url = drivePermissionsUrl(driveId);
  url.searchParams.set("sendNotificationEmail", sendNotifications ? "true" : "false");
  url.searchParams.set("fields", "id,type,emailAddress,role,displayName");
  return googleDriveRequest({ url, accessToken, method: "POST", body, fetchImpl });
}

async function updateDrivePermission({ driveId, accessToken, permissionId, body, fetchImpl = fetch }) {
  const url = drivePermissionsUrl(driveId, `/${encodeURIComponent(permissionId)}`);
  url.searchParams.set("fields", "id,type,emailAddress,role,displayName");
  return googleDriveRequest({
    url,
    accessToken,
    method: "PATCH",
    body: { role: body.role },
    fetchImpl,
  });
}

function buildDriveAdminPlan({
  driveId,
  emails = DEFAULT_DRIVE_ADMIN_EMAILS,
  role = "organizer",
} = {}) {
  if (!driveId) throw new Error("driveId is required");
  const admins = parseEmails(emails);
  if (!admins.length) throw new Error("at least one Drive admin email is required; use --emails or GOOGLE_DRIVE_ADMIN_EMAILS");
  const normalizedRole = normalizeRole(role);
  return {
    drive_id: driveId,
    role: normalizedRole,
    admins,
    actions: admins.map((email) => ({
      action: "dry-run",
      email,
      role: normalizedRole,
    })),
  };
}

async function runGoogleDriveAdminSetup({
  driveId,
  accessToken,
  emails = DEFAULT_DRIVE_ADMIN_EMAILS,
  role = "organizer",
  apply = false,
  verify = false,
  sendNotifications = false,
  fetchImpl = fetch,
} = {}) {
  const plan = buildDriveAdminPlan({ driveId, emails, role });
  const result = {
    drive_id: plan.drive_id,
    apply: !!apply,
    verify: !!verify,
    role: plan.role,
    planned: plan.admins.length,
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
  const permissions = await fetchDrivePermissions({ driveId, accessToken, fetchImpl });
  for (const email of plan.admins) {
    const existing = matchingPermission(permissions, email);
    const body = permissionBody({ email, role: plan.role });
    if (!existing) {
      if (!apply) {
        result.missing += 1;
        result.actions.push({ action: "missing", email, role: plan.role });
        continue;
      }
      const permission = await createDrivePermission({ driveId, accessToken, body, sendNotifications, fetchImpl });
      result.inserted += 1;
      result.actions.push({
        action: "inserted",
        email,
        role: permission?.role || plan.role,
        permission_id: permission?.id || null,
      });
      continue;
    }
    if (roleRank(existing.role) >= roleRank(plan.role)) {
      result.unchanged += 1;
      result.actions.push({
        action: "unchanged",
        email,
        role: existing.role,
        requested_role: plan.role,
        permission_id: existing.id || null,
      });
      continue;
    }
    if (!apply) {
      result.would_update += 1;
      result.actions.push({
        action: "would_update",
        email,
        from_role: existing.role || null,
        role: plan.role,
        permission_id: existing.id || null,
      });
      continue;
    }
    const permission = await updateDrivePermission({
      driveId,
      accessToken,
      permissionId: existing.id,
      body,
      fetchImpl,
    });
    result.updated += 1;
    result.actions.push({
      action: "updated",
      email,
      from_role: existing.role || null,
      role: permission?.role || plan.role,
      permission_id: permission?.id || existing.id || null,
    });
  }
  return result;
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const apply = flag("--apply", argv) && !flag("--dry-run", argv);
  const verify = !apply && (flag("--verify", argv) || flag("--read-existing", argv));
  const result = await runGoogleDriveAdminSetup({
    driveId: arg("--drive-id", argv) || process.env.GOOGLE_DRIVE_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    emails: arg("--emails", argv) || process.env.GOOGLE_DRIVE_ADMIN_EMAILS || DEFAULT_DRIVE_ADMIN_EMAILS,
    role: arg("--role", argv) || "organizer",
    sendNotifications: flag("--send-notifications", argv),
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
  DEFAULT_DRIVE_ADMIN_EMAILS,
  buildDriveAdminPlan,
  runGoogleDriveAdminSetup,
};
