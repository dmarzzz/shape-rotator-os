import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextSubmission,
  contextSubmissionsUrl,
  postContextSubmission,
  submitContext,
  BODY_MAX,
  TITLE_MAX,
  CONTEXT_SUBMISSION_KINDS,
} from './context-submit.mjs';

const CONFIG = { url: 'https://example.supabase.co', anonKey: 'anon-key' };

// --- buildContextSubmission (pure validation/normalization) ------------------

test('build: valid note produces a pending payload for this org', () => {
  const r = buildContextSubmission({ source_kind: 'note', body: '  a useful bit of info  ' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.source_kind, 'note');
  assert.equal(r.payload.body, 'a useful bit of info'); // trimmed
  assert.equal(r.payload.org_id, 'srfg');
  assert.equal(r.payload.processing_status, 'pending');
  assert.equal(r.payload.metadata.char_count, 'a useful bit of info'.length);
  assert.equal(r.payload.metadata.submitted_via, 'os-context-vault');
});

test('build: kind defaults to note when omitted', () => {
  const r = buildContextSubmission({ body: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.source_kind, 'note');
});

test('build: unsupported kind is rejected', () => {
  const r = buildContextSubmission({ source_kind: 'router', body: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported kind/);
});

test('build: empty body is rejected', () => {
  assert.equal(buildContextSubmission({ body: '   ' }).ok, false);
  assert.equal(buildContextSubmission({}).ok, false);
});

test('build: oversize body is rejected client-side (matches server CHECK)', () => {
  const r = buildContextSubmission({ body: 'x'.repeat(BODY_MAX + 1) });
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
});

test('build: title and contact are trimmed, capped, and nulled when empty', () => {
  const r = buildContextSubmission({ body: 'x', title: '  ' + 't'.repeat(TITLE_MAX + 50), contact: '  ' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.title.length, TITLE_MAX);
  assert.equal(r.payload.contact, null);
});

test('build: client_id and app_version included only when provided', () => {
  const without = buildContextSubmission({ body: 'x' });
  assert.equal('client_id' in without.payload, false);
  assert.equal('app_version' in without.payload, false);
  const withMeta = buildContextSubmission({ body: 'x' }, { clientId: 'c_123', appVersion: '0.3.8' });
  assert.equal(withMeta.payload.client_id, 'c_123');
  assert.equal(withMeta.payload.app_version, '0.3.8');
});

test('kinds list stays in lockstep with the migration CHECK set', () => {
  const values = CONTEXT_SUBMISSION_KINDS.map((k) => k.value).sort();
  assert.deepEqual(values, ['audio', 'doc', 'link', 'note', 'other', 'transcript', 'video']);
});

// --- contextSubmissionsUrl ---------------------------------------------------

test('url: trims trailing slashes and targets the table', () => {
  assert.equal(
    contextSubmissionsUrl('https://example.supabase.co///'),
    'https://example.supabase.co/rest/v1/context_submissions',
  );
});

// --- postContextSubmission (resilient network) -------------------------------

test('post: unconfigured (no url/anonKey) resolves with reason unconfigured', async () => {
  const r = await postContextSubmission({ body: 'x' }, { config: { url: '', anonKey: '' }, fetchImpl: () => {
    throw new Error('should not fetch');
  } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unconfigured');
});

test('post: success sends INSERT-only headers (Prefer: return=minimal)', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 201 };
  };
  const r = await postContextSubmission({ body: 'x' }, { config: CONFIG, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.prefer, 'return=minimal'); // no read-back; anon has no SELECT
  assert.equal(seen.init.headers.apikey, 'anon-key');
  assert.equal(seen.init.headers.authorization, 'Bearer anon-key');
  assert.equal(seen.url, 'https://example.supabase.co/rest/v1/context_submissions');
});

test('post: 401/403 classified as forbidden', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'nope' }) });
  const r = await postContextSubmission({ body: 'x' }, { config: CONFIG, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden');
  assert.equal(r.error, 'nope');
});

test('post: other non-ok classified as rejected with detail', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ message: 'bad body' }) });
  const r = await postContextSubmission({ body: 'x' }, { config: CONFIG, fetchImpl });
  assert.equal(r.reason, 'rejected');
  assert.equal(r.error, 'bad body');
});

test('post: thrown fetch resolves with reason network (never throws)', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const r = await postContextSubmission({ body: 'x' }, { config: CONFIG, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network');
});

// --- submitContext (validate + post) -----------------------------------------

test('submit: invalid input short-circuits before any fetch', async () => {
  let fetched = false;
  const r = await submitContext({ body: '' }, { config: CONFIG, clientId: '', fetchImpl: () => { fetched = true; } });
  assert.equal(r.ok, false);
  assert.equal(fetched, false);
});

test('submit: valid input posts the built payload', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 201 }; };
  const r = await submitContext({ source_kind: 'transcript', body: 'hello' }, { config: CONFIG, clientId: 'c_x', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(body.source_kind, 'transcript');
  assert.equal(body.body, 'hello');
  assert.equal(body.client_id, 'c_x');
  assert.equal(body.processing_status, 'pending');
});
