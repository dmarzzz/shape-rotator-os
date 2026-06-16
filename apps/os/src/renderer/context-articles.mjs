function clean(value) {
  return String(value ?? "").trim();
}

function slugify(value, fallback = "article") {
  const slug = clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function articleKey(source = {}) {
  const slug = clean(source.article_slug);
  if (slug) return `slug:${slug.toLowerCase()}`;
  const title = clean(source.article_title || source.title);
  if (title) return `title:${slugify(title)}`;
  return clean(source.id || source.article_id || source.corpus_id).toLowerCase();
}

export function mergeContextArticleSources(localSources = [], liveArticles = []) {
  const merged = [];
  const seen = new Set();
  for (const source of [...(Array.isArray(localSources) ? localSources : [])]) {
    if (!source) continue;
    const key = articleKey(source);
    if (key) seen.add(key);
    merged.push(source);
  }
  for (const article of (Array.isArray(liveArticles) ? liveArticles : [])) {
    if (!article) continue;
    const key = articleKey(article);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(article);
  }
  return merged;
}

export function contextArticleSourceById(localSources = [], liveArticles = [], id = "") {
  const target = clean(id);
  if (!target) return null;
  return mergeContextArticleSources(localSources, liveArticles)
    .find((source) => source?.id === target) || null;
}
