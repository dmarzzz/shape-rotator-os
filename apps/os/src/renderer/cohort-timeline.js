// Read-only cohort timeline loader for renderer surfaces.
//
// The generated artifact is the canonical public self-declaration timeline:
// Git history of cohort-data/people and cohort-data/teams, with each snapshot
// carrying a complete public cohort surface. Renderer views consume snapshots
// directly instead of replaying events in-browser.

const TIMELINE_URL = new URL("../cohort-timeline.json", import.meta.url);

let _cache = null;
let _promise = null;

function emptySurface() {
  return { schema_version: 1, teams: [], people: [], clusters: [], program: [], events: [], asks: [], cohort_vocab: {}, calendar: null };
}

// Last-wins by record_id, matching buildCohortIndex semantics, so snapshot
// counts can never disagree with the nodes a view actually renders.
function dedupById(records) {
  const byId = new Map();
  const anonymous = [];
  for (const record of Array.isArray(records) ? records : []) {
    const id = record?.record_id;
    if (id) byId.set(id, record);
    else if (record) anonymous.push(record);
  }
  return [...byId.values(), ...anonymous];
}

function normalizeSurface(surface) {
  const src = surface && typeof surface === "object" ? surface : {};
  return {
    ...emptySurface(),
    ...src,
    teams: dedupById(src.teams),
    people: dedupById(src.people),
    clusters: Array.isArray(src.clusters) ? src.clusters : [],
    program: Array.isArray(src.program) ? src.program : [],
    events: Array.isArray(src.events) ? src.events : [],
    asks: Array.isArray(src.asks) ? src.asks : [],
    cohort_vocab: src.cohort_vocab && typeof src.cohort_vocab === "object" ? src.cohort_vocab : {},
    calendar: src.calendar && typeof src.calendar === "object" ? src.calendar : null,
  };
}

function normalizeTimeline(data) {
  const src = data && typeof data === "object" ? data : {};
  const snapshots = Array.isArray(src.snapshots)
    ? src.snapshots
        .filter((snapshot) => snapshot && typeof snapshot === "object" && snapshot.id)
        .map((snapshot) => {
          const surface = normalizeSurface(snapshot.surface);
          // Counts are derived from the deduped surface, not trusted from the
          // artifact — a generator double-emit must not skew the meta line.
          return {
            ...snapshot,
            surface,
            counts: {
              teams: surface.teams.length,
              people: surface.people.length,
              clusters: surface.clusters.length,
            },
          };
        })
    : [];
  return {
    ...src,
    snapshots,
    events: Array.isArray(src.events) ? src.events : [],
    sources: Array.isArray(src.sources) ? src.sources : [],
  };
}

export async function getCohortTimeline() {
  if (_cache) return _cache;
  if (_promise) return _promise;
  _promise = (async () => {
    const res = await fetch(TIMELINE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`cohort timeline unavailable: HTTP ${res.status}`);
    const data = await res.json();
    _cache = normalizeTimeline(data);
    return _cache;
  })().finally(() => {
    _promise = null;
  });
  return _promise;
}

