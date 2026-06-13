import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function readOptional(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
}

function between(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`missing start marker for ${label}: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) throw new Error(`missing end marker for ${label}: ${endNeedle}`);
  return source.slice(start, end);
}

function countPopulated(records, fieldPath) {
  const parts = fieldPath.split(".");
  let count = 0;
  for (const record of records || []) {
    let value = record;
    for (const part of parts) value = value?.[part];
    if (Array.isArray(value)) {
      if (value.length) count++;
    } else if (value && typeof value === "object") {
      if (Object.keys(value).length) count++;
    } else if (value != null && String(value).trim()) {
      count++;
    }
  }
  return count;
}

function countSurfaceField(kind, field) {
  if (field === "person_timeline") return Object.keys(surface.person_timeline || {}).length;
  if (field === "team_timeline") return Object.keys(surface.team_timeline || {}).length;
  return countPopulated(kind === "person" ? surface.people : surface.teams, field);
}

const web = read("apps/web/scripts/cohort.js");
const packageShapeUiIndex = read("packages/shape-ui/src/index.js");
const packageShapeUiCohortCard = read("packages/shape-ui/src/cohort-card.js");
const webShapeUiIndex = readOptional("apps/web/shape-ui/src/index.js");
const webShapeUiCohortCard = readOptional("apps/web/shape-ui/src/cohort-card.js");
const os = read("apps/os/src/renderer/alchemy.js");
const cohortSource = read("apps/os/src/renderer/cohort-source.js");
const publishBundles = read("scripts/publish-bundles.js");
const surface = JSON.parse(read("apps/os/src/cohort-surface.json"));

const webPerson = between(web, "function renderPersonDetail", "function renderTeamDetail", "web person detail");
const webTeam = between(web, "function renderTeamDetail", "function renderDetail(rec)", "web team detail");

const osDetailHelpers = between(os, "function detailItems", "function renderTimelineMissingDetail", "os detail helpers");
const osTeam = between(os, "function renderTeamDetail(team)", "function wirePlateFoil", "os team detail");
const osPerson = between(os, "function renderPersonDetail(person)", "function wirePersonLinks", "os person detail");
const generatedPersonFields = between(cohortSource, "const GENERATED_PERSON_READ_FIELDS = [", "];", "generated person fields");
const generatedTeamFields = between(cohortSource, "const GENERATED_TEAM_READ_FIELDS = [", "];", "generated team fields");

const personFields = [
  "bio_md",
  "weekly_intention",
  "comm_style",
  "availability_pref",
  "working_style",
  "best_contexts",
  "contribute_interests",
  "go_to_them_for",
  "seeking",
  "offering",
  "recurring_themes",
  "prior_work",
  "making_signature",
  "person_timeline",
];

const teamFields = [
  "traction",
  "prior_shipping",
  "paper_basis",
  "hackathon_note",
  "journey",
  "team_timeline",
  "seeking",
  "offering",
];

const electronOnlyTeamFields = [
  "weekly_goals",
  "monthly_milestones",
  "graduation_target",
  "dependencies",
];

const aliases = {
  person_timeline: ["person_timeline", 'renderRecordTimeline("person"'],
  team_timeline: ["team_timeline", 'renderRecordTimeline("team"'],
};

function hasToken(scope, field) {
  const needles = aliases[field] || [field];
  return needles.some(needle => scope.includes(needle));
}

const failures = [];

for (const field of personFields) {
  if (!hasToken(webPerson, field) && !hasToken(web, field)) {
    failures.push(`web person detail no longer references ${field}; update parity list if intentional`);
  }
  const osScope = `${osPerson}\n${osDetailHelpers}`;
  if (!hasToken(osScope, field)) {
    failures.push(`Electron person detail does not reference shared field ${field}`);
  }
}

for (const field of teamFields) {
  if (!hasToken(webTeam, field) && !hasToken(web, field)) {
    failures.push(`web team detail no longer references ${field}; update parity list if intentional`);
  }
  const osScope = `${osTeam}\n${osDetailHelpers}`;
  if (!hasToken(osScope, field)) {
    failures.push(`Electron team detail does not reference shared field ${field}`);
  }
}

for (const field of electronOnlyTeamFields) {
  const osScope = `${osTeam}\n${osDetailHelpers}`;
  if (!hasToken(osScope, field)) {
    failures.push(`Electron team detail does not reference Electron dossier field ${field}`);
  }
}

for (const field of ["person_timeline", "team_timeline"]) {
  if (!hasToken(cohortSource, field)) {
    failures.push(`Electron cohort-source data boundary does not preserve generated field ${field}`);
  }
}

if (!cohortSource.includes("mergeGeneratedReadModels")) {
  failures.push("Electron cohort-source data boundary does not merge generated profile/team read models");
}

if (!cohortSource.includes("function extractPublicPersonBio") || !cohortSource.includes('expectedType === "person"')) {
  failures.push("Electron GitHub loader must derive person bio_md from live markdown bodies before generated fallback hydration");
}

if (!publishBundles.includes('"dependency", "dependencies"') || !publishBundles.includes("schema.dependencies?.surface_fields")) {
  failures.push("signed cohort.surface publisher must include dependency records because relationship insights depend on them");
}

if (!publishBundles.includes("function extractPublicPersonBio") || !publishBundles.includes("payload.bio_md = bio")) {
  failures.push("signed cohort.surface publisher must derive person bio_md from markdown bodies");
}

if (!web.includes("function renderRelationshipList") || !web.includes("dependencyRecords") || !webTeam.includes("relationships")) {
  failures.push("web team detail must surface typed dependency relationship records, not only legacy team.dependencies");
}

for (const helper of ["cohortRosterForTeam", "cohortRosterSummary", "compactCohortLinkItems"]) {
  if (!packageShapeUiIndex.includes(helper) || !packageShapeUiCohortCard.includes(`export function ${helper}`)) {
    failures.push(`tracked shape-ui package must export ${helper}; web vendor copy is generated from packages/shape-ui`);
  }
  if ((webShapeUiIndex || webShapeUiCohortCard) && (!webShapeUiIndex.includes(helper) || !webShapeUiCohortCard.includes(`export function ${helper}`))) {
    failures.push(`local web vendored shape-ui must export ${helper}; run npm run vendor:web after changing packages/shape-ui`);
  }
}

for (const field of personFields.filter(field => field !== "person_timeline")) {
  if (generatedPersonFields.includes(`"${field}"`)) {
    failures.push(`Electron cohort-source must not hydrate source-owned person field ${field} from generated surface`);
  }
}

for (const field of [...teamFields.filter(field => field !== "team_timeline"), ...electronOnlyTeamFields]) {
  if (generatedTeamFields.includes(`"${field}"`)) {
    failures.push(`Electron cohort-source must not hydrate source-owned team field ${field} from generated surface`);
  }
}

if (!osTeam.includes("journeyAssessed(team)") || !osTeam.includes("not explicitly assessed in this snapshot")) {
  failures.push("Electron team detail must label missing historical PMF journey reads instead of rendering default stage/evidence as assessed data");
}

if (failures.length) {
  console.error("[cohort-detail-parity] failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const personCounts = Object.fromEntries(personFields.map(field => [field, countSurfaceField("person", field)]));
const teamCounts = Object.fromEntries([...teamFields, ...electronOnlyTeamFields].map(field => [field, countSurfaceField("team", field)]));

console.log("[cohort-detail-parity] OK");
console.log(`[cohort-detail-parity] people fields: ${JSON.stringify(personCounts)}`);
console.log(`[cohort-detail-parity] team fields: ${JSON.stringify(teamCounts)}`);
