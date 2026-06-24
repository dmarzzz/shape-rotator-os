#!/usr/bin/env node
/**
 * GitHub releases audit for cohort projects.
 *
 * Companion to check-github-progress.mjs. That script distills COMMIT history
 * (git transport, no API). This one captures the GitHub *Release* object —
 * which only exists in the GitHub API — so the membrane "what's new" feed can
 * surface real releases (e.g. v0.3.5) instead of commit subjects.
 *
 * Reads cohort-data team/people markdown, extracts GitHub repo links, and uses
 * the `gh` CLI (Releases API) to list published releases per repo. Writes one
 * github_release_list artifact per repo into
 * cohort-data/artifacts/github-releases/generated/. Like the progress pipeline,
 * the artifacts are committed and the deterministic build only reads them — the
 * API call lives here, never in build-bundles.js.
 *
 * Pre-releases are included (draft releases are not). Auth comes from `gh`
 * (local `gh auth login`, or GH_TOKEN in CI).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const DEFAULT_ARTIFACTS_DIR = path.join(COHORT_DIR, "artifacts", "github-releases", "generated");
const REPO_LINK_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const DEFAULT_LIMIT = 100;

function rel(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function parseArgs(argv) {
  const out = {
    maxRepos: Infinity,
    limit: DEFAULT_LIMIT,
    includePrereleases: true,
    writeArtifacts: false,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--max-repos") out.maxRepos = Math.max(1, Number(next()) || 1);
    else if (arg === "--limit") out.limit = Math.max(1, Number(next()) || DEFAULT_LIMIT);
    else if (arg === "--no-prereleases") out.includePrereleases = false;
    else if (arg === "--write-artifacts") out.writeArtifacts = true;
    else if (arg === "--artifacts-dir") out.artifactsDir = path.resolve(REPO_ROOT, next());
    else if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log([
    "Usage: node scripts/check-github-releases.mjs [options]",
    "",
    "Options:",
    "  --limit N                Max releases fetched per repo (default 100)",
    "  --max-repos N            Inspect only the first N normalized repos",
    "  --no-prereleases         Exclude prereleases (rc/beta/alpha); default includes them",
    "  --write-artifacts        Write generated artifacts (otherwise dry summary only)",
    "  --artifacts-dir path     Output dir; defaults to cohort-data/artifacts/github-releases/generated",
  ].join("\n"));
}

// Synchronous sleep — this script is intentionally sequential/sync. Used to
// back off between gh retries on a rate-limit, without pulling in async.
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// gh failures we should retry: primary + secondary (abuse) rate limits. A
// transient 403/429 here previously dropped the repo for the whole run.
const RATE_LIMIT_RE = /rate limit|secondary rate limit|abuse detection|was submitted too quickly|retry after|\b(?:403|429)\b/i;
export function isRateLimited(stderr) {
  return RATE_LIMIT_RE.test(stderr || "");
}

function gh(args, opts = {}) {
  const maxAttempts = Math.max(1, opts.retries ?? 3);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execFileSync("gh", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeout || 60000,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (err) {
      const stderr = err.stderr ? String(err.stderr).trim() : "";
      lastErr = new Error(`gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
      lastErr.stderr = stderr;
      if (attempt < maxAttempts && isRateLimited(stderr)) {
        const backoffMs = Math.min(30000, 1000 * 2 ** attempt); // 2s, 4s, 8s…
        process.stderr.write(`[github-releases] rate-limited; backing off ${backoffMs}ms (attempt ${attempt}/${maxAttempts})\n`);
        sleepSync(backoffMs);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== "");
  if (value == null || value === "") return [];
  return [value];
}

function parseMarkdownRecord(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return null;
  const frontmatter = yaml.load(match[1]) || {};
  return {
    file: rel(file),
    record_id: frontmatter.record_id || path.basename(file, ".md"),
    record_type: frontmatter.record_type || (file.includes("/people/") ? "person" : "team"),
    name: frontmatter.name || frontmatter.record_id || path.basename(file, ".md"),
    links: frontmatter.links || {},
  };
}

function loadRecords(kind) {
  const dir = path.join(COHORT_DIR, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => parseMarkdownRecord(path.join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => `${a.record_type}:${a.record_id}`.localeCompare(`${b.record_type}:${b.record_id}`));
}

// Mirror of check-github-progress.mjs normalizeGithubValue: only owner/repo
// shaped links become release targets; bare accounts / org URLs are skipped.
function normalizeGithubValue(value) {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!raw || raw === "null") return null;
  let rest = raw;
  if (/^https?:\/\//i.test(rest)) {
    try {
      const url = new URL(rest);
      if (!/^(www\.)?github\.com$/i.test(url.hostname)) return { kind: "external", raw };
      rest = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return { kind: "unparsed", raw };
    }
  } else {
    rest = rest.replace(/^github\.com\//i, "").replace(/^@/, "").replace(/^\/+|\/+$/g, "");
  }
  rest = rest.replace(/\.git$/i, "");
  if (!rest) return null;
  if (/^orgs\/([^/]+)\/repositories$/i.test(rest)) return { kind: "org_repositories", raw };
  const parts = rest.split("/").filter(Boolean);
  if (parts.length >= 2 && REPO_LINK_RE.test(`${parts[0]}/${parts[1]}`)) {
    return { kind: "repo", repo: `${parts[0]}/${parts[1]}`, raw };
  }
  if (parts.length === 1 && /^[A-Za-z0-9_.-]+$/.test(parts[0])) {
    return { kind: "account", account: parts[0], raw };
  }
  return { kind: "unparsed", raw };
}

// One entry per unique repo, carrying every team that links it. Mirrors
// collectTargets()/repoTeamIds() in check-github-progress.mjs.
function collectRepoTargets(records) {
  const repos = new Map();
  const skipped = [];
  for (const record of records) {
    for (const field of ["repo", "github"]) {
      const normalized = normalizeGithubValue(record.links?.[field]);
      if (!normalized) continue;
      if (normalized.kind !== "repo") {
        if (record.record_type === "team") {
          skipped.push({ record_id: record.record_id, field: `links.${field}`, raw: normalized.raw, kind: normalized.kind });
        }
        continue;
      }
      const key = normalized.repo.toLowerCase();
      if (!repos.has(key)) {
        repos.set(key, { repo: normalized.repo, teamIds: new Set() });
      }
      if (record.record_type === "team") repos.get(key).teamIds.add(String(record.record_id).toLowerCase());
    }
  }
  return {
    repos: Array.from(repos.values()).map((entry) => ({ repo: entry.repo, teamIds: Array.from(entry.teamIds) })),
    skipped,
  };
}

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function listReleases(repo, limit) {
  const raw = gh([
    "release", "list",
    "-R", repo,
    "--limit", String(limit),
    "--json", "tagName,name,publishedAt,isPrerelease,isDraft,isLatest",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`could not parse gh output for ${repo}: ${e.message}`);
  }
  return Array.isArray(parsed) ? parsed : [];
}

export function buildReleaseArtifact(repo, teamId, releases, opts = {}) {
  const sorted = releases
    .map((r) => ({
      tag_name: String(r.tagName || ""),
      name: String(r.name || r.tagName || "").trim() || String(r.tagName || ""),
      published_at: String(r.publishedAt || ""),
      prerelease: Boolean(r.isPrerelease),
      latest: Boolean(r.isLatest),
      html_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tagName || "")}`,
    }))
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const latest = sorted.find((r) => r.latest) || sorted[0] || null;
  const date = String(latest?.published_at || "").slice(0, 10);
  const names = sorted.slice(0, 5).map((r) => r.name).join(", ");
  // No generated_at field: the artifact is a pure projection of the repo's
  // releases, so it stays byte-stable across runs unless a release actually
  // changes — letting the scheduled workflow commit only on real updates.
  const artifact = {
    schema_version: 1,
    artifact_id: `github-releases:${teamId}:${slugPart(repo)}`,
    artifact_kind: "github_release_list",
    record_type: "team",
    record_id: teamId,
    date,
    title: `${repo}: ${sorted.length} release${sorted.length === 1 ? "" : "s"}`,
    summary: names ? `Latest: ${names}` : "No published releases.",
    source_kind: "github_releases_api",
    source_url: `https://github.com/${repo}/releases`,
    source_repo: repo,
    source_transform: "gh-release-list",
    review_status: "generated",
    surface_recommendation: "promote_candidate",
    verbatim: true,
    release_count: sorted.length,
    releases: sorted,
  };
  // Only stamp this when the upstream fetch hit the --limit cap, so the common
  // (un-truncated) case stays byte-identical to prior runs and doesn't churn
  // a spurious commit. Signals to the publisher that older in-window releases
  // may be missing for this repo.
  if (opts.capped) artifact.release_count_capped = true;
  return artifact;
}

// On a transient query failure (rate-limit/outage) keep the repo's previously
// written artifact, because writeArtifacts() deletes-all-then-rewrites and the
// publisher globs *.json — without this, a flaky hour silently drops the repo
// from the live feed. Returned as-is (no mutation) so a recovered run rewrites
// it identically and produces no spurious diff.
function loadPriorArtifact(dir, teamId, repo) {
  try {
    const file = path.join(dir, `${slugPart(`github-releases:${teamId}:${slugPart(repo)}`)}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && parsed.artifact_kind === "github_release_list" ? parsed : null;
  } catch {
    return null;
  }
}

function writeArtifacts(dir, artifacts) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) fs.unlinkSync(path.join(dir, entry.name));
  }
  const fileFor = (a) => `${slugPart(a.artifact_id)}.json`;
  const manifest = {
    schema_version: 1,
    artifact_count: artifacts.length,
    artifacts: artifacts.map((a) => ({
      artifact_id: a.artifact_id,
      artifact_kind: a.artifact_kind,
      record_id: a.record_id,
      date: a.date,
      file: fileFor(a),
      release_count: a.release_count,
      review_status: a.review_status,
      surface_recommendation: a.surface_recommendation,
    })),
  };
  for (const a of artifacts) writeJson(path.join(dir, fileFor(a)), a);
  writeJson(path.join(dir, "manifest.json"), manifest);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ghAvailable()) {
    throw new Error("`gh` CLI not found. Install GitHub CLI and authenticate (gh auth login), or set GH_TOKEN in CI.");
  }

  const records = [...loadRecords("teams"), ...loadRecords("people")];
  const { repos, skipped } = collectRepoTargets(records);
  const repoTargets = repos.slice(0, args.maxRepos);

  const artifacts = [];
  const empty = [];
  const failed = [];

  for (const [idx, target] of repoTargets.entries()) {
    const teamId = target.teamIds[0];
    if (!teamId) continue; // repo linked only by a person record; no team to attach to
    process.stderr.write(`[github-releases] ${idx + 1}/${repoTargets.length} ${target.repo}\n`);
    let releases;
    try {
      releases = listReleases(target.repo, args.limit);
    } catch (err) {
      failed.push({ repo: target.repo, error: err.message });
      // Preserve the repo's prior artifact so a transient failure doesn't drop
      // it from the live feed (writeArtifacts wipes anything not re-listed).
      if (args.writeArtifacts) {
        const prior = loadPriorArtifact(args.artifactsDir, teamId, target.repo);
        if (prior) {
          artifacts.push(prior);
          process.stderr.write(`[github-releases] kept prior artifact for ${target.repo} after query failure (feed not regressed)\n`);
        }
      }
      continue;
    }
    // gh returns newest-first up to --limit; hitting the cap means older
    // in-window releases may be truncated at the source. Make it loud.
    const capped = releases.length >= args.limit;
    if (capped) {
      process.stderr.write(`[github-releases] WARNING: ${target.repo} returned the full --limit (${args.limit}); older in-window releases may be truncated. Raise --limit or add pagination.\n`);
    }
    let usable = releases.filter((r) => !r.isDraft);
    if (!args.includePrereleases) usable = usable.filter((r) => !r.isPrerelease);
    if (!usable.length) {
      empty.push(target.repo);
      continue;
    }
    artifacts.push(buildReleaseArtifact(target.repo, teamId, usable, { capped }));
  }

  artifacts.sort((a, b) => String(a.artifact_id).localeCompare(String(b.artifact_id)));

  console.log(`[github-releases] repos inspected: ${repoTargets.length}`);
  console.log(`[github-releases] repos with releases: ${artifacts.length}`);
  for (const a of artifacts) console.log(`  ${a.record_id} ${a.source_repo}: ${a.release_count} releases (latest ${a.date})`);
  if (empty.length) console.log(`[github-releases] repos with no published releases: ${empty.join(", ")}`);
  if (failed.length) {
    console.log(`[github-releases] repos that could not be queried:`);
    for (const f of failed) console.log(`  ${f.repo}: ${f.error}`);
  }
  if (skipped.length) {
    console.log(`[github-releases] team links skipped (not owner/repo shaped):`);
    for (const s of skipped) console.log(`  ${s.record_id} ${s.field}=${s.raw} (${s.kind})`);
  }

  if (args.writeArtifacts) {
    writeArtifacts(args.artifactsDir, artifacts);
    console.log(`[github-releases] wrote ${artifacts.length} artifacts + manifest to ${rel(args.artifactsDir)}`);
  } else {
    console.log(`[github-releases] dry run (pass --write-artifacts to persist)`);
  }
}

// Only run as a CLI — guarded so tests can import the exported helpers without
// triggering main() (which hard-fails when gh is absent).
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    main();
  } catch (err) {
    console.error(`[github-releases] ${err.message}`);
    process.exit(1);
  }
}
