#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATCHES_PATH = path.join(ROOT, "apps", "os", "src", "content", "context", "calendar-transcript-matches.js");
const RAW_ROOT = path.join(ROOT, "apps", "os", "src", "content", "context", "raw-scripts");
const CALENDAR_PATH = path.join(ROOT, "cohort-data", "calendar.json");
const PRIMARY_TAB = "May 18 Start";
const DAY_COLUMNS = [
  { index: 2, offset: 0 },
  { index: 3, offset: 1 },
  { index: 4, offset: 2 },
  { index: 5, offset: 3 },
  { index: 6, offset: 4 },
  { index: 7, offset: 5 },
  { index: 8, offset: 6 },
];

function normalizedMatchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function addDays(date, offset) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + offset);
  return next;
}

function parseWeekStart(row) {
  const dateCell = String(row?.[1] || "");
  const match = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d)/i.exec(dateCell);
  if (!match) return null;
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  return new Date(Date.UTC(2026, months[match[1].slice(0, 3).toLowerCase()], Number(match[2])));
}

function calendarBlocksByDate() {
  const calendar = JSON.parse(readFileSync(CALENDAR_PATH, "utf8"));
  const rows = calendar?.tabs?.[PRIMARY_TAB] || [];
  const byDate = new Map();
  for (const row of rows.slice(2)) {
    const weekStart = parseWeekStart(row);
    if (!weekStart) continue;
    for (const day of DAY_COLUMNS) {
      const text = String(row[day.index] || "").trim();
      if (!text) continue;
      const date = addDays(weekStart, day.offset).toISOString().slice(0, 10);
      const blocks = byDate.get(date) || [];
      blocks.push(text);
      byDate.set(date, blocks);
    }
  }
  return byDate;
}

async function importMatches() {
  const source = readFileSync(MATCHES_PATH, "utf8");
  const sourceUrl = pathToFileURL(MATCHES_PATH).href;
  const encoded = Buffer.from(`${source}\n//# sourceURL=${sourceUrl}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const { CALENDAR_TRANSCRIPT_MATCHES } = await importMatches();
const blocksByDate = calendarBlocksByDate();

assert.ok(Array.isArray(CALENDAR_TRANSCRIPT_MATCHES), "CALENDAR_TRANSCRIPT_MATCHES must be an array");

const seenPaths = new Set();
const seenVaultIds = new Set();
for (const [index, match] of CALENDAR_TRANSCRIPT_MATCHES.entries()) {
  assert.match(match?.date || "", /^\d{4}-\d{2}-\d{2}$/, `match ${index} must have an ISO date`);
  const fragments = Array.isArray(match.title_contains)
    ? match.title_contains
    : match.title_contains
      ? [match.title_contains]
      : [];
  assert.ok(fragments.length, `match ${index} must have title_contains fragments`);
  const blocks = blocksByDate.get(match.date) || [];
  const matchingBlock = blocks.find(block => {
    const hay = normalizedMatchText(block);
    return fragments.every(fragment => hay.includes(normalizedMatchText(fragment)));
  });
  assert.ok(matchingBlock, `match ${index} (${match.date}) does not match any calendar block`);
  assert.ok(Array.isArray(match.sources) && match.sources.length, `match ${index} must have sources`);

  for (const [sourceIndex, source] of match.sources.entries()) {
    const where = `match ${index} source ${sourceIndex}`;
    if (source?.held) {
      // Held-private source: the raw transcript lives outside the public
      // repo; only the timeline anchor + mention snapshot are committed.
      assert.equal(source.held, "private-vault", `${where} held must be "private-vault"`);
      assert.ok(!source.path, `${where} must not carry a path when held privately`);
      assert.match(source.vault_id || "", /^[a-z0-9][a-z0-9-]*$/, `${where} must have a kebab-case vault_id`);
      assert.ok(source.label, `${where} must keep a label`);
      for (const key of ["mentions_direct", "mentions_any"]) {
        const list = source[key];
        if (list == null) continue;
        assert.ok(Array.isArray(list), `${where} ${key} must be an array`);
        for (const id of list) {
          assert.match(String(id), /^[a-z0-9][a-z0-9-]*$/, `${where} ${key} entries must be record_id slugs`);
        }
      }
      seenVaultIds.add(source.vault_id);
      continue;
    }
    assert.ok(source?.path, `${where} must have a path or be held privately`);
    const absPath = path.resolve(ROOT, source.path);
    const relToRaw = path.relative(RAW_ROOT, absPath);
    assert.ok(!relToRaw.startsWith("..") && !path.isAbsolute(relToRaw), `${source.path} must stay under raw-scripts`);
    assert.ok(existsSync(absPath), `${source.path} does not exist`);
    assert.match(source.path, /\.(txt|md|markdown)$/i, `${source.path} must be a transcript text file`);
    seenPaths.add(source.path);
  }
}

console.log(`calendar transcript matches ok (${CALENDAR_TRANSCRIPT_MATCHES.length} matches, ${seenPaths.size} bundled sources, ${seenVaultIds.size} held privately)`);
