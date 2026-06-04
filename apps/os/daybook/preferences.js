'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Learning store.
//
// Every revision note is logged silently. Notes do NOT influence future
// drafts one-by-one — a one-off ("make it iambic pentameter") stays a one-off.
// Only when the SAME intent recurs across several notes does it get distilled
// into a standing preference (see reflect.extractPatterns) and applied. The
// distilled patterns are cached so we don't re-derive them every run.
//
// Files (all on your machine, under ~/.router-daybook/):
//   notes.jsonl     — the raw note log
//   patterns.json   — { notesCount, patterns: [...] } cache of recurring prefs
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.router-daybook');
const NOTES_FILE = path.join(DIR, 'notes.jsonl');
const CACHE_FILE = path.join(DIR, 'patterns.json');

// Need at least this many notes before a pattern is even possible.
const MIN_NOTES = 3;
// Only feed the most recent notes to the pattern extractor.
const WINDOW = 40;

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ } }

function recordNote(text, date) {
  const clean = (text || '').trim();
  if (!clean) return;
  ensureDir();
  try { fs.appendFileSync(NOTES_FILE, JSON.stringify({ ts: Date.now(), date: date || '', text: clean }) + '\n'); }
  catch { /* ignore */ }
}

function readNotes() {
  try {
    return fs.readFileSync(NOTES_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { notesCount: -1, patterns: [] }; }
}

function savePatterns(notesCount, patterns) {
  ensureDir();
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ notesCount, patterns: patterns || [] }, null, 2)); }
  catch { /* ignore */ }
}

// The window of notes to analyze for patterns.
function notesWindow() { return readNotes().slice(-WINDOW); }

// Should we (re-)derive patterns? Only when there are enough notes AND the note
// count has changed since the cache was built.
function shouldDerive() {
  const n = readNotes().length;
  return n >= MIN_NOTES && n !== readCache().notesCount;
}

// Currently learned patterns as { patterns, text } for the prompt.
function learned() {
  const patterns = readCache().patterns || [];
  return { patterns, text: patterns.map((p) => `- ${p}`).join('\n') };
}

// Forget everything (notes log + derived patterns).
function clearAll() {
  try { fs.writeFileSync(NOTES_FILE, ''); } catch { /* ignore */ }
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ notesCount: 0, patterns: [] })); } catch { /* ignore */ }
}

module.exports = {
  recordNote, readNotes, notesWindow, shouldDerive, savePatterns, learned, clearAll,
  MIN_NOTES, NOTES_FILE, CACHE_FILE,
};
