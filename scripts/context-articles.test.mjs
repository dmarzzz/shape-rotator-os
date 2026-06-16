import test from "node:test";
import assert from "node:assert/strict";

import {
  contextArticleSourceById,
  mergeContextArticleSources,
} from "../apps/os/src/renderer/context-articles.mjs";

test("mergeContextArticleSources appends live Supabase articles to local sources", () => {
  const local = [{
    id: "article:memory",
    article_title: "Why LLM agents need memory",
    article_slug: "why-llm-agents-need-memory",
  }];
  const live = [{
    id: "supabase-article:public-session:trust",
    article_title: "Trust Is the Product Surface",
    article_slug: "trust-is-the-product-surface",
  }];

  const merged = mergeContextArticleSources(local, live);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "article:memory");
  assert.equal(merged[1].id, "supabase-article:public-session:trust");
});

test("mergeContextArticleSources keeps local articles when live rows duplicate a slug", () => {
  const local = [{
    id: "article:trust",
    article_title: "Trust Is the Product Surface",
    article_slug: "trust-is-the-product-surface",
    source_kind: "cohort-article",
  }];
  const live = [{
    id: "supabase-article:public-session:trust",
    article_title: "Trust Is the Product Surface",
    article_slug: "trust-is-the-product-surface",
    source_kind: "supabase-public",
  }];

  const merged = mergeContextArticleSources(local, live);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source_kind, "cohort-article");
});

test("contextArticleSourceById searches the merged local plus live article list", () => {
  const found = contextArticleSourceById([], [{
    id: "supabase-article:public-session:trust",
    article_title: "Trust Is the Product Surface",
    article_slug: "trust-is-the-product-surface",
  }], "supabase-article:public-session:trust");

  assert.equal(found.article_title, "Trust Is the Product Surface");
});
