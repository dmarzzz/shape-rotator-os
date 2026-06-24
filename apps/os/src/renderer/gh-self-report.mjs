// gh-self-report.mjs — "scan my recent public GitHub activity" for the self-report.
//
// One unauthenticated GET to the public Events API (the CSP already allows
// api.github.com — see index.html; gh-user.js uses the same host). The reply is
// parsed into a compact, line-oriented digest that drops straight into
// buildSelfReportPrompt's githubDigest. Pure parsing/formatting is exported and
// tested; the fetch is cached in localStorage with gh-user.js's TTL discipline so
// repeat clicks don't spend the 60/hr unauthenticated budget.
//
// Limits (surfaced in the consent UI): PUBLIC events only (private repos/orgs
// never appear), a recent window (~90 days / ~300 events, ~100 returned), and the
// only thing sent to GitHub is the member's own public username.

const EVENTS_CACHE_KEY = "srfg:gh_events_cache_v1";
const EVENTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h positive — activity is fresher than profile
const EVENTS_NEG_TTL_MS = 60 * 60 * 1000; // 1h negative (mirrors gh-user.js)
const MAX_COMMITS = 8;
const MAX_PRS = 6;
const MAX_RELEASES = 6;
const MAX_REPOS = 10;

// Strip a leading @, pull the username out of a github.com/<user> URL, drop any
// trailing /?# segment. (Same shape as gh-user.js's private normalizeHandle.)
export function normalizeHandle(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  s = s.replace(/^@+/, "");
  const m = s.match(/github\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.split(/[/?#]/)[0];
  return s.trim();
}

// Resolve a single handle from a person record, trying the fields asks.js trusts.
export function resolvePersonHandle(person) {
  if (!person) return "";
  return normalizeHandle(
    (person.links && person.links.github) || person.gh_handle || person.github || "",
  );
}

function firstLine(s) { return String(s == null ? "" : s).split("\n")[0].trim(); }
function isMerge(msg) { return /^merge\b/i.test(firstLine(msg)); }

// Pure: a GitHub events[] array → a structured summary. No network/storage.
export function summarizeEvents(events) {
  const commits = []; // { repo, message }
  const prs = [];      // { repo, number, title, action }
  const releases = []; // { repo, tag }
  const created = [];  // { repo, refType }
  const repos = new Set();
  let pushCount = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue;
    const repo = ev.repo && ev.repo.name ? String(ev.repo.name) : "";
    if (repo) repos.add(repo);
    const p = ev.payload || {};
    switch (ev.type) {
      case "PushEvent": {
        pushCount++;
        for (const c of Array.isArray(p.commits) ? p.commits : []) {
          const msg = firstLine(c && c.message);
          if (msg && !isMerge(msg)) commits.push({ repo, message: msg });
        }
        break;
      }
      case "PullRequestEvent": {
        const pr = p.pull_request || {};
        const action = p.action === "closed" && pr.merged ? "merged" : p.action;
        if (action === "merged" || action === "opened") {
          prs.push({ repo, number: pr.number || p.number || null, title: firstLine(pr.title), action });
        }
        break;
      }
      case "ReleaseEvent": {
        const tag = (p.release && (p.release.tag_name || p.release.name)) || "";
        if (tag) releases.push({ repo, tag: String(tag) });
        break;
      }
      case "CreateEvent": {
        if (p.ref_type === "repository" || p.ref_type === "tag") created.push({ repo, refType: p.ref_type });
        break;
      }
      default: break;
    }
  }
  return { commits, prs, releases, created, repos: [...repos], pushCount };
}

// Pure: a summary → a compact plain-text digest. "" when there's nothing useful
// (so the modal's empty-digest guards fire and don't draft from nothing).
export function digestFromEvents(handle, data) {
  if (!data) return "";
  const { commits, prs, releases, created, repos, pushCount } = data;
  if (!(commits.length || prs.length || releases.length || created.length)) return "";
  const counts = [];
  if (pushCount) counts.push(`${pushCount} push${pushCount === 1 ? "" : "es"} (${commits.length} commit${commits.length === 1 ? "" : "s"})`);
  const merged = prs.filter((p) => p.action === "merged").length;
  const opened = prs.filter((p) => p.action === "opened").length;
  if (merged) counts.push(`${merged} PR${merged === 1 ? "" : "s"} merged`);
  if (opened) counts.push(`${opened} PR${opened === 1 ? "" : "s"} opened`);
  if (releases.length) counts.push(`${releases.length} release${releases.length === 1 ? "" : "s"}`);
  const newRepos = created.filter((c) => c.refType === "repository").length;
  if (newRepos) counts.push(`${newRepos} new repo${newRepos === 1 ? "" : "s"}`);

  const lines = [`handle: ${handle} · window: recent public events`];
  if (counts.length) lines.push(`activity: ${counts.join(", ")}`);
  if (commits.length) {
    lines.push("recent commits:");
    for (const c of commits.slice(0, MAX_COMMITS)) lines.push(`- ${c.repo}: ${c.message}`);
  }
  if (prs.length) {
    lines.push("pull requests:");
    for (const p of prs.slice(0, MAX_PRS)) lines.push(`- ${p.repo}#${p.number || "?"} (${p.action}): ${p.title}`);
  }
  if (releases.length) {
    lines.push("releases: " + releases.slice(0, MAX_RELEASES).map((r) => `${r.repo} ${r.tag}`).join(", "));
  }
  if (repos.length) lines.push(`repos touched: ${repos.slice(0, MAX_REPOS).join(", ")}`);
  return lines.join("\n");
}

// ── cache (mirrors gh-user.js; no-ops gracefully where localStorage is absent) ──
function loadCache() {
  try { const raw = localStorage.getItem(EVENTS_CACHE_KEY); return raw ? JSON.parse(raw) || {} : {}; }
  catch { return {}; }
}
function saveCache(obj) { try { localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(obj)); } catch {} }
function readCached(handle) {
  const e = loadCache()[handle];
  if (!e || typeof e.fetched_at !== "number") return undefined;
  const ttl = e.ok ? EVENTS_TTL_MS : EVENTS_NEG_TTL_MS;
  return (Date.now() - e.fetched_at > ttl) ? undefined : e;
}
function writeCached(handle, entry) {
  const all = loadCache();
  all[handle] = { ...entry, fetched_at: Date.now() };
  saveCache(all);
}

// Fetch (cached) → { ok, digest } | { ok:false, status }. fetchImpl is injectable
// for tests; in the app it uses the renderer's fetch (CSP allows the host).
export async function scanGithubActivity(rawHandle, { maxEvents = 100, fetchImpl } = {}) {
  const handle = normalizeHandle(rawHandle);
  if (!handle) return { ok: false, status: 0, error: "empty_handle" };
  const cached = readCached(handle);
  if (cached !== undefined) return cached;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, status: 0, error: "no_fetch" };
  let r;
  try {
    r = await doFetch(
      `https://api.github.com/users/${encodeURIComponent(handle)}/events/public?per_page=${maxEvents}`,
      { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" },
    );
  } catch (e) {
    const entry = { ok: false, status: 0, error: (e && e.message) || String(e) };
    writeCached(handle, entry);
    return entry;
  }
  if (!r || r.status !== 200) {
    const entry = { ok: false, status: r ? r.status : 0 };
    writeCached(handle, entry);
    return entry;
  }
  let events;
  try { events = await r.json(); }
  catch { const entry = { ok: false, status: 0, error: "bad_json" }; writeCached(handle, entry); return entry; }
  const digest = digestFromEvents(handle, summarizeEvents(Array.isArray(events) ? events : []));
  const entry = { ok: true, status: 200, digest };
  writeCached(handle, entry);
  return entry;
}
