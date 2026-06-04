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
      pair_with: ["third"],
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
  assert.equal(model.aff.get(relations.collabAffKey("offer", "third")).endorsed, true);
  assert.deepEqual(model.aff.get(relations.collabAffKey("need", "offer")).shared, ["tee"]);
  assert.deepEqual(model.convergence, [{ skill: "tee", teams: ["Offer Studio", "Need Lab", "Third Works"], count: 3 }]);
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
