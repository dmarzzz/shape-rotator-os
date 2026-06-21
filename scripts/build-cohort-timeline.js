#!/usr/bin/env node
/**
 * build-cohort-timeline.js - canonical Git-backed cohort timeline read model.
 *
 * Projects public self-declared cohort records from cohort-data history into:
 *   1. point-in-time snapshots for week/map reconstruction, and
 *   2. record-level field-change events for the canonical timeline log.
 *
 * This intentionally ignores OS/app code changes. A commit is relevant only
 * when it changes a supported cohort-data record collection. Future sources
 * (Teleport Router, transcript evidence) should append to the same event
 * shape with their own source_id instead of creating a parallel timeline.
 *
 * Usage:
 *   node scripts/build-cohort-timeline.js
 *   node scripts/build-cohort-timeline.js --check
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(__dirname, "..");
const COHORT_DIR = path.join(REPO_ROOT, "cohort-data");
const CONFIG_PATH = path.join(COHORT_DIR, "timeline.yml");
const SCHEMA_PATH = path.join(COHORT_DIR, "schema.yml");
const OUT_PATH = path.join(REPO_ROOT, "apps", "os", "src", "cohort-timeline.json");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COHORT_RECORD_COLLECTIONS = [
  { key: "teams", dir: "teams", recordType: "team" },
  { key: "people", dir: "people", recordType: "person" },
  { key: "clusters", dir: "clusters", recordType: "cluster" },
  { key: "dependencies", dir: "dependencies", recordType: "dependency" },
];

const SNAPSHOT_SOURCE_PATHS = COHORT_RECORD_COLLECTIONS.map((spec) => `cohort-data/${spec.dir}`);
const SNAPSHOT_COLLECTIONS = COHORT_RECORD_COLLECTIONS;
const EVENT_COLLECTIONS = COHORT_RECORD_COLLECTIONS.map((spec) => ({
  ...spec,
  sourceId: "cohort-data-github",
}));

function rel(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function git(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: opts.encoding || "utf8",
      stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"],
      maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
    });
  } catch (err) {
    if (opts.allowFail) return null;
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

function gitBuffer(args, input) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      input,
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

function parseMarkdown(raw, sourceLabel) {
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  try {
    return { frontmatter: yaml.load(match[1]) || {}, body: match[2] || "" };
  } catch (err) {
    throw new Error(`bad YAML in ${sourceLabel}: ${err.message}`);
  }
}

function pickSurface(obj, whitelist) {
  const out = {};
  for (const key of whitelist || []) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, key)) out[key] = obj[key];
  }
  return out;
}

function sanitizePersonSurface(surface) {
  delete surface.email;
  delete surface.dietary_restrictions;
  if (surface.links && typeof surface.links === "object") {
    const links = { ...surface.links };
    delete links.telegram;
    surface.links = links;
  }
  return surface;
}

function showFile(ref, repoPath) {
  return git(["show", `${ref}:${repoPath}`], { allowFail: true });
}

function listBlobEntriesAtRef(ref, dirs) {
  const pathspecs = (Array.isArray(dirs) ? dirs : [dirs]).map((dir) => `cohort-data/${dir}`);
  const out = git(["ls-tree", "-r", ref, ...pathspecs], { allowFail: true });
  if (!out) return [];
  return out.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line);
      return match ? { mode: match[1], sha: match[2], path: match[3] } : null;
    })
    .filter((entry) => entry && entry.path.endsWith(".md"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readBlobsBySha(shas) {
  const unique = Array.from(new Set((shas || []).filter(Boolean)));
  if (!unique.length) return new Map();
  const input = Buffer.from(unique.map((sha) => `${sha}\n`).join(""), "utf8");
  const buf = gitBuffer(["cat-file", "--batch"], input);
  const out = new Map();
  let offset = 0;
  for (const requestedSha of unique) {
    const headerEnd = buf.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file --batch ended before ${requestedSha}`);
    const header = buf.toString("utf8", offset, headerEnd);
    const [sha, type, sizeRaw] = header.split(/\s+/);
    const size = Number(sizeRaw);
    if (type !== "blob" || !Number.isFinite(size)) {
      throw new Error(`unexpected cat-file header for ${requestedSha}: ${header}`);
    }
    const start = headerEnd + 1;
    const end = start + size;
    out.set(sha, buf.toString("utf8", start, end));
    offset = end + 1; // trailing newline after each batch object
  }
  return out;
}

function readObjectsBySpec(specs) {
  const unique = Array.from(new Set((specs || []).filter(Boolean)));
  if (!unique.length) return new Map();
  const input = Buffer.from(unique.map((spec) => `${spec}\n`).join(""), "utf8");
  const buf = gitBuffer(["cat-file", "--batch"], input);
  const out = new Map();
  let offset = 0;
  for (const requested of unique) {
    const headerEnd = buf.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file --batch ended before ${requested}`);
    const header = buf.toString("utf8", offset, headerEnd);
    const parts = header.split(/\s+/);
    if (parts[1] === "missing") {
      out.set(requested, null);
      offset = headerEnd + 1;
      continue;
    }
    const type = parts[1];
    const size = Number(parts[2]);
    if (type !== "blob" || !Number.isFinite(size)) {
      throw new Error(`unexpected cat-file header for ${requested}: ${header}`);
    }
    const start = headerEnd + 1;
    const end = start + size;
    out.set(requested, buf.toString("utf8", start, end));
    offset = end + 1;
  }
  return out;
}

function loadRecordAtRef(ref, repoPath, spec, schema, includeBodyMarker = false) {
  const raw = showFile(ref, repoPath);
  if (raw == null) return null;
  return loadRecordFromRaw(raw, `${ref}:${repoPath}`, spec, schema, includeBodyMarker);
}

function loadRecordFromRaw(raw, sourceLabel, spec, schema, includeBodyMarker = false) {
  const { frontmatter, body } = parseMarkdown(raw, sourceLabel);
  if (!frontmatter) return null;
  if (frontmatter.record_type !== spec.recordType) return null;
  if (!frontmatter.record_id) return null;
  const whitelist = schema[spec.key]?.surface_fields || [];
  const surface = pickSurface(frontmatter, whitelist);
  if (spec.recordType === "person") sanitizePersonSurface(surface);
  if (includeBodyMarker) {
    Object.defineProperty(surface, "__body_hash", {
      value: hashJson(normalizeBody(body)),
      enumerable: false,
    });
  }
  return surface;
}

function buildSurfaceAtRef(ref, schema) {
  const surface = { schema_version: 1 };
  const entries = listBlobEntriesAtRef(ref, SNAPSHOT_COLLECTIONS.map((spec) => spec.dir));
  const blobs = readBlobsBySha(entries.map((entry) => entry.sha));
  for (const spec of SNAPSHOT_COLLECTIONS) {
    const records = [];
    for (const entry of entries.filter((item) => item.path.startsWith(`cohort-data/${spec.dir}/`))) {
      const raw = blobs.get(entry.sha);
      if (raw == null) continue;
      const record = loadRecordFromRaw(raw, `${ref}:${entry.path}`, spec, schema);
      if (record) records.push(record);
    }
    records.sort((a, b) => String(a.record_id).localeCompare(String(b.record_id)));
    surface[spec.key] = records;
  }
  surface.cohort_vocab = schema.cohort_vocab || {};
  return surface;
}

function resolveSnapshotRef(snapshot, baseRef) {
  if (snapshot.ref) {
    const commit = git(["rev-list", "--first-parent", "-n", "1", snapshot.ref, "--", ...SNAPSHOT_SOURCE_PATHS]).trim()
      || git(["rev-parse", `${snapshot.ref}^{commit}`]).trim();
    return { commit, mode: "ref" };
  }
  if (!snapshot.as_of) throw new Error(`snapshot ${snapshot.id} needs ref or as_of`);
  const commit = git(["rev-list", "--first-parent", "-n", "1", `--before=${snapshot.as_of}`, baseRef, "--", ...SNAPSHOT_SOURCE_PATHS]).trim();
  if (!commit) throw new Error(`snapshot ${snapshot.id} could not resolve a commit before ${snapshot.as_of}`);
  return { commit, mode: "as_of" };
}

function commitInfo(commit) {
  const line = git(["show", "-s", "--format=%H%x1f%ct%x1f%an%x1f%ae%x1f%s", commit]).trim();
  const [hash, epoch, authorName, _authorEmail, subject] = line.split("\x1f");
  return {
    commit: hash,
    committed_at: new Date(Number(epoch) * 1000).toISOString(),
    author_name: authorName || "",
    subject: subject || "",
  };
}

function commitInfoMap(commits) {
  const unique = Array.from(new Set((commits || []).filter(Boolean)));
  if (!unique.length) return new Map();
  const out = git(["show", "-s", "--format=%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%s", ...unique]);
  const map = new Map();
  for (const chunk of out.split("\x1e").map((part) => part.trim()).filter(Boolean)) {
    const [hash, epoch, authorName, authorEmail, subject] = chunk.split("\x1f");
    map.set(hash, {
      commit: hash,
      committed_at: new Date(Number(epoch) * 1000).toISOString(),
      author_name: authorName || "",
      subject: subject || "",
    });
  }
  return map;
}

function collectionForPath(repoPath) {
  return EVENT_COLLECTIONS.find((spec) => repoPath.startsWith(`cohort-data/${spec.dir}/`) && repoPath.endsWith(".md")) || null;
}

function parseNameStatusLines(lines) {
  return (lines || []).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const status = parts[0] || "";
    if (status.startsWith("R")) {
      return { status: "R", beforePath: parts[1], afterPath: parts[2] };
    }
    return { status, beforePath: status === "D" ? parts[1] : null, afterPath: status === "D" ? null : parts[1] };
  });
}

function flatten(value, prefix = "", out = {}) {
  if (Array.isArray(value)) {
    out[prefix] = value;
    return out;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length && prefix) out[prefix] = value;
    for (const [key, child] of entries) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out[prefix] = value;
  return out;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
    return out;
  }
  return value;
}

function valueEqual(a, b) {
  return JSON.stringify(stableJson(a)) === JSON.stringify(stableJson(b));
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function normalizeBody(body) {
  return String(body || "").replace(/\s+$/g, "");
}

function diffSurfaces(before, after) {
  const beforeFlat = flatten(before || {});
  const afterFlat = flatten(after || {});
  const keys = Array.from(new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]))
    .filter((key) => !key.startsWith("__"))
    .sort();
  const changes = [];
  for (const key of keys) {
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeFlat, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(afterFlat, key);
    const beforeVal = hasBefore ? beforeFlat[key] : null;
    const afterVal = hasAfter ? afterFlat[key] : null;
    if (!hasBefore || !hasAfter || !valueEqual(beforeVal, afterVal)) {
      changes.push({ field: key, before: hasBefore ? beforeVal : null, after: hasAfter ? afterVal : null });
    }
  }
  if (before && after && before.__body_hash && after.__body_hash && before.__body_hash !== after.__body_hash) {
    changes.push({
      field: "_body_md",
      before_hash: before.__body_hash,
      after_hash: after.__body_hash,
      public_value_included: false,
    });
  }
  return changes;
}

function recordAction(before, after, status) {
  if (!before && after) return "created";
  if (before && !after) return "deleted";
  if (status === "R") return before?.record_id === after?.record_id ? "renamed" : "replaced";
  return "updated";
}

function eventSummary(action, record, changes) {
  const name = record?.name || record?.record_id || "record";
  if (action === "created") return `Created ${name}`;
  if (action === "duplicated") return `Duplicated ${name}`;
  if (action === "deleted") return `Deleted ${name}`;
  if (action === "renamed") return `Renamed ${name}`;
  const fields = changes.map((c) => c.field).filter((f) => f !== "_body_md");
  if (!fields.length && changes.some((c) => c.field === "_body_md")) return `Updated ${name} body`;
  return `Updated ${name}: ${fields.slice(0, 6).join(", ")}${fields.length > 6 ? ", ..." : ""}`;
}

function buildEvents(schema, baseRef) {
  const eventPaths = EVENT_COLLECTIONS.map((spec) => `cohort-data/${spec.dir}`);
  const log = git([
    "log",
    "--reverse",
    "--first-parent",
    "--diff-merges=first-parent",
    "--name-status",
    "--find-renames",
    "--format=%H%x1f%P%x1f%ct%x1f%an%x1f%ae%x1f%s",
    baseRef,
    "--",
    ...eventPaths,
  ]);
  const commits = [];
  let current = null;
  for (const line of log.split(/\r?\n/)) {
    if (!line) continue;
    if (line.includes("\x1f")) {
      const [commit, parentsRaw, epoch, authorName, authorEmail, subject] = line.split("\x1f");
      const parents = String(parentsRaw || "").split(/\s+/).filter(Boolean);
      current = { commit, parent: parents[0] || EMPTY_TREE, epoch: Number(epoch), authorName, authorEmail, subject, statusLines: [] };
      commits.push(current);
    } else if (current) {
      current.statusLines.push(line);
    }
  }

  const specsToRead = [];
  for (const c of commits) {
    for (const item of parseNameStatusLines(c.statusLines)) {
      if (item.afterPath) specsToRead.push(`${c.commit}:${item.afterPath}`);
    }
  }
  const objects = readObjectsBySpec(specsToRead);
  const events = [];
  const stateByPath = new Map();
  const pathByRecordId = new Map();
  for (const c of commits) {
    const changed = parseNameStatusLines(c.statusLines);
    for (const item of changed) {
      const pathForSpec = item.afterPath || item.beforePath;
      const spec = collectionForPath(pathForSpec);
      if (!spec) continue;
      const afterSpec = item.afterPath ? collectionForPath(item.afterPath) || spec : spec;
      const afterRaw = item.afterPath ? objects.get(`${c.commit}:${item.afterPath}`) : null;
      const beforePath = item.beforePath || item.afterPath;
      const before = beforePath ? stateByPath.get(beforePath) || null : null;
      const after = afterRaw ? loadRecordFromRaw(afterRaw, `${c.commit}:${item.afterPath}`, afterSpec, schema, true) : null;
      if (!before && !after) continue;
      let action = recordAction(before, after, item.status);
      const record = after || before;
      const changes = diffSurfaces(before, after);
      if (action === "updated" && changes.length === 0) continue;
      const existingPathForRecord = after?.record_id ? pathByRecordId.get(after.record_id) : null;
      const duplicateOfPath = action === "created" && existingPathForRecord && existingPathForRecord !== item.afterPath
        ? existingPathForRecord
        : null;
      if (duplicateOfPath) action = "duplicated";
      if (item.status === "D") {
        stateByPath.delete(item.beforePath);
        if (before?.record_id && pathByRecordId.get(before.record_id) === item.beforePath) {
          pathByRecordId.delete(before.record_id);
        }
      } else if (item.status === "R") {
        if (item.beforePath) stateByPath.delete(item.beforePath);
        if (item.afterPath && after) stateByPath.set(item.afterPath, after);
        if (after?.record_id) pathByRecordId.set(after.record_id, item.afterPath);
      } else if (item.afterPath && after) {
        stateByPath.set(item.afterPath, after);
        if (after.record_id && !duplicateOfPath) pathByRecordId.set(after.record_id, item.afterPath);
      }
      const idSeed = `${c.commit}:${item.beforePath || ""}:${item.afterPath || ""}:${record.record_id}`;
      events.push({
        id: `ctl_${hashJson(idSeed).slice(0, 16)}`,
        source_id: spec.sourceId,
        source_kind: "git",
        committed_at: new Date(c.epoch * 1000).toISOString(),
        commit: c.commit,
        commit_short: c.commit.slice(0, 7),
        author_name: c.authorName || "",
        subject: c.subject || "",
        collection: spec.key,
        record_type: record.record_type || spec.recordType,
        record_id: record.record_id,
        record_name: record.name || record.record_id,
        path: item.afterPath || item.beforePath,
        previous_path: item.beforePath && item.beforePath !== item.afterPath ? item.beforePath : null,
        duplicate_of_path: duplicateOfPath,
        action,
        summary: eventSummary(action, record, changes),
        changed_fields: changes,
      });
    }
  }
  return events;
}

function buildSnapshots(config, schema, baseRef) {
  const resolved = (config.snapshots || []).map((snapshot) => {
    if (!snapshot.id) throw new Error("timeline snapshot missing id");
    return { snapshot, resolved: resolveSnapshotRef(snapshot, baseRef) };
  });
  const infoByCommit = commitInfoMap(resolved.map((row) => row.resolved.commit));
  return resolved.map(({ snapshot, resolved }) => {
    const info = infoByCommit.get(resolved.commit) || commitInfo(resolved.commit);
    const surface = buildSurfaceAtRef(resolved.commit, schema);
    return {
      id: snapshot.id,
      label: snapshot.label || snapshot.id,
      as_of: snapshot.as_of || null,
      ref: snapshot.ref || null,
      resolved_by: resolved.mode,
      source_commit: resolved.commit,
      source_commit_short: resolved.commit.slice(0, 7),
      committed_at: info.committed_at,
      counts: Object.fromEntries(SNAPSHOT_COLLECTIONS.map((spec) => [spec.key, (surface[spec.key] || []).length])),
      surface,
    };
  });
}

function snapshotMembership(events, snapshots) {
  const orderedSnapshots = snapshots
    .filter((s) => s.id !== "latest")
    .map((s) => ({ id: s.id, ts: Date.parse(s.as_of || s.committed_at) }))
    .filter((s) => Number.isFinite(s.ts))
    .sort((a, b) => a.ts - b.ts);
  if (!orderedSnapshots.length) return events;
  return events.map((event) => {
    const ts = Date.parse(event.committed_at);
    const bucket = orderedSnapshots.find((s) => ts <= s.ts);
    return { ...event, snapshot_id: bucket ? bucket.id : "latest" };
  });
}

function build() {
  const config = readYaml(CONFIG_PATH);
  const schema = readYaml(SCHEMA_PATH);
  if (!config || config.schema_version !== 1) throw new Error(`${rel(CONFIG_PATH)} must declare schema_version: 1`);
  if (!schema || schema.schema_version !== 1) throw new Error(`${rel(SCHEMA_PATH)} must declare schema_version: 1`);
  const baseRef = config.base_ref || "HEAD";
  const repoUrl = git(["remote", "get-url", "origin"], { allowFail: true, quiet: true })?.trim() || null;
  const snapshots = buildSnapshots(config, schema, baseRef);
  const events = snapshotMembership(buildEvents(schema, baseRef), snapshots);
  return {
    schema_version: 1,
    _comment: "Generated by scripts/build-cohort-timeline.js - do not edit by hand. Source of truth is cohort-data Git history.",
    generated_at: new Date().toISOString(),
    source_boundary: {
      canonical_source: "cohort-data-github",
      repo_url: repoUrl,
      base_ref: baseRef,
      included_paths: SNAPSHOT_SOURCE_PATHS,
      ignored: ["OS/app code changes", "schema-only changes", "unmerged PRs", "dirty working-tree edits"],
      public_surface_only: true,
    },
    sources: config.sources || [],
    snapshots,
    events,
  };
}

function fmt(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function comparable(data) {
  return { ...data, generated_at: null };
}

function main() {
  const check = process.argv.slice(2).includes("--check");
  let built;
  try {
    built = build();
  } catch (err) {
    console.error(`[build-cohort-timeline] ${err.message}`);
    process.exit(2);
  }

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`[build-cohort-timeline] --check: ${rel(OUT_PATH)} does not exist`);
      process.exit(3);
    }
    const current = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    if (JSON.stringify(comparable(current)) !== JSON.stringify(comparable(built))) {
      console.error(`[build-cohort-timeline] --check: ${rel(OUT_PATH)} is stale; run node scripts/build-cohort-timeline.js`);
      process.exit(4);
    }
    console.log(`[build-cohort-timeline] --check: timeline is up to date (${built.snapshots.length} snapshots, ${built.events.length} events)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, fmt(built));
  console.log(`[build-cohort-timeline] wrote ${rel(OUT_PATH)} (${built.snapshots.length} snapshots, ${built.events.length} events)`);
}

if (require.main === module) main();
