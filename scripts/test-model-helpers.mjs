import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function importRendererModule(relPath) {
  const absPath = path.join(ROOT, relPath);
  const source = await readFile(absPath, "utf8");
  const sourceUrl = pathToFileURL(absPath).href;
  const encoded = Buffer.from(`${source}\n//# sourceURL=${sourceUrl}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const relations = await importRendererModule("apps/os/src/renderer/cohort-relations.js");
const contextVault = await importRendererModule("apps/os/src/renderer/context-vault-model.js");
const shapeEscape = await importRendererModule("packages/shape-ui/src/escape.js");
const vendoredEscape = await importRendererModule("apps/os/src/vendor/shape-ui/escape.js");

test("cohort timeline source boundary covers snapshot collections that drive insights", async () => {
  const timeline = JSON.parse(await readFile(path.join(ROOT, "apps/os/src/cohort-timeline.json"), "utf8"));
  const collectionPaths = new Map([
    ["teams", "cohort-data/teams"],
    ["people", "cohort-data/people"],
    ["clusters", "cohort-data/clusters"],
    ["dependencies", "cohort-data/dependencies"],
  ]);
  const recordTypes = new Map([
    ["teams", "team"],
    ["people", "person"],
    ["clusters", "cluster"],
    ["dependencies", "dependency"],
  ]);
  const source = (timeline.sources || []).find((item) => item.id === "cohort-data-github") || {};
  const sourcePaths = new Set(source.paths || []);
  const sourceRecordTypes = new Set(source.record_types || []);
  const boundaryPaths = new Set(timeline.source_boundary?.included_paths || []);
  const eventCollections = new Set((timeline.events || []).map((event) => event.collection).filter(Boolean));
  const snapshotCollections = new Set();

  for (const snapshot of (timeline.snapshots || [])) {
    const surface = snapshot.surface || {};
    for (const collection of collectionPaths.keys()) {
      if (Array.isArray(surface[collection]) && surface[collection].length) snapshotCollections.add(collection);
    }
  }

  for (const collection of snapshotCollections) {
    const pathName = collectionPaths.get(collection);
    assert.ok(sourcePaths.has(pathName), `${pathName} is missing from cohort-data-github source paths`);
    assert.ok(
      sourceRecordTypes.has(recordTypes.get(collection)),
      `${collection} record type is missing from cohort-data-github source record_types`,
    );
    assert.ok(boundaryPaths.has(pathName), `${pathName} is missing from timeline source_boundary.included_paths`);
    assert.ok(eventCollections.has(collection), `${collection} snapshots exist but no ${collection} events are present`);
  }
});

test("cohort dependency snapshots stay on first-parent history", async () => {
  const timeline = JSON.parse(await readFile(path.join(ROOT, "apps/os/src/cohort-timeline.json"), "utf8"));
  const week03 = (timeline.snapshots || []).find((snapshot) => snapshot.id === "week-03");
  const dependencyEvents = (timeline.events || []).filter((event) => event.collection === "dependencies");

  assert.ok(week03, "week-03 snapshot is missing");
  assert.equal(week03.counts?.dependencies, 0);
  assert.equal((week03.surface?.dependencies || []).length, 0);
  assert.ok(dependencyEvents.length > 0, "dependency events are missing from the timeline");
  assert.ok(
    dependencyEvents.every((event) => event.snapshot_id === "latest"),
    "dependency events should not be back-assigned to earlier snapshots",
  );
});

test("transcript-derived cues and session insights resolve cohort references", async () => {
  const surface = JSON.parse(await readFile(path.join(ROOT, "apps/os/src/cohort-surface.json"), "utf8"));
  const teamIds = new Set((surface.teams || []).map(team => team.record_id));
  const personIds = new Set((surface.people || []).map(person => person.record_id));
  const clusterIds = new Set((surface.clusters || []).map(cluster => cluster.record_id));
  const failures = [];

  for (const [idx, cue] of (surface.constellation_cues || []).entries()) {
    assert.ok(cue.label, `constellation cue ${idx} is missing label`);
    assert.ok(cue.source, `constellation cue ${idx} is missing source`);
    assert.ok(cue.excerpt, `constellation cue ${idx} is missing excerpt`);
    for (const id of cue.teams || []) if (!teamIds.has(id)) failures.push(`cue ${idx} team ${id}`);
    for (const id of cue.clusters || []) if (!clusterIds.has(id)) failures.push(`cue ${idx} cluster ${id}`);
  }

  for (const [idx, insight] of (surface.session_insights || []).entries()) {
    assert.ok(insight.vault_id, `session insight ${idx} is missing vault_id`);
    assert.ok(insight.source, `session insight ${idx} is missing source`);
    for (const id of insight.teams || []) if (!teamIds.has(id)) failures.push(`session insight ${idx} team ${id}`);
    for (const id of insight.people || []) if (!personIds.has(id)) failures.push(`session insight ${idx} person ${id}`);
  }

  assert.deepEqual(failures, []);
});

test("cohort surface join fields resolve to canonical records", async () => {
  const surface = JSON.parse(await readFile(path.join(ROOT, "apps/os/src/cohort-surface.json"), "utf8"));
  const teamIds = new Set((surface.teams || []).map(team => team.record_id));
  const personIds = new Set((surface.people || []).map(person => person.record_id));
  const failures = [];

  for (const person of surface.people || []) {
    if (person.team && !teamIds.has(person.team)) failures.push(`person ${person.record_id} team ${person.team}`);
    for (const id of person.secondary_teams || []) {
      if (!teamIds.has(id)) failures.push(`person ${person.record_id} secondary team ${id}`);
    }
    for (const id of person.pair_with || []) {
      if (!personIds.has(id)) failures.push(`person ${person.record_id} pair_with ${id}`);
    }
  }

  for (const team of surface.teams || []) {
    for (const id of team.dependencies || []) {
      if (!teamIds.has(id)) failures.push(`team ${team.record_id} dependency ${id}`);
    }
  }

  for (const cluster of surface.clusters || []) {
    for (const id of cluster.teams || []) {
      if (!teamIds.has(id)) failures.push(`cluster ${cluster.record_id} team ${id}`);
    }
  }

  for (const dependency of surface.dependencies || []) {
    if (!teamIds.has(dependency.source)) failures.push(`dependency ${dependency.record_id} source ${dependency.source}`);
    if (!teamIds.has(dependency.target)) failures.push(`dependency ${dependency.record_id} target ${dependency.target}`);
    if (dependency.owner && !teamIds.has(dependency.owner) && !personIds.has(dependency.owner)) {
      failures.push(`dependency ${dependency.record_id} owner ${dependency.owner}`);
    }
  }

  for (const ask of surface.asks || []) {
    if (ask.author && !personIds.has(ask.author)) failures.push(`ask ${ask.record_id} author ${ask.author}`);
    if (ask.claimed_by && !personIds.has(ask.claimed_by)) failures.push(`ask ${ask.record_id} claimed_by ${ask.claimed_by}`);
  }

  assert.deepEqual(failures, []);
});

test("buildCohortIndex maps local team, person, secondary team, and cluster joins", () => {
  const cohort = {
    teams: [
      { record_id: "alpha", name: "Alpha Studio", kind: "team" },
      { record_id: "beta", name: "Beta Works", kind: "team" },
      { record_id: "update-1", name: "Weekly Update", kind: "update" },
    ],
    people: [
      { record_id: "person-1", name: "Mira", team: "alpha", secondary_teams: ["beta"] },
      { record_id: "person-2", name: "Jon", team: "beta" },
    ],
    clusters: [
      { record_id: "cluster-1", label: "Applied AI", teams: ["alpha", "beta"] },
    ],
  };

  const index = relations.buildCohortIndex(cohort);

  assert.equal(relations.teamKind(cohort.teams[2]), "update");
  assert.deepEqual(relations.teamsOfKind(cohort.teams, "team").map(team => team.record_id), ["alpha", "beta"]);
  assert.equal(index.teamById.get("alpha").name, "Alpha Studio");
  assert.equal(index.personById.get("person-1").team, "alpha");
  assert.deepEqual(index.peopleByTeam.get("beta").map(person => person.record_id), ["person-1", "person-2"]);
  assert.deepEqual(index.primaryPeopleByTeam.get("beta").map(person => person.record_id), ["person-2"]);
  assert.deepEqual(index.clustersByTeam.get("alpha").map(cluster => cluster.record_id), ["cluster-1"]);
  assert.equal(index.teamLabel("missing-team"), "missing-team");
  assert.equal(index.teamForPerson(cohort.people[0]).record_id, "alpha");
  assert.deepEqual(index.teamsForPerson(cohort.people[0]).map(team => team.record_id), ["alpha", "beta"]);
});

test("buildCollabModel derives dependencies, seek-offer matches, affinity, and convergence locally", () => {
  const teams = [
    {
      record_id: "need",
      name: "Need Lab",
      skill_areas: ["tee", "protocol"],
      seeking: ["documentation help"],
      dependencies: ["offer"],
    },
    {
      record_id: "offer",
      name: "Offer Studio",
      skill_areas: ["documentation", "tee"],
      offering: ["documentation help"],
    },
    {
      record_id: "third",
      name: "Third Works",
      skill_areas: ["tee", "research"],
      offering: ["research review"],
    },
  ];
  const clusters = [{ record_id: "cluster", label: "Builders", teams: ["need", "offer", "third"] }];

  const model = relations.buildCollabModel(teams, clusters);

  assert.deepEqual(model.ordered.map(item => item.rid), ["offer", "need", "third"]);
  assert.ok(model.deps.has("need>offer"));
  assert.deepEqual(model.soByPair.get("need>offer").shared, ["documentation"]);
  assert.equal(model.aff.get(relations.collabAffKey("offer", "third")).endorsed, false);
  assert.deepEqual(model.aff.get(relations.collabAffKey("need", "offer")).shared, ["tee"]);
  assert.deepEqual(model.convergence, [{ skill: "tee", teams: ["Offer Studio", "Need Lab", "Third Works"], count: 3 }]);
});

test("buildCollabModel ignores unsupported team-level pair_with endorsements", () => {
  const teams = [
    { record_id: "alpha", name: "Alpha", skill_areas: ["tee"], pair_with: ["beta"] },
    { record_id: "beta", name: "Beta", skill_areas: ["design"] },
  ];

  const model = relations.buildCollabModel(teams, []);

  assert.equal(model.aff.has(relations.collabAffKey("alpha", "beta")), false);
});

test("typed dependency records override legacy shorthand without inventing dependency semantics", () => {
  const teams = [
    { record_id: "source", name: "Source Lab", dependencies: ["target"] },
    { record_id: "target", name: "Target Studio" },
    { record_id: "other", name: "Other Works", dependencies: ["target"] },
  ];
  const dependencyRecords = [
    {
      record_id: "source-target",
      record_type: "dependency",
      source: "source",
      target: "target",
      relation: "shares_substrate",
      status: "exploring",
      confidence: "medium",
      reason: "Both teams are working on the same substrate.",
      evidence: ["Shared substrate field"],
    },
    {
      record_id: "other-target",
      record_type: "dependency",
      source: "other",
      target: "target",
      status: "active",
      confidence: "high",
    },
  ];

  const edges = relations.constellationDependencyEdges(teams, undefined, dependencyRecords);
  const typed = edges.find(edge => edge.from === "source" && edge.to === "target");
  const defaulted = edges.find(edge => edge.from === "other" && edge.to === "target");

  assert.equal(edges.length, 2);
  assert.equal(relations.dependencyPairKey("source", "target"), "source>target");
  assert.equal(relations.dependencySafeToken("Shared substrate"), "shared-substrate");
  assert.equal(typed.normalized, true);
  assert.equal(typed.id, "source-target");
  assert.equal(typed.relation, "shares_substrate");
  assert.equal(typed.relation_label, "shared substrate");
  assert.equal(typed.status_label, "exploring");
  assert.deepEqual(typed.evidence, ["Shared substrate field"]);
  assert.equal(edges.some(edge => edge.id === "legacy:source>target"), false);
  assert.equal(defaulted.relation, "declared");
  assert.equal(defaulted.relation_label, "declared link");

  const model = relations.buildCollabModel(teams, [], dependencyRecords);
  assert.equal(model.deps.size, 2);
  assert.equal(model.depByPair.get(relations.dependencyPairKey("source", "target")).relation_label, "shared substrate");
  assert.equal(model.depByPair.get(relations.dependencyPairKey("other", "target")).relation_label, "declared link");
});

test("aggregateSkillAreas normalizes and dedupes team and person skill tags", () => {
  const cohort = {
    teams: [
      { record_id: "alpha", skill_areas: ["TEE", "tee", "Protocol"] },
      { record_id: "beta", skill_areas: ["Protocol", "Research"] },
    ],
    people: [
      { record_id: "person-1", skill_areas: ["tee", "Research"] },
    ],
  };

  const model = relations.aggregateSkillAreas(cohort);
  const byTag = new Map(model.nodes.map(node => [node.tag, node]));

  assert.deepEqual(byTag.get("tee"), { tag: "tee", teams: ["alpha"], people: ["person-1"], size: 2 });
  assert.deepEqual(byTag.get("protocol"), { tag: "protocol", teams: ["alpha", "beta"], people: [], size: 2 });
  assert.ok(model.edges.some(edge => edge.a === "protocol" && edge.b === "tee" && edge.weight === 1));
  assert.ok(model.edges.some(edge => edge.a === "protocol" && edge.b === "research" && edge.weight === 1));
});

test("skill-area models ignore freeform tags when controlled vocab is present", async () => {
  const cohort = {
    cohort_vocab: { skill_areas: ["agentic", "agent-runtime", "agent-routing", "p2p", "bd-gtm"] },
    teams: [
      { record_id: "alpha", name: "Alpha", skill_areas: ["agentic", "model-routing", "unknown-specialty"] },
      { record_id: "beta", name: "Beta", skill_areas: ["agentic"] },
      { record_id: "gamma", name: "Gamma", skill_areas: ["agentic", "p2p-networks"] },
    ],
    people: [
      { record_id: "person-1", skill_areas: ["bd-gtm", "rust"] },
      { record_id: "person-2", skill_areas: ["agent-runtime", "memory-retrieval"] },
    ],
  };

  const aggregate = relations.aggregateSkillAreas(cohort);
  const nodeTags = aggregate.nodes.map(node => node.tag).sort();
  assert.deepEqual(nodeTags, ["agent-runtime", "agentic", "bd-gtm"]);
  assert.deepEqual(aggregate.nodes.find(node => node.tag === "agentic").teams.sort(), ["alpha", "beta", "gamma"]);
  assert.equal(aggregate.nodes.some(node => node.tag === "unknown-specialty" || node.tag === "rust" || node.tag === "model-routing" || node.tag === "p2p-networks"), false);

  const collab = relations.buildCollabModel(cohort.teams, [], [], cohort.cohort_vocab.skill_areas);
  assert.equal(collab.convergence.length, 1);
  assert.equal(collab.convergence[0].skill, "agentic");
  assert.equal(collab.convergence[0].count, 3);
  assert.deepEqual([...collab.convergence[0].teams].sort(), ["Alpha", "Beta", "Gamma"]);

  const surface = JSON.parse(await readFile(path.join(ROOT, "apps/os/src/cohort-surface.json"), "utf8"));
  const surfaceVocab = new Set(surface.cohort_vocab?.skill_areas || []);
  const surfaceAggregate = relations.aggregateSkillAreas(surface);
  const unknownSurfaceTags = surfaceAggregate.nodes
    .map(node => node.tag)
    .filter(tag => !surfaceVocab.has(tag));
  assert.deepEqual(unknownSurfaceTags, []);
});

test("normalizeGithubAccount canonicalizes profile handles in shared and vendored helpers", () => {
  for (const helper of [shapeEscape, vendoredEscape]) {
    assert.equal(helper.normalizeGithubAccount("@cnode"), "cnode");
    assert.equal(helper.normalizeGithubAccount("https://github.com/CNode?tab=repositories"), "CNode");
    assert.equal(helper.normalizeGithubAccount("github.com/orgs/teleport"), "teleport");
    assert.equal(helper.normalizeGithubAccount("not github.com/cnode"), null);
  }
});

test("normalizeLinkHref keeps github account links absolute and handle-safe", () => {
  for (const helper of [shapeEscape, vendoredEscape]) {
    assert.equal(helper.normalizeLinkHref("github", "@cnode"), "https://github.com/cnode");
    assert.equal(helper.normalizeLinkHref("github", "github.com/cnode"), "https://github.com/cnode");
  }
});

test("context vault helpers resolve raw scripts by id, path, basename, and pending path", () => {
  const manifest = {
    sources: [{ id: "source-1", title: "Reviewed source" }],
    raw_scripts: [
      { id: "raw-1", path: "apps/os/src/content/context/raw-scripts/Foo Bar.txt" },
      { id: "raw-2", path: "apps/os/src/content/context/raw-scripts/Nested/Baz.txt" },
    ],
  };

  assert.equal(contextVault.contextSourceById(manifest, "source-1").title, "Reviewed source");
  assert.equal(contextVault.contextRawScriptById(manifest, "raw-2").path, "apps/os/src/content/context/raw-scripts/Nested/Baz.txt");
  assert.equal(contextVault.contextRawScriptByPath(manifest, "raw-scripts/foo bar.txt").id, "raw-1");
  assert.equal(contextVault.contextRawScriptByPath(manifest, "nested\\baz.txt").id, "raw-2");
  assert.equal(contextVault.pendingContextRawScript(manifest, "Foo Bar.txt").id, "raw-1");
  assert.equal(contextVault.contextRawScriptByPath(manifest, ""), null);
});
