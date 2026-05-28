#!/usr/bin/env node
/**
 * build-ics.js — render cohort-data/calendar.json into an iCalendar feed at
 * cohort-data/calendar.ics so the schedule can be imported into / subscribed
 * from Apple Calendar, Google Calendar, Outlook, etc.
 *
 * The Phala schedule is a spreadsheet dump: tabs → rows → freeform cells. A
 * cell like the "Wed" column for week 1 holds multiple lines of times and
 * notes with no reliable machine structure. Rather than guess timed events
 * out of that text (typos like "12:00:14:00", ranges like "Mon-Tue: …"), we
 * emit ONE all-day event per non-empty day cell. The cell text is the event
 * body; the first line is the title. This is lossless and deterministic — a
 * human reading the imported calendar sees exactly the cell they'd see in the
 * grid, on the right day.
 *
 * Dates: the "Dates" column gives the Monday of each week (e.g. "May 18–23").
 * The day columns (Mon…Sun) map to Monday+0 … Monday+6. The cohort year is
 * taken from last_refresh so output is self-contained. (Verified against the
 * data: May 18 2026 = Mon, Jul 4 2026 = Sat.)
 *
 * Output is deterministic — DTSTAMP is pinned to last_refresh and events are
 * sorted — so `--check` can detect drift byte-for-byte, the same contract
 * sync-calendar.js uses.
 *
 * Usage:
 *   node scripts/build-ics.js            # write cohort-data/calendar.ics
 *   node scripts/build-ics.js --check    # exit 1 if the committed .ics is stale
 */

const fs   = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "..", "cohort-data", "calendar.json");
const OUT = path.resolve(__dirname, "..", "cohort-data", "calendar.ics");

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

// RFC 5545 §3.3.5 UTC date-time, e.g. 20260521T183346Z.
function dtstamp(iso) {
  const d = new Date(iso);
  return `${ymd(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, newline.
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545 §3.1 content lines fold at 75 octets; continuation starts with a
// space. We measure bytes (UTF-8) so multibyte chars never split a fold.
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    // First line 75 octets, continuations 74 (the leading space costs one).
    const limit = out.length === 0 ? 75 : 74;
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multibyte char: back off until `end` is a char boundary.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((out.length ? " " : "") + bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return out.join("\r\n");
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Pull the first "<Month> <day>" out of a Dates cell → {month, day}, or null.
function parseMonthDay(cell) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(cell || "");
  return m ? { month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: Number(m[2]) } : null;
}

// Locate the header row of a tab and its day columns. Returns null for tabs
// that aren't day-grid schedules (e.g. "Weekly Themes", whose columns are
// Phase/Theme/Goals, not weekdays).
function headerInfo(rows) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const dayCols = [];
    let datesCol = -1;
    row.forEach((cell, c) => {
      const v = String(cell).trim();
      const wd = WEEKDAYS.indexOf(v);
      if (wd !== -1) dayCols.push({ col: c, offset: wd });
      if (v === "Dates") datesCol = c;
    });
    if (dayCols.length && datesCol !== -1) return { headerRow: r, dayCols, datesCol };
  }
  return null;
}

function collectEvents(json) {
  const year = new Date(json.last_refresh).getUTCFullYear();
  if (!Number.isFinite(year)) throw new Error("calendar.json missing a valid last_refresh");
  const events = [];
  for (const [tab, rows] of Object.entries(json.tabs || {})) {
    const hdr = headerInfo(rows);
    if (!hdr) continue;
    for (let r = hdr.headerRow + 1; r < rows.length; r++) {
      const md = parseMonthDay(rows[r][hdr.datesCol]);
      if (!md) continue;
      const monday = new Date(Date.UTC(year, md.month, md.day));
      for (const { col, offset } of hdr.dayCols) {
        const text = String(rows[r][col] ?? "").trim();
        if (!text) continue;
        const date = new Date(monday.getTime() + offset * 86400000);
        const title = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || text;
        events.push({
          date,
          uid: `${slug(tab)}-${ymd(date)}-${WEEKDAYS[offset].toLowerCase()}@shape-rotator-os`,
          summary: title.length > 80 ? title.slice(0, 77) + "…" : title,
          description: text,
          category: tab,
        });
      }
    }
  }
  events.sort((a, b) => (a.date - b.date) || a.uid.localeCompare(b.uid));
  return events;
}

function generateIcs(json) {
  const stamp = dtstamp(json.last_refresh);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//shape-rotator-os//cohort calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Shape Rotator Cohort",
  ];
  for (const e of collectEvents(json)) {
    const next = new Date(e.date.getTime() + 86400000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.date)}`,
      `DTEND;VALUE=DATE:${ymd(next)}`,
      `SUMMARY:${esc(e.summary)}`,
      `DESCRIPTION:${esc(e.description)}`,
      `CATEGORIES:${esc(e.category)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function main() {
  const json = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const ics = generateIcs(json);
  const rel = path.relative(path.resolve(__dirname, ".."), OUT);

  if (process.argv.includes("--check")) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (existing !== ics) {
      console.error(`[build-ics] --check: ${rel} is stale — run \`node scripts/build-ics.js\``);
      process.exit(1);
    }
    console.log(`[build-ics] --check: ${rel} is up to date`);
    return;
  }

  fs.writeFileSync(OUT, ics);
  console.log(`[build-ics] wrote ${rel} (${(ics.match(/BEGIN:VEVENT/g) || []).length} events)`);
}

module.exports = { generateIcs, collectEvents };

if (require.main === module) main();
