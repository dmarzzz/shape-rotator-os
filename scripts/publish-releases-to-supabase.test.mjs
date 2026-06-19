import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReleaseItems,
  buildWhatsNew,
  buildUpsertRequest,
  buildReleasesPayload,
  publishReleasesFeed,
} from "./publish-releases-to-supabase.mjs";

const TEAMS = [
  { record_id: "shape-rotator-os", name: "Shape Rotator OS" },
  { record_id: "elizaos", name: "elizaOS" },
];

function artifact(record_id, releases) {
  return { artifact_kind: "github_release_list", record_type: "team", record_id, releases };
}

// shape-rotator-os: a pre-window release (v0.1.1, May 9 — before the May 18
// cohort window) plus in-window ones. It's a FULL_HISTORY repo, so the pre-
// window release must survive.
const OS_RELEASES = [
  { tag_name: "v0.3.9", name: "0.3.9", published_at: "2026-06-18T20:43:45Z" },
  { tag_name: "v0.1.11", name: "0.1.11", published_at: "2026-05-18T09:00:00Z" },
  { tag_name: "v0.1.1", name: "0.1.1", published_at: "2026-05-09T09:00:00Z" },
];
// elizaos: a clipped (non-full-history) repo with a pre-window release that must
// be dropped so its pre-cohort tail never floods the feed.
const DEP_RELEASES = [
  { tag_name: "v1.0.0", name: "1.0.0", published_at: "2026-06-01T09:00:00Z" },
  { tag_name: "v0.9.0", name: "0.9.0", published_at: "2025-10-21T09:00:00Z" },
];
const osArtifact = artifact("shape-rotator-os", OS_RELEASES);
const depArtifact = artifact("elizaos", DEP_RELEASES);

test("buildReleaseItems: clips a normal repo to the program window", () => {
  const items = buildReleaseItems([depArtifact], TEAMS, { since: "2026-05-18" });
  assert.deepEqual(items.map((i) => i.label), ["1.0.0"]); // 0.9.0 (Oct 2025) clipped
  assert.equal(items[0].meta, "elizaOS");
});

test("buildReleaseItems: shape-rotator-os keeps its full history (no gap)", () => {
  const items = buildReleaseItems([osArtifact], TEAMS, { since: "2026-05-18" });
  assert.deepEqual(items.map((i) => i.label), ["0.3.9", "0.1.11", "0.1.1"]); // 0.1.1 NOT clipped
  assert.ok(items.every((i) => i.kind === "release"));
  assert.equal(items[0].meta, "Shape Rotator OS");
  assert.deepEqual(items[0].nav, { mode: "shapes", recordId: "shape-rotator-os" });
});

test("buildReleaseItems: the full-history override is configurable", () => {
  // With an empty override set, the OS repo clips like any other repo.
  const items = buildReleaseItems([osArtifact], TEAMS, { since: "2026-05-18", fullHistoryIds: new Set() });
  assert.deepEqual(items.map((i) => i.label), ["0.3.9", "0.1.11"]); // 0.1.1 now clipped
});

test("buildReleaseItems: backfills past the committed 12-cap (no per-project trim)", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    tag_name: `v0.2.${i}`,
    name: `0.2.${i}`,
    // all in-window (June 1–28, >= program start) so none are clipped
    published_at: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00Z`,
  }));
  const items = buildReleaseItems([artifact("shape-rotator-os", many)], TEAMS, { since: "2026-05-18" });
  assert.equal(items.length, 40); // all kept — not sliced to 12
});

test("buildReleaseItems: skips non-release artifacts", () => {
  const other = { artifact_kind: "github_progress", record_id: "x", releases: OS_RELEASES };
  assert.equal(buildReleaseItems([other], TEAMS, { since: "2026-05-18" }).length, 0);
});

test("buildWhatsNew: merges releases with non-release items, drops stale releases, sorts desc", () => {
  const releaseItems = buildReleaseItems([osArtifact], TEAMS, { since: "2026-05-18" });
  const base = [
    { date: "2026-06-01", kind: "ask", label: "an ask", meta: "ask" },
    { date: "2026-05-30", kind: "commit", label: "12 commits", meta: "Shape Rotator OS" },
    { date: "2026-06-13", kind: "release", label: "0.3.5 (stale)", meta: "Shape Rotator OS" },
  ];
  const feed = buildWhatsNew(releaseItems, base);
  // The stale committed release item is dropped; only freshly-built releases remain.
  assert.equal(feed.filter((i) => i.kind === "release" && /stale/.test(i.label)).length, 0);
  assert.ok(feed.some((i) => i.kind === "ask"));
  assert.ok(feed.some((i) => i.kind === "commit"));
  const dates = feed.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort((a, b) => b.localeCompare(a)));
});

test("buildReleasesPayload: shapes { whats_new[], github_releases[] }", () => {
  const payload = buildReleasesPayload({
    artifacts: [osArtifact, depArtifact],
    surface: { teams: TEAMS, whats_new: [{ date: "2026-06-02", kind: "event", label: "demo" }] },
    since: "2026-05-18",
  });
  assert.ok(Array.isArray(payload.whats_new) && Array.isArray(payload.github_releases));
  assert.equal(payload.github_releases.length, 4); // 3 OS (incl. pre-window 0.1.1) + 1 elizaOS in-window
  assert.ok(payload.whats_new.some((i) => i.kind === "event"));
  assert.ok(payload.github_releases.some((i) => i.label === "0.1.1")); // gap filled
});

test("buildUpsertRequest: on_conflict=id, stamped now, validates payload shape", () => {
  const req = buildUpsertRequest({
    url: "https://proj.supabase.co/",
    payload: { whats_new: [], github_releases: [] },
    now: "2026-06-19T00:00:00.000Z",
  });
  assert.equal(req.url, "https://proj.supabase.co/rest/v1/public_releases_feed?on_conflict=id");
  assert.equal(req.body.id, "current");
  assert.equal(req.body.updated_at, "2026-06-19T00:00:00.000Z");
  assert.throws(() => buildUpsertRequest({ url: "", payload: { whats_new: [], github_releases: [] } }), /SUPABASE_URL/);
  assert.throws(() => buildUpsertRequest({ url: "https://x", payload: {} }), /whats_new/);
});

test("publishReleasesFeed: skips cleanly when env is unset", async () => {
  const r = await publishReleasesFeed({ url: "", key: "", artifacts: [], surface: { teams: [], whats_new: [] } });
  assert.equal(r.skipped, true);
});

test("publishReleasesFeed: POSTs upsert with service-role headers", async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 201 }; };
  const r = await publishReleasesFeed({
    url: "https://proj.supabase.co",
    key: "service-key",
    artifacts: [osArtifact],
    surface: { teams: TEAMS, whats_new: [] },
    since: "2026-05-18",
    fetchImpl,
    now: "2026-06-19T00:00:00.000Z",
  });
  assert.equal(r.skipped, false);
  assert.equal(r.releases, 3); // full OS history incl. pre-window 0.1.1
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers.apikey, "service-key");
  assert.match(captured.opts.headers.prefer, /merge-duplicates/);
  assert.match(captured.url, /public_releases_feed\?on_conflict=id$/);
});

test("publishReleasesFeed: throws on a non-ok HTTP response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, async text() { return "no"; } });
  await assert.rejects(
    publishReleasesFeed({
      url: "https://proj.supabase.co", key: "k",
      artifacts: [osArtifact], surface: { teams: TEAMS, whats_new: [] },
      since: "2026-05-18", fetchImpl,
    }),
    /Supabase upsert failed: 401/,
  );
});
