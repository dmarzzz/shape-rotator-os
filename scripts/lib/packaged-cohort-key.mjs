import fs from "node:fs";
import path from "node:path";
import { decodeJwtPayload } from "./cohort-key.mjs";

export const DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH = path.join(
  "apps",
  "os",
  "build-resources",
  "cohort-app-key.json",
);

const DAY_MS = 24 * 60 * 60 * 1000;

export function projectRefFromSupabaseUrl(url) {
  const match = String(url || "").match(/^https?:\/\/([a-z0-9]+)\.supabase\.(?:co|in)/i);
  return match ? match[1] : "";
}

export function hasJwtShape(value) {
  const parts = String(value || "").trim().split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

function toIsoDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function finish(result) {
  if (result.errors.length === 0 && result.key_present && result.jwt_shape) {
    result.status = "ready";
    result.ready = true;
    result.ok = true;
  } else if (!result.exists) {
    result.status = "missing";
  } else if (!result.key_present) {
    result.status = "empty";
  } else {
    result.status = "invalid";
  }
  return result;
}

export function inspectPackagedCohortKey({
  root = process.cwd(),
  filePath = DEFAULT_PACKAGED_COHORT_KEY_RELATIVE_PATH,
  expectedRef = "",
  minDays = 30,
  now = new Date(),
} = {}) {
  const target = path.resolve(root, filePath);
  const relativePath = path.relative(root, target) || target;
  const result = {
    ok: false,
    ready: false,
    status: "invalid",
    path: relativePath.split(path.sep).join("/"),
    exists: false,
    bytes: 0,
    key_present: false,
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

  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
    result.exists = true;
    result.bytes = Buffer.byteLength(raw);
  } catch (error) {
    result.errors.push(
      error?.code === "ENOENT"
        ? `missing packaged cohort key file: ${result.path}`
        : `cannot read packaged cohort key file: ${error?.message || error}`,
    );
    return finish(result);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    result.errors.push(`packaged cohort key JSON is malformed: ${error?.message || error}`);
    return finish(result);
  }

  const cohortKey = typeof parsed?.cohortKey === "string" ? parsed.cohortKey.trim() : "";
  result.key_present = cohortKey.length > 0;
  if (!result.key_present) {
    result.errors.push("cohortKey is empty; this packaged build will fall back to public T3 reads");
    return finish(result);
  }

  result.jwt_shape = hasJwtShape(cohortKey);
  if (!result.jwt_shape) {
    result.errors.push("cohortKey is not a JWT-shaped value");
    return finish(result);
  }

  const payload = decodeJwtPayload(cohortKey);
  if (!payload) {
    result.errors.push("cohortKey payload cannot be decoded");
    return finish(result);
  }

  result.role = typeof payload.role === "string" ? payload.role : null;
  result.iss = typeof payload.iss === "string" ? payload.iss : null;
  result.ref = typeof payload.ref === "string" ? payload.ref : null;
  result.issued_at = toIsoDate(Number(payload.iat));
  result.expires_at = toIsoDate(Number(payload.exp));

  if (result.role !== "cohort_app") {
    result.errors.push(`expected role=cohort_app, got ${result.role || "(missing)"}`);
  }
  if (result.iss !== "supabase") {
    result.errors.push(`expected iss=supabase, got ${result.iss || "(missing)"}`);
  }

  const expSeconds = Number(payload.exp);
  if (!Number.isFinite(expSeconds)) {
    result.errors.push("cohortKey is missing a numeric exp claim");
  } else {
    result.days_until_expiry = Math.floor((expSeconds * 1000 - now.getTime()) / DAY_MS);
    if (result.days_until_expiry < 0) {
      result.errors.push(`cohortKey expired ${Math.abs(result.days_until_expiry)} day(s) ago`);
    } else if (Number.isFinite(minDays) && result.days_until_expiry < minDays) {
      result.errors.push(`cohortKey expires in ${result.days_until_expiry} day(s), below minDays=${minDays}`);
    }
  }

  if (expectedRef && result.ref !== expectedRef) {
    result.errors.push(`expected ref=${expectedRef}, got ${result.ref || "(missing)"}`);
  } else if (!expectedRef && !result.ref) {
    result.warnings.push("cohortKey has no ref claim; pass --expected-ref or SUPABASE_URL to check project binding");
  }

  return finish(result);
}

export function formatPackagedCohortKeyInspection(result) {
  const lines = [
    `packaged cohort key: ${String(result.status || "invalid").toUpperCase()}`,
    `file: ${result.path}`,
    `exists: ${result.exists ? "yes" : "no"}${result.exists ? ` (${result.bytes} bytes)` : ""}`,
    `key present: ${result.key_present ? "yes" : "no"}`,
    `jwt shaped: ${result.jwt_shape ? "yes" : "no"}`,
  ];
  if (result.role) lines.push(`role: ${result.role}`);
  if (result.iss) lines.push(`iss: ${result.iss}`);
  if (result.ref) lines.push(`ref: ${result.ref}`);
  if (result.expires_at) {
    lines.push(`expires: ${result.expires_at} (${result.days_until_expiry} day(s) remaining)`);
  }
  for (const warning of result.warnings || []) lines.push(`warning: ${warning}`);
  for (const error of result.errors || []) lines.push(`error: ${error}`);
  lines.push(result.ready ? "PASS: packaged T2 cohort key is ready." : "FAIL: packaged T2 cohort key is not ready.");
  return `${lines.join("\n")}\n`;
}
