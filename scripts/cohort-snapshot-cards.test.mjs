import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionEdgeCard, cardAttributionCard, clusterSummaryCard, buildSnapshotManifest,
  assertNoPrivateContent, assertPublicSourceRefs,
} from "./lib/cohort-snapshot-cards.mjs";
import { connectionEdgesFromInsightCards, frozenAttributionFromInsightCards } from "../apps/os/src/renderer/cohort-evidence-index.mjs";

const names = new Map([["abra", "Abra"], ["teesql", "TeeSQL"]]);

test("connectionEdgeCard sets the cohort-safe boundary fields", () => {
  const c = connectionEdgeCard({ from: "abra", to: "teesql", reason: "needs TEE Postgres", score: 0.9 }, { nameById: names });
  assert.equal(c.kind, "connection_edge");
  assert.equal(c.subject_type, "team_pair");
  assert.deepEqual(c.subject_ids, ["abra", "teesql"]);
  assert.equal(c.surface_tier, "cohort", "behind the cohort key, NOT public");
  assert.equal(c.source_boundary, "public_bundle");
  assert.equal(c.raw_allowed, false);
  assert.equal(c.generated_at, null, "nulled for byte-stable --check");
  assert.equal(c.content_json.from_team, "abra");
  assert.ok(c.source_refs.every((r) => r.path.startsWith("cohort-data/")));
});

test("cardAttributionCard + clusterSummaryCard produce valid cards", () => {
  const a = cardAttributionCard({ card_id: "live-7", teams: ["abra"], teams_basis: "inferred" });
  assert.equal(a.kind, "card_attribution");
  assert.equal(a.subject_type, "team");
  assert.equal(a.content_json.card_id, "live-7");
  const s = clusterSummaryCard({ cluster_id: "confidential", summary: "TEE + verification teams", member_teams: ["abra", "teesql"] });
  assert.equal(s.kind, "cluster_summary");
  assert.equal(s.subject_type, "cluster");
});

test("privacy guards throw on private content / non-public source refs", () => {
  assert.throws(() => assertNoPrivateContent({ storage_ref: "x" }), /storage_ref/);
  assert.throws(() => assertNoPrivateContent({ source_artifact_id: "x" }), /source_artifact_id/);
  assert.throws(() => assertPublicSourceRefs([{ path: "cohort-data/.private/transcript-vault/x.md" }]), /not under a public/);
  assert.doesNotThrow(() => assertPublicSourceRefs([{ path: "cohort-data/teams/abra.md" }]));
});

test("buildSnapshotManifest is a valid cohort_insight_bundle the publisher accepts", () => {
  const m = buildSnapshotManifest({
    edges: [{ from: "abra", to: "teesql", reason: "r", score: 0.8 }],
    attributions: [{ card_id: "live-7", teams: ["abra"], teams_basis: "inferred" }],
    summaries: [{ cluster_id: "confidential", summary: "s", member_teams: ["abra"] }],
    nameById: names,
  });
  assert.equal(m.artifact_kind, "cohort_insight_bundle");
  assert.equal(m.generated_at, null);
  assert.equal(m.cards.length, 3);
  assert.deepEqual(m.cards.map((c) => c.kind).sort(), ["card_attribution", "cluster_summary", "connection_edge"]);
  // every card is cohort-tier, public-bundle, no private content
  for (const c of m.cards) {
    assert.equal(c.surface_tier, "cohort");
    assert.equal(c.source_boundary, "public_bundle");
    assert.doesNotThrow(() => assertNoPrivateContent(c.content_json));
  }
});

test("WRITE↔READ round-trip: emitted cards parse back through the renderer shapers", () => {
  const manifest = buildSnapshotManifest({
    edges: [
      { from: "abra", to: "teesql", reason: "needs TEE Postgres", score: 0.9 },
      { from: "abra", to: "tinycloud", reason: "skills", score: 0.4 },
    ],
    attributions: [{ card_id: "live-7", teams: ["abra"], teams_basis: "inferred" }],
    nameById: names,
  });
  // connection edges read back into the per-record adjacency
  const by = connectionEdgesFromInsightCards(manifest.cards, names);
  assert.equal(by.get("abra").length, 2);
  assert.equal(by.get("abra")[0].to, "teesql", "highest score first survives the round-trip");
  assert.equal(by.get("abra")[0].toName, "TeeSQL");
  // attribution reads back into the frozen map
  const frozen = frozenAttributionFromInsightCards(manifest.cards);
  assert.deepEqual(frozen.get("live-7"), { teams: ["abra"], basis: "inferred" });
});
