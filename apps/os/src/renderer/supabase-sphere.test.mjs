import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAllSpheres, saveSphere, normalizeHex,
  SPHERE_DIALS, SPHERE_KEYS, SPHERE_DEFAULTS, SPHERE_BG_DEFAULT, SPHERE_INTENSITY, SPHERE_BG_PRESETS,
} from './supabase-sphere.mjs';

const CONFIG = { url: 'https://proj.supabase.co', anonKey: 'anon-key' };
const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, async json() { return body; } });

test('SPHERE_DIALS: five editable dials; keys + defaults consistent', () => {
  assert.equal(SPHERE_DIALS.length, 5);
  // Display order (Tempest/phase moved to the bottom for the wiggly wave); the set
  // of keys is unchanged.
  assert.deepEqual(SPHERE_DIALS.map((d) => d.key), ['hue', 'complexity', 'hue2', 'intensity', 'phase']);
  assert.equal(SPHERE_DIALS.filter((d) => d.wave).map((d) => d.key).join(), 'phase');  // Tempest has the wave
  // All five float columns are dials; hue2 → Strata, intensity → Filament.
  assert.deepEqual(SPHERE_KEYS, ['hue', 'hue2', 'phase', 'intensity', 'complexity']);
  assert.equal(SPHERE_INTENSITY, 0.3);   // fixed rim glow (render-time constant)
  assert.equal(SPHERE_DEFAULTS.hue2, 0.3);        // Strata → 3 layers
  assert.equal(SPHERE_DEFAULTS.intensity, 0.3333); // Filament → 1.2 exponent
  assert.equal(SPHERE_DEFAULTS.complexity, 0.25);
});

test('fetchAllSpheres: maps + clamps rows, drops invalid', async () => {
  let calledUrl = null, calledOpts = null;
  const fetchImpl = async (url, opts) => {
    calledUrl = url; calledOpts = opts;
    return jsonResponse([
      { record_id: 'a', hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5 },
      { record_id: 'b', hue: 2, hue2: -1, phase: 0.3, intensity: 0.4, complexity: 0.5 }, // out of range → clamped
      { record_id: 'c', hue: 0.1 },                                                       // missing dials → dropped
      { hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5 },               // no record_id → dropped
    ]);
  };
  const { spheres, source } = await fetchAllSpheres({ fetchImpl, config: CONFIG });
  assert.equal(source, 'supabase');
  assert.ok(calledUrl.startsWith('https://proj.supabase.co/rest/v1/os_spheres'));
  assert.ok(calledUrl.includes('select='));
  assert.equal(calledOpts.headers.apikey, 'anon-key');
  assert.equal(calledOpts.headers.authorization, 'Bearer anon-key');
  assert.deepEqual(spheres.a, { hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5 });
  assert.deepEqual(spheres.b, { hue: 1, hue2: 0, phase: 0.3, intensity: 0.4, complexity: 0.5 }, 'clamped to [0,1]');
  assert.equal(spheres.c, undefined, 'incomplete row dropped');
  assert.equal(Object.keys(spheres).length, 2);
});

test('fetchAllSpheres: unconfigured + http error degrade to empty', async () => {
  const r1 = await fetchAllSpheres({ fetchImpl: async () => jsonResponse([]), config: { url: '', anonKey: '' } });
  assert.equal(r1.source, 'unconfigured');
  assert.deepEqual(r1.spheres, {});

  const r2 = await fetchAllSpheres({ fetchImpl: async () => jsonResponse(null, false, 500), config: CONFIG });
  assert.equal(r2.source, 'error');
  assert.deepEqual(r2.spheres, {});
});

test('saveSphere: upsert POST with clamped body + merge-duplicates', async () => {
  let url = null, opts = null;
  const fetchImpl = async (u, o) => { url = u; opts = o; return { ok: true, status: 204, async json() { return null; } }; };
  const res = await saveSphere('albiona-hoti', { hue: 0.5, hue2: 1.5, phase: -2, intensity: 0.9 }, { fetchImpl, config: CONFIG });
  assert.deepEqual(res, { ok: true });
  assert.equal(url, 'https://proj.supabase.co/rest/v1/os_spheres');
  assert.equal(opts.method, 'POST');
  assert.match(opts.headers.prefer, /resolution=merge-duplicates/);
  assert.match(opts.headers.prefer, /return=minimal/);
  assert.equal(opts.headers.apikey, 'anon-key');
  const body = JSON.parse(opts.body);
  assert.equal(body.record_id, 'albiona-hoti');
  assert.equal(body.hue, 0.5);
  assert.equal(body.hue2, 1, 'clamped down to 1');
  assert.equal(body.phase, 0, 'clamped up to 0');
  assert.equal(body.intensity, 0.9);
  assert.equal(body.complexity, 0.25, 'omitted dial falls back to its default');
});

test('SPHERE_BG_PRESETS: 10 valid lowercase hex colours incl. the default', () => {
  assert.equal(SPHERE_BG_PRESETS.length, 10);
  for (const hex of SPHERE_BG_PRESETS) assert.equal(normalizeHex(hex), hex, `${hex} must be a valid lowercase #rrggbb`);
  assert.ok(SPHERE_BG_PRESETS.includes(SPHERE_BG_DEFAULT), 'the charcoal default is in the palette');
  assert.equal(new Set(SPHERE_BG_PRESETS).size, 10, 'no duplicate presets');
});

test('normalizeHex: validates + lowercases #rrggbb', () => {
  assert.equal(normalizeHex('#AABBCC'), '#aabbcc');
  assert.equal(normalizeHex('  #10203f '), '#10203f');
  assert.equal(normalizeHex('#abc'), null);   // shorthand not accepted
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex(null), null);
  assert.equal(typeof SPHERE_BG_DEFAULT, 'string');
});

test('fetchAllSpheres: keeps valid bg, ignores bad bg (row still kept)', async () => {
  const fetchImpl = async () => jsonResponse([
    { record_id: 'a', hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5, bg: '#10203F' },
    { record_id: 'b', hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5, bg: 'nope' },
  ]);
  const { spheres } = await fetchAllSpheres({ fetchImpl, config: CONFIG });
  assert.equal(spheres.a.bg, '#10203f', 'valid bg normalised + kept');
  assert.equal('bg' in spheres.b, false, 'invalid bg omitted, row still present');
  assert.ok(spheres.b.hue === 0.1);
});

test('saveSphere: sends valid bg; retries without bg when the write fails', async () => {
  // bg column exists → first write succeeds and carries bg
  let bodies = [];
  const ok = async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, status: 204, async json() { return null; } }; };
  await saveSphere('p', { hue: 0.5, bg: '#abcdef' }, { fetchImpl: ok, config: CONFIG });
  assert.equal(bodies[0].bg, '#abcdef');

  // bg column missing → first POST 400s, retry omits bg so the dials still save
  bodies = [];
  let n = 0;
  const failFirst = async (_u, o) => {
    bodies.push(JSON.parse(o.body)); n += 1;
    return { ok: n > 1, status: n > 1 ? 204 : 400, async json() { return null; } };
  };
  const res = await saveSphere('p', { hue: 0.5, bg: '#abcdef' }, { fetchImpl: failFirst, config: CONFIG });
  assert.equal(res.ok, true, 'retry without bg succeeds');
  assert.equal(bodies.length, 2);
  assert.equal('bg' in bodies[0], true,  'first attempt carried bg');
  assert.equal('bg' in bodies[1], false, 'retry dropped bg');
});

test('saveSphere: includes shader_src when set, null when cleared, omitted when absent', async () => {
  let bodies = [];
  const ok = async (_u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, status: 204, async json() { return null; } }; };

  await saveSphere('p', { hue: 0.5, shader_src: 'pal(t)' }, { fetchImpl: ok, config: CONFIG });
  assert.equal(bodies[0].shader_src, 'pal(t)');

  bodies = [];
  await saveSphere('p', { hue: 0.5, shader_src: '' }, { fetchImpl: ok, config: CONFIG });
  assert.equal(bodies[0].shader_src, null, 'empty string clears it');

  bodies = [];
  await saveSphere('p', { hue: 0.5 }, { fetchImpl: ok, config: CONFIG });
  assert.equal('shader_src' in bodies[0], false, 'omitted when the key is absent (upsert preserves)');
});

test('saveSphere: progressive retry drops shader_src then bg when those columns are missing', async () => {
  let n = 0; const bodies = [];
  // First two POSTs 400 (shader_src then bg column absent); the third (core) succeeds.
  const fetchImpl = async (_u, o) => { bodies.push(JSON.parse(o.body)); n += 1; return { ok: n >= 3, status: n >= 3 ? 204 : 400, async json() { return null; } }; };
  const res = await saveSphere('p', { hue: 0.5, bg: '#abcdef', shader_src: 'pal(t)' }, { fetchImpl, config: CONFIG });
  assert.equal(res.ok, true, 'falls back to a working core write');
  assert.equal(bodies.length, 3);
  assert.equal('shader_src' in bodies[0], true);
  assert.equal('shader_src' in bodies[1], false, 'dropped shader_src on the 1st retry');
  assert.equal('bg' in bodies[1], true);
  assert.equal('bg' in bodies[2], false, 'dropped bg on the 2nd retry');
  assert.equal('hue' in bodies[2], true, 'core dials always survive');
});

test('fetchAllSpheres: carries shader_src text through', async () => {
  const fetchImpl = async () => jsonResponse([
    { record_id: 'a', hue: 0.1, hue2: 0.2, phase: 0.3, intensity: 0.4, complexity: 0.5, shader_src: 'pal(t)' },
  ]);
  const { spheres } = await fetchAllSpheres({ fetchImpl, config: CONFIG });
  assert.equal(spheres.a.shader_src, 'pal(t)');
});

test('saveSphere: bad record id + unconfigured rejected without a network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, async json() { return null; } }; };

  assert.deepEqual(await saveSphere('', { hue: 0.5 }, { fetchImpl, config: CONFIG }), { ok: false, error: 'bad_record_id' });

  const unconf = await saveSphere('x', { hue: 0.5 }, { fetchImpl, config: { url: '', anonKey: '' } });
  assert.equal(unconf.ok, false);
  assert.equal(unconf.error, 'unconfigured');

  assert.equal(called, false, 'no fetch on validation failure');
});
