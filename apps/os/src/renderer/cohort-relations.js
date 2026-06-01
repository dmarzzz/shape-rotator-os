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
  declared: "declared link",
};
const DEP_STATUS_LABELS = {
  declared: "declared",
  exploring: "exploring",
  active: "active",
  blocked: "blocked",
  resolved: "resolved",
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
  return edges;
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
  const orphans = list.filter(team => !primary.has(team.record_id)).map(team => team.record_id);
  if (orphans.length) wellsDef.push({ id: "_other", label: "unclustered", members: orphans });
  return { byRecordId, wellsDef, edges, indegree: constellationIndegree(list, dependencyRecords) };
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

export function buildCollabModel(teams = [], clusters = [], dependencyRecords = []) {
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
  for (const { rid, team } of ordered) {
    const skills = new Set((team.skill_areas || []).map(skill => String(skill).toLowerCase()));
    skillSet.set(rid, skills);
    seekSet.set(rid, collabTokens(team.seeking));
    const offers = collabTokens(team.offering);
    for (const skill of skills) offers.add(skill);
    offerSet.set(rid, offers);
    seekConceptSet.set(rid, collabConceptSet(team.seeking));
    offerConceptSet.set(rid, collabConceptSet(team.offering));
    skillConceptSet.set(rid, collabConceptSet(team.skill_areas, team.paper_basis));
  }

  const depByPair = new Map(base.edges.map(edge => [dependencyPairKey(edge.from, edge.to), edge]));
  const deps = new Set(depByPair.keys());

  const seekOffer = [];
  const soByPair = new Map();
  for (const seeker of ordered) {
    for (const offerer of ordered) {
      if (seeker.rid === offerer.rid) continue;
      const sharedConcepts = collabInter(seekConceptSet.get(seeker.rid), offerConceptSet.get(offerer.rid));
      const tokenOverlap = collabInter(seekSet.get(seeker.rid), offerSet.get(offerer.rid));
      const sharedTokens = tokenOverlap.filter(token => !sharedConcepts.includes(token));
      if (!tokenOverlap.length) continue;
      const shared = sharedConcepts.length ? [...collabConceptLabels(sharedConcepts), ...sharedTokens] : sharedTokens;
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
        score: collabScore(sharedConcepts, sharedTokens.length, deps.has(`${seeker.rid}>${offerer.rid}`) ? 0.8 : 0),
      };
      seekOffer.push(rec);
      soByPair.set(`${seeker.rid}>${offerer.rid}`, rec);
    }
  }

  const aff = new Map();
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      const shared = collabInter(skillSet.get(a.rid), skillSet.get(b.rid));
      const sharedConcepts = collabInter(skillConceptSet.get(a.rid), skillConceptSet.get(b.rid));
      const endorsed = (Array.isArray(a.team.pair_with) && a.team.pair_with.includes(b.rid))
        || (Array.isArray(b.team.pair_with) && b.team.pair_with.includes(a.rid));
      if (!shared.length && !sharedConcepts.length && !endorsed) continue;
      const displayShared = shared.length ? shared : collabConceptLabels(sharedConcepts);
      aff.set(collabAffKey(a.rid, b.rid), {
        a: a.rid,
        b: b.rid,
        aName: a.team.name,
        bName: b.team.name,
        shared: displayShared,
        sharedConcepts,
        endorsed,
        score: displayShared.length + (endorsed ? 1.5 : 0),
      });
    }
  }

  const convergenceMap = new Map();
  for (const { team } of ordered) {
    for (const skill of (team.skill_areas || [])) {
      const key = String(skill).toLowerCase();
      (convergenceMap.get(key) || convergenceMap.set(key, []).get(key)).push(team.name);
    }
  }
  const convergence = [...convergenceMap.entries()].filter(([, names]) => names.length >= 3)
    .map(([skill, names]) => ({ skill, teams: names, count: names.length }))
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));

  return { ordered, deps, depByPair, seekOffer, soByPair, aff, convergence, indegree: base.indegree };
}

export function aggregateSkillAreas(cohort = {}) {
  const tagsToTeams = new Map();
  const tagsToPeople = new Map();
  const tagPairs = new Map();

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
    consume(team.skill_areas, "team", team.record_id);
  }
  for (const person of (Array.isArray(cohort.people) ? cohort.people : [])) {
    consume(person.skill_areas, "person", person.record_id);
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
