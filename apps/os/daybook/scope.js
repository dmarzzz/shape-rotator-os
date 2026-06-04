'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Scope / rules store (Invariant I3).
//
// Persisted scope state + the allow/deny decision engine, keyed on the FULL
// repo PATH (never path.basename — same-named repos under different parents
// must not collide and silently merge). Deny-by-default: unknown/new full
// paths are OUT until a rule or a manual pin lets them in.
//
// Reuses preferences.js's ensureDir/read/write idiom and the SAME directory
// (~/.router-daybook/), but owns its own two files:
//   scope.json       — full-path allow/deny, rules, per-conversation excludes,
//                       known paths, permRaw (device-link raw-sharing flag)
//   redactions.json  — always-hide terms + client abstractions; this is the
//                       single source of redaction rules for ALL THREE scrub
//                       sites (transcripts, reflect post-scrub, link).
//
// Pure Node: fs/os/path only. No electron, no child_process. This module is
// imported by transcripts.js (decision), reflect.js (loadRules for scrub #2),
// link.js (gate + rules), and main.js (IPC). It imports nothing from this
// project — no cycle with redact.js.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.router-daybook');
const SCOPE_FILE = path.join(DIR, 'scope.json');
const RULES_FILE = path.join(DIR, 'redactions.json');

const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ } }

// ── Defaults ──────────────────────────────────────────────────────────────
// Deny-by-default + privacy-safe resting state (I3, I4). permRaw MUST default
// false (perm-raw OFF). Unknown full paths are excluded by default-deny in
// decide(); these rules only widen the allow set deliberately.
function scopeDefaults() {
  return {
    version: 1,
    rules: [
      { id: 'r-active30', kind: 'activeWithinDays', days: 30 },
      { id: 'r-clients', kind: 'excludePathPrefix', path: path.join(os.homedir(), 'clients') },
      { id: 'r-private', kind: 'excludePrivateRepos' },
    ],
    overrides: {},
    conversations: {},
    knownPaths: [],
    permRaw: false,
  };
}

function rulesDefaults() {
  return { version: 1, hide: [], abstractions: [] };
}

// ── scope.json read/write ───────────────────────────────────────────────────
function loadScope() {
  const defaults = scopeDefaults();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(SCOPE_FILE, 'utf8')); }
  catch { return defaults; }
  if (!parsed || typeof parsed !== 'object') return defaults;
  // Merge over defaults so a partial/old file still yields a complete object.
  return {
    version: 1,
    rules: Array.isArray(parsed.rules) ? parsed.rules : defaults.rules,
    overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
    conversations: (parsed.conversations && typeof parsed.conversations === 'object') ? parsed.conversations : {},
    knownPaths: Array.isArray(parsed.knownPaths) ? parsed.knownPaths : [],
    permRaw: parsed.permRaw === true,
  };
}

function saveScope(scope) {
  ensureDir();
  const out = (scope && typeof scope === 'object') ? scope : scopeDefaults();
  try {
    const tmp = SCOPE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, SCOPE_FILE);
  } catch {
    try { fs.writeFileSync(SCOPE_FILE, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  }
}

// ── redactions.json read/write ──────────────────────────────────────────────
// loadRules() returns EXACTLY the object shape passed as redact(text, rules):
//   { hide: string[], abstractions: [{ from, to }] }
function loadRules() {
  const defaults = rulesDefaults();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); }
  catch { return { hide: [], abstractions: [] }; }
  if (!parsed || typeof parsed !== 'object') return { hide: [], abstractions: [] };
  const hide = Array.isArray(parsed.hide)
    ? parsed.hide.filter((t) => typeof t === 'string' && t.length > 0)
    : [];
  const abstractions = Array.isArray(parsed.abstractions)
    ? parsed.abstractions
        .filter((a) => a && typeof a === 'object' && typeof a.from === 'string' && typeof a.to === 'string')
        .map((a) => ({ from: a.from, to: a.to }))
    : [];
  return { hide, abstractions };
}

function saveRules(rules) {
  ensureDir();
  const src = (rules && typeof rules === 'object') ? rules : {};
  const out = {
    version: 1,
    hide: Array.isArray(src.hide) ? src.hide.filter((t) => typeof t === 'string' && t.length > 0) : [],
    abstractions: Array.isArray(src.abstractions)
      ? src.abstractions
          .filter((a) => a && typeof a === 'object' && typeof a.from === 'string' && typeof a.to === 'string')
          .map((a) => ({ from: a.from, to: a.to }))
      : [],
  };
  try {
    const tmp = RULES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, RULES_FILE);
  } catch {
    try { fs.writeFileSync(RULES_FILE, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  }
}

// ── Path helpers ────────────────────────────────────────────────────────────
// Prefix match on path boundaries: ~/clients matches ~/clients and
// ~/clients/api but NOT ~/clients-archive.
function pathHasPrefix(fullPath, prefix) {
  if (typeof fullPath !== 'string' || typeof prefix !== 'string' || !prefix) return false;
  const fp = fullPath.replace(/[/\\]+$/, '');
  const pf = prefix.replace(/[/\\]+$/, '');
  if (fp === pf) return true;
  return fp.startsWith(pf + path.sep) || fp.startsWith(pf + '/');
}

// Best-effort private-repo heuristic. scope.js has no git access and must not
// add deps, so excludePrivateRepos matches paths the caller can't prove are
// public. We treat it conservatively: it only excludes when caller-supplied
// activity/metadata flags it (handled in decideWithActivity via meta), and on
// its own (no meta) it does NOT exclude — keeping the rule inert rather than
// over-blocking. The rule still appears in the rules list for the UI.
function isPrivateRepo(_fullPath, meta) {
  return !!(meta && meta.private === true);
}

// ── The decision engine ─────────────────────────────────────────────────────
// Precedence (first match wins):
//   (1) per-path override: 'exclude' => excluded; 'include' => pinned included
//   (2) any exclude rule (path-prefix, private) => excluded with ruleId
//   (3) any include rule (active-within-days via activity, or includePaths
//       prefix) => included
//   (4) default => excluded, isNew = !knownPaths.includes(fullPath)
//
// decide() does the override + path-based rule logic. Activity-based include
// (activeWithinDays) needs a lastActiveMs the caller supplies; decideWithActivity
// layers that in. decide() alone treats activeWithinDays as not-matched.
function decideCore(fullPath, scope, lastActiveMs, meta) {
  const s = (scope && typeof scope === 'object') ? scope : loadScope();
  const overrides = s.overrides || {};
  const rules = Array.isArray(s.rules) ? s.rules : [];
  const known = Array.isArray(s.knownPaths) ? s.knownPaths : [];

  // (1) per-path override.
  const ov = overrides[fullPath];
  if (ov === 'exclude') return { included: false, reason: 'override-exclude', ruleId: null, isNew: false };
  if (ov === 'include') return { included: true, reason: 'override-include', ruleId: null, isNew: false };

  // (2) exclude rules.
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'excludePathPrefix' && pathHasPrefix(fullPath, r.path)) {
      return { included: false, reason: 'rule-exclude', ruleId: r.id || null, isNew: false };
    }
    if (r.kind === 'excludePrivateRepos' && isPrivateRepo(fullPath, meta)) {
      return { included: false, reason: 'rule-exclude', ruleId: r.id || null, isNew: false };
    }
  }

  // (3) include rules.
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'includePathPrefix' && pathHasPrefix(fullPath, r.path)) {
      return { included: true, reason: 'rule-include', ruleId: r.id || null, isNew: false };
    }
    if (r.kind === 'activeWithinDays' && typeof lastActiveMs === 'number' && lastActiveMs > 0) {
      const days = (typeof r.days === 'number' && r.days > 0) ? r.days : 0;
      if (days > 0 && (Date.now() - lastActiveMs) <= days * DAY_MS) {
        return { included: true, reason: 'rule-include', ruleId: r.id || null, isNew: false };
      }
    }
  }

  // (4) default deny.
  return { included: false, reason: 'default-deny', ruleId: null, isNew: !known.includes(fullPath) };
}

function decide(fullPath, scope) {
  return decideCore(fullPath, scope, undefined, undefined);
}

// Activity-aware variant used by buildAllowSet so the active-within-N-days
// include rule can fire. meta is optional ({ private?: boolean }).
function decideWithActivity(fullPath, scope, lastActiveMs, meta) {
  return decideCore(fullPath, scope, lastActiveMs, meta);
}

// ── buildAllowSet ───────────────────────────────────────────────────────────
// Runs decide() over every candidate full path, optionally using
// activity[fullPath] = lastActiveMs for the active-within-N-days rule.
// Returns the allow Set plus per-path decisions, the list of new repos, and
// basename collisions so the UI can disambiguate (I3 anti-collision).
function buildAllowSet(candidatePaths, scope, activity) {
  const s = (scope && typeof scope === 'object') ? scope : loadScope();
  const act = (activity && typeof activity === 'object') ? activity : {};
  const paths = Array.isArray(candidatePaths) ? candidatePaths : [];

  const allow = new Set();
  const decisions = {};
  const newRepos = [];
  const byBasename = new Map();

  for (const fp of paths) {
    if (typeof fp !== 'string' || !fp) continue;
    const lastActiveMs = (typeof act[fp] === 'number') ? act[fp] : undefined;
    const d = decideWithActivity(fp, s, lastActiveMs, undefined);
    decisions[fp] = d;
    if (d.included) allow.add(fp);
    if (d.isNew) newRepos.push(fp);

    const base = path.basename(fp);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(fp);
  }

  const collisions = [];
  for (const [basename, group] of byBasename) {
    if (group.length > 1) collisions.push({ basename, paths: group });
  }

  return { allow, decisions, newRepos, collisions };
}

// ── Per-conversation excludes ───────────────────────────────────────────────
function conversationExcluded(sessionId, scope) {
  const s = (scope && typeof scope === 'object') ? scope : loadScope();
  const conv = s.conversations || {};
  return conv[sessionId] === 'exclude';
}

// ── Rule mutations ──────────────────────────────────────────────────────────
function genId() {
  return 'r-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

function setRule(rule) {
  const scope = loadScope();
  const rules = Array.isArray(scope.rules) ? scope.rules.slice() : [];
  const r = Object.assign({}, rule);
  if (!r.id) r.id = genId();
  const idx = rules.findIndex((x) => x && x.id === r.id);
  if (idx >= 0) rules[idx] = r;
  else rules.push(r);
  scope.rules = rules;
  saveScope(scope);
  return scope;
}

function removeRule(ruleId) {
  const scope = loadScope();
  const rules = Array.isArray(scope.rules) ? scope.rules : [];
  scope.rules = rules.filter((r) => !(r && r.id === ruleId));
  saveScope(scope);
  return scope;
}

// ── Overrides ───────────────────────────────────────────────────────────────
// Sets scope.overrides[fullPath]; null deletes it (revert to rules). Records
// fullPath into knownPaths so it is no longer reported as 'new'.
function setOverride(fullPath, decision) {
  const scope = loadScope();
  scope.overrides = (scope.overrides && typeof scope.overrides === 'object') ? scope.overrides : {};
  if (decision === null || decision === undefined) {
    delete scope.overrides[fullPath];
  } else if (decision === 'include' || decision === 'exclude') {
    scope.overrides[fullPath] = decision;
  }
  scope.knownPaths = Array.isArray(scope.knownPaths) ? scope.knownPaths : [];
  if (typeof fullPath === 'string' && fullPath && !scope.knownPaths.includes(fullPath)) {
    scope.knownPaths.push(fullPath);
  }
  saveScope(scope);
  return scope;
}

// ── Conversations ───────────────────────────────────────────────────────────
function setConversation(sessionId, decision) {
  const scope = loadScope();
  scope.conversations = (scope.conversations && typeof scope.conversations === 'object') ? scope.conversations : {};
  if (decision === null || decision === undefined) {
    delete scope.conversations[sessionId];
  } else if (decision === 'include' || decision === 'exclude') {
    scope.conversations[sessionId] = decision;
  }
  saveScope(scope);
  return scope;
}

// ── Raw-sharing gate (I4) ────────────────────────────────────────────────────
// link.js consults this AND buildAllowSet/decide to gate device-link raw logs.
function rawSharingEnabled(scope) {
  const s = (scope && typeof scope === 'object') ? scope : loadScope();
  return s.permRaw === true;
}

module.exports = {
  loadScope, saveScope,
  loadRules, saveRules,
  decide, decideWithActivity, buildAllowSet,
  conversationExcluded,
  setRule, removeRule,
  setOverride, setConversation,
  rawSharingEnabled,
  SCOPE_FILE, RULES_FILE,
};
