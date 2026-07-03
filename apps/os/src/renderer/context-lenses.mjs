// Pure helpers for the context page's two lenses (stream · library). The
// renderer owns state, DOM, and IPC; this module only derives orderings,
// groupings, and the topic index from records the surface already carries:
//   articles   — merged vault/live article sources (context-articles.mjs)
//   distilled  — cohort distilled readouts (supabase-distillations.mjs)
//   rawScripts — optional device-local raw files (context vault manifest)
//   cards      — transcript evidence cards (supabase-evidence.mjs)

function clean(value) {
  return String(value ?? "").trim();
}

// One topic vocabulary across three sources: readout themes, article
// skill_areas/tags, and evidence topic_labels. Normalizing here is what keeps
// the library from fragmenting into near-duplicate topics ("Agent_Infra" /
// "agent-infra" / "agent infra" are one topic).
export function normalizeTopicLabel(raw) {
  return clean(raw)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Topic labels can hold spaces, but the sidebar filter tokenizes data-cv-tags
// on whitespace — slugs keep multi-word topics matchable as one token.
export function topicSlug(label) {
  return normalizeTopicLabel(label).replace(/\s+/g, "-");
}

export function streamKey(kind, id) {
  return `${kind}:${id}`;
}

export function parseStreamKey(key) {
  const s = String(key || "");
  const i = s.indexOf(":");
  if (i < 1) return { kind: "", id: "" };
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function articleDateMs(record) {
  return parseDateMs(record?.date || record?.generated_at || record?.created_at || record?.updated_at);
}

function distilledDateMs(record) {
  return parseDateMs(record?.date || record?.created_at || record?.week_start);
}

function rawDateMs(record) {
  return parseDateMs(record?.date || record?.modified_at || record?.created_at);
}

// Merge the three stream species into one newest-first list. Undated items
// sink to the end in their original order (stable sort), so device files
// without a parseable date don't shuffle between renders.
export function buildStreamItems({ articles = [], distilled = [], rawScripts = [] } = {}) {
  const items = [];
  for (const record of Array.isArray(distilled) ? distilled : []) {
    if (!record || record.id == null) continue;
    items.push({ kind: "readout", id: String(record.id), dateMs: distilledDateMs(record), record });
  }
  for (const record of Array.isArray(articles) ? articles : []) {
    if (!record || record.id == null) continue;
    items.push({ kind: "article", id: String(record.id), dateMs: articleDateMs(record), record });
  }
  for (const record of Array.isArray(rawScripts) ? rawScripts : []) {
    if (!record || record.id == null) continue;
    items.push({ kind: "raw", id: String(record.id), dateMs: rawDateMs(record), record });
  }
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ((b.item.dateMs ?? -Infinity) - (a.item.dateMs ?? -Infinity)) || (a.i - b.i))
    .map(({ item }) => item);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function startOfWeekMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday-start week
  return d.getTime();
}

// Date-bucket an already-sorted stream: this week / last week / month pages /
// undated. Buckets appear in the order the sorted items produce them, so the
// scroll stays strictly newest-first.
export function groupStreamItems(items = [], now = new Date()) {
  const thisWeek = startOfWeekMs(now);
  const lastWeek = thisWeek - WEEK_MS;
  const groups = [];
  const byLabel = new Map();
  const push = (label, item) => {
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (item.dateMs == null) { push("undated", item); continue; }
    if (item.dateMs >= thisWeek && item.dateMs < thisWeek + WEEK_MS) { push("this week", item); continue; }
    if (item.dateMs >= lastWeek && item.dateMs < thisWeek) { push("last week", item); continue; }
    const d = new Date(item.dateMs);
    push(`${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`, item);
  }
  return groups;
}

export function articleTopics(record) {
  const out = new Set();
  const from = [
    ...(Array.isArray(record?.skill_areas) ? record.skill_areas : []),
    ...(Array.isArray(record?.tags) ? record.tags : []),
  ];
  for (const raw of from) {
    const label = normalizeTopicLabel(raw);
    if (label) out.add(label);
  }
  return [...out];
}

export function distilledTopics(record) {
  const out = new Set();
  for (const raw of Array.isArray(record?.themes) ? record.themes : []) {
    const label = normalizeTopicLabel(raw);
    if (label) out.add(label);
  }
  return [...out];
}

export function cardTopic(card) {
  return normalizeTopicLabel(card?.content_json?.topic_label);
}

// The library's spine: every topic any hint (article), claim (evidence card),
// or session (readout) contributes to, with per-species counts, busiest first.
export function buildTopicIndex({ articles = [], distilled = [], cards = [] } = {}) {
  const topics = new Map();
  const at = (label) => {
    let t = topics.get(label);
    if (!t) {
      t = { key: label, label, hints: 0, claims: 0, sessions: 0, total: 0 };
      topics.set(label, t);
    }
    return t;
  };
  for (const a of Array.isArray(articles) ? articles : []) {
    for (const label of articleTopics(a)) { const t = at(label); t.hints += 1; t.total += 1; }
  }
  for (const c of Array.isArray(cards) ? cards : []) {
    const label = cardTopic(c);
    if (label) { const t = at(label); t.claims += 1; t.total += 1; }
  }
  for (const d of Array.isArray(distilled) ? distilled : []) {
    for (const label of distilledTopics(d)) { const t = at(label); t.sessions += 1; t.total += 1; }
  }
  return [...topics.values()].sort((a, b) => (b.total - a.total) || a.label.localeCompare(b.label));
}

function confidenceOf(card) {
  const n = Number(card?.confidence);
  return Number.isFinite(n) ? n : -1;
}

// Everything the library shows for one topic, ordered durable → derived → raw:
// hints (evergreen articles) → claims (highest-confidence first) → sessions
// (newest receipts first).
export function topicPageData(key, { articles = [], distilled = [], cards = [] } = {}) {
  const k = normalizeTopicLabel(key);
  const hints = (Array.isArray(articles) ? articles : [])
    .filter((a) => articleTopics(a).includes(k));
  const claims = (Array.isArray(cards) ? cards : [])
    .filter((c) => cardTopic(c) === k)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (confidenceOf(b.c) - confidenceOf(a.c))
      || ((parseDateMs(b.c?.created_at) ?? 0) - (parseDateMs(a.c?.created_at) ?? 0))
      || (a.i - b.i))
    .map(({ c }) => c);
  const sessions = (Array.isArray(distilled) ? distilled : [])
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => distilledTopics(d).includes(k))
    .sort((a, b) => ((distilledDateMs(b.d) ?? -Infinity) - (distilledDateMs(a.d) ?? -Infinity)) || (a.i - b.i))
    .map(({ d }) => d);
  return { key: k, hints, claims, sessions };
}

function dayOf(value) {
  const s = clean(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = parseDateMs(s);
  return ms == null ? "" : new Date(ms).toISOString().slice(0, 10);
}

// Evidence cards carry no session FK — only content_json provenance
// (week_start / date / teams / topic_label). A card rolls up under a session
// when it lands in the same week (or same day) AND either shares a team, or —
// when either side lacks team attribution (T3 cards strip teams) — its topic
// is one of the session's themes.
export function claimsForSession(cards = [], session = null) {
  if (!session) return [];
  const sWeek = dayOf(session.week_start);
  const sDay = dayOf(session.date);
  if (!sWeek && !sDay) return [];
  const sTeams = new Set(
    (Array.isArray(session.teams) ? session.teams : []).map((t) => clean(t).toLowerCase()).filter(Boolean),
  );
  const sThemes = new Set(distilledTopics(session));
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const cj = card?.content_json && typeof card.content_json === "object" ? card.content_json : {};
    const cWeek = dayOf(cj.week_start);
    const cDay = dayOf(cj.date || card?.created_at);
    const sameWindow = (sWeek && cWeek && sWeek === cWeek) || (sDay && cDay && sDay === cDay);
    if (!sameWindow) continue;
    const cTeams = (Array.isArray(cj.teams) ? cj.teams : []).map((t) => clean(t).toLowerCase()).filter(Boolean);
    const matches = (cTeams.length && sTeams.size)
      ? cTeams.some((t) => sTeams.has(t))
      : sThemes.has(cardTopic(card));
    if (matches) out.push(card);
  }
  return out;
}
