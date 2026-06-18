// supabase-sphere.mjs — READ + WRITE for per-person sphere customization.
//
// Each person's sphere medallion (the shape-canvas.js "kind 2" sphere) is
// normally drawn from hashColors(record_id) — fully deterministic. This module
// lets a person override five visual dials and persist them so EVERY viewer's
// app reflects the change within seconds.
//
//   READ  — fetchAllSpheres(): GET the whole os_spheres table (it's small,
//           one row per customized person). Folded onto the cohort surface as
//           `person_spheres` by cohort-source.js's applySphereOverlay.
//   WRITE — saveSphere(): upsert one row via PostgREST merge-duplicates. Used
//           by the profile-page "your sphere" editor.
//
// Reuses the same anon key + config resolver as the other Supabase modules; the
// security boundary is the os_spheres RLS/grants (see the migration), not key
// secrecy. SECURITY NOTE: with no member auth, the anon key can technically
// write any record_id — the editor only ever saves the user's own claimed id.
// See supabase/migrations/20260618010000_os_spheres.sql.

import { readSupabaseConfig } from "./supabase-evidence.mjs";

const SPHERE_TABLE = "os_spheres";

// The customizable dials, in display order. Single source of truth shared by the
// editor UI, the shader override path, and the tests.
//   key   — the os_spheres column + the param key the editor reads/writes.
//   label — the sci-fi/esoteric slider name shown to the user.
//   hint  — a tiny sub-label describing what it does.
// Shader mapping: hue → u_hue (palette), complexity → u_progress (fold density),
// phase → u_warp ("Vortex" radial twist), hue2 → u_iters ("Strata" layer count),
// intensity → u_sharp ("Filament" line sharpness). NOTE the last two REUSE the
// hue2/intensity columns (no migration). u_phase + u_hue2 stay hash-derived per
// person and the rim glow (u_intensity) is fixed at render time. Labels are
// one-word sci-fi; keys stay the column names.
// `color` tints each slider's line + dot; `wave` (Tempest only — a storm should
// wiggle) draws a sine-wave track the dot rides along as you drag — purely
// cosmetic, the 0..1 value is unchanged. Display-only metadata (like label/hint);
// the dial KEYS still map to their columns, so array ORDER is just display order.
export const SPHERE_DIALS = [
  { key: "hue",        label: "Iris",      hint: "colour spectrum", color: "#43c0b4" },              // rainbow goddess — teal
  { key: "complexity", label: "Mandala",   hint: "fold density",    color: "#d6a23c" },              // sacred geometry — amber
  { key: "hue2",       label: "Aether",    hint: "fractal layers",  color: "#9b6fd4" },              // the celestial planes — purple
  { key: "intensity",  label: "Glyph",     hint: "line sharpness",  color: "#d2596e" },              // arcane etched lines — rose
  { key: "phase",      label: "Tempest",   hint: "radial twist",    color: "#5e8ad6", wave: true },  // the churning storm — blue, sine track (bottom)
];

// Every float column stored in os_spheres (all NOT NULL). All five are dials now.
export const SPHERE_KEYS = ["hue", "hue2", "phase", "intensity", "complexity"];

// Fixed rim/spec glow ("Luminous Flux" dial removed) — hardcoded at render time;
// the intensity COLUMN is repurposed to store the Filament dial, not this.
export const SPHERE_INTENSITY = 0.3;

// Per-dial fallbacks used when a save omits a value. hue2 (Strata) 0.3 → 3 layers;
// intensity (Filament) 0.3333 → the original 1.2 sharpness exponent.
export const SPHERE_DEFAULTS = { hue2: 0.3, intensity: 0.3333, complexity: 0.25 };

// Optional ORB BODY colour (added in migration 2; column is still named `bg`).
// A #rrggbb hex string driving the shader's base colour; absent/NULL keeps the
// original charcoal orb. (It is NOT a background — the area outside the orb is
// always transparent.) The editor's picker defaults to this warm charcoal — the
// same value as the shader's K_CANVAS — so the orb is unchanged until edited.
export const SPHERE_BG_DEFAULT = "#231f20";

// Orb Core "amount" — how strongly the bg colour tints the whole orb (the shader's
// mix weight, 0..1). 0.45 is the baked-in default the shader uses when unset. Stored
// in the bg_mix column (migration 4). Keep in sync with shape-canvas.js's fallback.
export const SPHERE_BG_MIX_DEFAULT = 0.45;

// Curated Orb Core palette — 10 deep/muted tones (no neon brights), shown on one
// row; users pick one or type a hex. The full-spectrum native picker is NOT
// exposed. First entry is the charcoal default (== K_CANVAS).
export const SPHERE_BG_PRESETS = [
  "#231f20", "#0b0f1a", "#10243f", "#1f3a5f", "#0e3b3b",
  "#13361f", "#2a1a47", "#451a32", "#5a1e1e", "#5b5b66",
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Validate + normalise a hex colour to lowercase #rrggbb, or null if unusable.
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return HEX_RE.test(s) ? s : null;
}

// `*` (not an explicit column list) so the read keeps working even if migration 2
// (the bg column) hasn't been hand-applied yet — PostgREST returns whatever
// columns exist; naming a missing `bg` would 400 the whole request.
const SELECT_COLUMNS = "*";

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function spheresUrl(baseUrl) {
  const url = new URL(`${baseUrl}/rest/v1/${SPHERE_TABLE}`);
  url.searchParams.set("select", SELECT_COLUMNS);
  return url.toString();
}

// Coerce a raw row into a clean { hue, hue2, phase, intensity, complexity }
// object with every dial present and in range, or null if any dial is unusable.
function normalizeSphere(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const key of SPHERE_KEYS) {
    const v = clamp01(row[key]);
    if (v == null) return null;
    out[key] = v;
  }
  // bg is optional — attach only when valid; never let it drop the row.
  const bg = normalizeHex(row.bg);
  if (bg) out.bg = bg;
  // bg_mix (Orb Core amount) — optional 0..1; attach only when present (migration 4).
  const bgMix = clamp01(row.bg_mix);
  if (bgMix != null) out.bg_mix = bgMix;
  // shader_src is optional, UNTRUSTED text — carried as-is here and validated at
  // render time (shader-dsl.compileUserExpr). The DB CHECK bounds its length.
  if (typeof row.shader_src === "string" && row.shader_src.trim()) {
    out.shader_src = row.shader_src.slice(0, 8000);
  }
  return out;
}

// Fetch every customized sphere as a { record_id: {dials} } map. Always
// resolves (never throws): a Supabase outage / missing table degrades to an
// empty map, so spheres just fall back to their hash-derived defaults. Returns
// { spheres, source }: source is "supabase" on success, "unconfigured" when no
// anon key is set, or "error" with an `error` string.
export async function fetchAllSpheres({ storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { spheres: {}, source: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(spheresUrl(url), {
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { spheres: {}, source: "error", error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { spheres: {}, source: "error", error: `HTTP ${res ? res.status : "no response"}` };
  }
  let rows;
  try {
    rows = await res.json();
  } catch {
    return { spheres: {}, source: "error", error: "invalid JSON from Supabase" };
  }
  const spheres = {};
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const id = row && row.record_id != null ? String(row.record_id) : "";
      const dials = normalizeSphere(row);
      if (id && dials) spheres[id] = dials;
    }
  }
  return { spheres, source: "supabase" };
}

// Upsert one person's sphere. `record_id` is the person slug; `values` is any
// subset of the five dials (missing dials fall back to SPHERE_DEFAULTS / 0.5).
// Always resolves: { ok: true } on success, { ok: false, error } otherwise so
// the editor can show a quiet failure and let the user retry. Uses PostgREST
// merge-duplicates so the same record_id overwrites in place (insert-or-update).
export async function saveSphere(recordId, values = {}, { storage, fetchImpl, config } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id || id.length > 128) {
    return { ok: false, error: "bad_record_id" };
  }
  const body = { record_id: id };
  for (const key of SPHERE_KEYS) {
    const fallback = SPHERE_DEFAULTS[key] != null ? SPHERE_DEFAULTS[key] : 0.5;
    const v = clamp01(values[key]);
    body[key] = v == null ? fallback : v;
  }
  // bg only when a valid hex is supplied; omitted → PostgREST upsert preserves
  // the existing bg (insert defaults it to NULL/transparent). Until migration 2
  // is applied the column is absent and including bg would fail the write.
  const bg = normalizeHex(values.bg);
  if (bg) body.bg = bg;
  // bg_mix (Orb Core amount, migration 4): include a finite 0..1 when supplied
  // (0 is valid → no tint). Omitted → upsert preserves the existing value.
  const bgMix = clamp01(values.bg_mix);
  if (bgMix != null) body.bg_mix = bgMix;
  // shader_src: when the editor passes the key, a non-empty string SETS it and an
  // explicit null/empty CLEARS it; when the key is absent we omit it (upsert
  // preserves the existing value). Stored as-is (UNTRUSTED, validated at render)
  // + length-capped as defense-in-depth.
  if ("shader_src" in values) {
    const s = values.shader_src;
    body.shader_src = (typeof s === "string" && s.trim()) ? s.slice(0, 8000) : null;
  }
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { ok: false, error: "unconfigured" };
  }
  const headers = {
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`,
    "content-type": "application/json",
    // merge-duplicates → upsert on the record_id primary key; return=minimal
    // keeps the response body empty (no SELECT needed to satisfy the write).
    prefer: "resolution=merge-duplicates,return=minimal",
  };
  const post = async (payload) => {
    try {
      const r = await doFetch(`${url}/rest/v1/${SPHERE_TABLE}`, {
        method: "POST", headers, body: JSON.stringify(payload), cache: "no-store",
      });
      return (r && r.ok) ? { ok: true } : { ok: false, error: `HTTP ${r ? r.status : "no response"}` };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  };
  let res = await post(body);
  // On failure, progressively drop optional columns that later migrations add, so
  // saves still work before a migration is hand-applied (newest column first):
  // bg_mix (migration 4), shader_src (migration 3), then bg (migration 2), leaving
  // the core 5 dials.
  for (const key of ["bg_mix", "shader_src", "bg"]) {
    if (res.ok) break;
    if (!(key in body)) continue;
    delete body[key];
    res = await post(body);
  }
  return res;
}
