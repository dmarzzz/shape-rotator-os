#!/usr/bin/env node
/**
 * API-free GitHub progress audit for cohort projects.
 *
 * Reads cohort-data people/team markdown, extracts GitHub repo/profile links,
 * fetches public repo refs through Git transport, and writes a distilled
 * progress report. It deliberately avoids api.github.com and GitHub HTML
 * scraping. The cache is shallow + blobless: enough commit metadata to infer
 * movement over time, not a source-code mirror.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const DEFAULT_OUT = path.join(REPO_ROOT, "tmp", "github-progress-audit.json");
const DEFAULT_MD_OUT = path.join(REPO_ROOT, "tmp", "github-progress-audit.md");
const DEFAULT_CACHE = path.join(REPO_ROOT, "tmp", "github-progress-cache");
const DEFAULT_ARTIFACTS_DIR = path.join(COHORT_DIR, "artifacts", "github-progress", "generated");
const REPO_LINK_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const MAX_COMMITS_PER_REPO = 500;
const MAX_EXAMPLES_PER_WEEK = 4;
const HIGH_VOLUME_COUNT = 150;
const GENERATED_OR_BOT_AUTHORS = /\b(bot|github-actions|dependabot|renovate)\b/i;

function rel(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function parseArgs(argv) {
  const out = {
    since: null,
    output: DEFAULT_OUT,
    markdown: DEFAULT_MD_OUT,
    cache: DEFAULT_CACHE,
    depth: 200,
    maxRepos: Infinity,
    noFetch: false,
    writeArtifacts: false,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--since") out.since = next();
    else if (arg === "--output") out.output = path.resolve(REPO_ROOT, next());
    else if (arg === "--markdown") out.markdown = path.resolve(REPO_ROOT, next());
    else if (arg === "--cache") out.cache = path.resolve(REPO_ROOT, next());
    else if (arg === "--depth") out.depth = Math.max(1, Number(next()) || out.depth);
    else if (arg === "--max-repos") out.maxRepos = Math.max(1, Number(next()) || 1);
    else if (arg === "--no-fetch") out.noFetch = true;
    else if (arg === "--write-artifacts") out.writeArtifacts = true;
    else if (arg === "--artifacts-dir") out.artifactsDir = path.resolve(REPO_ROOT, next());
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function usage() {
  console.log([
    "Usage: node scripts/check-github-progress.mjs [options]",
    "",
    "Options:",
    "  --since YYYY-MM-DD       Start date for recent commits; defaults to cohort program_start",
    "  --output path            JSON report path; defaults to tmp/github-progress-audit.json",
    "  --markdown path          Markdown report path; defaults to tmp/github-progress-audit.md",
    "  --cache path             Bare git cache dir; defaults to tmp/github-progress-cache",
    "  --depth N                Shallow fetch depth per branch; defaults to 200",
    "  --max-repos N            Fetch only first N normalized repos",
    "  --no-fetch               Reuse existing cache only",
    "  --write-artifacts        Write generated artifacts for review",
    "  --artifacts-dir path     Artifact output dir; defaults to cohort-data/artifacts/github-progress/generated",
  ].join("\n"));
}

function git(args, opts = {}) {
  try {
    return execFileSync("git", ["-c", "safe.directory=*", ...args], {
      cwd: opts.cwd || REPO_ROOT,
      encoding: opts.encoding || "utf8",
      stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
      timeout: opts.timeout || 120000,
      maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
    });
  } catch (err) {
    if (opts.allowFail) {
      return {
        ok: false,
        stdout: err.stdout ? String(err.stdout) : "",
        stderr: err.stderr ? String(err.stderr) : "",
        message: err.message,
      };
    }
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function readYamlFile(file) {
  return yaml.load(fs.readFileSync(file, "utf8")) || {};
}

function readProgramStart() {
  const timelinePath = path.join(COHORT_DIR, "timeline.yml");
  try {
    const cfg = readYamlFile(timelinePath);
    return toIsoDate(cfg.program_start);
  } catch {
    return null;
  }
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  return match ? match[0] : null;
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
    record_type: frontmatter.record_type || (file.includes("/people/") || file.includes("\\people\\") ? "person" : "team"),
    name: frontmatter.name || frontmatter.record_id || path.basename(file, ".md"),
    links: frontmatter.links || {},
    team: frontmatter.team || null,
    secondary_teams: asArray(frontmatter.secondary_teams).map(String),
    focus: frontmatter.focus || null,
    now: frontmatter.now || null,
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

  const orgRepos = /^orgs\/([^/]+)\/repositories$/i.exec(rest);
  if (orgRepos) return { kind: "org_repositories", account: orgRepos[1], raw };

  const parts = rest.split("/").filter(Boolean);
  if (parts.length >= 2 && REPO_LINK_RE.test(`${parts[0]}/${parts[1]}`)) {
    return { kind: "repo", repo: `${parts[0]}/${parts[1]}`, raw };
  }
  if (parts.length === 1 && /^[A-Za-z0-9_.-]+$/.test(parts[0])) {
    return { kind: "account", account: parts[0], raw };
  }
  return { kind: "unparsed", raw };
}

function addSource(map, key, payload) {
  if (!map.has(key)) map.set(key, { ...payload, sources: [] });
  map.get(key).sources.push(payload.source);
}

function collectTargets(records) {
  const repos = new Map();
  const profiles = new Map();
  const unresolved = [];

  for (const record of records) {
    for (const field of ["repo", "github"]) {
      const normalized = normalizeGithubValue(record.links?.[field]);
      if (!normalized) continue;
      const source = {
        record_id: record.record_id,
        record_type: record.record_type,
        name: record.name,
        field: `links.${field}`,
        file: record.file,
        raw: normalized.raw,
      };
      if (normalized.kind === "repo") {
        addSource(repos, normalized.repo.toLowerCase(), {
          repo: normalized.repo,
          url: `https://github.com/${normalized.repo}`,
          source,
        });
      } else if (normalized.kind === "account" || normalized.kind === "org_repositories") {
        addSource(profiles, `${normalized.kind}:${normalized.account.toLowerCase()}`, {
          kind: normalized.kind,
          account: normalized.account,
          url: `https://github.com/${normalized.account}`,
          source,
        });
      } else {
        unresolved.push({ ...normalized, source });
      }
    }
  }

  return {
    repos: Array.from(repos.values()).map((entry) => ({
      repo: entry.repo,
      url: entry.url,
      sources: entry.sources,
    })),
    profiles: Array.from(profiles.values()).map((entry) => ({
      kind: entry.kind,
      account: entry.account,
      url: entry.url,
      sources: entry.sources,
    })),
    unresolved,
  };
}

function canonicalText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildCohortIndex(records) {
  const people = records.filter((record) => record.record_type === "person");
  const teams = records.filter((record) => record.record_type === "team");
  const peopleByGithub = new Map();
  const peopleByName = new Map();
  const teamsById = new Map();

  for (const team of teams) teamsById.set(String(team.record_id).toLowerCase(), team);

  for (const person of people) {
    const teamsForPerson = [person.team, ...asArray(person.secondary_teams)]
      .filter(Boolean)
      .map((team) => String(team).toLowerCase());
    person._team_ids = teamsForPerson;

    const github = normalizeGithubValue(person.links?.github);
    if (github?.kind === "account") {
      peopleByGithub.set(github.account.toLowerCase(), person);
    }
    const nameKey = canonicalText(person.name);
    if (nameKey) peopleByName.set(nameKey, person);
    const idKey = canonicalText(person.record_id);
    if (idKey) peopleByName.set(idKey, person);
  }

  return { people, teams, peopleByGithub, peopleByName, teamsById };
}

function extractGithubLoginFromEmail(email) {
  const text = String(email || "").trim().toLowerCase();
  const withId = /^\d+\+([^@]+)@users\.noreply\.github\.com$/.exec(text);
  if (withId) return withId[1];
  const direct = /^([^@]+)@users\.noreply\.github\.com$/.exec(text);
  if (direct) return direct[1];
  return null;
}

function matchCommitPerson(commit, cohortIndex) {
  const login = extractGithubLoginFromEmail(commit.author_email);
  if (login && cohortIndex.peopleByGithub.has(login.toLowerCase())) {
    const person = cohortIndex.peopleByGithub.get(login.toLowerCase());
    return {
      confidence: "high",
      reason: "github_noreply_email",
      login,
      person_id: person.record_id,
      person_name: person.name,
      person_team_ids: person._team_ids || [],
    };
  }

  const nameKey = canonicalText(commit.author);
  if (nameKey && cohortIndex.peopleByName.has(nameKey)) {
    const person = cohortIndex.peopleByName.get(nameKey);
    return {
      confidence: "medium",
      reason: "exact_author_name",
      login: null,
      person_id: person.record_id,
      person_name: person.name,
      person_team_ids: person._team_ids || [],
    };
  }

  return null;
}

function repoTeamIds(target) {
  return Array.from(new Set((target.sources || [])
    .filter((source) => source.record_type === "team")
    .map((source) => String(source.record_id || "").toLowerCase())
    .filter(Boolean)));
}

function classifySubject(subject) {
  const raw = String(subject || "").trim();
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/^[^a-z0-9]+/, "");
  const conventional = /^([a-z]+)(?:\([^)]+\))?!?:/.exec(normalized);
  const prefix = conventional?.[1] || "";
  if (["feat", "feature"].includes(prefix)) return "feature";
  if (["fix", "hotfix"].includes(prefix)) return "fix";
  if (["docs", "doc"].includes(prefix)) return "docs";
  if (["test", "tests"].includes(prefix)) return "test";
  if (["refactor"].includes(prefix)) return "refactor";
  if (["perf"].includes(prefix)) return "performance";
  if (["ci"].includes(prefix)) return "ci";
  if (["build", "chore", "deps", "dep"].includes(prefix)) return "maintenance";
  if (["release"].includes(prefix)) return "release";

  if (/\b(fix|bug|patch|recover|repair|correct|resolve|handled?)\b/.test(lower)) return "fix";
  if (/\b(add|new|implement|introduce|enable|support|ship|create)\b/.test(lower)) return "feature";
  if (/\b(readme|docs?|document|guide|changelog|note)\b/.test(lower)) return "docs";
  if (/\b(test|spec|coverage|assert|benchmark|bench)\b/.test(lower)) return "test";
  if (/\b(refactor|cleanup|simplify|rename|restructure)\b/.test(lower)) return "refactor";
  if (/\b(ui|ux|style|css|layout|design|visual)\b/.test(lower)) return "ui";
  if (/\b(ci|workflow|action|docker|deploy|build)\b/.test(lower)) return "ci";
  if (/\b(deps?|bump|upgrade|vendor|lockfile|chore)\b/.test(lower)) return "maintenance";
  if (/\b(release|version|tag)\b/.test(lower)) return "release";
  return "other";
}

function isLikelyCohortAdminCommit(subject) {
  const lower = String(subject || "").toLowerCase().trim();
  return /^profile:/.test(lower)
    || /^cohort[- ]data:/.test(lower)
    || /^calendar:/.test(lower)
    || /^chore\(calendar\):/.test(lower)
    || /\b(sync schedule|profile update|update .* profile)\b/.test(lower);
}

function isLikelyBotCommit(commit) {
  const author = String(commit?.author || "");
  const email = String(commit?.author_email || "");
  return GENERATED_OR_BOT_AUTHORS.test(author) || GENERATED_OR_BOT_AUTHORS.test(email);
}

function topicTags(subject) {
  const lower = String(subject || "").toLowerCase();
  const tags = [];
  for (const [tag, re] of [
    ["auth", /\b(auth|login|session|permission|access|csrf)\b/],
    ["agent", /\b(agent|llm|model|memory|context|tool|workflow)\b/],
    ["privacy", /\b(private|privacy|encrypted|secret|attestation|tee|sgx|tdx)\b/],
    ["data", /\b(data|schema|migration|database|sql|index|cache)\b/],
    ["runtime", /\b(runtime|server|worker|daemon|node|client|api)\b/],
    ["ui", /\b(ui|ux|style|css|layout|modal|card|view|page)\b/],
    ["ops", /\b(deploy|ci|workflow|docker|release|build|version)\b/],
  ]) {
    if (re.test(lower)) tags.push(tag);
  }
  return tags;
}

function increment(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function topCounts(map, limit = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function weekStartIso(dateText) {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.getUTCDay() || 7;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - day + 1);
  return start.toISOString().slice(0, 10);
}

function programWeek(dateText, since) {
  const date = new Date(dateText);
  const start = new Date(`${since}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(start.getTime())) return null;
  return Math.max(1, Math.floor((date.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1);
}

function summarizeCommits(commits, since) {
  const categoryCounts = new Map();
  const topicCounts = new Map();
  const weeklyMap = new Map();

  for (const commit of commits) {
    const category = classifySubject(commit.subject);
    const tags = topicTags(commit.subject);
    commit.category = category;
    commit.topic_tags = tags;
    increment(categoryCounts, category);
    for (const tag of tags) increment(topicCounts, tag);

    const week_start = weekStartIso(commit.date);
    if (!weeklyMap.has(week_start)) {
      weeklyMap.set(week_start, {
        week_start,
        program_week: programWeek(commit.date, since),
        commit_count: 0,
        categories: new Map(),
        topics: new Map(),
        authors: new Map(),
        human_commit_count: 0,
        bot_commit_count: 0,
        admin_commit_count: 0,
        examples: [],
      });
    }
    const bucket = weeklyMap.get(week_start);
    bucket.commit_count++;
    if (isLikelyBotCommit(commit)) bucket.bot_commit_count++;
    else bucket.human_commit_count++;
    if (isLikelyCohortAdminCommit(commit.subject)) bucket.admin_commit_count++;
    increment(bucket.categories, category);
    for (const tag of tags) increment(bucket.topics, tag);
    increment(bucket.authors, commit.author || "unknown");
    if (bucket.examples.length < MAX_EXAMPLES_PER_WEEK) {
      bucket.examples.push({
        date: commit.date,
        sha: commit.sha?.slice(0, 12),
        category,
        subject: commit.subject,
        author: commit.author,
      });
    }
  }

  const weekly = Array.from(weeklyMap.values())
    .sort((a, b) => String(a.week_start).localeCompare(String(b.week_start)))
    .map((bucket) => ({
      ...bucket,
      categories: topCounts(bucket.categories, 4),
      topics: topCounts(bucket.topics, 4),
      authors: topCounts(bucket.authors, 4),
      useful_commit_count: Math.max(0, bucket.commit_count - bucket.bot_commit_count - bucket.admin_commit_count),
    }));

  return {
    categories: topCounts(categoryCounts, 8),
    topics: topCounts(topicCounts, 8),
    active_weeks: weekly.length,
    weekly,
  };
}

function cachePathFor(cacheRoot, repo) {
  return path.join(cacheRoot, `${repo.replace(/[/:]/g, "__")}.git`);
}

function ensureRepoCache(cacheRoot, repo, depth, noFetch) {
  const dir = cachePathFor(cacheRoot, repo);
  const url = `https://github.com/${repo}.git`;
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (!fs.existsSync(dir)) {
    if (noFetch) return { ok: false, error: "cache_missing_no_fetch", cache: rel(dir) };
    fs.mkdirSync(dir, { recursive: true });
    const init = git(["init", "--bare", dir], { allowFail: true, quiet: true });
    if (init.ok === false) return { ok: false, error: cleanGitError(init), cache: rel(dir) };
    const remote = git(["remote", "add", "origin", url], { cwd: dir, allowFail: true, quiet: true });
    if (remote.ok === false) return { ok: false, error: cleanGitError(remote), cache: rel(dir) };
  } else {
    git(["remote", "set-url", "origin", url], { cwd: dir, allowFail: true, quiet: true });
  }

  if (!noFetch) {
    const fetch = git([
      "fetch",
      "--quiet",
      "--prune",
      "--no-tags",
      "--depth",
      String(depth),
      "--filter=blob:none",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ], { cwd: dir, allowFail: true, timeout: 180000, maxBuffer: 30 * 1024 * 1024 });
    if (fetch.ok === false) return { ok: false, error: cleanGitError(fetch), cache: rel(dir) };
  }

  return { ok: true, cache: rel(dir) };
}

function cleanGitError(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}\n${result.message || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return text || "git command failed";
}

function parseTsv(out, columns) {
  return String(out || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const obj = {};
      columns.forEach((key, i) => { obj[key] = parts[i] || ""; });
      return obj;
    });
}

function inspectRepo(cacheRoot, target, since, depth, noFetch, cohortIndex) {
  const repo = target.repo;
  const prepared = ensureRepoCache(cacheRoot, repo, depth, noFetch);
  const linkedTeamIds = repoTeamIds(target);
  const base = {
    repo,
    url: target.url,
    sources: target.sources,
    linked_team_ids: linkedTeamIds,
    cache: prepared.cache,
    analysis_depth_per_branch: depth,
  };
  if (!prepared.ok) return { ...base, ok: false, error: prepared.error };

  const dir = cachePathFor(cacheRoot, repo);
  const branches = parseTsv(git([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
    "refs/heads",
  ], { cwd: dir, allowFail: false }), ["name", "sha", "tip_date"]);
  if (!branches.length) {
    return {
      ...base,
      ok: false,
      error: noFetch
        ? "cache contains no branch refs; run without --no-fetch to verify whether the repo exists"
        : "fetch completed but no branch refs were available",
    };
  }

  const sinceArg = `${since}T00:00:00Z`;
  const commits = parseTsv(git([
    "log",
    "--all",
    `--since=${sinceArg}`,
    "--max-count",
    String(MAX_COMMITS_PER_REPO),
    "--date=iso-strict",
    "--pretty=format:%H%x09%cI%x09%an%x09%ae%x09%D%x09%s",
  ], { cwd: dir, allowFail: false, maxBuffer: 30 * 1024 * 1024 }), ["sha", "date", "author", "author_email", "refs", "subject"]);

  for (const commit of commits) {
    commit.matched_person = matchCommitPerson(commit, cohortIndex);
  }

  const authors = new Map();
  for (const commit of commits) {
    const author = commit.author || "unknown";
    authors.set(author, (authors.get(author) || 0) + 1);
  }
  const topAuthors = Array.from(authors.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
  const activeBranches = branches.filter((branch) => branch.tip_date >= since);
  const latest = commits[0] || branches[0] || null;
  const distilled = summarizeCommits(commits, since);
  const matchedPeople = new Map();
  const possibleCrossTeamContribs = new Map();

  for (const commit of commits) {
    const match = commit.matched_person;
    if (!match) continue;
    const key = match.person_id;
    if (!matchedPeople.has(key)) {
      matchedPeople.set(key, {
        person_id: match.person_id,
        person_name: match.person_name,
        confidence: match.confidence,
        reason: match.reason,
        person_team_ids: match.person_team_ids,
        commit_count: 0,
        latest_date: "",
      });
    }
    const person = matchedPeople.get(key);
    person.commit_count++;
    if (String(commit.date || "") > String(person.latest_date || "")) person.latest_date = commit.date;

    const outsideLinkedTeams = linkedTeamIds.length
      && match.person_team_ids?.length
      && !match.person_team_ids.some((teamId) => linkedTeamIds.includes(String(teamId).toLowerCase()))
      && !isLikelyCohortAdminCommit(commit.subject);
    if (outsideLinkedTeams) {
      if (!possibleCrossTeamContribs.has(key)) {
        possibleCrossTeamContribs.set(key, {
          person_id: match.person_id,
          person_name: match.person_name,
          person_team_ids: match.person_team_ids,
          repo_team_ids: linkedTeamIds,
          confidence: match.confidence === "high" ? "medium" : "low",
          reason: "commit_author_matched_person_but_repo_is_linked_to_other_team",
          commit_count: 0,
          examples: [],
        });
      }
      const contrib = possibleCrossTeamContribs.get(key);
      contrib.commit_count++;
      if (contrib.examples.length < 3) {
        contrib.examples.push({
          date: commit.date,
          sha: commit.sha?.slice(0, 12),
          subject: commit.subject,
        });
      }
    }
  }

  return {
    ...base,
    ok: true,
    status: commits.length ? "active_since_cutoff" : "no_recent_commits_seen",
    recent_commit_count: commits.length,
    recent_commit_count_capped: commits.length >= MAX_COMMITS_PER_REPO,
    branch_count: branches.length,
    active_branch_count: activeBranches.length,
    latest,
    distilled,
    matched_cohort_people: Array.from(matchedPeople.values())
      .sort((a, b) => b.commit_count - a.commit_count || a.person_id.localeCompare(b.person_id)),
    possible_cross_team_contributions: Array.from(possibleCrossTeamContribs.values())
      .sort((a, b) => b.commit_count - a.commit_count || a.person_id.localeCompare(b.person_id)),
    insight: repoInsight({ commits, distilled, latest, linkedTeamIds }),
    top_authors: topAuthors,
    active_branches: activeBranches.slice(0, 10),
    recent_commits: commits.slice(0, 20).map(compactCommit),
  };
}

function compactCommit(commit) {
  return {
    sha: commit.sha,
    date: commit.date,
    author: commit.author,
    author_email: commit.author_email,
    refs: commit.refs,
    subject: commit.subject,
    category: commit.category,
    topic_tags: commit.topic_tags,
    matched_person: commit.matched_person,
  };
}

function repoInsight({ commits, distilled, latest }) {
  if (!commits.length) {
    return {
      summary: "No public commits were observed in the linked repo during the analysis window.",
      bullets: [
        "Treat this as a weak signal: work may be private, in a different repo, or not committed yet.",
      ],
    };
  }
  const mainCategories = distilled.categories.slice(0, 3).map((item) => `${item.key} (${item.count})`).join(", ");
  const mainTopics = distilled.topics.slice(0, 3).map((item) => item.key).join(", ");
  const latestText = latest?.date ? `${latest.date.slice(0, 10)}: ${latest.subject}` : "no latest commit";
  const bullets = [
    `${commits.length}${commits.length >= MAX_COMMITS_PER_REPO ? "+" : ""} commits observed across ${distilled.active_weeks} active week${distilled.active_weeks === 1 ? "" : "s"}.`,
    `Dominant change types: ${mainCategories || "uncategorized"}.`,
    `Latest visible movement: ${latestText}.`,
  ];
  if (mainTopics) bullets.push(`Detected topic surface: ${mainTopics}.`);
  if (commits.length >= HIGH_VOLUME_COUNT) {
    bullets.push("High-volume repo: use category/week summaries instead of reading individual commits.");
  }
  return {
    summary: `${commits.length}${commits.length >= MAX_COMMITS_PER_REPO ? "+" : ""} commits since cutoff; main work reads as ${mainCategories || "mixed changes"}.`,
    bullets,
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}

function artifactFileName(artifact) {
  const id = artifact.artifact_id || `${artifact.record_id || "unknown"}:${artifact.date || "undated"}`;
  return `${slugPart(id)}.json`;
}

function reviewGuidanceForProgressEvent(event) {
  const evidence = event.evidence || {};
  const commitCount = Number(evidence.commit_count || 0);
  const humanCount = Number(evidence.human_commit_count || 0);
  const botCount = Number(evidence.bot_commit_count || 0);
  const adminCount = Number(evidence.admin_commit_count || 0);
  const usefulCount = Number(evidence.useful_commit_count || 0);
  const categories = new Set((evidence.categories || []).map((item) => item.key));
  const consider = [];
  const doNotConsider = [];
  const reviewQuestions = [
    "Is this the team's real project repo for this period?",
    "Do the example commit subjects describe product/research movement rather than generated churn?",
    "Would this card add information not already captured by profile, transcript, or calendar timeline items?",
  ];

  if (humanCount > 0) consider.push(`${humanCount} human-authored commit${humanCount === 1 ? "" : "s"} observed in the week.`);
  if (usefulCount > 0) consider.push(`${usefulCount} non-bot, non-admin commit${usefulCount === 1 ? "" : "s"} remain after basic filtering.`);
  if (categories.has("feature")) consider.push("Feature-labeled movement is present.");
  if (categories.has("fix")) consider.push("Fix/stabilization movement is present.");
  if (categories.has("docs")) consider.push("Documentation or launch/readout movement is present.");
  if ((evidence.topics || []).length) {
    consider.push(`Topic surface: ${(evidence.topics || []).slice(0, 3).map((item) => item.key).join(", ")}.`);
  }

  if (botCount > 0) doNotConsider.push(`${botCount} bot/generated commit${botCount === 1 ? "" : "s"} should not count as product momentum.`);
  if (adminCount > 0) doNotConsider.push(`${adminCount} cohort-admin/profile/calendar commit${adminCount === 1 ? "" : "s"} should not count as project progress.`);
  if (commitCount >= HIGH_VOLUME_COUNT) doNotConsider.push("High-volume week: promote only if the examples summarize a meaningful phase, not raw activity volume.");
  if (categories.has("maintenance") && !categories.has("feature") && !categories.has("fix")) {
    doNotConsider.push("Maintenance-heavy week: verify it represents meaningful operational progress before surfacing.");
  }
  if (humanCount === 0) doNotConsider.push("No human-authored commits detected in this weekly bucket.");
  if (usefulCount === 0) doNotConsider.push("No non-bot, non-admin commits remain after basic filtering.");

  let surface_recommendation = "review";
  if (usefulCount === 0 || humanCount === 0) {
    surface_recommendation = "hold";
  } else if (commitCount >= HIGH_VOLUME_COUNT || botCount > humanCount || adminCount > 0) {
    surface_recommendation = "review";
  } else {
    surface_recommendation = "promote_candidate";
  }

  return {
    surface_recommendation,
    consider,
    do_not_consider: doNotConsider,
    review_questions: reviewQuestions,
  };
}

function buildArtifactObjects(report) {
  const out = [];
  for (const event of report.timeline_events || []) {
    const review = reviewGuidanceForProgressEvent(event);
    out.push({
      schema_version: 1,
      artifact_id: `github-progress:${event.record_id}:${slugPart(event.evidence?.repo)}:${event.date}`,
      artifact_kind: "github_progress_weekly_summary",
      record_type: "team",
      record_id: event.record_id,
      date: event.date,
      week_start: event.date,
      program_week: event.program_week ?? null,
      title: event.title,
      summary: event.detail,
      source_kind: "github_git_transport",
      source_url: event.evidence?.url || "",
      source_repo: event.evidence?.repo || "",
      source_transform: "commit-metadata-weekly-distillation",
      confidence: event.confidence || "medium",
      review_status: "generated",
      surface_recommendation: review.surface_recommendation,
      consider: review.consider,
      do_not_consider: review.do_not_consider,
      review_questions: review.review_questions,
      verbatim: false,
      generated_at: report.generated_at,
      evidence: {
        commit_count: event.evidence?.commit_count || 0,
        human_commit_count: event.evidence?.human_commit_count || 0,
        bot_commit_count: event.evidence?.bot_commit_count || 0,
        admin_commit_count: event.evidence?.admin_commit_count || 0,
        useful_commit_count: event.evidence?.useful_commit_count || 0,
        categories: event.evidence?.categories || [],
        topics: event.evidence?.topics || [],
        authors: event.evidence?.authors || [],
        examples: event.evidence?.examples || [],
      },
      // Public-GitHub cross-team collaboration evidence, kept as a sibling of
      // `evidence` (not inside it) so the evidence shape stays byte-stable. Both
      // arrays are repo-level and confidence medium/low; the cohort-insight engine
      // turns possible_cross_team_contributions into team-pair collaboration edges.
      collaboration: {
        matched_cohort_people: event.collaboration?.matched_cohort_people || [],
        possible_cross_team_contributions: event.collaboration?.possible_cross_team_contributions || [],
      },
    });
  }

  for (const repo of report.repos || []) {
    if (repo.ok) continue;
    const teamSources = (repo.sources || []).filter((source) => source.record_type === "team");
    for (const source of teamSources) {
      out.push({
        schema_version: 1,
        artifact_id: `github-progress-quality:${source.record_id}:${slugPart(repo.repo)}`,
        artifact_kind: "github_repo_data_quality",
        record_type: "team",
        record_id: source.record_id,
        date: report.generated_at.slice(0, 10),
        title: `${repo.repo}: GitHub repo unavailable`,
        summary: `Linked repo could not be verified: ${repo.error || "unknown error"}`,
        source_kind: "github_git_transport",
        source_url: repo.url,
        source_repo: repo.repo,
        source_transform: "repo-link-verification",
        confidence: "high",
        review_status: "generated",
        surface_recommendation: "operator_only",
        consider: [
          "Use as a data-quality prompt to repair or classify the linked GitHub repo.",
        ],
        do_not_consider: [
          "Do not render this as participant-facing project progress.",
          "Do not infer the project is inactive from an unavailable public repo link.",
        ],
        review_questions: [
          "Is this repo private, renamed, deleted, or just the wrong field?",
          "Should the team record use a concrete public repo, a profile link, or `repo: null`?",
        ],
        verbatim: false,
        generated_at: report.generated_at,
        evidence: {
          source_file: source.file,
          source_field: source.field,
          raw_value: source.raw,
          error: repo.error || "",
        },
      });
    }
  }
  return out.sort((a, b) => String(a.artifact_id).localeCompare(String(b.artifact_id)));
}

function writeArtifacts(dir, artifacts, generatedAt) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      fs.unlinkSync(path.join(dir, entry.name));
    }
  }
  const manifest = {
    schema_version: 1,
    generated_at: generatedAt || new Date().toISOString(),
    artifact_count: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      artifact_kind: artifact.artifact_kind,
      record_id: artifact.record_id,
      date: artifact.date,
      file: artifactFileName(artifact),
      review_status: artifact.review_status,
      surface_recommendation: artifact.surface_recommendation,
    })),
  };
  for (const artifact of artifacts) {
    writeJson(path.join(dir, artifactFileName(artifact)), artifact);
  }
  writeJson(path.join(dir, "manifest.json"), manifest);
}

// Repo-level cohort attribution: which cohort members authored commits, and which
// of those commits land on a repo linked to a DIFFERENT team than the author's own.
// inspectRepo derives these once per repo; thread the snapshot onto every weekly event
// for the repo so it survives into the committed weekly-summary artifact as a top-level
// `collaboration` field. It is kept OUT of `evidence` so the evidence shape stays
// byte-stable; downstream the cohort-insight engine dedupes the replicated snapshot.
function repoCollaborationSnapshot(repo) {
  return {
    matched_cohort_people: asArray(repo?.matched_cohort_people),
    possible_cross_team_contributions: asArray(repo?.possible_cross_team_contributions),
  };
}

function buildTimelineEvents(repos) {
  const events = [];
  for (const repo of repos) {
    if (!repo.ok || !repo.distilled?.weekly?.length) continue;
    const linkedTeams = repo.linked_team_ids?.length
      ? repo.linked_team_ids
      : repo.sources.filter((source) => source.record_type === "team").map((source) => source.record_id);
    const collaboration = repoCollaborationSnapshot(repo);
    for (const recordId of linkedTeams) {
      for (const week of repo.distilled.weekly) {
        const categories = week.categories.map((item) => item.key).join(", ") || "mixed";
        const examples = week.examples.map((example) => example.subject).slice(0, 3);
        events.push({
          id: `github:${recordId}:${repo.repo}:${week.week_start}`,
          source_id: "github-git-transport",
          source: "github",
          record_type: "team",
          record_id: recordId,
          date: week.week_start,
          program_week: week.program_week,
          type: "external_repo_progress",
          title: `${repo.repo}: ${week.commit_count} commit${week.commit_count === 1 ? "" : "s"}`,
          detail: `${categories}${examples.length ? ` — ${examples.join("; ")}` : ""}`,
          confidence: "medium",
          evidence: {
            repo: repo.repo,
            url: repo.url,
            commit_count: week.commit_count,
            human_commit_count: week.human_commit_count || 0,
            bot_commit_count: week.bot_commit_count || 0,
            admin_commit_count: week.admin_commit_count || 0,
            useful_commit_count: week.useful_commit_count || 0,
            categories: week.categories,
            topics: week.topics,
            authors: week.authors,
            examples,
          },
          collaboration,
        });
      }
    }
  }
  return events.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.record_id.localeCompare(b.record_id));
}

function writeMarkdown(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  lines.push("# GitHub Progress Distillation");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Since: ${report.since}`);
  lines.push("Method: public Git transport only; no api.github.com calls; no GitHub HTML scraping; shallow blobless cache only.");
  lines.push("");
  lines.push("## Executive Readout");
  lines.push("");
  lines.push(`- Concrete repos inspected: ${report.source_counts.repo_targets_fetched}/${report.source_counts.repo_targets}`);
  lines.push(`- Active repos since cutoff: ${report.rollup.active_repos}`);
  lines.push(`- Repos with no recent public commits: ${report.rollup.inactive_repos}`);
  lines.push(`- Inaccessible or bad repo links: ${report.rollup.error_repos}`);
  lines.push(`- Profile/org-only GitHub links needing specific repos: ${report.source_counts.profile_or_org_targets}`);
  lines.push(`- Timeline-ready weekly events generated: ${report.timeline_events.length}`);
  lines.push("");
  lines.push("## Repo Activity");
  lines.push("");
  lines.push("| Repo | Status | Commits | Active weeks | Main read | Latest | Linked records |");
  lines.push("| --- | --- | ---: | ---: | --- | --- | --- |");
  for (const repo of report.repos) {
    const linked = repo.sources
      .map((source) => `${source.record_type}:${source.record_id}`)
      .filter((value, idx, arr) => arr.indexOf(value) === idx)
      .join(", ");
    const latest = repo.latest?.date
      ? `${repo.latest.date.slice(0, 10)} ${repo.latest.subject || repo.latest.sha?.slice(0, 7) || ""}`.trim()
      : "";
    const categories = repo.distilled?.categories?.slice(0, 3).map((item) => `${item.key} ${item.count}`).join(", ") || "";
    lines.push(`| [${repo.repo}](${repo.url}) | ${repo.ok ? repo.status : `error: ${repo.error}`} | ${repo.recent_commit_count ?? ""}${repo.recent_commit_count_capped ? "+" : ""} | ${repo.distilled?.active_weeks ?? ""} | ${escapeTable(categories)} | ${escapeTable(latest)} | ${escapeTable(linked)} |`);
  }
  lines.push("");
  lines.push("## Per-Project Distillation");
  lines.push("");
  for (const repo of report.repos) {
    lines.push(`### ${repo.repo}`);
    lines.push("");
    if (!repo.ok) {
      lines.push(`- Error: ${repo.error}`);
      lines.push("");
      continue;
    }
    lines.push(`- ${repo.insight.summary}`);
    for (const bullet of repo.insight.bullets || []) lines.push(`- ${bullet}`);
    if (repo.matched_cohort_people?.length) {
      const people = repo.matched_cohort_people
        .slice(0, 5)
        .map((person) => `${person.person_name || person.person_id} (${person.commit_count}, ${person.confidence})`)
        .join("; ");
      lines.push(`- Cohort author matches: ${people}`);
    }
    if (repo.possible_cross_team_contributions?.length) {
      const contribs = repo.possible_cross_team_contributions
        .slice(0, 5)
        .map((person) => `${person.person_name || person.person_id} -> ${person.repo_team_ids.join("/")} (${person.commit_count}, ${person.confidence})`)
        .join("; ");
      lines.push(`- Possible cross-team contribution: ${contribs}`);
    }
    if (repo.distilled.weekly?.length) {
      lines.push("- Weekly movement:");
      for (const week of repo.distilled.weekly.slice(-8)) {
        const categories = week.categories.map((item) => `${item.key} ${item.count}`).join(", ") || "mixed";
        const examples = week.examples.map((example) => example.subject).join("; ");
        lines.push(`  - Week ${week.program_week ?? "?"} (${week.week_start}): ${week.commit_count} commit${week.commit_count === 1 ? "" : "s"}; ${categories}${examples ? `; examples: ${examples}` : ""}`);
      }
    }
    lines.push("");
  }
  lines.push("");
  lines.push("## Profile Or Org Links Needing Specific Repos");
  lines.push("");
  lines.push("| Account | Link kind | Linked records |");
  lines.push("| --- | --- | --- |");
  for (const profile of report.profiles) {
    const linked = profile.sources
      .map((source) => `${source.record_type}:${source.record_id} (${source.field})`)
      .join(", ");
    lines.push(`| [${profile.account}](${profile.url}) | ${profile.kind} | ${escapeTable(linked)} |`);
  }
  if (!report.profiles.length) lines.push("|  |  |  |");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Repo links can produce real progress signals: commits, active branches, latest author/date/subject, weekly movement, and coarse change themes.");
  lines.push("- Profile/org-only links are intentionally not scraped; add a concrete `owner/repo` link if they should feed timelines.");
  lines.push("- Shallow fetch depth is per branch, so very high-volume repos may report capped lower-bound counts.");
  lines.push("- Cross-team contribution signals are inferred only from commit authors that match cohort people; treat medium/low confidence matches as review prompts.");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since || readProgramStart() || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const records = [...loadRecords("teams"), ...loadRecords("people")];
  const cohortIndex = buildCohortIndex(records);
  const targets = collectTargets(records);
  const repoTargets = targets.repos.slice(0, args.maxRepos);

  const repos = [];
  for (const [idx, target] of repoTargets.entries()) {
    process.stderr.write(`[github-progress] ${idx + 1}/${repoTargets.length} ${target.repo}\n`);
    repos.push(inspectRepo(args.cache, target, since, args.depth, args.noFetch, cohortIndex));
  }
  const sortedRepos = repos.sort((a, b) => String(b.latest?.date || "").localeCompare(String(a.latest?.date || "")));
  const timelineEvents = buildTimelineEvents(sortedRepos);
  const rollup = {
    active_repos: sortedRepos.filter((repo) => repo.ok && repo.recent_commit_count > 0).length,
    inactive_repos: sortedRepos.filter((repo) => repo.ok && repo.recent_commit_count === 0).length,
    error_repos: sortedRepos.filter((repo) => !repo.ok).length,
    capped_repos: sortedRepos.filter((repo) => repo.recent_commit_count_capped).map((repo) => repo.repo),
    possible_cross_team_contribution_count: sortedRepos.reduce((sum, repo) => sum + (repo.possible_cross_team_contributions?.length || 0), 0),
  };

  const report = {
    generated_at: new Date().toISOString(),
    since,
    method: "git-transport-no-github-rest-api-no-html-scrape",
    cache_note: "Local cache is shallow and blobless; it stores commit metadata and trees for analysis, not source file blobs.",
    source_counts: {
      records: records.length,
      repo_targets: targets.repos.length,
      repo_targets_fetched: repoTargets.length,
      profile_or_org_targets: targets.profiles.length,
      unresolved_targets: targets.unresolved.length,
    },
    rollup,
    repos: sortedRepos,
    timeline_events: timelineEvents,
    profiles: targets.profiles,
    unresolved: targets.unresolved,
  };

  writeJson(args.output, report);
  writeMarkdown(args.markdown, report);
  if (args.writeArtifacts) {
    const artifacts = buildArtifactObjects(report);
    writeArtifacts(args.artifactsDir, artifacts, report.generated_at);
    console.log(`[github-progress] wrote ${artifacts.length} artifacts to ${rel(args.artifactsDir)}`);
  }
  console.log(`[github-progress] wrote ${rel(args.output)} and ${rel(args.markdown)}`);
}

try {
  main();
} catch (err) {
  console.error(`[github-progress] ${err.message}`);
  process.exit(1);
}
