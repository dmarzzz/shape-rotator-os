// supabase-connections.mjs — the READ side of the cohort connection graph.
//
// Reads the precomputed "who should talk to whom" edges LIVE from Supabase (the
// public_cohort_connections row published by the daily connection routine), so a
// refreshed graph reaches the app without waiting on a git PR merging into
// protected main. Mirrors supabase-releases.mjs: an anon SELECT of a curated
// PUBLIC projection (never a gated base table), with the committed
// cohort-surface.json (`cohort_connections`) as the offline / first-paint
// fallback.
//
// The payload holds { schema_version, generated_at, generator, edges:[...] }.
// Each edge is a directional suggestion "from should talk to `to`", carrying a
// score, a kind, and a human reason. An anon read here exposes nothing the
// public cohort markdown didn't already show. RLS grants anon only SELECT on
// this one row.

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// PostgREST URL for the single connections row.
export function publicConnectionsUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/public_cohort_connections`);
  url.searchParams.set("select", "payload,source,updated_at");
  url.searchParams.set("id", "eq.current");
  url.searchParams.set("limit", "1");
  return url.toString();
}

// Only pass through well-formed edges so a malformed row can't poison the
// renderer. Each edge needs a from + to + a numeric score; reason/kind/basis are
// optional but carried through when present. Scores are clamped to [0,1].
export function sanitizeEdges(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const e of value) {
    if (!e || typeof e !== "object") continue;
    const from = typeof e.from === "string" ? e.from.trim() : "";
    const to = typeof e.to === "string" ? e.to.trim() : "";
    if (!from || !to || from === to) continue;
    let score = Number(e.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(0, Math.min(1, score));
    out.push({
      from,
      to,
      score,
      kind: typeof e.kind === "string" ? e.kind : "",
      reason: typeof e.reason === "string" ? e.reason : "",
      basis: typeof e.basis === "string" ? e.basis : "",
      ...(Array.isArray(e.evidence) ? { evidence: e.evidence.filter((x) => typeof x === "string").slice(0, 8) } : {}),
    });
  }
  return out;
}

// Validate the row's payload is the shape the renderer expects ({ edges:[...] }).
// Returns null when there are no usable edges so callers fall back to the
// committed bundle.
export function normalizeConnectionsPayload(row) {
  if (!row || typeof row !== "object") return null;
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return null;
  const edges = sanitizeEdges(payload.edges);
  if (!edges.length) return null;
  return {
    edges,
    generatedAt: typeof payload.generated_at === "string" ? payload.generated_at : "",
    generator: typeof payload.generator === "string" ? payload.generator : "",
  };
}

// Fetch the live connection graph. Always resolves (never throws) so a Supabase
// outage degrades to the committed bundle. Returns { edges, generatedAt,
// generator, source }: source is "supabase" on success, "unconfigured" with no
// anon key, "empty" when the row is missing/malformed, or "error".
export async function fetchConnections({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { edges: [], generatedAt: "", generator: "", source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(publicConnectionsUrl(url), {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { edges: [], generatedAt: "", generator: "", source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { edges: [], generatedAt: "", generator: "", source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { edges: [], generatedAt: "", generator: "", source: "error", error: "invalid JSON from Supabase" };
  }
  const payload = normalizeConnectionsPayload(Array.isArray(rows) ? rows[0] : rows);
  if (!payload) return { edges: [], generatedAt: "", generator: "", source: "empty" };
  return { ...payload, source: "supabase" };
}

// Pure: fold a flat edge list into a per-record adjacency the renderer can hang
// on each team/person as `record.connections`. Groups by `from`, resolves the
// counterpart's display name from `nameById`, sorts by score desc, caps per
// record. Exposed (and unit-tested) so the overlay and any caller agree.
export function connectionsByRecord(edges, nameById, { perRecord = 8 } = {}) {
  const names = nameById instanceof Map ? nameById : new Map(Object.entries(nameById || {}));
  const byRecord = new Map();
  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || !e.from || !e.to) continue;
    if (!byRecord.has(e.from)) byRecord.set(e.from, []);
    byRecord.get(e.from).push({
      to: e.to,
      toName: names.get(e.to) || e.to,
      score: e.score,
      kind: e.kind || "",
      reason: e.reason || "",
      basis: e.basis || "",
    });
  }
  for (const [, list] of byRecord) {
    list.sort((a, b) => b.score - a.score || String(a.to).localeCompare(String(b.to)));
    if (list.length > perRecord) list.length = perRecord;
  }
  return byRecord;
}
