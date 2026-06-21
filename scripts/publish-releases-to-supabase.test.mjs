import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReleaseItems,
  buildWhatsNew,
  buildUpsertRequest,
  buildReleasesPayload,
  publishReleasesFeed,
} from "./publish-releases-to-supabase.mjs";

const TEAMS = [{ record_id: "shape-rotator-os", name: "Shape Rotator OS" }];

function artifact(releases) {
  return {
    artifact_kind: "github_release_list",
    record_type: "team",
    record_id: "shape-rotator-os",
    releases,
  };
}

const RELEASES = [
  { tag_name: "v0.3.9", name: "0.3.9", published_at: "2026-06-18T20:43:45Z" },
  { tag_name: "v0.2.0", name: "0.2.0", published_at: "2026-05-21T10:00:00Z" },
  { tag_name: "v0.1.11", name: "0.1.11", published_at: "2026-05-18T09:00:00Z" },
  // pre-program — must be clipped by the window
  { tag_name: "v0.0.1", name: "0.0.1", published_at: "2026-04-01T09:00:00Z" },
];

test("buildReleaseItems: full in-window history, newest-first, project name resolved", () => {
  const items = buildReleaseItems([artifact(RELEASES)], TEAMS, { since: "2026-05-18" });
  assert.deepEqual(items.map((i) => i.label), ["0.3.9", "0.2.0", "0.1.11"]); // 0.0.1 clipped
  assert.ok(items.every((i) => i.kind === "release"));
  assert.equal(items[0].meta, "Shape Rotator OS");
  assert.deepEqual(items[0].nav, { mode: "shapes", recordId: "shape-rotator-os" });
});

test("buildReleaseItems: backfills past the committed 12-cap (no per-project trim)", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    tag_name: `v0.2.${i}`,
    name: `0.2.${i}`,
    // all in-window (June 1–28, >= program start) so none are clipped
    published_at: `2026-06-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00Z`,
  }));
  const items = buildReleaseItems([artifact(many)], TEAMS, { since: "2026-05-18" });
  assert.equal(items.length, 40); // all kept — not sliced to 12
});

test("buildReleaseItems: skips non-release artifacts", () => {
  const other = { artifact_kind: "github_progress", record_id: "x", releases: RELEASES };
  assert.equal(buildReleaseItems([other], TEAMS, { since: "2026-05-18" }).length, 0);
});

test("buildWhatsNew: merges releases with non-release items, drops stale releases, sorts desc", () => {
  const releaseItems = buildReleaseItems([artifact(RELEASES)], TEAMS, { since: "2026-05-18" });
  const base = [
    { date: "2026-06-01", kind: "ask", label: "an ask", meta: "ask" },
    { date: "2026-05-30", kind: "commit", label: "12 commits", meta: "Shape Rotator OS" },
    { date: "2026-06-13", kind: "release", label: "0.3.5 (stale)", meta: "Shape Rotator OS" },
  ];
  const feed = buildWhatsNew(releaseItems, base);
  // The stale committed release item is dropped; only freshly-built releases remain.
  assert.equal(feed.filter((i) => i.kind === "release" && /stale/.test(i.label)).length, 0);
  // Non-release items survive.
  assert.ok(feed.some((i) => i.kind === "ask"));
  assert.ok(feed.some((i) => i.kind === "commit"));
  // Newest-first.
  const dates = feed.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort((a, b) => b.localeCompare(a)));
});

test("buildReleasesPayload: shapes { whats_new[], github_releases[] }", () => {
  const payload = buildReleasesPayload({
    artifacts: [artifact(RELEASES)],
    surface: { teams: TEAMS, whats_new: [{ date: "2026-06-02", kind: "event", label: "demo" }] },
    since: "2026-05-18",
  });
  assert.ok(Array.isArray(payload.whats_new) && Array.isArray(payload.github_releases));
  assert.equal(payload.github_releases.length, 3);
  assert.ok(payload.whats_new.some((i) => i.kind === "event"));
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
    artifacts: [artifact(RELEASES)],
    surface: { teams: TEAMS, whats_new: [] },
    since: "2026-05-18",
    fetchImpl,
    now: "2026-06-19T00:00:00.000Z",
  });
  assert.equal(r.skipped, false);
  assert.equal(r.releases, 3);
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
      artifacts: [artifact(RELEASES)], surface: { teams: TEAMS, whats_new: [] },
      since: "2026-05-18", fetchImpl,
    }),
    /Supabase upsert failed: 401/,
  );
});
