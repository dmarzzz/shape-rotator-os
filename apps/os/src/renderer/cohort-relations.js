// Local cohort relation builders. These functions intentionally recompute from
// the current in-memory cohort surface; they do not cache remote data or replace
// cohort-source.js as the source boundary.

export function teamKind(team) {
  return team?.kind || "team";
}

export function teamsOfKind(teams, kind) {
  return (Array.isArray(teams) ? teams : []).filter(team => teamKind(team) === kind);
}

export function buildCohortIndex(cohort = {}) {
  const teams = Array.isArray(cohort?.teams) ? cohort.teams : [];
  const people = Array.isArray(cohort?.people) ? cohort.people : [];
  const clusters = Array.isArray(cohort?.clusters) ? cohort.clusters : [];

  const teamById = new Map(teams.filter(t => t?.record_id).map(t => [t.record_id, t]));
  const personById = new Map(people.filter(p => p?.record_id).map(p => [p.record_id, p]));
  const peopleByTeam = new Map();
  const primaryPeopleByTeam = new Map();
  const clustersByTeam = new Map();

  const addPersonToTeam = (map, teamId, person) => {
    if (!teamId || !person) return;
    if (!map.has(teamId)) map.set(teamId, []);
    map.get(teamId).push(person);
  };

  for (const person of people) {
    addPersonToTeam(peopleByTeam, person?.team, person);
    addPersonToTeam(primaryPeopleByTeam, person?.team, person);
    for (const teamId of Array.isArray(person?.secondary_teams) ? person.secondary_teams : []) {
      addPersonToTeam(peopleByTeam, teamId, person);
    }
  }

  for (const cluster of clusters) {
    for (const teamId of Array.isArray(cluster?.teams) ? cluster.teams : []) {
      if (!clustersByTeam.has(teamId)) clustersByTeam.set(teamId, []);
      clustersByTeam.get(teamId).push(cluster);
    }
  }

  const teamLabel = (teamId) => teamById.get(teamId)?.name || teamId || "—";
  const teamForPerson = (person) => person?.team ? teamById.get(person.team) || null : null;
  const teamsForPerson = (person) => {
    const ids = [person?.team, ...(Array.isArray(person?.secondary_teams) ? person.secondary_teams : [])]
      .filter(Boolean);
    return ids.map(id => teamById.get(id)).filter(Boolean);
  };

  return {
    teams,
    people,
    clusters,
    teamById,
    personById,
    peopleByTeam,
    primaryPeopleByTeam,
    clustersByTeam,
    teamLabel,
    teamForPerson,
    teamsForPerson,
  };
}

const DEP_RELATION_LABELS = {
  depends_on: "depends on",
  unblocks: "unblocks",
  pairs_with: "pairs with",
  shares_substrate: "shared substrate",
  complements: "complements",
  contributed_to: "contributed to",
  declared: "declared link",
};
const DEP_STATUS_LABELS = {
  declared: "declared",
  exploring: "exploring",
  active: "active",
  blocked: "blocked",
  resolved: "resolved",
  session_observed: "session-observed",
  github_observed: "GitHub-observed",
  legacy: "profile-declared",
  unknown: "unknown",
};
const DEP_CONFIDENCE_LABELS = {
  low: "candidate signal",
  medium: "source-backed",
  high: "verified signal",
  unknown: "ungraded signal",
};

function relationText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(relationText).filter(Boolean).join(" · ");
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function relationList(value) {
  if (Array.isArray(value)) return value.map(relationText).filter(Boolean);
  const text = relationText(value);
  if (!text) return [];
  return text.split(/\s*[,;]\s*|\n+/).map(item => item.trim()).filter(Boolean);
}

function relationDateText(value) {
  const text = relationText(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

export function dependencySafeToken(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function dependencyPairKey(from, to) {
  return `${String(from || "").trim()}>${String(to || "").trim()}`;
}

function depLabel(map, key, fallback = "unknown") {
  const normalized = dependencySafeToken(key).replace(/-/g, "_");
  return map[normalized] || String(key || fallback).replace(/_/g, " ");
}

function normalizeDependencyRecord(record, have) {
  if (!record || record.record_type !== "dependency") return null;
  const from = relationText(record.source);
  const to = relationText(record.target);
  if (!from || !to || from === to || !have.has(from) || !have.has(to)) return null;
  const relation = dependencySafeToken(record.relation || "declared").replace(/-/g, "_");
  const status = dependencySafeToken(record.status || "declared").replace(/-/g, "_");
  const confidence = dependencySafeToken(record.confidence || "unknown").replace(/-/g, "_");
  return {
    id: record.record_id || dependencyPairKey(from, to),
    record_id: record.record_id || "",
    from,
    to,
    normalized: true,
    source_kind: "dependency_record",
    relation,
    relation_label: depLabel(DEP_RELATION_LABELS, relation, "declared link"),
    status,
    status_label: depLabel(DEP_STATUS_LABELS, status, "declared"),
    confidence,
    confidence_label: depLabel(DEP_CONFIDENCE_LABELS, confidence, "ungraded signal"),
    reason: relationText(record.reason),
    evidence: relationList(record.evidence),
    next_action: relationText(record.next_action),
    owner: relationText(record.owner),
    updated_at: relationDateText(record.updated_at),
  };
}

function legacyDependencyEdge(team, dependencyId) {
  const from = team.record_id;
  const to = String(dependencyId || "").trim();
  return {
    id: `legacy:${dependencyPairKey(from, to)}`,
    record_id: "",
    from,
    to,
    normalized: false,
    source_kind: "team_dependencies",
    relation: "declared",
    relation_label: "declared link",
    status: "legacy",
    status_label: "profile-declared",
    confidence: "unknown",
    confidence_label: "ungraded signal",
    reason: "",
    evidence: [],
    next_action: "",
    owner: "",
    updated_at: "",
  };
}

export function constellationDependencyEdges(teams = [], byRecordId, dependencyRecords = []) {
  const list = Array.isArray(teams) ? teams : [];
  const have = byRecordId || new Map(list.filter(team => team?.record_id).map(team => [team.record_id, team]));
  const edges = [];
  const seen = new Set();
  for (const record of (Array.isArray(dependencyRecords) ? dependencyRecords : [])) {
    const edge = normalizeDependencyRecord(record, have);
    if (!edge) continue;
    const key = dependencyPairKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  for (const team of list) {
    for (const dependencyId of (Array.isArray(team?.dependencies) ? team.dependencies : [])) {
      if (!have.has(dependencyId) || dependencyId === team.record_id) continue;
      const key = dependencyPairKey(team.record_id, dependencyId);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(legacyDependencyEdge(team, dependencyId));
    }
  }
  // Collapse mirror pairs. When A→B and B→A both exist they usually describe ONE
  // relationship declared from both sides (most commonly a typed dependency
  // record one way and an untyped profile mention the other) — drawing two
  // opposing arrows and double-counting it in degree/coverage/score. Keep the
  // typed edge when exactly one side is typed, else the lexicographically-first
  // endpoint as the canonical direction; flag the survivor `mutual`. Two typed
  // records (a deliberately authored bidirectional pair) are left as-is.
  const collapsed = [];
  const indexByPair = new Map();
  for (const edge of edges) {
    const pairKey = collabAffKey(edge.from, edge.to);
    if (!indexByPair.has(pairKey)) {
      indexByPair.set(pairKey, collapsed.length);
      collapsed.push(edge);
      continue;
    }
    const at = indexByPair.get(pairKey);
    const existing = collapsed[at];
    if (existing.normalized && edge.normalized) { collapsed.push(edge); continue; }
    if (edge.normalized && !existing.normalized) collapsed[at] = { ...edge, mutual: true };
    else collapsed[at] = { ...existing, mutual: true };
  }
  return collapsed;
}

export function constellationIndegree(teams = [], dependencyRecords = []) {
  const list = Array.isArray(teams) ? teams : [];
  const have = new Map(list.map(t => [t.record_id, t]));
  const ind = new Map(list.map(t => [t.record_id, 0]));
  for (const edge of constellationDependencyEdges(list, have, dependencyRecords)) {
    if (edge.to !== edge.from && have.has(edge.to)) ind.set(edge.to, (ind.get(edge.to) || 0) + 1);
  }
  return ind;
}

export function constellationModel(teams = [], clusters = [], dependencyRecords = []) {
  const list = Array.isArray(teams) ? teams : [];
  const byRecordId = new Map(list.map(team => [team.record_id, team]));
  const edges = constellationDependencyEdges(list, byRecordId, dependencyRecords);
  const primary = new Map();
  const wellsDef = [];
  for (const cluster of (Array.isArray(clusters) ? clusters : [])) {
    const members = (cluster.teams || []).filter(id => byRecordId.has(id) && !primary.has(id));
    if (!members.length) continue;
    members.forEach(id => primary.set(id, cluster.record_id));
    wellsDef.push({
      id: cluster.record_id || cluster.name,
      label: cluster.label || cluster.name || "cluster",
      members,
    });
  }
  // Fold singleton wells into "unclustered". A full dashed ecosystem circle
  // drawn around ONE node — same footprint as a 6-team well — is the map's
  // loudest source of empty space (12 wells for ~55 projects, several holding a
  // single node). Anything that ends up alone joins the shared well so the map
  // shows ecosystems, not scattered orphans each in their own circle.
  const orphans = list.filter(team => !primary.has(team.record_id)).map(team => team.record_id);
  const grouped = [];
  for (const well of wellsDef) {
    if (well.members.length < 2) orphans.push(...well.members);
    else grouped.push(well);
  }
  if (orphans.length) grouped.push({ id: "_other", label: "unclustered", members: orphans });
  return { byRecordId, wellsDef: grouped, edges, indegree: constellationIndegree(list, dependencyRecords) };
}

const COLLAB_STOP = new Set(("a an and the to of for with in on at or be is are am was were we our us you your yours i me my mine they them their it its this that these those as by from into about over under more most less few many much can could should would will may might want wants wanted need needs needed looking look able build building built make making made get gets help helps using use used via across other others team teams project projects cohort people person folks who whom what when where why how do does done also like just very real new use").split(/\s+/));
const COLLAB_CONCEPTS = [
  { key: "tee", label: "TEE", weight: 2.4, rx: /\b(tee|tees|tdx|sgx|sev|cvm|cvm[s]?|enclave|enclaves|dstack|phala|confidential[\s-]*compute|trusted[\s-]*execution)\b/ },
  { key: "attestation", label: "attestation", weight: 2.3, rx: /\b(attestation|attested|attest|dcap|quote|quotes|ratls|ra[\s-]*tls|remote[\s-]*attestation)\b/ },
  { key: "agent-runtime", label: "agent runtime", weight: 2.1, rx: /\b(agentic|agent|agents|runtime|runtimes|workflow|workflows|harness|harnesses|smithers|eliza|elizaos|openclaw|long[\s-]*running)\b/ },
  { key: "identity", label: "identity", weight: 2.0, rx: /\b(identity|credential|credentials|zk|sybil|anonymous|membership|wallet|wallets|signing|auth|oauth|consent)\b/ },
  { key: "data", label: "data pipeline", weight: 1.8, rx: /\b(data|dataset|datasets|pipeline|pipelines|intake|processing|provenance|evidence|records|transcript|transcripts)\b/ },
  { key: "database", label: "database", weight: 1.8, rx: /\b(postgres|postgresql|sql|database|db|replication|backup|failover|wal|indexer|indexing)\b/ },
  { key: "crypto", label: "crypto design", weight: 1.7, rx: /\b(crypto|cryptographic|cryptography|threshold|lattice|post[\s-]*quantum|pqc|ml[\s-]*kem|mpc|proof|proofs|formal|verification|kani|cvc5|cbmc)\b/ },
  { key: "payments", label: "payments", weight: 1.5, rx: /\b(payment|payments|x402|micropayment|micropayments|settlement|routing|market|markets|order[\s-]*flow|liquidity)\b/ },
  { key: "ux", label: "UX/design", weight: 1.4, rx: /\b(ux|design|storytelling|feedback|framing|demo|demos|user[\s-]*journey|interface|interfaces)\b/ },
  { key: "gtm", label: "GTM/fundraise", weight: 1.3, rx: /\b(gtm|sales|fundraising|fundraise|customer|customers|pilot|pilots|buyer|buyers|distribution|partnership|partnerships)\b/ },
];
const COLLAB_CONCEPT_BY_KEY = new Map(COLLAB_CONCEPTS.map(concept => [concept.key, concept]));
const COLLAB_CLUSTER_DEFS = [
  { id: "attestation", label: "Attestation / TEE", rank: 0, test: (_team, text) => /\b(attestation|attested|attest|dcap|quote|ratls|ra[\s-]*tls|remote[\s-]*attestation)\b/.test(text) },
  { id: "dstack", label: "dstack · Phala", rank: 1, test: (_team, text) => /\b(dstack|phala)\b/.test(text) },
  { id: "trusted-execution", label: "Trusted execution", rank: 2, test: (team, text) => {
    const skills = collabText(team.skill_areas);
    return team.domain === "tee" || /\b(tee|tdx|sgx|sev|cvm|enclave)\b/.test(skills) || /\b(confidential[\s-]*compute|trusted[\s-]*execution)\b/.test(text);
  } },
  { id: "identity", label: "Identity · creds", rank: 3, test: (_team, text) => /\b(identity|credential|credentials|zk|wallet|wallets|consent|sybil|anonymous|membership|oauth)\b/.test(text) },
  { id: "agent-runtime", label: "Agent runtime", rank: 4, test: (_team, text) => /\b(agent[\s-]*runtime|runtime|harness|workflow|workflows|smithers|eliza|elizaos|openclaw|long[\s-]*running)\b/.test(text) },
  { id: "agentic", label: "Agentic systems", rank: 5, test: (team, text) => team.domain === "ai" || /\b(agentic|agents?|llm|memory|context|routing)\b/.test(text) },
  { id: "crypto", label: "Crypto · protocols", rank: 6, test: (team, text) => team.domain === "crypto" || /\b(crypto|cryptographic|cryptography|protocol|threshold|lattice|pqc|mpc|proof|formal|verification)\b/.test(text) },
  { id: "app-ux", label: "App · UX", rank: 7, test: (team, text) => team.domain === "app-ux" || /\b(ux|design|storytelling|interface|demo|front[\s-]*end|product)\b/.test(text) },
];
const COLLAB_OTHER_CLUSTER = { id: "other", label: "Other", rank: 8 };

function normalizeSkillAreaToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function modelSkillAreas(areas, skillAreaVocab = []) {
  const vocab = Array.isArray(skillAreaVocab)
    ? new Set(skillAreaVocab.map(normalizeSkillAreaToken).filter(Boolean))
    : new Set();
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(areas) ? areas : []) {
    const normalized = normalizeSkillAreaToken(raw);
    if (!normalized) continue;
    if ((vocab.size && !vocab.has(normalized)) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collabTokens(value) {
  const out = new Set();
  const arr = Array.isArray(value) ? value : [value];
  for (const item of arr) {
    String(item == null ? "" : item).toLowerCase().split(/[^a-z0-9+]+/).forEach(word => {
      if (word.length >= 3 && !COLLAB_STOP.has(word)) out.add(word);
    });
  }
  return out;
}

function collabText(value) {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(item => String(item == null ? "" : item)).join(" · ").toLowerCase();
}

function collabInter(a, b) {
  const out = [];
  for (const item of a || []) if (b?.has(item)) out.push(item);
  return out;
}

export function collabAffKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function collabHasText(value) {
  return Array.isArray(value)
    ? value.some(item => String(item || "").trim())
    : !!String(value || "").trim();
}

function collabClusterForTeam(team) {
  const ownedText = [
    team.domain,
    team.focus,
    team.now,
    collabText(team.skill_areas),
  ].map(value => String(value || "").toLowerCase()).join(" · ");
  return COLLAB_CLUSTER_DEFS.find(def => def.test(team, ownedText)) || COLLAB_OTHER_CLUSTER;
}

function collabConceptSet(...values) {
  const text = values.map(collabText).join(" · ");
  const out = new Set();
  for (const concept of COLLAB_CONCEPTS) {
    concept.rx.lastIndex = 0;
    if (concept.rx.test(text)) out.add(concept.key);
  }
  return out;
}

function collabConceptLabels(keys) {
  return keys.map(key => COLLAB_CONCEPT_BY_KEY.get(key)?.label || key);
}

// ── Seek/offer match policy (the tunable core) ──────────────────────────────
// buildCollabModel proposes a match for every (seeker, offerer) pair whose
// ask-tokens touch an offer. This policy — isolated here on purpose — decides
// which proposals survive and how strong each is. Two knobs:
//   accept()   — is a proposal a real, routable match? (the noise floor)
//   strength() — how strong, which drives matrix shade + intro ranking.
// Specificity is the spine: in a TEE-heavy cohort the word "tee" is nearly
// free, so a term many teams offer is weak evidence and a rare term is a sharp,
// routable match. weightOf(df) turns a document frequency (how many teams offer
// a term) into an inverse-frequency weight: rare ⇒ higher, generic ⇒ ~1.
export function collabMatchPolicy(N, tokenDF = new Map(), conceptDF = new Map()) {
  // Inverse document frequency: ~0 when everyone offers the term, ~3 when only
  // one or two do. Keyed on the ratio (N-1)/df, so the floor is N-independent —
  // a cohort-wide term scores ≈ln(2) no matter how big the cohort is.
  const idf = (df) => Math.log(1 + Math.max(0, N - 1) / Math.max(1, df || 1));
  const policy = {
    tokenWeight: (token) => 1 + idf(tokenDF.get(token)),
    // Specificity-weighted evidence for one proposed match: each shared concept
    // counts its semantic weight DISCOUNTED by how common it is in the cohort,
    // each shared token counts its own rarity, plus a bump when a declared
    // dependency already points the same way.
    strength: ({ sharedConcepts, sharedTokens, depAligned }) =>
      sharedConcepts.reduce((sum, key) => sum + (COLLAB_CONCEPT_BY_KEY.get(key)?.weight || 1) * idf(conceptDF.get(key)), 0)
      + sharedTokens.reduce((sum, token) => sum + (1 + idf(tokenDF.get(token))) * 0.6, 0)
      + (depAligned ? 0.8 : 0),
    // The noise dials (← tune here). A match must clear MIN_STRENGTH AND be
    // corroborated: either two distinct shared signals, or one lone signal so
    // rare/strong it clears MIN_SINGLE on its own. This is what kills the block
    // of "everyone shares one cluster concept" matches a flat floor let through.
    MIN_STRENGTH: 1.85,
    MIN_SINGLE: 4.5,
    accept(parts) {
      const strength = policy.strength(parts);
      const signals = parts.sharedConcepts.length + parts.sharedTokens.length;
      return strength >= policy.MIN_STRENGTH && (signals >= 2 || strength >= policy.MIN_SINGLE);
    },
  };
  return policy;
}

export function buildCollabModel(teams = [], clusters = [], dependencyRecords = [], skillAreaVocab = []) {
  const base = constellationModel(teams, clusters, dependencyRecords);
  const ordered = [];
  const seen = new Set();
  for (const team of teams) {
    if (!team?.record_id || seen.has(team.record_id)) continue;
    seen.add(team.record_id);
    const cluster = collabClusterForTeam(team);
    ordered.push({
      rid: team.record_id,
      team,
      clusterId: cluster.id,
      clusterLabel: cluster.label,
      clusterRank: cluster.rank,
    });
  }
  ordered.sort((a, b) =>
    a.clusterRank - b.clusterRank
    || (base.indegree.get(b.rid) || 0) - (base.indegree.get(a.rid) || 0)
    || String(a.team.name || a.rid).localeCompare(String(b.team.name || b.rid)));

  const seekSet = new Map();
  const offerSet = new Map();
  const skillSet = new Map();
  const seekConceptSet = new Map();
  const offerConceptSet = new Map();
  const skillConceptSet = new Map();
  const skillsByTeam = new Map();
  for (const { rid, team } of ordered) {
    const skillAreas = modelSkillAreas(team.skill_areas, skillAreaVocab);
    skillsByTeam.set(rid, skillAreas);
    const skills = new Set(skillAreas);
    skillSet.set(rid, skills);
    seekSet.set(rid, collabTokens(team.seeking));
    const offers = collabTokens(team.offering);
    for (const skill of skills) offers.add(skill);
    offerSet.set(rid, offers);
    seekConceptSet.set(rid, collabConceptSet(team.seeking));
    offerConceptSet.set(rid, collabConceptSet(team.offering));
    skillConceptSet.set(rid, collabConceptSet(team.skill_areas, skillAreas, team.paper_basis));
  }

  const depByPair = new Map(base.edges.map(edge => [dependencyPairKey(edge.from, edge.to), edge]));
  const deps = new Set(depByPair.keys());

  // Specificity model: count how many teams offer each token / concept, then
  // weight inversely so rare offers (the routable ones) outscore cohort-wide
  // terms when matches are accepted and ranked.
  const offerTokenDF = new Map();
  const offerConceptDF = new Map();
  for (const { rid } of ordered) {
    for (const token of offerSet.get(rid)) offerTokenDF.set(token, (offerTokenDF.get(token) || 0) + 1);
    for (const concept of offerConceptSet.get(rid)) offerConceptDF.set(concept, (offerConceptDF.get(concept) || 0) + 1);
  }
  const policy = collabMatchPolicy(ordered.length, offerTokenDF, offerConceptDF);

  const seekOffer = [];
  const soByPair = new Map();
  for (const seeker of ordered) {
    for (const offerer of ordered) {
      if (seeker.rid === offerer.rid) continue;
      const sharedConcepts = collabInter(seekConceptSet.get(seeker.rid), offerConceptSet.get(offerer.rid));
      const tokenOverlap = collabInter(seekSet.get(seeker.rid), offerSet.get(offerer.rid));
      const sharedTokens = tokenOverlap.filter(token => !sharedConcepts.includes(token));
      if (!policy.accept({ sharedConcepts, sharedTokens })) continue;
      const shared = sharedConcepts.length ? [...collabConceptLabels(sharedConcepts), ...sharedTokens] : sharedTokens;
      const depAligned = deps.has(`${seeker.rid}>${offerer.rid}`);
      const rec = {
        seeker: seeker.rid,
        offerer: offerer.rid,
        seekerName: seeker.team.name,
        offererName: offerer.team.name,
        seeking: (seeker.team.seeking || [])[0] || "",
        offering: (offerer.team.offering || [])[0] || "",
        shared,
        sharedConcepts,
        sharedTokens,
        mutual: false,
        score: policy.strength({ sharedConcepts, sharedTokens, depAligned }),
      };
      seekOffer.push(rec);
      soByPair.set(`${seeker.rid}>${offerer.rid}`, rec);
    }
  }
  // Mutual fit — both teams want what the other offers. The strongest possible
  // intro, so flag it and let it outrank one-way matches. Symmetric: both
  // directional records get the bump, so the pair reads as one relationship.
  for (const rec of seekOffer) {
    if (soByPair.has(`${rec.offerer}>${rec.seeker}`)) { rec.mutual = true; rec.score += 1.2; }
  }

  const aff = new Map();
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      const shared = collabInter(skillSet.get(a.rid), skillSet.get(b.rid));
      const sharedConcepts = collabInter(skillConceptSet.get(a.rid), skillConceptSet.get(b.rid));
      if (!shared.length && !sharedConcepts.length) continue;
      const displayShared = shared.length ? shared : collabConceptLabels(sharedConcepts);
      aff.set(collabAffKey(a.rid, b.rid), {
        a: a.rid,
        b: b.rid,
        aName: a.team.name,
        bName: b.team.name,
        shared: displayShared,
        sharedConcepts,
        endorsed: false,
        score: displayShared.length,
      });
    }
  }

  const convergenceMap = new Map();
  for (const { rid, team } of ordered) {
    for (const skill of skillsByTeam.get(rid) || []) {
      const key = String(skill).toLowerCase();
      (convergenceMap.get(key) || convergenceMap.set(key, []).get(key)).push(team.name);
    }
  }
  const convergence = [...convergenceMap.entries()].filter(([, names]) => names.length >= 3)
    .map(([skill, names]) => ({ skill, teams: names, count: names.length }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));

  const offerMatches = new Map();
  for (const s of seekOffer) {
    const rows = offerMatches.get(s.offerer) || [];
    rows.push(s);
    offerMatches.set(s.offerer, rows);
  }
  const underusedOffers = ordered
    .filter(item => collabHasText(item.team.offering))
    .map(item => {
      const matches = (offerMatches.get(item.rid) || []).sort((a, b) => b.score - a.score);
      const skills = skillsByTeam.get(item.rid) || [];
      const offering = Array.isArray(item.team.offering)
        ? item.team.offering.map(v => String(v || "").trim()).filter(Boolean)[0] || ""
        : String(item.team.offering || "").trim();
      return {
        rid: item.rid,
        team: item.team,
        teamName: item.team.name || item.rid,
        offering,
        skills,
        matchCount: matches.length,
        matches,
      };
    })
    .sort((a, b) =>
      a.matchCount - b.matchCount
      || b.skills.length - a.skills.length
      || String(a.teamName).localeCompare(String(b.teamName)));

  const inbound = new Map();
  const outbound = new Map();
  for (const edge of deps) {
    const [from, to] = edge.split(">");
    (inbound.get(to) || inbound.set(to, []).get(to)).push(from);
    (outbound.get(from) || outbound.set(from, []).get(from)).push(to);
  }
  const keystones = ordered
    .map(item => ({
      ...item,
      inbound: inbound.get(item.rid) || [],
      outbound: outbound.get(item.rid) || [],
    }))
    .filter(item => item.inbound.length || item.outbound.length)
    .sort((a, b) =>
      b.inbound.length - a.inbound.length
      || b.outbound.length - a.outbound.length
      || String(a.team.name || a.rid).localeCompare(String(b.team.name || b.rid)));
  seekOffer.sort((a, b) => b.score - a.score || a.seekerName.localeCompare(b.seekerName));
  const coverage = {
    needs: ordered.filter(item => collabHasText(item.team.seeking)).length,
    offers: ordered.filter(item => collabHasText(item.team.offering)).length,
    skills: ordered.filter(item => (skillsByTeam.get(item.rid) || []).length).length,
    links: ordered.filter(item => collabHasText(item.team.dependencies)).length,
  };

  return {
    ordered,
    byRecordId: base.byRecordId,
    deps,
    depByPair,
    seekOffer,
    soByPair,
    aff,
    convergence,
    underusedOffers,
    indegree: base.indegree,
    keystones,
    coverage,
  };
}

export function aggregateSkillAreas(cohort = {}) {
  const tagsToTeams = new Map();
  const tagsToPeople = new Map();
  const tagPairs = new Map();
  const skillAreaVocab = Array.isArray(cohort?.cohort_vocab?.skill_areas) ? cohort.cohort_vocab.skill_areas : [];

  const consume = (areas, kind, id) => {
    const uniq = Array.from(new Set((Array.isArray(areas) ? areas : [])
      .map(tag => String(tag).trim().toLowerCase())
      .filter(Boolean)));
    for (const normalized of uniq) {
      const map = kind === "team" ? tagsToTeams : tagsToPeople;
      if (!map.has(normalized)) map.set(normalized, new Set());
      map.get(normalized).add(id);
    }
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i];
        const b = uniq[j];
        if (a === b) continue;
        const key = a < b ? `${a}::${b}` : `${b}::${a}`;
        tagPairs.set(key, (tagPairs.get(key) || 0) + 1);
      }
    }
  };

  for (const team of (Array.isArray(cohort.teams) ? cohort.teams : [])) {
    consume(modelSkillAreas(team.skill_areas, skillAreaVocab), "team", team.record_id);
  }
  for (const person of (Array.isArray(cohort.people) ? cohort.people : [])) {
    consume(modelSkillAreas(person.skill_areas, skillAreaVocab), "person", person.record_id);
  }

  const allTags = new Set([...tagsToTeams.keys(), ...tagsToPeople.keys()]);
  const nodes = Array.from(allTags).map(tag => {
    const teams = Array.from(tagsToTeams.get(tag) || []);
    const people = Array.from(tagsToPeople.get(tag) || []);
    return { tag, teams, people, size: teams.length + people.length };
  }).sort((a, b) => b.size - a.size);

  const edges = Array.from(tagPairs.entries()).map(([key, weight]) => {
    const [a, b] = key.split("::");
    return { a, b, weight };
  });
  return { nodes, edges };
}

// ── Bubble map (nested circle packing) ──────────────────────────────────────
// Hand-rolled, dependency-free circle packing: a faithful port of
// d3-hierarchy's front-chain `packSiblings` + Welzl `enclose`, plus a small
// recursive layout that nests team bubbles inside cluster/theme containers.
// Used by the cohort "relationship map" bubble view and the per-company
// overlap inspector. The renderer ships no d3 by design, so these stay local.

export const THEME_LABELS = {
  "confidential-ai": "confidential AI · TEE",
  "agent-runtime": "agent runtime",
  "crypto-mechanism": "crypto & mechanism",
  "consumer": "consumer & creative",
  "_other": "unclustered",
};

// Cluster record_id → theme id. Unmapped clusters (and the folded "_other"
// well) fall back to the "_other" theme; this is the only "high level" grouping
// the surface lacks, so it lives here as code, not data.
export const CLUSTER_TO_THEME = {
  "confidential-ai-ops": "confidential-ai",
  "confidential-data": "confidential-ai",
  "dstack": "confidential-ai",
  "ndai": "confidential-ai",
  "regulated": "confidential-ai",
  "agents": "agent-runtime",
  "agentic-dev-platform": "agent-runtime",
  "crypto-id": "crypto-mechanism",
  "market-mechanism-research": "crypto-mechanism",
  "local-first-networking": "crypto-mechanism",
  "consumer-behavior-apps": "consumer",
  "realtime-creative": "consumer",
};

function bmThemeForWell(wellId) {
  if (wellId === "_other") return "_other";
  return CLUSTER_TO_THEME[wellId] || "_other";
}

// --- Welzl smallest-enclosing-circle (circle variant, ported from d3) -------
function bmEnclose(circles) {
  let i = 0; const n = circles.length; let B = []; let p; let e;
  while (i < n) {
    p = circles[i];
    if (e && bmEnclosesWeak(e, p)) ++i;
    else { e = bmEncloseBasis(B = bmExtendBasis(B, p)); i = 0; }
  }
  return e || { x: 0, y: 0, r: 0 };
}
function bmExtendBasis(B, p) {
  let i; let j;
  if (bmEnclosesWeakAll(p, B)) return [p];
  for (i = 0; i < B.length; ++i) {
    if (bmEnclosesNot(p, B[i]) && bmEnclosesWeakAll(bmEncloseBasis2(B[i], p), B)) return [B[i], p];
  }
  for (i = 0; i < B.length - 1; ++i) {
    for (j = i + 1; j < B.length; ++j) {
      if (bmEnclosesNot(bmEncloseBasis2(B[i], B[j]), p)
        && bmEnclosesNot(bmEncloseBasis2(B[i], p), B[j])
        && bmEnclosesNot(bmEncloseBasis2(B[j], p), B[i])
        && bmEnclosesWeakAll(bmEncloseBasis3(B[i], B[j], p), B)) {
        return [B[i], B[j], p];
      }
    }
  }
  // Degenerate input (e.g. coincident circles): never throw in the renderer.
  return B.length ? B : [p];
}
function bmEnclosesNot(a, b) {
  const dr = a.r - b.r; const dx = b.x - a.x; const dy = b.y - a.y;
  return dr < 0 || dr * dr < dx * dx + dy * dy;
}
function bmEnclosesWeak(a, b) {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9; const dx = b.x - a.x; const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}
function bmEnclosesWeakAll(a, B) {
  for (let i = 0; i < B.length; ++i) if (!bmEnclosesWeak(a, B[i])) return false;
  return true;
}
function bmEncloseBasis(B) {
  if (B.length === 1) return { x: B[0].x, y: B[0].y, r: B[0].r };
  if (B.length === 2) return bmEncloseBasis2(B[0], B[1]);
  return bmEncloseBasis3(B[0], B[1], B[2]);
}
function bmEncloseBasis2(a, b) {
  const x1 = a.x, y1 = a.y, r1 = a.r, x2 = b.x, y2 = b.y, r2 = b.r;
  const x21 = x2 - x1, y21 = y2 - y1, r21 = r2 - r1;
  const l = Math.sqrt(x21 * x21 + y21 * y21) || 1;
  return { x: (x1 + x2 + x21 / l * r21) / 2, y: (y1 + y2 + y21 / l * r21) / 2, r: (l + r1 + r2) / 2 };
}
function bmEncloseBasis3(a, b, c) {
  const x1 = a.x, y1 = a.y, r1 = a.r, x2 = b.x, y2 = b.y, r2 = b.r, x3 = c.x, y3 = c.y, r3 = c.r;
  const a2 = x1 - x2, a3 = x1 - x3, b2 = y1 - y2, b3 = y1 - y3, c2 = r2 - r1, c3 = r3 - r1;
  const d1 = x1 * x1 + y1 * y1 - r1 * r1;
  const d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2;
  const d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3;
  const ab = (a3 * b2 - a2 * b3) || 1e-9;
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1, xb = (b3 * c2 - b2 * c3) / ab;
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1, yb = (a2 * c3 - a3 * c2) / ab;
  const A = xb * xb + yb * yb - 1, B = 2 * (r1 + xa * xb + ya * yb), C = xa * xa + ya * ya - r1 * r1;
  const r = -(Math.abs(A) > 1e-6 ? (B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A) : C / B);
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r };
}

// --- Front-chain sibling packing (ported from d3-hierarchy) ------------------
function bmPlace(b, a, c) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (d2) {
    const a2 = (a.r + c.r) * (a.r + c.r), b2 = (b.r + c.r) * (b.r + c.r);
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2), y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy; c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2), y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy; c.y = a.y + x * dy + y * dx;
    }
  } else { c.x = a.x + c.r; c.y = a.y; }
}
function bmIntersects(a, b) {
  const dr = a.r + b.r - 1e-6, dx = b.x - a.x, dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}
function bmChainScore(node) {
  const a = node._, b = node.next._, ab = (a.r + b.r) || 1;
  const dx = (a.x * b.r + b.x * a.r) / ab, dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}
function BmChainNode(circle) { this._ = circle; this.next = null; this.previous = null; }

// Pack `circles` ([{x,y,r}]) around the origin in place; returns enclosing r.
export function packSiblings(circles) {
  const n = circles.length;
  if (n === 0) return 0;
  let a, b, c, aa, ca, i, j, k, sj, sk;
  a = circles[0]; a.x = 0; a.y = 0;
  if (!(n > 1)) return a.r;
  b = circles[1]; a.x = -b.r; b.x = a.r; b.y = 0;
  if (!(n > 2)) return a.r + b.r;
  bmPlace(b, a, c = circles[2]);
  a = new BmChainNode(a); b = new BmChainNode(b); c = new BmChainNode(c);
  a.next = c.previous = b; b.next = a.previous = c; c.next = b.previous = a;
  pack: for (i = 3; i < n; ++i) {
    bmPlace(a._, b._, c = circles[i]); c = new BmChainNode(c);
    j = b.next; k = a.previous; sj = b._.r; sk = a._.r;
    do {
      if (sj <= sk) {
        if (bmIntersects(j._, c._)) { b = j; a.next = b; b.previous = a; --i; continue pack; }
        sj += j._.r; j = j.next;
      } else {
        if (bmIntersects(k._, c._)) { a = k; a.next = b; b.previous = a; --i; continue pack; }
        sk += k._.r; k = k.previous;
      }
    } while (j !== k.next);
    c.previous = a; c.next = b; a.next = b.previous = b = c;
    aa = bmChainScore(a);
    while ((c = c.next) !== b) { if ((ca = bmChainScore(c)) < aa) { a = c; aa = ca; } }
    b = a.next;
  }
  const chain = [b._]; c = b;
  while ((c = c.next) !== b) chain.push(c._);
  const en = bmEnclose(chain);
  for (i = 0; i < n; ++i) { a = circles[i]; a.x -= en.x; a.y -= en.y; }
  return en.r;
}

export function enclose(circles) { return bmEnclose(circles); }

// --- Hierarchy + recursive layout -------------------------------------------
function bmLeafRadius(stage) {
  const s = Math.max(1, Number(stage) || 1);
  return Math.max(9, Math.sqrt(s) * 10); // area ∝ maturity; ~14 (s2) … ~26 (s7)
}

function bmSkillFreq(teams) {
  const freq = new Map();
  for (const t of teams) {
    for (const raw of (Array.isArray(t?.skill_areas) ? t.skill_areas : [])) {
      const s = String(raw || "").trim().toLowerCase();
      if (!s) continue;
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  }
  return freq;
}

// One bubble per team: assign each team to its RAREST cohort skill so the
// crowded tags (tee/agentic) spread out and no team is drawn twice.
export function teamPrimarySkill(team, skillFreq) {
  const skills = Array.isArray(team?.skill_areas) ? team.skill_areas : [];
  let best = null; let bestFreq = Infinity;
  for (const raw of skills) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) continue;
    const f = skillFreq.get(s) || 0;
    if (f < bestFreq) { bestFreq = f; best = s; }
  }
  return best || "_other";
}

export function bubbleHierarchy(model, granularity, stageOf) {
  const byId = model.byRecordId || new Map();
  const leaf = (rid) => {
    const team = byId.get(rid);
    const stage = stageOf ? stageOf(team) : (team?.journey?.stage || 2);
    return { leaf: true, rid, team, stage };
  };
  if (granularity === "skills") {
    const teams = [...byId.values()];
    const freq = bmSkillFreq(teams);
    const buckets = new Map();
    for (const t of teams) {
      const key = teamPrimarySkill(t, freq);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t.record_id);
    }
    const children = [...buckets.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([key, rids]) => ({
        id: `skill:${key}`, label: key === "_other" ? "unclassified" : key, level: "cluster",
        children: rids.map(leaf), redundant: rids.length === 1,
      }));
    return { id: "_root", label: "cohort", level: "root", children };
  }
  const clusterNodes = (model.wellsDef || []).map(w => ({
    id: w.id, label: w.label || w.id, level: "cluster",
    children: (w.members || []).map(leaf), redundant: (w.members || []).length === 1,
  }));
  if (granularity === "themes") {
    const byTheme = new Map();
    for (const cn of clusterNodes) {
      const th = bmThemeForWell(cn.id);
      if (!byTheme.has(th)) byTheme.set(th, []);
      byTheme.get(th).push(cn);
    }
    const children = [...byTheme.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([th, clusters]) => ({
        id: `theme:${th}`, label: THEME_LABELS[th] || th, level: "theme",
        children: clusters,
        redundant: clusters.length === 1 && (clusters[0].children || []).length <= 1,
      }));
    return { id: "_root", label: "cohort", level: "root", children };
  }
  return { id: "_root", label: "cohort", level: "root", children: clusterNodes };
}

// Inter-ring separation. root/theme gaps are generous so adjacent ecosystem
// rings (and their titles) don't crowd each other — the map reads as distinct
// spaces with air between them rather than one dense pile. cluster gap stays
// tight so teams inside a space still cohere.
const BM_GAP = { root: 14, theme: 12, cluster: 5 };
const BM_PAD = { root: 4, theme: 9, cluster: 6 };

function bmLayout(node) {
  if (node.leaf) { node.r = node._leafR != null ? node._leafR : bmLeafRadius(node.stage); return node.r; }
  const kids = node.children || [];
  kids.forEach(bmLayout);
  const gap = BM_GAP[node.level] != null ? BM_GAP[node.level] : 4;
  const circles = kids.map(ch => ({ x: 0, y: 0, r: ch.r + gap, ch }));
  const encR = packSiblings(circles);
  circles.forEach(c => { c.ch._lx = c.x; c.ch._ly = c.y; });
  node.r = (kids.length ? encR : 0) + (BM_PAD[node.level] || 0);
  return node.r;
}

function bmAssign(node, ax, ay, scale, out) {
  node._ax = ax; node._ay = ay; node._ar = node.r * scale;
  if (node.leaf) { out.leaves.push(node); return; }
  if (node.level !== "root") out.containers.push(node);
  for (const ch of (node.children || [])) {
    bmAssign(ch, ax + (ch._lx || 0) * scale, ay + (ch._ly || 0) * scale, scale, out);
  }
}

function bmAssignRanks(node) {
  if (node.leaf) return;
  const leafKids = (node.children || []).filter(c => c.leaf);
  leafKids.sort((a, b) => b.r - a.r);
  leafKids.forEach((lk, idx) => { lk._rank = idx; lk._wellId = node.id; lk._wellSize = leafKids.length; });
  (node.children || []).forEach(bmAssignRanks);
}

// All team (leaf) record_ids under a container, at any depth — so a theme ring
// focuses every team in its clusters, a cluster ring its own teams, etc.
function bmDescendantLeafRids(node, out = []) {
  for (const ch of (node.children || [])) {
    if (ch.leaf) out.push(ch.rid);
    else bmDescendantLeafRids(ch, out);
  }
  return out;
}

// Nested circle packing for the cohort. Returns a drop-in superset of
// placeConstellation's `pos` contract plus nested `containers`.
export function packBubbles(model, granularity, opts = {}) {
  const W = opts.W || 980; const H = opts.H || 540; const margin = opts.margin || 16;
  const root = bubbleHierarchy(model, granularity, opts.stageOf);
  // Optional size channel: pre-set each leaf's radius from opts.radiusOf(leaf)
  // BEFORE layout so the packer honours it. No override → bmLayout falls back to
  // bmLeafRadius(stage), preserving the maturity-sized default exactly.
  if (typeof opts.radiusOf === "function") {
    const applyR = (node) => {
      if (node.leaf) {
        const r = opts.radiusOf(node);
        if (Number.isFinite(r) && r > 0) node._leafR = r;
        return;
      }
      for (const ch of (node.children || [])) applyR(ch);
    };
    applyR(root);
  }
  bmLayout(root);
  bmAssignRanks(root);
  const scale = root.r > 0 ? Math.min(1, (Math.min(W, H) / 2 - margin) / root.r) : 1;
  const out = { leaves: [], containers: [] };
  bmAssign(root, W / 2, H / 2, scale, out);

  const indeg = model.indegree || new Map();
  let maxDeg = 0;
  for (const v of indeg.values()) if (v > maxDeg) maxDeg = v;

  const pos = new Map();
  for (const lf of out.leaves) {
    const deg = indeg.get(lf.rid) || 0;
    // No fake midpoint: if nobody is depended on, all bubbles read as the
    // floor (least-influence), not a misleading "medium everywhere".
    const shade = maxDeg > 0 ? deg / maxDeg : 0;
    pos.set(lf.rid, {
      team: lf.team, x: lf._ax, y: lf._ay, r: lf._ar, deg, angle: null,
      wellId: lf._wellId || "_other", wellSize: lf._wellSize || 1, rank: lf._rank || 0,
      stage: lf.stage, shade,
    });
  }
  const containers = out.containers.map(c => ({
    id: c.id, label: c.label, level: c.level, cx: c._ax, cy: c._ay, r: c._ar,
    members: bmDescendantLeafRids(c),
    redundant: !!c.redundant,
  }));
  // Tight content box: the real extent of leaves + containers (incl. radii) so
  // the renderer can fit the SVG viewBox to actual content and kill internal
  // letterboxing (the dead band above/below the packed cohort). bmAssign sets
  // _ax/_ay/_ar on every node, so this needs no extra layout pass.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lf of out.leaves) {
    if (lf._ax - lf._ar < minX) minX = lf._ax - lf._ar;
    if (lf._ay - lf._ar < minY) minY = lf._ay - lf._ar;
    if (lf._ax + lf._ar > maxX) maxX = lf._ax + lf._ar;
    if (lf._ay + lf._ar > maxY) maxY = lf._ay + lf._ar;
  }
  for (const c of out.containers) {
    if (c._ax - c._ar < minX) minX = c._ax - c._ar;
    if (c._ay - c._ar < minY) minY = c._ay - c._ar;
    if (c._ax + c._ar > maxX) maxX = c._ax + c._ar;
    if (c._ay + c._ar > maxY) maxY = c._ay + c._ar;
  }
  // Keystone TEAM labels sit BELOW their bubble (renderer labelY = r + gap) and
  // container labels sit INSIDE the ring, so the real clip risk is the bottom
  // edge — pad it a touch more than the top.
  // padX gets extra room: bounds are fit to circle geometry only (labels are not
  // measured), so a wide container title centred near the frame could clip the
  // right edge. The extra horizontal pad guarantees margin even if a label runs
  // close to its ring's edge.
  const padX = margin + 24, padTop = margin, padBottom = 22;
  const bounds = Number.isFinite(minX)
    ? { x: minX - padX, y: minY - padTop,
        w: (maxX - minX) + padX * 2, h: (maxY - minY) + padTop + padBottom }
    : { x: 0, y: 0, w: W, h: H };
  return { pos, containers, wells: [], ringSegments: [], bounds };
}
