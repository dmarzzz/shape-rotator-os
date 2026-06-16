#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 2000;
const PRIVATE_MARKER_RE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|private-vault:|drive:\/\/|"source_artifact_id"\s*:|"storage_ref"\s*:|[A-Z]:\\Users\\|\/Users\/)/i;
const PUBLIC_FORBIDDEN_KEYS = new Set([
  "teams",
  "people",
  "team_id",
  "person_id",
  "person_record_id",
  "team_record_id",
  "source_artifact_id",
  "processing_job_id",
  "derived_artifact_id",
  "storage_ref",
  "source_hash",
  "capture_artifact_id",
]);

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readEnvFile(filePath) {
  if (!filePath) return {};
  return parseEnvText(fs.readFileSync(filePath, "utf8"));
}

function readOptions(argv = process.argv.slice(2), env = process.env) {
  const envFile = arg(argv, "--env-file", env.SHAPE_ENV_FILE || null);
  const fileEnv = readEnvFile(envFile);
  const merged = { ...env, ...fileEnv };
  return {
    envFile,
    supabaseUrl: arg(argv, "--supabase-url", merged.SUPABASE_URL || merged.SHAPE_SUPABASE_URL),
    anonKey: arg(argv, "--anon-key", merged.SUPABASE_ANON_KEY || merged.SHAPE_SUPABASE_ANON_KEY),
    serviceRoleKey: arg(argv, "--service-role-key", merged.SUPABASE_SERVICE_ROLE_KEY || merged.SHAPE_SUPABASE_SERVICE_ROLE_KEY),
    limit: Number(arg(argv, "--limit", merged.SUPABASE_EVIDENCE_AUDIT_LIMIT || DEFAULT_LIMIT)) || DEFAULT_LIMIT,
    strict: hasFlag(argv, "--strict"),
    json: hasFlag(argv, "--json"),
    help: hasFlag(argv, "--help") || hasFlag(argv, "-h"),
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/audit-supabase-evidence-cards.mjs --env-file .env.calendar.local [--json] [--strict]",
    "",
    "Audits live Supabase evidence_cards and public_transcript_evidence_cards without printing raw transcript text.",
    "",
    "Hard failures: missing public view, anonymous private-table access, T3 publication boundary violations, public rows exposing entity/provenance keys or private markers.",
    "Warnings: missing provenance links, uniform confidence, low claim/evidence-type diversity, weak people coverage, sparse week/theme coverage.",
  ].join("\n");
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function restUrl(supabaseUrl, table, query = {}) {
  const url = new URL(`${trimSlash(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return String(url);
}

function countFromContentRange(contentRange, fallback) {
  const match = String(contentRange || "").match(/\/(\d+|\*)$/);
  return match && match[1] !== "*" ? Number(match[1]) : fallback;
}

async function restSelect({
  supabaseUrl,
  key,
  table,
  select,
  query = {},
  limit = DEFAULT_LIMIT,
  fetchImpl = fetch,
}) {
  const url = restUrl(supabaseUrl, table, {
    select,
    order: query.order,
    limit,
    ...query,
  });
  const response = await fetchImpl(url, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const rows = Array.isArray(data) ? data : [];
  return {
    ok: response.ok,
    status: response.status,
    table,
    count: response.ok ? countFromContentRange(response.headers.get("content-range"), rows.length) : 0,
    rows,
    error: response.ok ? null : data,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueCount(values) {
  return new Set(values.map(normalizeText).filter(Boolean)).size;
}

function inc(map, key, amount = 1) {
  const value = String(key || "not declared");
  map[value] = (map[value] || 0) + amount;
}

function sortedCounts(map, limit = 20) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function scanForbiddenKeys(value, pathParts = []) {
  const hits = [];
  if (!value || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...scanForbiddenKeys(item, [...pathParts, String(index)])));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    const populated = Array.isArray(child) ? child.length > 0 : child != null && child !== "" && child !== false;
    if (PUBLIC_FORBIDDEN_KEYS.has(key) && populated) hits.push(nextPath.join("."));
    hits.push(...scanForbiddenKeys(child, nextPath));
  }
  return hits;
}

function rowText(row) {
  return [
    row.title,
    row.claim_text,
    row.summary,
    row.content_json ? JSON.stringify(row.content_json) : "",
  ].join(" ");
}

function privateMarkerHits(rows) {
  return rows.filter((row) => PRIVATE_MARKER_RE.test(rowText(row)));
}

function loadEntityDictionary(root = ROOT) {
  const surfacePath = path.join(root, "apps", "web", "cohort-surface.json");
  if (!fs.existsSync(surfacePath)) return [];
  const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
  const terms = [];
  for (const team of asArray(surface.teams)) {
    for (const value of [team.record_id, team.name]) {
      const text = normalizeText(value);
      if (text && text.length >= 4) terms.push({ kind: "team", value: text });
    }
  }
  for (const person of asArray(surface.people)) {
    for (const value of [person.record_id, person.name]) {
      const text = normalizeText(value);
      if (text && text.length >= 4) terms.push({ kind: "person", value: text });
    }
  }
  return [...new Map(terms.map((item) => [`${item.kind}:${item.value}`, item])).values()];
}

function countNamedEntityHints(rows, dictionary = []) {
  let hitCount = 0;
  const termCounts = {};
  for (const row of rows) {
    const text = normalizeText(rowText(row));
    const rowTerms = new Set();
    for (const item of dictionary) {
      if (text.includes(item.value)) rowTerms.add(`${item.kind}:${item.value}`);
    }
    if (rowTerms.size) hitCount += 1;
    for (const term of rowTerms) inc(termCounts, term);
  }
  return { row_count: hitCount, top_terms: sortedCounts(termCounts, 12) };
}

function evidenceMetrics(rows = []) {
  const claimTypes = {};
  const evidenceLevels = {};
  const reviewStatuses = {};
  const surfaceTiers = {};
  const approvalStates = {};
  const titles = {};
  const themes = {};
  const teams = {};
  const people = {};
  const weeks = {};
  const confidenceValues = [];
  for (const row of rows) {
    inc(claimTypes, row.claim_type);
    inc(evidenceLevels, row.evidence_level);
    inc(reviewStatuses, row.review_status);
    inc(surfaceTiers, row.surface_tier);
    inc(approvalStates, row.approval_state);
    inc(titles, row.title);
    if (row.confidence != null && Number.isFinite(Number(row.confidence))) confidenceValues.push(Number(row.confidence));
    const content = row.content_json && typeof row.content_json === "object" ? row.content_json : {};
    for (const theme of asArray(content.themes)) inc(themes, theme);
    for (const team of asArray(content.teams)) inc(teams, team);
    for (const person of asArray(content.people)) inc(people, person);
    inc(weeks, String(content.week_start || content.date || row.created_at || "undated").slice(0, 10));
  }
  const avgConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : null;
  return {
    total: rows.length,
    unique_titles: Object.keys(titles).length,
    unique_claim_texts: uniqueCount(rows.map((row) => row.claim_text)),
    confidence: {
      count: confidenceValues.length,
      distinct: uniqueCount(confidenceValues.map(String)),
      min: confidenceValues.length ? Math.min(...confidenceValues) : null,
      max: confidenceValues.length ? Math.max(...confidenceValues) : null,
      avg: avgConfidence == null ? null : Number(avgConfidence.toFixed(3)),
    },
    by_claim_type: claimTypes,
    by_evidence_level: evidenceLevels,
    by_review_status: reviewStatuses,
    by_surface_tier: surfaceTiers,
    by_approval_state: approvalStates,
    by_week: weeks,
    top_themes: sortedCounts(themes),
    top_teams: sortedCounts(teams),
    top_people: sortedCounts(people),
  };
}

function evaluateEvidenceCardAudit({
  evidenceResult = null,
  publicResult = null,
  anonEvidenceResult = null,
  appResult = null,
  insightPublicResult = null,
  anonInsightResult = null,
  entityDictionary = [],
  strict = false,
} = {}) {
  const evidenceRows = evidenceResult?.rows || [];
  const publicRows = publicResult?.rows || [];
  const insightPublicRows = insightPublicResult?.rows || [];
  const schema = { failures: [], warnings: [] };
  const privacy = { failures: [], warnings: [] };
  const insight = { failures: [], warnings: [], metrics: evidenceMetrics(evidenceRows), public_metrics: evidenceMetrics(publicRows) };

  if (!evidenceResult?.ok) schema.failures.push(`cannot query evidence_cards with service role: ${evidenceResult?.status || "not queried"}`);
  if (!publicResult?.ok) schema.failures.push(`cannot query public_transcript_evidence_cards with anon key: ${publicResult?.status || "not queried"}`);
  if (appResult && !appResult.ok) schema.warnings.push(`cannot query app_transcript_evidence_cards with service role: ${appResult.status}`);
  if (insightPublicResult && !insightPublicResult.ok) schema.warnings.push(`cannot query public_cohort_insight_cards with anon key: ${insightPublicResult.status}`);

  if (anonEvidenceResult?.ok && (anonEvidenceResult.rows || []).length > 0) {
    privacy.failures.push(`anon can read evidence_cards (${anonEvidenceResult.rows.length} row(s) returned)`);
  }
  if (anonInsightResult?.ok && (anonInsightResult.rows || []).length > 0) {
    privacy.failures.push(`anon can read cohort_insight_cards (${anonInsightResult.rows.length} row(s) returned)`);
  }

  const t3Bad = evidenceRows.filter((row) =>
    row.surface_tier === "T3"
    && (
      row.review_status !== "published"
      || row.approval_state !== "approved"
      || row.public_anonymous !== true
      || row.public_article_mode !== "generalized_no_named_insights"
    )
  );
  if (t3Bad.length) privacy.failures.push(`${t3Bad.length} T3 card(s) violate published/approved/anonymous/no-name boundary`);

  const publicForbidden = publicRows
    .map((row) => ({ id: row.id, hits: scanForbiddenKeys(row.content_json) }))
    .filter((item) => item.hits.length);
  if (publicForbidden.length) {
    privacy.failures.push(`${publicForbidden.length} public row(s) expose entity/provenance keys in content_json`);
  }

  const publicPrivateMarkers = privateMarkerHits(publicRows);
  if (publicPrivateMarkers.length) privacy.failures.push(`${publicPrivateMarkers.length} public row(s) contain private markers`);

  const insightForbidden = insightPublicRows
    .map((row) => ({ id: row.id, hits: scanForbiddenKeys(row.content_json) }))
    .filter((item) => item.hits.length);
  if (insightForbidden.length) {
    privacy.failures.push(`${insightForbidden.length} public insight row(s) expose entity/provenance keys in content_json`);
  }
  const insightPrivateMarkers = privateMarkerHits(insightPublicRows);
  if (insightPrivateMarkers.length) privacy.failures.push(`${insightPrivateMarkers.length} public insight row(s) contain private markers`);

  const nonAnonymousScope = publicRows.filter((row) => row.attribution_scope && row.attribution_scope !== "anonymous_public");
  if (nonAnonymousScope.length) privacy.warnings.push(`${nonAnonymousScope.length} public row(s) expose non-anonymous attribution_scope`);

  const namedHints = countNamedEntityHints(publicRows, entityDictionary);
  if (namedHints.row_count) {
    privacy.warnings.push(`${namedHints.row_count} public row(s) contain known cohort entity names/ids in title, text, summary, or content`);
  }

  const missingSource = evidenceRows.filter((row) => !row.source_artifact_id).length;
  const missingSession = evidenceRows.filter((row) => !row.session_id).length;
  const missingProvenanceRatio = evidenceRows.length ? (missingSource + missingSession) / (evidenceRows.length * 2) : 0;
  if (missingProvenanceRatio > 0.25) {
    insight.warnings.push(`${Math.round(missingProvenanceRatio * 100)}% of source/session provenance links are missing`);
  }
  if (insight.metrics.confidence.count && insight.metrics.confidence.distinct < 2) {
    insight.warnings.push("confidence is uniform; calibration cannot distinguish weak vs strong evidence");
  }
  if (Object.keys(insight.metrics.by_claim_type).length < 2 && evidenceRows.length >= 10) {
    insight.warnings.push("claim_type diversity is low; everything is collapsing into one insight bucket");
  }
  if (Object.keys(insight.metrics.by_evidence_level).length < 2 && evidenceRows.length >= 10) {
    insight.warnings.push("evidence_level diversity is low; observed/inferred/reviewed distinctions are not being used");
  }
  if (!insight.metrics.top_people.length && evidenceRows.length) {
    insight.warnings.push("people coverage is zero; the cards cannot support individual contribution or follow-up analysis");
  }
  if (insight.public_metrics.top_themes.length < 5 && publicRows.length >= 10) {
    insight.warnings.push("public theme coverage is thin; anonymous public insights may read as a flat feed");
  }
  if (Object.keys(insight.public_metrics.by_week).length < 2 && publicRows.length >= 10) {
    insight.warnings.push("public cards cover fewer than two dated week buckets");
  }

  const hardFail = schema.failures.length || privacy.failures.length || (strict && insight.failures.length);
  const warn = schema.warnings.length || privacy.warnings.length || insight.warnings.length;
  return {
    ok: !hardFail,
    status: hardFail ? "fail" : warn ? "warn" : "pass",
    schema,
    privacy: {
      ...privacy,
      public_forbidden_key_rows: publicForbidden.length,
      public_private_marker_rows: publicPrivateMarkers.length,
      public_named_entity_hints: namedHints,
    },
    insight,
    counts: {
      evidence_cards: evidenceResult?.count ?? evidenceRows.length,
      public_transcript_evidence_cards: publicResult?.count ?? publicRows.length,
      public_cohort_insight_cards: insightPublicResult?.count ?? insightPublicRows.length,
      app_transcript_evidence_cards: appResult?.count ?? (appResult?.rows || []).length,
      anon_evidence_cards_rows: (anonEvidenceResult?.rows || []).length,
      anon_cohort_insight_cards_rows: (anonInsightResult?.rows || []).length,
    },
  };
}

async function runLiveEvidenceCardAudit({
  supabaseUrl,
  anonKey,
  serviceRoleKey,
  limit = DEFAULT_LIMIT,
  strict = false,
  fetchImpl = fetch,
} = {}) {
  if (!supabaseUrl) throw new Error("supabaseUrl is required");
  if (!anonKey) throw new Error("anonKey is required");
  if (!serviceRoleKey) throw new Error("serviceRoleKey is required");

  const evidenceSelect = [
    "id",
    "session_id",
    "derived_artifact_id",
    "source_artifact_id",
    "processing_job_id",
    "claim_type",
    "title",
    "claim_text",
    "summary",
    "evidence_level",
    "confidence",
    "attribution_scope",
    "surface_tier",
    "review_status",
    "approval_state",
    "public_anonymous",
    "public_article_mode",
    "content_json",
    "created_at",
  ].join(",");
  const publicSelect = "id,claim_type,title,claim_text,summary,evidence_level,confidence,attribution_scope,content_json,created_at";

  const [evidenceResult, publicResult, anonEvidenceResult, appResult, insightPublicResult, anonInsightResult] = await Promise.all([
    restSelect({
      supabaseUrl,
      key: serviceRoleKey,
      table: "evidence_cards",
      select: evidenceSelect,
      query: { order: "created_at.desc" },
      limit,
      fetchImpl,
    }),
    restSelect({
      supabaseUrl,
      key: anonKey,
      table: "public_transcript_evidence_cards",
      select: publicSelect,
      query: { order: "created_at.desc" },
      limit,
      fetchImpl,
    }),
    restSelect({
      supabaseUrl,
      key: anonKey,
      table: "evidence_cards",
      select: "id",
      query: { order: "created_at.desc" },
      limit: 1,
      fetchImpl,
    }),
    restSelect({
      supabaseUrl,
      key: serviceRoleKey,
      table: "app_transcript_evidence_cards",
      select: "id,claim_type,title,evidence_level,confidence,surface_tier,review_status,approval_state,public_anonymous,public_article_mode,content_json,created_at",
      query: { order: "created_at.desc" },
      limit,
      fetchImpl,
    }),
    restSelect({
      supabaseUrl,
      key: anonKey,
      table: "public_cohort_insight_cards",
      select: "id,kind,subject_type,title,claim_text,summary,content_json,created_at",
      query: { order: "created_at.desc" },
      limit,
      fetchImpl,
    }),
    restSelect({
      supabaseUrl,
      key: anonKey,
      table: "cohort_insight_cards",
      select: "id",
      query: { order: "created_at.desc" },
      limit: 1,
      fetchImpl,
    }),
  ]);

  return evaluateEvidenceCardAudit({
    evidenceResult,
    publicResult,
    anonEvidenceResult,
    appResult,
    insightPublicResult,
    anonInsightResult,
    entityDictionary: loadEntityDictionary(),
    strict,
  });
}

function printSummary(result) {
  console.log(`Supabase evidence-card audit: ${result.status}`);
  console.log(`cards: evidence=${result.counts.evidence_cards} public=${result.counts.public_transcript_evidence_cards} app=${result.counts.app_transcript_evidence_cards}`);
  for (const [label, section] of Object.entries({ schema: result.schema, privacy: result.privacy, insight: result.insight })) {
    const failures = section.failures || [];
    const warnings = section.warnings || [];
    if (!failures.length && !warnings.length) continue;
    console.log(`\n${label}`);
    for (const item of failures) console.log(`  FAIL ${item}`);
    for (const item of warnings) console.log(`  WARN ${item}`);
  }
  const metrics = result.insight.metrics;
  console.log(`\ninsight metrics`);
  console.log(`  unique claim text: ${metrics.unique_claim_texts}/${metrics.total}`);
  console.log(`  confidence: distinct=${metrics.confidence.distinct} min=${metrics.confidence.min} max=${metrics.confidence.max} avg=${metrics.confidence.avg}`);
  console.log(`  claim types: ${Object.keys(metrics.by_claim_type).join(", ") || "none"}`);
  console.log(`  evidence levels: ${Object.keys(metrics.by_evidence_level).join(", ") || "none"}`);
  console.log(`  top teams: ${metrics.top_teams.slice(0, 6).map((item) => `${item.value}:${item.count}`).join(", ") || "none"}`);
  console.log(`  top people: ${metrics.top_people.slice(0, 6).map((item) => `${item.value}:${item.count}`).join(", ") || "none"}`);
}

async function main(argv = process.argv.slice(2)) {
  const options = readOptions(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runLiveEvidenceCardAudit(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

export {
  evaluateEvidenceCardAudit,
  loadEntityDictionary,
  parseEnvText,
  runLiveEvidenceCardAudit,
  scanForbiddenKeys,
};
