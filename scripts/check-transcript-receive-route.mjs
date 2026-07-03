#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import envFileLib from "./lib/env-file.cjs";
import { decodeJwtPayload } from "./lib/cohort-key.mjs";
import {
  DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH,
  hasJwtShape,
  inspectPackagedCohortKey,
  projectRefFromSupabaseUrl,
} from "./lib/packaged-cohort-key.mjs";
import {
  cohortEvidenceCardsUrl,
  cohortInsightCardsUrl,
  fetchCohortEvidenceCards,
  fetchCohortInsightCards,
  fetchPublicEvidenceCards,
  publicEvidenceCardsUrl,
  readSupabaseConfig,
} from "../apps/os/src/renderer/supabase-evidence.mjs";
import {
  cohortDistillationsUrl,
  fetchCohortDistillations,
} from "../apps/os/src/renderer/supabase-distillations.mjs";
import { runLiveEvidenceCardAudit } from "./audit-supabase-evidence-cards.mjs";

const { parseEnvFile } = envFileLib;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_COLUMNS = new Set([
  "org_id",
  "session_id",
  "source_artifact_id",
  "processing_job_id",
  "derived_artifact_id",
  "reviewed_by",
  "storage_ref",
  "source_hash",
]);

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readEnvFile(filePath, root = ROOT) {
  if (!filePath) return {};
  const resolved = path.resolve(root, filePath);
  return parseEnvFile(fs.readFileSync(resolved, "utf8"));
}

function readPackagedCohortKey(root = ROOT, filePath = DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(root, filePath), "utf8"));
    return typeof parsed?.cohortKey === "string" ? parsed.cohortKey.trim() : "";
  } catch {
    return "";
  }
}

function toIsoDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function daysUntil(seconds, now = new Date()) {
  return Number.isFinite(seconds)
    ? Math.floor((seconds * 1000 - now.getTime()) / (24 * 60 * 60 * 1000))
    : null;
}

function inspectRuntimeCohortKey({ key = "", expectedRef = "", minDays = 30, now = new Date(), source = "none" } = {}) {
  const result = {
    ok: false,
    ready: false,
    status: key ? "invalid" : "missing",
    source,
    key_present: Boolean(key),
    jwt_shape: false,
    role: null,
    iss: null,
    ref: null,
    issued_at: null,
    expires_at: null,
    days_until_expiry: null,
    min_days: minDays,
    expected_ref: expectedRef || null,
    warnings: [],
    errors: [],
  };

  if (!key) {
    result.errors.push("no cohort key configured; named T2 evidence and distillations need a Google sign-in app session or will stay in fallback mode");
    return result;
  }

  result.jwt_shape = hasJwtShape(key);
  if (!result.jwt_shape) {
    result.errors.push("cohort key is not a JWT-shaped value");
    return result;
  }

  const payload = decodeJwtPayload(key);
  if (!payload) {
    result.errors.push("cohort key payload cannot be decoded");
    return result;
  }

  result.role = typeof payload.role === "string" ? payload.role : null;
  result.iss = typeof payload.iss === "string" ? payload.iss : null;
  result.ref = typeof payload.ref === "string" ? payload.ref : null;
  result.issued_at = toIsoDate(Number(payload.iat));
  result.expires_at = toIsoDate(Number(payload.exp));

  if (result.role !== "cohort_app") result.errors.push(`expected role=cohort_app, got ${result.role || "(missing)"}`);
  if (result.iss !== "supabase") result.errors.push(`expected iss=supabase, got ${result.iss || "(missing)"}`);

  const expSeconds = Number(payload.exp);
  if (!Number.isFinite(expSeconds)) {
    result.errors.push("cohort key is missing a numeric exp claim");
  } else {
    result.days_until_expiry = daysUntil(expSeconds, now);
    if (result.days_until_expiry < 0) {
      result.errors.push(`cohort key expired ${Math.abs(result.days_until_expiry)} day(s) ago`);
    } else if (Number.isFinite(minDays) && result.days_until_expiry < minDays) {
      result.errors.push(`cohort key expires in ${result.days_until_expiry} day(s), below minDays=${minDays}`);
    }
  }

  if (expectedRef && result.ref !== expectedRef) {
    result.errors.push(`expected ref=${expectedRef}, got ${result.ref || "(missing)"}`);
  } else if (!expectedRef && !result.ref) {
    result.warnings.push("cohort key has no ref claim; pass SUPABASE_URL or --expected-ref to check project binding");
  }

  if (result.errors.length === 0) {
    result.ok = true;
    result.ready = true;
    result.status = "ready";
  }
  return result;
}

function inspectGoogleSigninAppSessionCredential({ token = "", now = new Date(), source = "none" } = {}) {
  const result = {
    ok: false,
    ready: false,
    status: token ? "invalid" : source !== "none" ? "runtime_bridge" : "missing",
    source,
    token_present: Boolean(token),
    jwt_shape: false,
    role: null,
    expires_at: null,
    seconds_until_expiry: null,
    warnings: [],
    errors: [],
  };

  if (!token) {
    if (source !== "none") {
      result.warnings.push("Google sign-in app session is supplied by the app auth bridge at read time; token is not inspected");
    } else {
      result.errors.push("no Google sign-in app session token available to this verifier");
    }
    return result;
  }

  result.jwt_shape = hasJwtShape(token);
  if (!result.jwt_shape) {
    result.errors.push("Google sign-in app session token is not a JWT-shaped value");
    return result;
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    result.errors.push("Google sign-in app session token payload cannot be decoded");
    return result;
  }

  result.role = typeof payload.role === "string" ? payload.role : null;
  if (result.role && result.role !== "authenticated") {
    result.errors.push(`expected role=authenticated, got ${result.role}`);
  } else if (!result.role) {
    result.warnings.push("Google sign-in app session token has no role claim; Supabase usually provides role=authenticated");
  }

  const expSeconds = Number(payload.exp);
  if (!Number.isFinite(expSeconds)) {
    result.errors.push("Google sign-in app session token is missing a numeric exp claim");
  } else {
    result.expires_at = toIsoDate(expSeconds);
    result.seconds_until_expiry = Math.floor(expSeconds * 1000 - now.getTime()) / 1000;
    if (result.seconds_until_expiry <= 30) {
      result.errors.push("Google sign-in app session token is expired or too close to expiry");
    }
  }

  if (result.errors.length === 0) {
    result.ok = true;
    result.ready = true;
    result.status = "ready";
  }
  return result;
}

function selectedColumns(url) {
  try {
    return (new URL(url).searchParams.get("select") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inspectReaderContracts(config) {
  const urls = {
    public_t3: publicEvidenceCardsUrl(config.url),
    cohort_t2: cohortEvidenceCardsUrl(config.url),
    distillations: cohortDistillationsUrl(config.url),
    cohort_insights: cohortInsightCardsUrl(config.url),
  };
  const readers = {};
  const failures = [];
  for (const [name, url] of Object.entries(urls)) {
    const columns = selectedColumns(url);
    const privateColumns = columns.filter((column) => PRIVATE_COLUMNS.has(column));
    readers[name] = {
      path: new URL(url).pathname.replace(/^\/rest\/v1\//, ""),
      columns,
      private_columns_requested: privateColumns,
    };
    if (privateColumns.length) failures.push(`${name} requests private column(s): ${privateColumns.join(", ")}`);
  }
  return {
    ok: failures.length === 0,
    readers,
    failures,
  };
}

function summarizeRead(result, rowsKey) {
  const rows = result?.[rowsKey];
  const source = result?.source || "error";
  return {
    ok: source === "supabase" || source === "supabase-cohort",
    source,
    count: Array.isArray(rows) ? rows.length : 0,
    error: result?.error ? String(result.error) : null,
  };
}

async function readPublicTier(config, fetchImpl) {
  const result = await fetchPublicEvidenceCards({ config, fetchImpl });
  return summarizeRead(result, "cards");
}

async function readGatedTier(config, fetchImpl, auth) {
  const opts = { config, fetchImpl };
  if (auth !== undefined) opts.auth = auth;
  const [evidence, distillations, insights] = await Promise.all([
    fetchCohortEvidenceCards(opts),
    fetchCohortDistillations(opts),
    fetchCohortInsightCards(opts),
  ]);
  return {
    evidence: summarizeRead(evidence, "cards"),
    distillations: summarizeRead(distillations, "artifacts"),
    cohort_insights: summarizeRead(insights, "cards"),
  };
}

function summarizeAudit(result) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    status: result.status || "unknown",
    counts: result.counts || {},
    failures: [
      ...(result.schema?.failures || []),
      ...(result.privacy?.failures || []),
      ...(result.insight?.failures || []),
    ],
    warnings: [
      ...(result.schema?.warnings || []),
      ...(result.privacy?.warnings || []),
      ...(result.insight?.warnings || []),
    ],
  };
}

function readOptions(argv = process.argv.slice(2), env = process.env) {
  const envFile = arg(argv, "--env-file", env.SHAPE_ENV_FILE || null);
  const minDays = Number(arg(argv, "--min-days", env.SRFG_COHORT_KEY_MIN_DAYS || "30"));
  return {
    envFile,
    json: hasFlag(argv, "--json"),
    requireGated: hasFlag(argv, "--require-gated"),
    strictPublicNames: hasFlag(argv, "--strict-public-names") || hasFlag(argv, "--strict"),
    live: !hasFlag(argv, "--no-live"),
    audit: !hasFlag(argv, "--skip-audit"),
    minDays: Number.isFinite(minDays) ? minDays : 30,
    expectedRef: arg(argv, "--expected-ref", env.SUPABASE_PROJECT_REF || ""),
    packageKeyFile: arg(argv, "--package-key-file", DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH),
    limit: Number(arg(argv, "--limit", env.TRANSCRIPT_RECEIVE_ROUTE_LIMIT || "2000")) || 2000,
    help: hasFlag(argv, "--help") || hasFlag(argv, "-h"),
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/check-transcript-receive-route.mjs --env-file .env.calendar.local [--json]",
    "",
    "Read-only Shape OS receive-route verifier.",
    "Checks the public T3 reader, gated T2 readers via cohort key or Google sign-in app session, packaged cohort key status, and optional privacy audit when a service-role key is available.",
    "",
    "Options:",
    "  --require-gated       Fail if the cohort_app key is missing or gated views do not read.",
    "  --strict-public-names Fail audit on known cohort/entity names in public rows.",
    "  --skip-audit          Skip the service-role privacy audit even when a key is available.",
    "  --no-live             Check reader contracts and key packaging without touching Supabase.",
    "  --json                Print machine-readable JSON without secrets or row text.",
  ].join("\n");
}

export async function checkTranscriptReceiveRoute({
  argv = [],
  env = process.env,
  root = ROOT,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  auth = undefined,
} = {}) {
  const options = readOptions(argv, env);
  const fileEnv = readEnvFile(options.envFile, root);
  const mergedEnv = { ...env, ...fileEnv };
  const defaultConfig = readSupabaseConfig(null);
  const url = String(mergedEnv.SUPABASE_URL || mergedEnv.SHAPE_SUPABASE_URL || defaultConfig.url || "").replace(/\/+$/, "");
  const anonKey = String(mergedEnv.SUPABASE_ANON_KEY || mergedEnv.SHAPE_SUPABASE_ANON_KEY || defaultConfig.anonKey || "").trim();
  const expectedRef = options.expectedRef || projectRefFromSupabaseUrl(url);
  const packagedKey = readPackagedCohortKey(root, options.packageKeyFile);
  const envCohortKey = String(mergedEnv.SRFG_COHORT_KEY || mergedEnv.SHAPE_COHORT_APP_KEY || "").trim();
  const cohortKey = envCohortKey || packagedKey;
  const cohortKeySource = envCohortKey ? "env" : packagedKey ? "package" : "none";
  const envSessionToken = String(mergedEnv.SHAPE_SUPABASE_SESSION_TOKEN || mergedEnv.SUPABASE_ACCESS_TOKEN || "").trim();
  const envAuth = envSessionToken ? { getSession: async () => ({ access_token: envSessionToken }) } : null;
  const authBridge = auth !== undefined ? auth : envAuth;
  const googleSigninAppSessionSource = envSessionToken ? "env" : authBridge ? "auth_bridge" : "none";
  const serviceRoleKey = String(mergedEnv.SUPABASE_SERVICE_ROLE_KEY || mergedEnv.SHAPE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const config = { url, anonKey, cohortKey };
  const packageKey = inspectPackagedCohortKey({
    root,
    filePath: options.packageKeyFile,
    expectedRef,
    minDays: options.minDays,
    now,
  });
  const runtimeKey = inspectRuntimeCohortKey({
    key: cohortKey,
    source: cohortKeySource,
    expectedRef,
    minDays: options.minDays,
    now,
  });
  const googleSigninAppSession = inspectGoogleSigninAppSessionCredential({
    token: envSessionToken,
    source: googleSigninAppSessionSource,
    now,
  });
  const gatedCredentialAvailable = runtimeKey.ready || Boolean(authBridge);
  const gatedCredentialSource = runtimeKey.ready
    ? `cohort_key:${cohortKeySource}`
    : authBridge
      ? `google_signin_app_session:${googleSigninAppSessionSource}`
      : "none";
  const contract = inspectReaderContracts(config);
  const errors = [];
  const warnings = [];

  if (!url) errors.push("Supabase URL is missing");
  if (!anonKey) errors.push("Supabase anon key is missing; public app reads cannot reach the T3 view");
  if (!contract.ok) errors.push(...contract.failures);
  if (!gatedCredentialAvailable) warnings.push(...runtimeKey.errors);
  if (!packageKey.ready && !gatedCredentialAvailable) warnings.push(...packageKey.errors);
  if (googleSigninAppSession.warnings.length) warnings.push(...googleSigninAppSession.warnings);

  let publicT3 = { ok: false, source: "skipped", count: 0, error: null };
  let gatedT2 = {
    required: options.requireGated,
    status: gatedCredentialAvailable ? "not_checked" : "fallback",
    ready: false,
    credential_source: gatedCredentialSource,
    evidence: { ok: false, source: "skipped", count: 0, error: null },
    distillations: { ok: false, source: "skipped", count: 0, error: null },
    cohort_insights: { ok: false, source: "skipped", count: 0, error: null },
  };

  if (options.live && url && anonKey && typeof fetchImpl === "function") {
    publicT3 = await readPublicTier(config, fetchImpl);
    if (!publicT3.ok) errors.push(`public T3 reader failed: ${publicT3.error || publicT3.source}`);

    if (gatedCredentialAvailable) {
      const gatedReads = await readGatedTier(config, fetchImpl, authBridge);
      const gatedReady = gatedReads.evidence.ok && gatedReads.distillations.ok && gatedReads.cohort_insights.ok;
      gatedT2 = {
        required: options.requireGated,
        status: gatedReady ? "ready" : "fail",
        ready: gatedReady,
        credential_source: gatedCredentialSource,
        ...gatedReads,
      };
      if (!gatedReady) errors.push("one or more cohort_app gated readers failed");
    }
  } else if (options.live) {
    publicT3.error = "unconfigured";
    errors.push("public T3 reader was not checked");
  }

  if (options.requireGated && !gatedT2.ready) {
    errors.push("gated cohort_app receive route is required but not ready");
  }

  let audit = null;
  if (options.audit && options.live && serviceRoleKey && url && anonKey && typeof fetchImpl === "function") {
    audit = summarizeAudit(await runLiveEvidenceCardAudit({
      supabaseUrl: url,
      anonKey,
      serviceRoleKey,
      strictPublicNames: options.strictPublicNames,
      limit: options.limit,
      fetchImpl,
    }));
    if (audit && !audit.ok) errors.push("service-role evidence-card privacy audit failed");
    if (audit?.warnings?.length) warnings.push(...audit.warnings);
  }

  const publicReady = !options.live || publicT3.ok;
  const ok = errors.length === 0 && publicReady;
  const releaseReady = ok && gatedT2.ready && (runtimeKey.ready || Boolean(authBridge));
  const status = errors.length ? "fail" : releaseReady ? "pass" : warnings.length ? "warn" : "pass";

  return {
    ok,
    status,
    release_ready: releaseReady,
    generated_at: now.toISOString(),
    config: {
      project_ref: projectRefFromSupabaseUrl(url) || null,
      supabase_url_present: Boolean(url),
      anon_key_present: Boolean(anonKey),
      service_role_key_present: Boolean(serviceRoleKey),
      cohort_key_source: cohortKeySource,
      google_signin_app_session_source: googleSigninAppSessionSource,
      gated_credential_source: gatedCredentialSource,
      live: options.live,
      audit_requested: options.audit,
      audit_attempted: Boolean(audit),
    },
    package_key: packageKey,
    runtime_key: runtimeKey,
    google_signin_app_session: googleSigninAppSession,
    contract,
    public_t3: publicT3,
    gated_t2: gatedT2,
    app_receive: {
      public_can_receive_generalized_t3: publicReady,
      named_t2_can_receive: gatedT2.ready,
      transcript_tab_can_receive_distillations: gatedT2.distillations.ok,
      fallback_route: gatedT2.ready
        ? (runtimeKey.ready
            ? "T2 named evidence and distillations via cohort_app key plus public T3 evidence"
            : "T2 named evidence and distillations via Google sign-in app session plus public T3 evidence")
        : "public T3 generalized evidence only; named T2/distillations wait for a cohort_app key or Google sign-in app session",
    },
    audit,
    errors,
    warnings: [...new Set(warnings)],
  };
}

function printSummary(result) {
  console.log(`Transcript receive route: ${result.status}`);
  console.log(`project: ${result.config.project_ref || "(unknown)"}`);
  console.log(`public T3: ${result.public_t3.ok ? "ready" : "not ready"} (${result.public_t3.source}, ${result.public_t3.count} row(s))`);
  console.log(`gated T2: ${result.gated_t2.ready ? "ready" : result.gated_t2.status}`);
  console.log(`gated credential: ${result.config.gated_credential_source}`);
  console.log(`packaged cohort key: ${result.package_key.status}`);
  console.log(`runtime cohort key: ${result.runtime_key.status} (${result.runtime_key.source})`);
  console.log(`Google sign-in app session: ${result.google_signin_app_session.status} (${result.google_signin_app_session.source})`);
  if (result.audit) console.log(`privacy audit: ${result.audit.status}`);
  for (const warning of result.warnings || []) console.log(`WARN ${warning}`);
  for (const error of result.errors || []) console.log(`FAIL ${error}`);
  console.log(result.release_ready
    ? "PASS: Shape OS can receive public and gated transcript outputs."
    : result.ok
      ? "PASS: Shape OS can receive public T3 transcript evidence; gated T2/distillations are waiting for a cohort key or Google sign-in app session."
      : "FAIL: Shape OS transcript receive route is not ready.");
}

async function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(usage());
    return;
  }
  const result = await checkTranscriptReceiveRoute({ argv });
  if (result.config.live && result.config.audit_requested && !result.config.audit_attempted && !result.config.service_role_key_present) {
    result.warnings.push("service-role privacy audit skipped because no service-role key was provided");
  }
  if (result.config.live && result.config.audit_requested && result.config.service_role_key_present && !result.config.audit_attempted) {
    result.warnings.push("service-role privacy audit was not attempted");
  }
  if (result.status === "pass" && result.warnings.length) result.status = "warn";
  if (hasFlag(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
