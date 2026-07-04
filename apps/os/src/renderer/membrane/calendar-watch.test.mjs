import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage shim so the seen-ledger actually persists — the
// eviction test below re-imports the module (query-suffix → fresh instance)
// to exercise the write→re-read cycle a real app restart performs. Defined
// before any seen() call runs (readSeen is lazy), so every test shares it.
const __store = new Map();
globalThis.localStorage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => { __store.set(k, String(v)); },
  removeItem: (k) => { __store.delete(k); },
};

const { computeIncoming, acknowledgeIncoming } = await import('./calendar-watch.mjs');

// "HH:MM" offsetMin minutes after nowMs (local clock) — keeps the proximity
// assertions timezone-independent. ymdAfterDays gives a local YYYY-MM-DD.
function clockAfter(nowMs, offsetMin) {
  const d = new Date(nowMs + offsetMin * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function ymdAfterDays(nowMs, days) {
  const d = new Date(nowMs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const byKind = (r, k) => r.cards.filter((c) => c.kind === k);

// One sequential scenario (the seen-ledger persists in-memory across calls,
// which is exactly the lifecycle we want to exercise): prime → soon → new →
// ack → changed.
test('incoming-watch: proximity + prime-silently + new + ack + changed', () => {
  const now = new Date(); now.setHours(10, 0, 0, 0); // mid-morning: +30m can't cross midnight
  const nowMs = now.getTime();
  const tomorrow = ymdAfterDays(nowMs, 1);
  const tea = { time: clockAfter(nowMs, 30), title: 'tea on roof' };
  const person = {
    record_id: 'novel-tokens', name: 'Novel Tokens',
    role_class: 'visiting-scholar', dates_start: ymdAfterDays(nowMs, 2),
  };
  const base = { eventsToday: [tea], people: [person], nowMs };

  // 1 — primes the diff baseline SILENTLY, but still surfaces real proximity.
  const r1 = computeIncoming({ ...base, eventsUpcoming: [{ date: tomorrow, time: '16:00', title: 'demo night' }] });
  assert.ok(byKind(r1, 'event-soon').some((c) => c.title === 'tea on roof'), 'tea is incoming');
  assert.ok(byKind(r1, 'person-soon').some((c) => c.title === 'Novel Tokens'), 'arrival greeted');
  assert.equal(byKind(r1, 'event-new').length, 0, 'prime is silent — no "new" spam');
  assert.equal(byKind(r1, 'event-changed').length, 0, 'prime is silent — no "changed" spam');

  // 2 — a brand-new event appears → exactly one event-new card.
  const up2 = [{ date: tomorrow, time: '16:00', title: 'demo night' }, { date: tomorrow, time: '18:00', title: 'salon' }];
  const r2 = computeIncoming({ ...base, eventsUpcoming: up2 });
  const newSalon = byKind(r2, 'event-new').find((c) => c.title === 'salon');
  assert.ok(newSalon, 'salon shows as new');

  // ack it → it must not reappear at the same time.
  acknowledgeIncoming(newSalon.seenKey);
  const r2b = computeIncoming({ ...base, eventsUpcoming: up2 });
  assert.equal(byKind(r2b, 'event-new').filter((c) => c.title === 'salon').length, 0, 'acked event stays gone');

  // 3 — salon moves 18:00 → 19:00 → an event-changed card with old→new.
  const r3 = computeIncoming({ ...base, eventsUpcoming: [{ date: tomorrow, time: '16:00', title: 'demo night' }, { date: tomorrow, time: '19:00', title: 'salon' }] });
  const moved = byKind(r3, 'event-changed').find((c) => c.title === 'salon');
  assert.ok(moved, 'salon shows as time-changed (identity excludes the clock)');
  assert.match(moved.detail, /18:00.*19:00/, 'change card shows old → new');

  // recurrence — an ongoing ritual present today AND tomorrow collapses to ONE
  // identity, so it never re-fires as "new event" every day.
  const r4 = computeIncoming({
    eventsToday: [{ time: '14:00', title: 'daily tea', ongoing: true }],
    eventsUpcoming: [{ date: tomorrow, time: '14:00', title: 'daily tea', ongoing: true }],
    people: [], nowMs,
  });
  assert.equal(byKind(r4, 'event-new').filter((c) => c.title === 'daily tea').length, 1,
    'recurring ritual yields one new-card, not one per day');
});

// An event moved 18:00 → 19:00 (acked) and then REVERTED to 18:00 must
// re-surface — the ledger keeps only the LAST acknowledged time per identity.
// Before the fix the original evt:…@18:00 entry lingered, matched the revert,
// and the user was never told (last word they had was "moved to 19:00").
test('incoming-watch: a move BACK to an acknowledged time re-surfaces', () => {
  const now = new Date(); now.setHours(10, 0, 0, 0);
  const nowMs = now.getTime();
  const tomorrow = ymdAfterDays(nowMs, 1);
  const at = (time) => ({ eventsToday: [], eventsUpcoming: [{ date: tomorrow, time, title: 'retro' }], people: [], nowMs });

  const r1 = computeIncoming(at('18:00'));
  const fresh = r1.cards.find((c) => c.kind === 'event-new' && c.title === 'retro');
  assert.ok(fresh, 'retro fires as new');
  acknowledgeIncoming(fresh.seenKey);

  const r2 = computeIncoming(at('19:00'));
  const moved = r2.cards.find((c) => c.kind === 'event-changed' && c.title === 'retro');
  assert.ok(moved, 'move fires as changed');
  acknowledgeIncoming(moved.seenKey);

  const r3 = computeIncoming(at('18:00'));
  const reverted = r3.cards.find((c) => c.kind === 'event-changed' && c.title === 'retro');
  assert.ok(reverted, 'revert to a previously-acknowledged time re-surfaces');
  assert.match(reverted.detail, /19:00.*18:00/, 'shows 19:00 → 18:00');
});

// Ledger eviction must sacrifice acknowledgements (soon:/arr:) before the
// event baseline: FIFO-dropping an evt: entry resurrects an already-
// acknowledged event as "new" once enough daily dismissals accumulate.
// (Keep this test LAST in the file — the flood pollutes the shared ledger.)
test('incoming-watch: ack-flood eviction never resurrects the event baseline', async () => {
  const now = new Date(); now.setHours(10, 0, 0, 0);
  const nowMs = now.getTime();
  const tomorrow = ymdAfterDays(nowMs, 1);
  const ev = { date: tomorrow, time: '09:00', title: 'quiet standup' };
  const args = { eventsToday: [], eventsUpcoming: [ev], people: [], nowMs };

  const r1 = computeIncoming(args);
  const card = r1.cards.find((c) => c.kind === 'event-new' && c.title === 'quiet standup');
  assert.ok(card, 'fresh event fires once');
  acknowledgeIncoming(card.seenKey);
  // Flood far past the 600-entry cap with proximity acknowledgements.
  for (let i = 0; i < 700; i++) acknowledgeIncoming(`soon:${tomorrow}|flood-${i}|0`);

  // A fresh module instance re-reads the truncated persisted ledger — the
  // same thing an app relaunch does.
  const m2 = await import('./calendar-watch.mjs?fresh-after-eviction');
  const r2 = m2.computeIncoming(args);
  assert.equal(r2.cards.filter((c) => c.kind === 'event-new' && c.title === 'quiet standup').length, 0,
    'acknowledged event must not resurrect after ack-flood eviction');
});
