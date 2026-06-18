import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Boundary test for the private user-submitted-context inbox. Mirrors the house
// convention (every Supabase migration ships a companion test asserting its RLS
// + grant boundary). This table is the INVERSE of the public_* projections:
// anon may INSERT a pending row and nothing else.
const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260618120000_context_submissions.sql', import.meta.url),
  'utf8',
);

test('migration creates the private context_submissions table with RLS', () => {
  assert.match(migration, /create table if not exists public\.context_submissions/);
  assert.match(migration, /alter table public\.context_submissions enable row level security/);
});

test('anon/authenticated get INSERT only — no SELECT/UPDATE/DELETE grant', () => {
  assert.match(migration, /revoke all on public\.context_submissions from anon, authenticated/);
  assert.match(migration, /grant insert on public\.context_submissions to anon, authenticated/);
  // The whole point: anon must never be able to read submissions back.
  assert.doesNotMatch(migration, /grant select[^;]*\bto[^;]*\banon\b/);
});

test('service_role keeps the verbs the engine needs', () => {
  assert.match(migration, /grant select, insert, update on public\.context_submissions to service_role/);
});

test('insert policy gates on pending status, org, length, and known kind', () => {
  assert.match(migration, /create policy "anon submit context"/);
  assert.match(migration, /for insert/);
  assert.match(migration, /with check \(/);
  assert.match(migration, /processing_status = 'pending'/);
  assert.match(migration, /org_id = 'srfg'/);
  assert.match(migration, /char_length\(body\) between 1 and 200000/);
});

test('table CHECK constraints defend independently of RLS', () => {
  assert.match(migration, /constraint context_submissions_body_len/);
  assert.match(migration, /constraint context_submissions_kind_allowed/);
  assert.match(migration, /constraint context_submissions_status_allowed/);
});

test('the inbox is NEVER wrapped in a public_* view', () => {
  assert.doesNotMatch(migration, /public_context_submissions/);
  assert.doesNotMatch(migration, /create view[^;]*context_submissions/);
});
