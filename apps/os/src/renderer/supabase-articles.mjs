import { readSupabaseConfig } from "./supabase-evidence.mjs";

const APP_COHORT_ARTICLE_TABLE = "app_cohort_articles";
const PUBLIC_COHORT_ARTICLE_TABLE = "public_cohort_articles";

const APP_ARTICLE_COLUMNS = [
  "id",
  "org_id",
  "slug",
  "title",
  "dek",
  "body_markdown",
  "tags",
  "article_kind",
  "article_mode",
  "surface_tier",
  "source_boundary",
  "review_status",
  "approval_state",
  "source_refs",
  "metadata",
  "generated_by",
  "generated_at",
  "created_at",
  "updated_at",
  "reviewed_at",
].join(",");

const PUBLIC_ARTICLE_COLUMNS = [
  "id",
  "slug",
  "title",
  "dek",
  "body_markdown",
  "tags",
  "article_kind",
  "article_mode",
  "source_boundary",
  "generated_at",
  "created_at",
  "updated_at",
].join(",");

const TOKEN_KEYS = [
  "srwk:supabase_access_token",
  "srfg:supabase_access_token",
];

const PRIVATE_MARKERS = [
  /source_artifact_id/i,
  /processing_job_id/i,
  /derived_artifact_id/i,
  /storage_ref/i,
  /drive_file_id/i,
  /raw_transcripts/i,
  /do_not_publish/i,
  /private_1on1/i,
  /private-vault/i,
  /\.private/i,
  /[A-Za-z]:\\[^"\n]+/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
];

function clean(value) {
  return String(value ?? "").trim();
}

function readToken(storage, key) {
  try {
    return clean(storage?.getItem?.(key));
  } catch {
    return "";
  }
}

function readRuntimeConfig(windowRef = globalThis) {
  return windowRef?.SHAPE_ROTATOR_RUNTIME?.cohortArticles
    || windowRef?.SHAPE_ROTATOR_RUNTIME?.context
    || windowRef?.SHAPE_ROTATOR_COHORT_ARTICLES_CONFIG
    || windowRef?.SHAPE_ROTATOR_CONTEXT_CONFIG
    || null;
}

export function readSupabaseArticleConfig({
  storage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  windowRef = globalThis,
  config = null,
} = {}) {
  const base = config || readSupabaseConfig(storage);
  const runtime = readRuntimeConfig(windowRef) || {};
  const url = clean(runtime.supabaseUrl || runtime.supabase_url || base.url).replace(/\/+$/, "");
  const anonKey = clean(
    runtime.supabaseAnonKey
      || runtime.supabase_anon_key
      || runtime.anonKey
      || runtime.anon_key
      || base.anonKey
  );
  const accessToken = clean(
    runtime.accessToken
      || runtime.access_token
      || runtime.supabaseAccessToken
      || runtime.supabase_access_token
      || TOKEN_KEYS.map((key) => readToken(sessionStorage, key)).find(Boolean)
      || ""
  );
  return { url, anonKey, accessToken };
}

function articleUrl(baseUrl, table, select, limit) {
  const url = new URL(`${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  url.searchParams.set("order", "updated_at.desc");
  url.searchParams.set("limit", String(limit || 50));
  return url.toString();
}

export function appCohortArticlesUrl(baseUrl, limit) {
  return articleUrl(baseUrl, APP_COHORT_ARTICLE_TABLE, APP_ARTICLE_COLUMNS, limit);
}

export function publicCohortArticlesUrl(baseUrl, limit) {
  return articleUrl(baseUrl, PUBLIC_COHORT_ARTICLE_TABLE, PUBLIC_ARTICLE_COLUMNS, limit);
}

function containsPrivateMarker(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return PRIVATE_MARKERS.some((pattern) => pattern.test(text || ""));
}

function articleSection(kind) {
  return String(kind || "article")
    .replace(/^public_/, "")
    .replace(/_/g, " ")
    .trim() || "article";
}

function safeSourceRefs(value) {
  const refs = Array.isArray(value) ? value : [];
  return refs.map((ref) => {
    const out = {};
    for (const key of ["kind", "title", "article_title", "trend_id", "session_id", "session_kind", "date"]) {
      if (ref && Object.prototype.hasOwnProperty.call(ref, key) && !containsPrivateMarker(ref[key])) {
        out[key] = ref[key];
      }
    }
    return out;
  }).filter((ref) => Object.keys(ref).length);
}

export function normalizeCohortArticleRow(row, { source = "supabase-public" } = {}) {
  if (!row || typeof row !== "object") return null;
  const id = clean(row.id);
  const title = clean(row.title);
  const body = clean(row.body_markdown);
  if (!id || !title || !body) return null;
  if (containsPrivateMarker([title, row.dek, body, source === "supabase-public" ? null : row.metadata])) return null;
  const slug = clean(row.slug) || id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const generatedAt = row.generated_at || row.updated_at || row.created_at || null;
  return {
    id: `supabase-article:${id}`,
    entry_kind: "article",
    article_id: id,
    corpus_id: id,
    article_title: title,
    article_angle: clean(row.dek),
    article_dek: clean(row.dek),
    article_section: articleSection(row.article_kind),
    article_slug: slug,
    article_file: `${slug || "article"}.md`,
    article_body_md: body,
    article_full_md: body,
    content_version: clean(row.generated_by || row.article_mode || source),
    status: clean(row.review_status || (source === "supabase-public" || row.surface_tier === "public" ? "published" : "reviewed")),
    date: generatedAt,
    source_kind: source,
    source_boundary: clean(row.source_boundary || "public_bundle"),
    article_kind: clean(row.article_kind),
    article_mode: clean(row.article_mode),
    surface_tier: clean(row.surface_tier || (source === "supabase-public" ? "public" : "cohort")),
    approval_state: clean(row.approval_state || (source === "supabase-public" ? "approved" : "")),
    tags: Array.isArray(row.tags) ? row.tags.map(String).filter(Boolean) : [],
    ...(source === "supabase-public" ? {} : {
      source_refs: safeSourceRefs(row.source_refs),
      support_count: Array.isArray(row.source_refs) ? row.source_refs.length : 0,
      metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {},
    }),
  };
}

async function fetchRows(url, apiKey, authToken, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${authToken || apiKey}`,
      accept: "application/json",
    },
    cache: "no-store",
  });
  if (!response?.ok) return { ok: false, status: response?.status || 0, rows: [] };
  const rows = await response.json().catch(() => null);
  return { ok: Array.isArray(rows), status: response.status, rows: Array.isArray(rows) ? rows : [] };
}

export async function fetchCohortArticles({
  storage,
  sessionStorage,
  windowRef,
  fetchImpl = globalThis.fetch,
  config,
  limit = 50,
} = {}) {
  const cfg = readSupabaseArticleConfig({ storage, sessionStorage, windowRef, config });
  if (!cfg.url || !cfg.anonKey || typeof fetchImpl !== "function") {
    return { articles: [], source: "unconfigured" };
  }

  if (cfg.accessToken) {
    try {
      const app = await fetchRows(appCohortArticlesUrl(cfg.url, limit), cfg.anonKey, cfg.accessToken, fetchImpl);
      if (app.ok && app.rows.length) {
        return {
          articles: app.rows.map((row) => normalizeCohortArticleRow(row, { source: "supabase-app" })).filter(Boolean),
          source: "supabase-app",
        };
      }
    } catch {
      // Fall through to the public view.
    }
  }

  try {
    const pub = await fetchRows(publicCohortArticlesUrl(cfg.url, limit), cfg.anonKey, cfg.anonKey, fetchImpl);
    if (!pub.ok) return { articles: [], source: "error", error: `HTTP ${pub.status}` };
    return {
      articles: pub.rows.map((row) => normalizeCohortArticleRow(row, { source: "supabase-public" })).filter(Boolean),
      source: "supabase-public",
    };
  } catch (error) {
    return { articles: [], source: "error", error: String(error?.message || error) };
  }
}
