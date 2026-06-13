#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const PRIVATE_TABLES = [
  "source_artifacts",
  "processing_jobs",
  "derived_artifacts",
  "evidence_cards",
  "private_invite_contacts",
];

const APP_VIEWS = [
  "app_transcript_distillations",
  "app_transcript_evidence_cards",
];

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function readArgs(argv = process.argv.slice(2), env = process.env) {
  return {
    supabaseUrl: arg(argv, "--supabase-url", env.SUPABASE_URL || env.SHAPE_SUPABASE_URL),
    anonKey: arg(argv, "--anon-key", env.SUPABASE_ANON_KEY || env.SHAPE_SUPABASE_ANON_KEY),
    orgId: arg(argv, "--org-id", env.ORG_ID),
    memberToken: arg(argv, "--member-token", env.SHAPE_RLS_MEMBER_TOKEN),
    coordinatorToken: arg(argv, "--coordinator-token", env.SHAPE_RLS_COORDINATOR_TOKEN),
    adminToken: arg(argv, "--admin-token", env.SHAPE_RLS_ADMIN_TOKEN),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/check-transcript-rls-boundary.mjs --supabase-url URL --anon-key KEY --org-id ORG_ID \\",
    "    --member-token JWT --coordinator-token JWT --admin-token JWT",
    "",
    "Checks that ordinary app members only see app-safe transcript views, while coordinators/admins can read operator tables.",
  ].join("\n");
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function restUrl({ supabaseUrl, table, orgId }) {
  const url = new URL(`${trimSlash(supabaseUrl)}/rest/v1/${table}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("org_id", `eq.${orgId}`);
  url.searchParams.set("limit", "1");
  return url;
}

async function queryTable({ supabaseUrl, anonKey, orgId, token, table, fetchImpl = fetch }) {
  const response = await fetchImpl(restUrl({ supabaseUrl, table, orgId }), {
    method: "GET",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => null);
  return {
    table,
    status: response.status,
    ok: response.ok,
    row_count: Array.isArray(data) ? data.length : null,
    error: response.ok ? null : data?.message || data?.error || null,
  };
}

function evaluateRole(role, checks) {
  const failures = [];
  const warnings = [];
  for (const check of checks) {
    const isPrivate = PRIVATE_TABLES.includes(check.table);
    if (role === "member" && isPrivate && check.ok && check.row_count > 0) {
      failures.push(`${role} can read ${check.table}`);
    }
    if (role === "member" && isPrivate && check.ok && check.row_count === 0) {
      warnings.push(`${role} ${check.table} returned zero rows; boundary is not proven without seeded private rows`);
    }
    if (["coordinator", "admin"].includes(role) && isPrivate && !check.ok) {
      failures.push(`${role} cannot query ${check.table}: ${check.status}`);
    }
    if (APP_VIEWS.includes(check.table) && !check.ok) {
      failures.push(`${role} cannot query ${check.table}: ${check.status}`);
    }
  }
  return {
    role,
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
  };
}

async function runTranscriptRlsBoundaryCheck({
  supabaseUrl,
  anonKey,
  orgId,
  tokens,
  fetchImpl = fetch,
}) {
  if (!supabaseUrl) throw new Error("supabaseUrl is required");
  if (!anonKey) throw new Error("anonKey is required");
  if (!orgId) throw new Error("orgId is required");
  const roles = Object.entries(tokens || {}).filter(([, token]) => token);
  if (!roles.length) throw new Error("at least one role token is required");
  const tables = [...PRIVATE_TABLES, ...APP_VIEWS];
  const roleResults = [];
  for (const [role, token] of roles) {
    const checks = [];
    for (const table of tables) {
      checks.push(await queryTable({ supabaseUrl, anonKey, orgId, token, table, fetchImpl }));
    }
    roleResults.push({
      ...evaluateRole(role, checks),
      checks,
    });
  }
  return {
    ok: roleResults.every((result) => result.status !== "fail"),
    roles: roleResults,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = readArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runTranscriptRlsBoundaryCheck({
    supabaseUrl: options.supabaseUrl,
    anonKey: options.anonKey,
    orgId: options.orgId,
    tokens: {
      member: options.memberToken,
      coordinator: options.coordinatorToken,
      admin: options.adminToken,
    },
  });
  const json = JSON.stringify(result, null, 2);
  if (!result.ok) {
    console.error(json);
    process.exit(1);
  }
  console.log(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  APP_VIEWS,
  PRIVATE_TABLES,
  evaluateRole,
  runTranscriptRlsBoundaryCheck,
};
