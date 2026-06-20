const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const awardScaffold = require("./cohort-award-scaffold.cjs");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");
const GENERATED_BY = "scripts/lib/cohort-insight-engine.cjs";
const INSIGHT_SCHEMA_VERSION = 1;
const PUBLIC_SOURCE_BOUNDARY = "public_bundle";
const COHORT_SURFACE = "cohort";

function asArray(value) {
  if (Array.isArray(value)) return value.filter(item => item != null && String(item).trim() !== "");
  return value == null || String(value).trim() === "" ? [] : [value];
}

function compactText(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : "";
}

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

function parseMarkdown(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: null, body: raw };
  let frontmatter;
  try {
    frontmatter = yaml.load(match[1]);
  } catch (error) {
    throw new Error(`bad YAML in ${file}: ${error.message}`);
  }
  return { frontmatter, body: match[2] };
}

function pickSurface(obj, whitelist) {
  const out = {};
  for (const key of whitelist || []) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, key)) out[key] = obj[key];
  }
  return out;
}

function loadDir(root, folder, recordType, surfaceFields) {
  const dir = path.join(root, "cohort-data", folder);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const fileName of fs.readdirSync(dir).filter(file => file.endsWith(".md")).sort()) {
    const file = path.join(dir, fileName);
    const { frontmatter } = parseMarkdown(file);
    if (!frontmatter || frontmatter.record_type !== recordType || !frontmatter.record_id) continue;
    rows.push(pickSurface(frontmatter, surfaceFields));
  }
  return rows.sort((a, b) => String(a.record_id || "").localeCompare(String(b.record_id || "")));
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listJsonFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function progressArtifactKey(artifact) {
  const repo = String(
    artifact.source_repo
      || artifact.sourceRepo
      || artifact.repository
      || artifact.repo
      || "",
  ).trim().toLowerCase();
  return `${artifact.record_id}|${repo}|${isoDate(artifact.date || artifact.week_start)}`;
}

function preferProgressArtifact(existing, candidate) {
  if (!existing) return candidate;
  if (existing.review_status !== "reviewed" && candidate.review_status === "reviewed") return candidate;
  return existing;
}

function sortProgressArtifacts(a, b) {
  const dateCompare = isoDate(b.date || b.week_start).localeCompare(isoDate(a.date || a.week_start));
  if (dateCompare) return dateCompare;
  return String(a.artifact_id || "").localeCompare(String(b.artifact_id || ""));
}

function loadGithubProgressArtifacts(root = DEFAULT_REPO_ROOT) {
  const dir = path.join(root, "cohort-data", "artifacts", "github-progress");
  const byKey = new Map();
  for (const file of listJsonFilesRecursive(dir)) {
    let artifact = null;
    try {
      artifact = readJson(file);
    } catch {
      continue;
    }
    if (artifact?.artifact_kind !== "github_progress_weekly_summary") continue;
    if (artifact.record_type !== "team" || !artifact.record_id) continue;
    const key = progressArtifactKey(artifact);
    byKey.set(key, preferProgressArtifact(byKey.get(key), artifact));
  }
  return [...byKey.values()].sort(sortProgressArtifacts);
}

function loadGithubReleaseArtifacts(root = DEFAULT_REPO_ROOT) {
  const dir = path.join(root, "cohort-data", "artifacts", "github-releases");
  return listJsonFilesRecursive(dir)
    .map(file => {
      try {
        return readJson(file);
      } catch {
        return null;
      }
    })
    .filter(artifact => artifact?.artifact_kind === "github_release_list")
    .filter(artifact => artifact.record_type === "team" && artifact.record_id)
    .sort((a, b) => String(a.artifact_id || "").localeCompare(String(b.artifact_id || "")));
}

function loadCohortInsightInputs({ root = DEFAULT_REPO_ROOT } = {}) {
  const schema = yaml.load(fs.readFileSync(path.join(root, "cohort-data", "schema.yml"), "utf8"));
  if (!schema || schema.schema_version !== 1) throw new Error("unsupported cohort schema_version");
  return {
    teams: loadDir(root, "teams", "team", schema.teams?.surface_fields || []),
    clusters: loadDir(root, "clusters", "cluster", schema.clusters?.surface_fields || []),
    dependencies: loadDir(root, "dependencies", "dependency", schema.dependencies?.surface_fields || []),
    githubProgressArtifacts: loadGithubProgressArtifacts(root),
    githubReleaseArtifacts: loadGithubReleaseArtifacts(root),
    editorialCategories: awardScaffold.loadEditorialAwardCategories(root),
  };
}

function sourceRef(kind, extra = {}) {
  return { kind, ...extra };
}

function makeInsightCard({
  id,
  kind,
  subjectType,
  subjectIds,
  title,
  claimText,
  summary,
  evidenceLevel,
  confidence,
  sourceRefs,
  contentJson,
  surfaceTier = COHORT_SURFACE,
  reviewStatus = "generated",
  approvalState = "not_reviewed",
}) {
  return {
    schema_version: INSIGHT_SCHEMA_VERSION,
    id,
    kind,
    subject_type: subjectType,
    subject_ids: asArray(subjectIds).map(String),
    title: compactText(title, 120),
    claim_text: compactText(claimText, 280),
    summary: compactText(summary, 320),
    evidence_level: evidenceLevel,
    confidence,
    surface_tier: surfaceTier,
    source_boundary: PUBLIC_SOURCE_BOUNDARY,
    review_status: reviewStatus,
    approval_state: approvalState,
    raw_allowed: false,
    source_refs: asArray(sourceRefs),
    content_json: contentJson && typeof contentJson === "object" ? contentJson : {},
    generated_by: GENERATED_BY,
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of asArray(items)) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function usefulCommitCount(artifact) {
  const evidence = artifact?.evidence || {};
  const useful = Number(evidence.useful_commit_count);
  if (Number.isFinite(useful)) return useful;
  const human = Number(evidence.human_commit_count);
  if (Number.isFinite(human)) return human;
  const total = Number(evidence.commit_count);
  return Number.isFinite(total) ? total : 0;
}

function releaseRows(artifact) {
  return asArray(artifact?.releases)
    .map(release => ({
      tag: release.tag_name || release.name || "",
      name: release.name || release.tag_name || "",
      published_at: release.published_at || "",
      url: release.html_url || release.url || "",
    }))
    .filter(release => release.name || release.tag)
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value, 260);
    if (text) return text;
  }
  return "";
}

const PROJECT_DOMAIN_LABELS = {
  tee: "trusted compute",
  ai: "agent infrastructure",
  crypto: "crypto",
  "app-ux": "application UX",
  "bd-gtm": "go-to-market",
};

function identityDomainLabel(value) {
  const key = String(value || "").toLowerCase();
  return PROJECT_DOMAIN_LABELS[key] || compactText(value, 60);
}

// Company-type label -> grammatical noun phrase with article: "Infra" -> "an infra
// project", "AI" -> "an AI project", "B2B" -> "a B2B project". Title-case words are
// lowercased so they read as categories mid-sentence; all-caps acronyms and tokens
// with digits are preserved so "AI"/"B2B" never read as typos.
function companyTypePhrase(companyType) {
  const raw = compactText(companyType, 60);
  if (!raw) return "";
  const word = /\d/.test(raw) || (raw.length <= 4 && raw === raw.toUpperCase())
    ? raw
    : raw.toLowerCase();
  const article = /^[aeiou]/i.test(word) ? "an" : "a";
  return `${article} ${word} project`;
}

// Strip the middle-dot/pipe secondary clause and any trailing full sentence so a
// "·"-joined or sentence-shaped focus reads cleanly inside prose:
// "formal verification · dstack TEE Postgres" -> "formal verification".
function focusFirstClause(focus) {
  let text = compactText(focus, 160);
  if (!text) return "";
  text = text.split("·")[0].split("|")[0].trim();
  const sentenceCut = text.search(/[.?!]\s/);
  if (sentenceCut > 0) text = text.slice(0, sentenceCut).trim();
  text = text.replace(/[.?!]+$/, "").trim();
  // A focus written as a full sentence ("Shake is a social network app ...") is not a
  // usable topic for "focused on ___"; drop it so the label falls back to the
  // company-type + domain form instead of emitting "focused on Shake is a ...".
  if (/^\S+\s+is\s+(a|an|the|not)\b/i.test(text)) return "";
  return text;
}

// Turn a declared solution/intent into a grammatical predicate for "it ___":
// a known imperative lead becomes third-person present ("build" -> "builds"); any
// other shape (a noun phrase) is introduced with "provides" so "it ___" stays valid.
const ACTION_VERB_MAP = {
  build: "builds", builds: "builds", make: "makes", makes: "makes",
  create: "creates", creates: "creates", enable: "enables", enables: "enables",
  offer: "offers", offers: "offers", provide: "provides", provides: "provides",
  explore: "explores", explores: "explores", productize: "productizes",
  productizes: "productizes", run: "runs", runs: "runs", turn: "turns", turns: "turns",
  power: "powers", powers: "powers", deliver: "delivers", delivers: "delivers",
};
function actionPredicate(rawDoes) {
  const text = compactText(rawDoes, 220);
  if (!text) return "";
  const match = /^([a-z][a-z-]*)\b/.exec(text);
  const lead = match ? match[1].toLowerCase() : "";
  if (lead && ACTION_VERB_MAP[lead]) {
    // Conjugate a second imperative joined by "and"/"&" too, so compound
    // imperatives ("make X and explore Y") don't leave a bare verb dangling.
    const rest = text.slice(match[1].length).replace(
      /\b(and|&)\s+([a-z][a-z-]*)\b/g,
      (whole, conj, verb) => (ACTION_VERB_MAP[verb.toLowerCase()] ? `${conj} ${ACTION_VERB_MAP[verb.toLowerCase()]}` : whole),
    );
    return `${ACTION_VERB_MAP[lead]} ${rest.trim()}`.trim();
  }
  return `provides ${text}`;
}

function teamKindLabel(team, { includeFocus = true } = {}) {
  const journey = team?.journey || {};
  const typePhrase = companyTypePhrase(journey.company_type);
  const domain = identityDomainLabel(team?.domain);
  const focus = includeFocus ? focusFirstClause(team?.focus) : "";
  if (typePhrase && domain && focus) return `${typePhrase} in ${domain} focused on ${focus}`;
  if (typePhrase && focus) return `${typePhrase} focused on ${focus}`;
  if (domain && focus) return `a project in ${domain} focused on ${focus}`;
  if (focus) return `a project focused on ${focus}`;
  if (typePhrase && domain) return `${typePhrase} in ${domain}`;
  if (typePhrase) return typePhrase;
  if (domain) return `a project in ${domain}`;
  return "a cohort project";
}

function teamActivity(team, progressByTeam, releasesByTeam) {
  const progress = asArray(progressByTeam.get(team.record_id)).slice().sort(sortProgressArtifacts);
  const releaseArtifacts = asArray(releasesByTeam.get(team.record_id));
  const releases = releaseArtifacts
    .flatMap(releaseRows)
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
  const latest = progress[0] || null;
  const observed = Boolean(latest || releases.length);
  const totalUsefulCommits = progress.reduce((sum, artifact) => sum + usefulCommitCount(artifact), 0);
  const releaseNames = releases.slice(0, 3).map(release => release.name || release.tag).filter(Boolean);
  return { progress, releaseArtifacts, releases, latest, observed, totalUsefulCommits, releaseNames };
}

// One per-team card carries BOTH a grammar-correct identity lead (what it is / does /
// who it serves) and the say -> did -> shipped public-proof strip. This replaces the
// former separate project_identity card: identity and proof are one read, derived once
// from the same public cohort fields + GitHub/release artifacts (no duplicate compute).
function buildSayDidShippedCards({ teams = [], githubProgressArtifacts = [], githubReleaseArtifacts = [] } = {}) {
  const progressByTeam = groupBy(githubProgressArtifacts, artifact => artifact.record_id);
  const releasesByTeam = groupBy(githubReleaseArtifacts, artifact => artifact.record_id);
  return asArray(teams)
    .filter(team => team?.record_id)
    .slice()
    .sort((a, b) => String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)))
    .map((team) => {
      const act = teamActivity(team, progressByTeam, releasesByTeam);
      const journey = team.journey || {};
      const name = team.name || team.record_id;

      const whatItDoes = actionPredicate(firstText(journey.solution, team.now, team.weekly_goals, focusFirstClause(team.focus)));
      // Avoid the "focused on X ... provides an X" stutter: drop the focus clause
      // from the identity lead only when the predicate already LEADS with that exact
      // focus phrase (e.g. "...focused on P2P LLM router; it provides a P2P LLM router").
      const focusClause = focusFirstClause(team.focus);
      const stutters = Boolean(focusClause)
        && new RegExp(`^[a-z]+\\s+(a|an|the)\\s+${focusClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(whatItDoes);
      const whatItIs = teamKindLabel(team, { includeFocus: !stutters });
      const whoItServes = firstText(journey.icp);

      const latestExamples = asArray(act.latest?.evidence?.examples).slice(0, 3);
      // did/shipped prefer OBSERVED public artifacts (GitHub). For the ~2/3 of teams
      // with no tracked repo, fall back to the team's own DECLARED public fields
      // (traction / next milestone / prior shipping) rather than an empty card — marked
      // "Declared" so it never reads as observed. Transcript-derived did/shipped is a
      // RUNTIME concern (gated Supabase view); it must NOT be baked into this committed
      // public bundle (source_boundary: public_bundle).
      const declaredDid = firstText(team.traction, team.journey?.next_milestone);
      const did = act.latest
        ? compactText(act.latest.summary || latestExamples.join("; "), 220)
        : declaredDid
          ? `Declared (no public artifact yet): ${declaredDid}`
          : "No reviewed GitHub progress artifact is attached to this project yet.";
      const declaredShipped = asArray(team.prior_shipping).filter(Boolean).join("; ");
      const shipped = act.releases.length
        ? act.releaseNames.join("; ")
        : act.observed
          ? "GitHub movement observed; no release artifact observed."
          : declaredShipped
            ? `Declared: ${compactText(declaredShipped, 200)}`
            : "No public release artifact observed.";
      const didBasis = act.latest ? "github_progress" : declaredDid ? "declared" : "none";
      const shippedBasis = act.releases.length ? "github_release" : declaredShipped ? "declared" : "none";
      const say = compactText(team.now || team.weekly_goals || focusFirstClause(team.focus) || "", 220);

      const refs = [
        sourceRef("team_record", {
          record_id: team.record_id,
          path: `cohort-data/teams/${team.record_id}.md`,
        }),
        ...act.progress.slice(0, 4).map(artifact => sourceRef("github_progress_artifact", {
          artifact_id: artifact.artifact_id || "",
          record_id: artifact.record_id,
          week_start: isoDate(artifact.week_start || artifact.date),
          source_repo: artifact.source_repo || "",
        })),
        ...act.releaseArtifacts.slice(0, 2).map(artifact => sourceRef("github_release_artifact", {
          artifact_id: artifact.artifact_id || "",
          record_id: artifact.record_id,
          source_repo: artifact.source_repo || "",
        })),
      ];

      return makeInsightCard({
        id: `cohort-insight:say-did-shipped:${slugPart(team.record_id)}`,
        kind: "say_did_shipped",
        subjectType: "team",
        subjectIds: [team.record_id],
        title: `${name}: say / did / shipped`,
        claimText: `${name} is ${whatItIs}; it ${whatItDoes || "has not declared its work clearly enough yet"}.`,
        summary: whoItServes
          ? `${name} serves ${whoItServes}. Public trace: ${act.observed ? did : "currently unobserved."}`
          : `${compactText(say, 120) || "No current intent declared."} Public trace: ${act.observed ? did : "currently unobserved."}`,
        evidenceLevel: act.observed ? "observed_public_metadata" : "declared_only",
        confidence: act.observed ? "medium" : "low",
        sourceRefs: refs,
        contentJson: {
          what_it_is: whatItIs,
          what_it_does: whatItDoes,
          who_it_serves: whoItServes,
          say,
          did,
          did_basis: didBasis,
          shipped,
          shipped_basis: shippedBasis,
          observed_status: act.observed ? "public_signal_observed" : "unobserved",
          public_activity: {
            observed_status: act.observed ? "public_signal_observed" : "declared_only",
            latest_week_start: isoDate(act.latest?.week_start || act.latest?.date),
            progress_artifact_count: act.progress.length,
            release_artifact_count: act.releaseArtifacts.length,
            release_count: act.releases.length,
            useful_commit_count: act.totalUsefulCommits,
          },
        },
      });
    });
}

function normalizedSet(value) {
  return new Set(asArray(value).map(item => String(item).trim().toLowerCase()).filter(Boolean));
}

function intersection(a, b) {
  const out = [];
  for (const item of a || []) if (b?.has(item)) out.push(item);
  return out.sort((x, y) => x.localeCompare(y));
}

function primaryClusterByTeam(clusters = []) {
  const out = new Map();
  for (const cluster of asArray(clusters)) {
    for (const teamId of asArray(cluster.teams)) {
      if (!out.has(teamId)) {
        out.set(teamId, {
          id: cluster.record_id || "",
          label: cluster.label || cluster.name || cluster.record_id || "",
        });
      }
    }
  }
  return out;
}

function unorderedPairKey(a, b) {
  return String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`;
}

function existingDependencyPairs(teams = [], dependencies = []) {
  const pairs = new Set();
  for (const dep of asArray(dependencies)) {
    if (dep?.source && dep?.target && dep.source !== dep.target) pairs.add(unorderedPairKey(dep.source, dep.target));
  }
  for (const team of asArray(teams)) {
    for (const target of asArray(team.dependencies)) {
      if (team.record_id && target && team.record_id !== target) pairs.add(unorderedPairKey(team.record_id, target));
    }
  }
  return pairs;
}

const OVERLAP_STOPWORDS = new Set([
  "about", "across", "agent", "agents", "build", "building", "cohort", "current", "data",
  "demo", "first", "help", "need", "needs", "project", "public", "ship", "team", "teams",
  "that", "their", "this", "user", "users", "with", "working",
]);

function overlapTokens(team) {
  const values = [
    team.domain,
    team.focus,
    team.now,
    asArray(team.seeking).join(" "),
    asArray(team.offering).join(" "),
    asArray(team.paper_basis).join(" "),
    team.journey?.problem,
    team.journey?.solution,
    team.journey?.next_milestone,
  ];
  const out = new Set();
  for (const value of values) {
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(token => token.length >= 4 && !OVERLAP_STOPWORDS.has(token))
      .forEach(token => out.add(token));
  }
  return out;
}

function scoreLatentOverlap({ sharedSkills, domainMatch, commonDependencies, sharedTokens }) {
  const score = (sharedSkills.length * 22)
    + (domainMatch ? 18 : 0)
    + (commonDependencies.length * 16)
    + Math.min(24, sharedTokens.length * 3);
  return Math.min(100, Math.round(score));
}

function confidenceForLatentScore(score) {
  if (score >= 80) return "medium";
  if (score >= 55) return "low-medium";
  return "low";
}

function latentReasonList({ sharedSkills, domainMatch, commonDependencies, sharedTokens, a, b }) {
  const reasons = [];
  if (sharedSkills.length) reasons.push(`shared skill areas: ${sharedSkills.slice(0, 5).join(", ")}`);
  if (domainMatch) reasons.push(`same declared domain: ${a.domain}`);
  if (commonDependencies.length) reasons.push(`shared dependency targets: ${commonDependencies.slice(0, 4).join(", ")}`);
  if (sharedTokens.length) reasons.push(`shared public terms: ${sharedTokens.slice(0, 5).join(", ")}`);
  return reasons;
}

function buildLatentOverlapCards({ teams = [], clusters = [], dependencies = [], limit = 40 } = {}) {
  const teamList = asArray(teams).filter(team => team?.record_id);
  const clusterByTeam = primaryClusterByTeam(clusters);
  const existingPairs = existingDependencyPairs(teamList, dependencies);
  const skillSets = new Map(teamList.map(team => [team.record_id, normalizedSet(team.skill_areas)]));
  const dependencySets = new Map(teamList.map(team => [team.record_id, normalizedSet(team.dependencies)]));
  const tokenSets = new Map(teamList.map(team => [team.record_id, overlapTokens(team)]));
  const cards = [];

  for (let i = 0; i < teamList.length; i += 1) {
    for (let j = i + 1; j < teamList.length; j += 1) {
      const a = teamList[i];
      const b = teamList[j];
      const pairKey = unorderedPairKey(a.record_id, b.record_id);
      if (existingPairs.has(pairKey)) continue;

      const aCluster = clusterByTeam.get(a.record_id) || { id: "_unclustered", label: "unclustered" };
      const bCluster = clusterByTeam.get(b.record_id) || { id: "_unclustered", label: "unclustered" };
      if (aCluster.id && bCluster.id && aCluster.id === bCluster.id) continue;

      const sharedSkills = intersection(skillSets.get(a.record_id), skillSets.get(b.record_id));
      const domainMatch = Boolean(a.domain && b.domain && String(a.domain).toLowerCase() === String(b.domain).toLowerCase());
      const commonDependencies = intersection(dependencySets.get(a.record_id), dependencySets.get(b.record_id))
        .filter(id => id !== a.record_id && id !== b.record_id);
      const sharedTokens = intersection(tokenSets.get(a.record_id), tokenSets.get(b.record_id))
        .filter(token => !sharedSkills.includes(token))
        .slice(0, 8);
      const score = scoreLatentOverlap({ sharedSkills, domainMatch, commonDependencies, sharedTokens });
      if (score < 35) continue;

      const reasons = latentReasonList({ sharedSkills, domainMatch, commonDependencies, sharedTokens, a, b });
      if (!reasons.length) continue;
      const aName = a.name || a.record_id;
      const bName = b.name || b.record_id;
      // Dedupe case-insensitively: a shared skill ("tee") and the shared domain
      // ("tee") both feed the signal, which used to render "...around tee, tee".
      const signal = [...new Map(
        [
          ...sharedSkills,
          domainMatch ? a.domain : "",
          ...commonDependencies,
          ...sharedTokens,
        ].filter(Boolean).map((token) => [String(token).toLowerCase(), token]),
      ).values()].slice(0, 4).join(", ");
      cards.push(makeInsightCard({
        id: `cohort-insight:latent-overlap:${slugPart(a.record_id)}:${slugPart(b.record_id)}`,
        kind: "latent_overlap",
        subjectType: "team_pair",
        subjectIds: [a.record_id, b.record_id],
        title: `${aName} / ${bName}: latent overlap`,
        claimText: `${aName} and ${bName} have an undeclared public-data overlap around ${signal || "shared cohort signals"}.`,
        summary: `No direct dependency record exists; the engine found ${reasons.slice(0, 2).join("; ")}.`,
        evidenceLevel: "inferred_public_metadata",
        confidence: confidenceForLatentScore(score),
        sourceRefs: [
          sourceRef("team_record", { record_id: a.record_id, path: `cohort-data/teams/${a.record_id}.md` }),
          sourceRef("team_record", { record_id: b.record_id, path: `cohort-data/teams/${b.record_id}.md` }),
          sourceRef("cluster_record", { record_id: aCluster.id, label: aCluster.label }),
          sourceRef("cluster_record", { record_id: bCluster.id, label: bCluster.label }),
        ],
        contentJson: {
          score,
          clusters: {
            [a.record_id]: aCluster,
            [b.record_id]: bCluster,
          },
          shared_skill_areas: sharedSkills,
          shared_domain: domainMatch ? a.domain : "",
          shared_dependency_targets: commonDependencies,
          shared_public_terms: sharedTokens,
          reasons,
          existing_dependency: false,
          suggested_actions: [
            "verify overlap with the teams",
            "stage an intro if both sides want it",
            "create a dependency record if the overlap is real",
            "dismiss as false positive",
          ],
        },
      }));
    }
  }

  return cards.sort((a, b) => {
    const scoreCompare = (b.content_json?.score || 0) - (a.content_json?.score || 0);
    if (scoreCompare) return scoreCompare;
    return a.title.localeCompare(b.title);
  }).slice(0, limit);
}

// GitHub-attested cross-team collaboration edges. The github-progress audit attaches
// a repo-level `collaboration.possible_cross_team_contributions` snapshot to each weekly
// summary artifact: cohort members whose commits land on a repo linked to a DIFFERENT
// team than their own. That snapshot is replicated across every weekly artifact for the
// repo, so we dedupe on (repo, person, direction) before aggregating per unordered team
// pair. Unlike latent_overlap (an INFERRED structural similarity), these edges are
// OBSERVED public-commit authorship — but still confidence medium/low because the
// author→person match is itself heuristic (github-noreply email = medium, exact name = low).
function collaborationEdgeConfidence(contributions) {
  return contributions.some(contrib => contrib.confidence === "medium") ? "medium" : "low";
}

function buildCollaborationEdgeCards({ teams = [], githubProgressArtifacts = [], limit = 40 } = {}) {
  const teamById = new Map(
    asArray(teams).filter(team => team?.record_id).map(team => [String(team.record_id).toLowerCase(), team]),
  );
  // pairKey -> Map(fingerprint -> contribution); the inner map dedupes the repo-level
  // snapshot that the audit replicates into each weekly artifact for the same repo.
  const edges = new Map();

  for (const artifact of asArray(githubProgressArtifacts)) {
    if (artifact?.artifact_kind && artifact.artifact_kind !== "github_progress_weekly_summary") continue;
    const collaboration = artifact?.collaboration || {};
    const repo = String(artifact?.source_repo || "").trim().toLowerCase();
    const artifactId = artifact?.artifact_id || "";
    const weekStart = isoDate(artifact?.week_start || artifact?.date);
    for (const contrib of asArray(collaboration.possible_cross_team_contributions)) {
      const personId = String(contrib?.person_id || "").trim();
      if (!personId) continue;
      const personName = compactText(contrib?.person_name || personId, 80);
      const personTeams = [...new Set(asArray(contrib?.person_team_ids).map(id => String(id).toLowerCase()).filter(Boolean))];
      const repoTeams = [...new Set(asArray(contrib?.repo_team_ids).map(id => String(id).toLowerCase()).filter(Boolean))];
      const commitCount = Number(contrib?.commit_count) || 0;
      const confidence = String(contrib?.confidence || "low").toLowerCase();
      const examples = asArray(contrib?.examples)
        .map(example => compactText(example?.subject || example, 120))
        .filter(Boolean)
        .slice(0, 2);
      for (const fromTeam of personTeams) {
        for (const toTeam of repoTeams) {
          // Only real, distinct cohort teams form an edge. fromTeam = the contributor's
          // own team; toTeam = the team whose public repo received the commits.
          if (fromTeam === toTeam) continue;
          if (!teamById.has(fromTeam) || !teamById.has(toTeam)) continue;
          const pairKey = unorderedPairKey(fromTeam, toTeam);
          if (!edges.has(pairKey)) edges.set(pairKey, new Map());
          const contributions = edges.get(pairKey);
          const fingerprint = `${repo}|${personId}|${fromTeam}|${toTeam}`;
          const existing = contributions.get(fingerprint);
          // A contributor committing across N weeks appears in N replicated snapshots,
          // each carrying the same repo-level total; keep the largest, never sum.
          if (!existing || commitCount > existing.commit_count) {
            contributions.set(fingerprint, {
              person_id: personId,
              person_name: personName,
              from_team: fromTeam,
              to_team: toTeam,
              repo,
              commit_count: commitCount,
              confidence,
              examples,
              artifact_id: artifactId,
              week_start: weekStart,
            });
          }
        }
      }
    }
  }

  const cards = [];
  for (const [pairKey, contributionMap] of edges) {
    const contributions = [...contributionMap.values()];
    if (!contributions.length) continue;
    const [teamAId, teamBId] = pairKey.split("|");
    const aName = teamById.get(teamAId)?.name || teamAId;
    const bName = teamById.get(teamBId)?.name || teamBId;
    const totalCommits = contributions.reduce((sum, contrib) => sum + contrib.commit_count, 0);
    const contributors = [...new Set(contributions.map(contrib => contrib.person_name))];
    const repos = [...new Set(contributions.map(contrib => contrib.repo).filter(Boolean))];
    const confidence = collaborationEdgeConfidence(contributions);

    // Roll the deduped contributions up by direction (who committed to whose repo) so a
    // bidirectional pair reads as two clear arrows instead of a flattened blob.
    const directions = [...groupBy(contributions, contrib => `${contrib.from_team}->${contrib.to_team}`).entries()]
      .map(([dirKey, list]) => {
        const [fromTeam, toTeam] = dirKey.split("->");
        return {
          from_team: fromTeam,
          to_team: toTeam,
          from_team_name: teamById.get(fromTeam)?.name || fromTeam,
          to_team_name: teamById.get(toTeam)?.name || toTeam,
          contributors: [...new Set(list.map(contrib => contrib.person_name))],
          repos: [...new Set(list.map(contrib => contrib.repo).filter(Boolean))],
          commit_count: list.reduce((sum, contrib) => sum + contrib.commit_count, 0),
        };
      })
      .sort((a, b) => b.commit_count - a.commit_count
        || `${a.from_team}->${a.to_team}`.localeCompare(`${b.from_team}->${b.to_team}`));

    const claimText = directions.length === 1
      ? `${directions[0].contributors.join(", ")} (${directions[0].from_team_name}) committed to ${directions[0].to_team_name}'s public repo (${totalCommits} commit${totalCommits === 1 ? "" : "s"}).`
      : `${contributors.length} cohort contributor${contributors.length === 1 ? "" : "s"} link ${aName} and ${bName} through ${repos.length} shared public repo${repos.length === 1 ? "" : "s"} (${totalCommits} commit${totalCommits === 1 ? "" : "s"}).`;

    cards.push(makeInsightCard({
      id: `cohort-insight:collaboration-edge:${slugPart(teamAId)}:${slugPart(teamBId)}`,
      kind: "collaboration_edge",
      subjectType: "team_pair",
      subjectIds: [teamAId, teamBId],
      title: `${aName} / ${bName}: GitHub collaboration`,
      claimText,
      summary: `Observed public-GitHub cross-team contribution: ${directions.map(dir => `${dir.contributors.join(", ")} (${dir.from_team_name}) → ${dir.to_team_name}`).join("; ")}.`,
      evidenceLevel: "observed_public_metadata",
      confidence,
      sourceRefs: [
        sourceRef("team_record", { record_id: teamAId, path: `cohort-data/teams/${teamAId}.md` }),
        sourceRef("team_record", { record_id: teamBId, path: `cohort-data/teams/${teamBId}.md` }),
        ...contributions
          .filter(contrib => contrib.artifact_id)
          .slice(0, 6)
          .map(contrib => sourceRef("github_progress_artifact", {
            artifact_id: contrib.artifact_id,
            source_repo: contrib.repo,
            week_start: contrib.week_start,
          })),
      ],
      contentJson: {
        team_pair: [teamAId, teamBId],
        total_commit_count: totalCommits,
        contributor_count: contributors.length,
        contributors,
        repos,
        directions,
        evidence_basis: "public_github_commit_authorship",
        suggested_actions: [
          "confirm the cross-team contribution with both teams",
          "record a dependency or collaboration if the work is ongoing",
          "dismiss as a false positive if the commit-author match is wrong",
        ],
      },
    }));
  }

  return cards
    .sort((a, b) => (b.content_json?.total_commit_count || 0) - (a.content_json?.total_commit_count || 0)
      || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function buildRotationReadModel() {
  return {
    status: "not_generated",
    reason: "Rotation cards require a reviewed semantic-distance pass over baseline/current declared state plus app-safe evidence. The deterministic public bundle does not create those judgments.",
    output_kind: "rotation",
    max_surface: COHORT_SURFACE,
    raw_allowed: false,
    required_inputs: [
      "baseline declared team state",
      "current declared team state",
      "reviewed app-safe evidence cards or public progress artifacts",
      "model judgment with provenance and review_status",
    ],
  };
}

function indexByKind(cards) {
  const out = {};
  for (const card of asArray(cards)) {
    if (!out[card.kind]) out[card.kind] = [];
    out[card.kind].push(card.id);
  }
  return out;
}

// Helpers injected into the award scaffold module (keeps awards in their own file
// without duplicating the canonical card factory or risking a circular require).
const AWARD_HELPERS = { asArray, compactText, sourceRef, groupBy, usefulCommitCount, releaseRows };

function buildAwardCards({
  teams = [],
  dependencies = [],
  githubProgressArtifacts = [],
  githubReleaseArtifacts = [],
  editorialCategories = [],
} = {}) {
  return awardScaffold.buildAwardCards({
    teams,
    dependencies,
    githubProgressArtifacts,
    githubReleaseArtifacts,
    editorialCategories,
    makeInsightCard,
    helpers: AWARD_HELPERS,
  });
}

function buildCohortInsightBundle({
  teams = [],
  clusters = [],
  dependencies = [],
  githubProgressArtifacts = [],
  githubReleaseArtifacts = [],
  editorialCategories = [],
  generatedAt = null,
} = {}) {
  const sayDidShipped = buildSayDidShippedCards({ teams, githubProgressArtifacts, githubReleaseArtifacts });
  const latentOverlaps = buildLatentOverlapCards({ teams, clusters, dependencies });
  const collaborationEdges = buildCollaborationEdgeCards({ teams, githubProgressArtifacts });
  const awards = buildAwardCards({ teams, dependencies, githubProgressArtifacts, githubReleaseArtifacts, editorialCategories });
  const rotation = buildRotationReadModel();
  const cards = [...sayDidShipped, ...latentOverlaps, ...collaborationEdges, ...awards];
  return {
    schema_version: INSIGHT_SCHEMA_VERSION,
    artifact_kind: "cohort_insight_bundle",
    generated_by: GENERATED_BY,
    generated_at: generatedAt,
    raw_allowed: false,
    source_boundary: PUBLIC_SOURCE_BOUNDARY,
    cards,
    indices: {
      by_kind: {
        ...indexByKind(cards),
        rotation: [],
      },
      by_subject: cards.reduce((out, card) => {
        for (const subjectId of card.subject_ids || []) {
          if (!out[subjectId]) out[subjectId] = [];
          out[subjectId].push(card.id);
        }
        return out;
      }, {}),
    },
    read_models: {
      say_did_shipped: sayDidShipped,
      latent_overlaps: latentOverlaps,
      collaboration_edges: collaborationEdges,
      awards,
      rotation,
    },
    quality: {
      card_count: cards.length,
      kind_counts: {
        say_did_shipped: sayDidShipped.length,
        latent_overlap: latentOverlaps.length,
        collaboration_edge: collaborationEdges.length,
        award: awards.length,
        rotation: 0,
      },
      award_scaffold_count: awards.length,
      editorial_award_slot_count: awards.filter(card => card.content_json?.award_kind === "editorial_slot").length,
      team_count: asArray(teams).length,
      public_progress_artifact_count: asArray(githubProgressArtifacts).length,
      public_release_artifact_count: asArray(githubReleaseArtifacts).length,
      say_did_shipped_card_count: sayDidShipped.length,
      latent_overlap_candidate_count: latentOverlaps.length,
      collaboration_edge_candidate_count: collaborationEdges.length,
      unobserved_say_did_shipped_count: sayDidShipped.filter(card => card.content_json?.observed_status === "unobserved").length,
    },
    policy: {
      app_surface: "Cohort app may render generated cards with generated/review status visible.",
      public_web: "Public web should exclude cards unless surface_tier is public, review_status is published, and approval_state is approved.",
      rotation: "Do not generate or publish named-team rotation judgments without reviewed model provenance.",
      award: "The public bundle only emits award SCAFFOLDS (public-signal nominations + empty editorial slots); winners are reviewed model judgments produced by the private engine into Supabase, never named here.",
    },
  };
}

function publicCohortInsights(source) {
  const base = source && typeof source === "object" ? source : {};
  const cards = asArray(base.cards)
    .filter(card => card.surface_tier === "public" && card.review_status === "published" && card.approval_state === "approved");
  return {
    schema_version: base.schema_version || INSIGHT_SCHEMA_VERSION,
    artifact_kind: base.artifact_kind || "cohort_insight_bundle",
    generated_by: base.generated_by || GENERATED_BY,
    generated_at: base.generated_at || null,
    raw_allowed: false,
    source_boundary: PUBLIC_SOURCE_BOUNDARY,
    cards,
    indices: {
      by_kind: indexByKind(cards),
      by_subject: {},
    },
    read_models: {
      say_did_shipped: [],
      latent_overlaps: [],
      collaboration_edges: [],
      awards: [],
      rotation: buildRotationReadModel(),
    },
    quality: {
      card_count: cards.length,
      kind_counts: {
        say_did_shipped: 0,
        latent_overlap: 0,
        collaboration_edge: 0,
        award: 0,
        rotation: 0,
      },
    },
    public_web_policy: "Cohort insight cards are excluded from public web unless explicitly public, published, and approved.",
  };
}

module.exports = {
  GENERATED_BY,
  buildAwardCards,
  loadEditorialAwardCategories: awardScaffold.loadEditorialAwardCategories,
  buildCohortInsightBundle,
  buildCollaborationEdgeCards,
  buildLatentOverlapCards,
  buildRotationReadModel,
  buildSayDidShippedCards,
  loadCohortInsightInputs,
  loadGithubProgressArtifacts,
  publicCohortInsights,
};
