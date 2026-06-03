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

export function constellationIndegree(teams = []) {
  const list = Array.isArray(teams) ? teams : [];
  const have = new Set(list.map(t => t.record_id));
  const ind = new Map(list.map(t => [t.record_id, 0]));
  for (const team of list) {
    for (const dep of (Array.isArray(team.dependencies) ? team.dependencies : [])) {
      if (dep !== team.record_id && have.has(dep)) ind.set(dep, ind.get(dep) + 1);
    }
  }
  return ind;
}

export function constellationModel(teams = [], clusters = []) {
  const list = Array.isArray(teams) ? teams : [];
  const byRecordId = new Map(list.map(team => [team.record_id, team]));
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
  if (orphans.length) wellsDef.push({ id: "_other", label: "other", members: orphans });
  return { byRecordId, wellsDef, indegree: constellationIndegree(list) };
}

const COLLAB_STOP = new Set(("a an and the to of for with in on at or be is are am was were we our us you your yours i me my mine they them their it its this that these those as by from into about over under more most less few many much can could should would will may might want wants wanted need needs needed looking look able build building built make making made get gets help helps using use used via across other others team teams project projects cohort people person folks who whom what when where why how do does done also like just very real new use").split(/\s+/));

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

function collabInter(a, b) {
  const out = [];
  for (const item of a || []) if (b?.has(item)) out.push(item);
  return out;
}

export function collabAffKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildCollabModel(teams = [], clusters = []) {
  const base = constellationModel(teams, clusters);
  const ordered = [];
  for (const well of base.wellsDef) {
    const members = well.members.slice().sort((a, b) => (base.indegree.get(b) || 0) - (base.indegree.get(a) || 0));
    for (const recordId of members) {
      const team = base.byRecordId.get(recordId);
      if (team) ordered.push({ rid: recordId, team, clusterId: well.id, clusterLabel: well.label });
    }
  }

  const seekSet = new Map();
  const offerSet = new Map();
  const skillSet = new Map();
  for (const { rid, team } of ordered) {
    const skills = new Set((team.skill_areas || []).map(skill => String(skill).toLowerCase()));
    skillSet.set(rid, skills);
    seekSet.set(rid, collabTokens(team.seeking));
    const offers = collabTokens(team.offering);
    for (const skill of skills) offers.add(skill);
    offerSet.set(rid, offers);
  }

  const deps = new Set();
  for (const { rid, team } of ordered) {
    for (const dep of (team.dependencies || [])) {
      if (base.byRecordId.has(dep) && dep !== rid) deps.add(`${rid}>${dep}`);
    }
  }

  const seekOffer = [];
  const soByPair = new Map();
  for (const seeker of ordered) {
    for (const offerer of ordered) {
      if (seeker.rid === offerer.rid) continue;
      const shared = collabInter(seekSet.get(seeker.rid), offerSet.get(offerer.rid));
      if (!shared.length) continue;
      const rec = {
        seeker: seeker.rid,
        offerer: offerer.rid,
        seekerName: seeker.team.name,
        offererName: offerer.team.name,
        seeking: (seeker.team.seeking || [])[0] || "",
        offering: (offerer.team.offering || [])[0] || "",
        shared,
        score: shared.length,
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
      const endorsed = (Array.isArray(a.team.pair_with) && a.team.pair_with.includes(b.rid))
        || (Array.isArray(b.team.pair_with) && b.team.pair_with.includes(a.rid));
      if (!shared.length && !endorsed) continue;
      aff.set(collabAffKey(a.rid, b.rid), {
        a: a.rid,
        b: b.rid,
        aName: a.team.name,
        bName: b.team.name,
        shared,
        endorsed,
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

  return { ordered, deps, seekOffer, soByPair, aff, convergence, indegree: base.indegree };
}

export function aggregateSkillAreas(cohort = {}) {
  const tagsToTeams = new Map();
  const tagsToPeople = new Map();
  const tagPairs = new Map();

  const consume = (areas, kind, id) => {
    const uniq = Array.from(new Set((Array.isArray(areas) ? areas : []).filter(Boolean)));
    for (const tag of uniq) {
      const normalized = String(tag).trim().toLowerCase();
      if (!normalized) continue;
      const map = kind === "team" ? tagsToTeams : tagsToPeople;
      if (!map.has(normalized)) map.set(normalized, new Set());
      map.get(normalized).add(id);
    }
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = String(uniq[i]).trim().toLowerCase();
        const b = String(uniq[j]).trim().toLowerCase();
        if (!a || !b || a === b) continue;
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
