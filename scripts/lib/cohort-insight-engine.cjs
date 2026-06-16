const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

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

function loadGithubProgressArtifacts(root = DEFAULT_REPO_ROOT) {
  const dir = path.join(root, "cohort-data", "artifacts", "github-progress");
  return listJsonFilesRecursive(dir)
    .map(file => {
      try {
        return readJson(file);
      } catch {
        return null;
      }
    })
    .filter(artifact => artifact?.artifact_kind === "github_progress_weekly_summary")
    .filter(artifact => artifact.record_type === "team" && artifact.record_id)
    .sort((a, b) => {
      const dateCompare = isoDate(b.date || b.week_start).localeCompare(isoDate(a.date || a.week_start));
      if (dateCompare) return dateCompare;
      return String(a.artifact_id || "").localeCompare(String(b.artifact_id || ""));
    });
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

function buildSayDidShippedCards({ teams = [], githubProgressArtifacts = [], githubReleaseArtifacts = [] } = {}) {
  const progressByTeam = groupBy(githubProgressArtifacts, artifact => artifact.record_id);
  const releasesByTeam = groupBy(githubReleaseArtifacts, artifact => artifact.record_id);
  return asArray(teams)
    .filter(team => team?.record_id)
    .slice()
    .sort((a, b) => String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)))
    .map((team) => {
      const progress = asArray(progressByTeam.get(team.record_id))
        .slice()
        .sort((a, b) => {
          const dateCompare = isoDate(b.date || b.week_start).localeCompare(isoDate(a.date || a.week_start));
          if (dateCompare) return dateCompare;
          return String(a.artifact_id || "").localeCompare(String(b.artifact_id || ""));
        });
      const releaseArtifacts = asArray(releasesByTeam.get(team.record_id));
      const releases = releaseArtifacts.flatMap(releaseRows).sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
      const latest = progress[0] || null;
      const totalUsefulCommits = progress.reduce((sum, artifact) => sum + usefulCommitCount(artifact), 0);
      const observed = Boolean(latest || releases.length);
      const latestExamples = asArray(latest?.evidence?.examples).slice(0, 3);
      const did = latest
        ? compactText(latest.summary || latestExamples.join("; "), 220)
        : "No reviewed GitHub progress artifact is attached to this project yet.";
      const shipped = releases.length
        ? releases.slice(0, 3).map(release => release.name || release.tag).join("; ")
        : observed
          ? "GitHub movement observed; no release artifact observed."
          : "No public release artifact observed.";
      const say = compactText(team.now || team.weekly_goals || team.focus || "", 220);
      const refs = [
        sourceRef("team_record", {
          record_id: team.record_id,
          path: `cohort-data/teams/${team.record_id}.md`,
        }),
        ...progress.slice(0, 4).map(artifact => sourceRef("github_progress_artifact", {
          artifact_id: artifact.artifact_id || "",
          record_id: artifact.record_id,
          week_start: isoDate(artifact.week_start || artifact.date),
          source_repo: artifact.source_repo || "",
        })),
        ...releaseArtifacts.slice(0, 2).map(artifact => sourceRef("github_release_artifact", {
          artifact_id: artifact.artifact_id || "",
          record_id: artifact.record_id,
          source_repo: artifact.source_repo || "",
        })),
      ];
      const name = team.name || team.record_id;
      return makeInsightCard({
        id: `cohort-insight:say-did-shipped:${slugPart(team.record_id)}`,
        kind: "say_did_shipped",
        subjectType: "team",
        subjectIds: [team.record_id],
        title: `${name}: say / did / shipped`,
        claimText: observed
          ? `${name} has declared current intent plus observable public build or release movement.`
          : `${name} has declared intent, but the engine has no attached public GitHub or release signal yet.`,
        summary: observed
          ? `${compactText(say, 120) || "No current intent declared."} Public trace: ${did}`
          : `${compactText(say, 120) || "No current intent declared."} Public trace is currently unobserved.`,
        evidenceLevel: observed ? "observed_public_metadata" : "declared_only",
        confidence: observed ? "medium" : "low",
        sourceRefs: refs,
        contentJson: {
          say,
          did,
          shipped,
          observed_status: observed ? "public_signal_observed" : "unobserved",
          latest_week_start: isoDate(latest?.week_start || latest?.date),
          progress_artifact_count: progress.length,
          release_artifact_count: releaseArtifacts.length,
          release_count: releases.length,
          useful_commit_count: totalUsefulCommits,
          latest_examples: latestExamples,
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
      const signal = [
        ...sharedSkills,
        domainMatch ? a.domain : "",
        ...commonDependencies,
        ...sharedTokens,
      ].filter(Boolean).slice(0, 4).join(", ");
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

function buildCohortInsightBundle({
  teams = [],
  clusters = [],
  dependencies = [],
  githubProgressArtifacts = [],
  githubReleaseArtifacts = [],
  generatedAt = null,
} = {}) {
  const sayDidShipped = buildSayDidShippedCards({ teams, githubProgressArtifacts, githubReleaseArtifacts });
  const latentOverlaps = buildLatentOverlapCards({ teams, clusters, dependencies });
  const rotation = buildRotationReadModel();
  const cards = [...sayDidShipped, ...latentOverlaps];
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
      rotation,
    },
    quality: {
      card_count: cards.length,
      kind_counts: {
        say_did_shipped: sayDidShipped.length,
        latent_overlap: latentOverlaps.length,
        rotation: 0,
      },
      team_count: asArray(teams).length,
      public_progress_artifact_count: asArray(githubProgressArtifacts).length,
      public_release_artifact_count: asArray(githubReleaseArtifacts).length,
      latent_overlap_candidate_count: latentOverlaps.length,
      unobserved_say_did_shipped_count: sayDidShipped.filter(card => card.content_json?.observed_status === "unobserved").length,
    },
    policy: {
      app_surface: "Cohort app may render generated cards with generated/review status visible.",
      public_web: "Public web should exclude cards unless surface_tier is public and approval_state is approved.",
      rotation: "Do not generate or publish named-team rotation judgments without reviewed model provenance.",
    },
  };
}

function publicCohortInsights(source) {
  const base = source && typeof source === "object" ? source : {};
  const cards = asArray(base.cards)
    .filter(card => card.surface_tier === "public" && card.approval_state === "approved");
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
      rotation: buildRotationReadModel(),
    },
    quality: {
      card_count: cards.length,
      kind_counts: {
        say_did_shipped: 0,
        latent_overlap: 0,
        rotation: 0,
      },
    },
    public_web_policy: "Cohort insight cards are excluded from public web unless explicitly public-approved.",
  };
}

module.exports = {
  GENERATED_BY,
  buildCohortInsightBundle,
  buildLatentOverlapCards,
  buildRotationReadModel,
  buildSayDidShippedCards,
  loadCohortInsightInputs,
  publicCohortInsights,
};
