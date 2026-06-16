import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  appCohortArticlesUrl,
  fetchCohortArticles,
  normalizeCohortArticleRow,
  publicCohortArticlesUrl,
  readSupabaseArticleConfig,
} from "../apps/os/src/renderer/supabase-articles.mjs";

const DEFAULT_URL = "https://txjntzwksiluvqcpccpc.supabase.co";

function fakeStorage(obj = {}) {
  return { getItem: (key) => (key in obj ? obj[key] : null) };
}

function okResponse(rows) {
  return { ok: true, status: 200, json: async () => rows };
}

test("cohort article URLs target app and public article views", () => {
  const appUrl = new URL(appCohortArticlesUrl(DEFAULT_URL, 25));
  const publicUrl = new URL(publicCohortArticlesUrl(DEFAULT_URL, 25));

  assert.match(appUrl.pathname, /\/rest\/v1\/app_cohort_articles$/);
  assert.match(publicUrl.pathname, /\/rest\/v1\/public_cohort_articles$/);
  assert.equal(appUrl.searchParams.get("order"), "updated_at.desc");
  assert.equal(publicUrl.searchParams.get("limit"), "25");

  const publicCols = (publicUrl.searchParams.get("select") || "").split(",");
  for (const gated of ["org_id", "source_refs", "metadata", "reviewed_by"]) {
    assert.ok(!publicCols.includes(gated), `public select must not include ${gated}`);
  }
});

test("migrations create the cohort article relations queried by the renderer", () => {
  const migration = fs.readFileSync("supabase/migrations/20260616150000_cohort_articles.sql", "utf8");

  assert.match(migration, /create table if not exists public\.cohort_articles/i);
  assert.match(migration, /create view public\.app_cohort_articles/i);
  assert.match(migration, /create view public\.public_cohort_articles/i);
  assert.match(migration, /grant select on public\.public_cohort_articles to anon, authenticated, service_role/i);
});

test("readSupabaseArticleConfig reads member token from session storage", () => {
  const cfg = readSupabaseArticleConfig({
    config: { url: "https://project.supabase.co", anonKey: "anon" },
    sessionStorage: fakeStorage({ "srwk:supabase_access_token": "member-token" }),
  });

  assert.equal(cfg.url, "https://project.supabase.co");
  assert.equal(cfg.anonKey, "anon");
  assert.equal(cfg.accessToken, "member-token");
});

test("normalizeCohortArticleRow maps Supabase rows into context article sources", () => {
  const row = {
    id: "public-session:demo",
    slug: "demo",
    title: "Demo Article",
    dek: "A short deck.",
    body_markdown: "# Demo Article\n\nBody.\n\n## Takeaway\n\nDone.",
    tags: ["public-session"],
    article_kind: "public_session",
    article_mode: "generalized_no_named_insights",
    source_boundary: "public_bundle",
    generated_at: "2026-06-16T00:00:00Z",
  };

  const article = normalizeCohortArticleRow(row, { source: "supabase-public" });

  assert.equal(article.id, "supabase-article:public-session:demo");
  assert.equal(article.entry_kind, "article");
  assert.equal(article.article_title, "Demo Article");
  assert.equal(article.article_slug, "demo");
  assert.equal(article.article_body_md, row.body_markdown);
  assert.equal(article.article_section, "session");
  assert.equal(article.status, "published");
  assert.equal(article.source_kind, "supabase-public");
  assert.equal(Object.prototype.hasOwnProperty.call(article, "metadata"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(article, "source_refs"), false);
});

test("normalizeCohortArticleRow rejects rows with private-looking markers", () => {
  const row = {
    id: "bad",
    slug: "bad",
    title: "Bad",
    body_markdown: "# Bad\n\nsource_artifact_id: abc\n\n## Takeaway\n\nNo.",
  };

  assert.equal(normalizeCohortArticleRow(row), null);
});

test("fetchCohortArticles uses app view when a member token returns rows", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return okResponse([{
      id: "a1",
      slug: "a1",
      title: "App Article",
      dek: "Member row.",
      body_markdown: "# App Article\n\nBody.\n\n## Takeaway\n\nDone.",
      article_kind: "public_session",
      review_status: "needs_review",
      surface_tier: "cohort",
    }]);
  };

  const out = await fetchCohortArticles({
    config: { url: DEFAULT_URL, anonKey: "anon" },
    sessionStorage: fakeStorage({ "srwk:supabase_access_token": "member-token" }),
    fetchImpl,
  });

  assert.equal(out.source, "supabase-app");
  assert.equal(out.articles.length, 1);
  assert.match(calls[0].url, /app_cohort_articles/);
  assert.equal(calls[0].options.headers.apikey, "anon");
  assert.equal(calls[0].options.headers.authorization, "Bearer member-token");
});

test("fetchCohortArticles falls back to public view without a token", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return okResponse([{
      id: "p1",
      slug: "p1",
      title: "Public Article",
      dek: "Public row.",
      body_markdown: "# Public Article\n\nBody.\n\n## Takeaway\n\nDone.",
      article_kind: "public_session",
    }]);
  };

  const out = await fetchCohortArticles({
    config: { url: DEFAULT_URL, anonKey: "anon" },
    sessionStorage: fakeStorage(),
    fetchImpl,
  });

  assert.equal(out.source, "supabase-public");
  assert.equal(out.articles.length, 1);
  assert.match(calls[0].url, /public_cohort_articles/);
  assert.equal(calls[0].options.headers.apikey, "anon");
  assert.equal(calls[0].options.headers.authorization, "Bearer anon");
});
