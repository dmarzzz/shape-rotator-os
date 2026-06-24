// publish-connections-to-supabase.mjs
//
// Publishes the precomputed cohort connection graph to the
// public_cohort_connections row in Supabase, so the OS + web apps read it LIVE
// (anon) instead of waiting on a git PR merging into protected main. Runs with
// the service-role key (server-side only — never shipped to a client). Mirrors
// publish-releases-to-supabase.mjs; the read side is
// apps/os/src/renderer/supabase-connections.mjs.
//
// Input is the artifact written by scripts/build-cohort-connections.mjs (the
// daily routine) — this step does NO LLM work, it only ships the precomputed
// edges. Safe to run from CI on a committed artifact (no AI key needed) OR
// locally right after the build (build --publish calls in here directly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = path.join(ROOT, "cohort-data", "artifacts", "connections", "generated", "connections.json");
const ROW_ID = "current";

function readArtifact(file = ARTIFACT) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

// Pure + deterministic (pass `now`) so it is unit-testable without a live
// Supabase. Builds the PostgREST upsert request for the single connections row.
export function buildUpsertRequest({ url, payload, rowId = ROW_ID, source = "cohort-connections-routine", now }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) throw new Error("SUPABASE_URL is required");
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.edges)) {
    throw new Error("payload must be an object with edges[]");
  }
  return {
    url: `${base}/rest/v1/public_cohort_connections?on_conflict=id`,
    body: {
      id: rowId,
      payload,
      source,
      updated_at: now || new Date().toISOString(),
    },
  };
}

// Upsert the connection graph. Resolves { skipped:true } when Supabase env is
// absent (local dev / unconfigured) so a routine never hard-fails on publish;
// throws only on a real HTTP error so CI surfaces a misconfiguration.
export async function publishConnections({
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY,
  payload = null,
  artifactPath = ARTIFACT,
  fetchImpl = globalThis.fetch,
  now,
} = {}) {
  if (!url || !key) {
    return { skipped: true, reason: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  const body = payload || readArtifact(artifactPath);
  if (!body || !Array.isArray(body.edges)) {
    return { skipped: true, reason: `no connections artifact at ${path.relative(ROOT, artifactPath)} (run build-cohort-connections.mjs first)` };
  }
  const { url: reqUrl, body: reqBody } = buildUpsertRequest({ url, payload: body, now });
  const res = await fetchImpl(reqUrl, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`.trim());
  }
  return { skipped: false, status: res.status, edges: body.edges.length };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  publishConnections()
    .then((r) => {
      console.log(
        r.skipped
          ? `[publish-connections] skipped — ${r.reason}`
          : `[publish-connections] published ${r.edges} edges to public_cohort_connections (HTTP ${r.status})`,
      );
    })
    .catch((e) => { console.error(`[publish-connections] ${e.message}`); process.exit(1); });
}
