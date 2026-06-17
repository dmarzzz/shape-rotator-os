"use strict";

const path = require("node:path");

const SCHEMA_VERSION = 1;
const PRIVATE_SOURCE_PREFIX = "private-vault:";

const CLAIM_PATTERNS = [
  {
    type: "decision",
    pattern: /\b(decided|chosen|selected|agreed|settled|committed|standardized|policy|rule)\b/i,
  },
  {
    type: "ask",
    pattern: /\b(ask|need help|needs help|looking for|seeking|request|question|probe|feedback|advice|mentor|intro)\b/i,
  },
  {
    type: "risk",
    pattern: /\b(risk|blocker|constraint|privacy|security|leak|fails?|failure|unresolved|unclear|concern|thin|liquidity|authentication)\b/i,
  },
  {
    type: "action_item",
    pattern: /\b(next|follow[- ]?up|needs to|should|will|ship|launch|prepare|finish|test|review|instrument)\b/i,
  },
  {
    type: "collaboration_edge",
    pattern: /\b(collaboration|connect|shared|overlap|swap|dependency|handoff|introduced|across teams|between teams|cohort)\b/i,
  },
  {
    type: "product_signal",
    pattern: /\b(product|user|customer|workflow|onboarding|retention|demo|prototype|agent|interface|feature|tooling|evaluation|evals)\b/i,
  },
  {
    type: "market_signal",
    pattern: /\b(market|buyer|revenue|pricing|monetiz|institution|enterprise|consumer|wedge|competition|go[- ]?to[- ]?market|liquidity)\b/i,
  },
];

const FORBIDDEN_RAW_PATTERNS = [
  /raw-scripts[\\/]/i,
  /local_private[\\/]/i,
  /privacy_boundary[\\/]/i,
  /transcript[-_ ]?root/i,
  /\b[a-z]:\\users[\\/]/i,
  /\/users\/[^/\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item !== null && item !== undefined)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(normalizeList(values)));
}

// Insights are now objects {text, subjects, evidence_level} (engine
// distillation-contract.mjs), but legacy readouts carry bare strings. These read
// either shape so evidence cards can route each claim to the subject it is ABOUT
// instead of broadcasting the readout's full team/person list onto every claim.
function insightText(insight) {
  return typeof insight === "string" ? insight : String(insight?.text || "");
}
function insightSubjects(insight) {
  return insight && typeof insight === "object" && Array.isArray(insight.subjects) ? normalizeList(insight.subjects) : [];
}
function insightEvidenceLevel(insight) {
  const level = insight && typeof insight === "object" ? insight.evidence_level : null;
  return ["grounded", "inferred", "speculative"].includes(level) ? level : "inferred";
}

function safeIdPart(value) {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "unknown";
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hasForbiddenRawPointer(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return FORBIDDEN_RAW_PATTERNS.some((pattern) => pattern.test(text));
}

function assertNoRawPointers(value, label = "value") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const match = FORBIDDEN_RAW_PATTERNS.find((pattern) => pattern.test(text));
  if (match) {
    throw new Error(`${label} contains a private raw-transcript pointer matching ${match}`);
  }
}

function parseDate(date) {
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekStart(dateValue) {
  const parsed = parseDate(dateValue);
  if (!parsed) return "undated";
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return toDateString(parsed);
}

function confidenceForReadout(readout) {
  if (!readout.date || !readout.vault_id) return "low";
  if (String(readout.consent || "").includes("speaker-pending")) return "medium";
  if (normalizeList(readout.insights).length >= 3 && normalizeList(readout.teams).length > 0) {
    return "medium";
  }
  return "low";
}

function confidencePctForLabel(label) {
  switch (String(label || "").toLowerCase()) {
    case "high":
      return 92;
    case "moderate":
    case "medium":
      return 76;
    case "low":
      return 52;
    case "none":
      return 0;
    default:
      return 35;
  }
}

function confidenceBasisForReadout(readout) {
  const basis = [];
  if (readout.date) basis.push("dated reviewed readout");
  else basis.push("missing date");
  if (readout.vault_id) basis.push("vault_id present");
  else basis.push("missing vault_id");
  if (normalizeList(readout.insights).length >= 3) basis.push("three or more insights");
  if (normalizeList(readout.teams).length > 0) basis.push("team reference present");
  if (String(readout.consent || "").includes("speaker-pending")) basis.push("speaker/public clearance pending");
  return unique(basis);
}

function sourceReviewStatus(readout) {
  return readout.review_status || "reviewed_readout";
}

function sharingBoundaryFor(readout) {
  const consent = readout.consent || "unknown";
  const publicCleared = consent === "public-cleared";
  return {
    source_access: "private-vault",
    max_surface: publicCleared ? "public_candidate" : "cohort",
    raw_allowed: false,
    public_requires_approval: !publicCleared,
    consent,
  };
}

function attributionFor(readout) {
  const teams = normalizeList(readout.teams);
  const people = normalizeList(readout.people);
  if (teams.length > 0) return "team-level";
  if (people.length > 0) return "participant-level";
  return "unattributed-theme";
}

function classifyClaim(text) {
  const matched = CLAIM_PATTERNS.find((entry) => entry.pattern.test(text));
  return matched ? matched.type : "claim";
}

function roleViewsForClaim(claimType, teams, people) {
  const views = ["weekly"];
  if (teams.length > 0) views.push("team");
  if (people.length > 0) views.push("person");
  if (claimType === "ask" || claimType === "collaboration_edge") views.push("operator");
  return views;
}

function buildEvidenceCard(readout) {
  assertNoRawPointers(readout, `readout ${readout.vault_id || readout.title || "unknown"}`);

  const vaultId = readout.vault_id;
  if (!vaultId) {
    throw new Error(`Transcript readout is missing vault_id: ${readout.title || "untitled"}`);
  }

  const teams = unique(readout.teams);
  const people = unique(readout.people);
  const themes = unique(readout.themes);
  const confidence = confidenceForReadout(readout);
  const confidencePct = confidencePctForLabel(confidence);
  const confidenceBasis = confidenceBasisForReadout(readout);
  const sharingBoundary = sharingBoundaryFor(readout);
  const attribution = attributionFor(readout);
  const source = `${PRIVATE_SOURCE_PREFIX}${vaultId}`;
  const artifactId = `transcript-evidence:${safeIdPart(vaultId)}`;

  const claims = (Array.isArray(readout.insights) ? readout.insights : [])
    .map((insight) => ({
      text: insightText(insight).trim(),
      subjects: insightSubjects(insight),
      evidence_level: insightEvidenceLevel(insight),
    }))
    .filter((insight) => insight.text)
    .map((insight, index) => {
      const claimType = classifyClaim(insight.text);
      // Per-insight subjects scope the claim's attribution; legacy bare-string
      // insights (no subjects) fall back to the readout-level tags so nothing
      // regresses. This stops a team being credited on a claim it never appears in.
      const scoped = insight.subjects.length > 0;
      const claimTeams = scoped ? insight.subjects.filter((id) => teams.includes(id)) : teams;
      const claimPeople = scoped ? insight.subjects.filter((id) => people.includes(id)) : people;
      const claimAttribution = scoped
        ? (claimTeams.length ? "team-level" : claimPeople.length ? "participant-level" : "unattributed-theme")
        : attribution;
      return {
        claim_id: `${artifactId}:claim:${index + 1}`,
        claim_type: claimType,
        text: insight.text,
        source,
        source_artifact_id: artifactId,
        evidence_level: insight.evidence_level,
        confidence,
        confidence_pct: confidencePct,
        confidence_basis: confidenceBasis,
        attribution: claimAttribution,
        teams: claimTeams,
        people: claimPeople,
        role_views: roleViewsForClaim(claimType, claimTeams, claimPeople),
        verbatim: false,
      };
    });

  const qa = Array.isArray(readout.qa)
    ? readout.qa.map((item, index) => ({
        qa_id: `${artifactId}:qa:${index + 1}`,
        question: String(item.q || "").trim(),
        answer: String(item.a || "").trim(),
        source,
        evidence_level: "inferred",
        confidence,
        confidence_pct: confidencePct,
        confidence_basis: confidenceBasis,
        attribution,
        teams,
        people,
        verbatim: false,
      })).filter((item) => item.question && item.answer)
    : [];

  const references = Array.isArray(readout.references)
    ? readout.references
        .map((reference) => ({
          label: String(reference.label || "").trim(),
          href: String(reference.href || "").trim(),
        }))
        .filter((reference) => reference.label && reference.href)
    : [];

  const card = {
    schema_version: SCHEMA_VERSION,
    artifact_id: artifactId,
    artifact_kind: "transcript_evidence_card",
    record_type: "session",
    record_id: vaultId,
    vault_id: vaultId,
    date: readout.date || null,
    week_start: isoWeekStart(readout.date),
    title: readout.title || vaultId,
    summary: readout.one_liner || "",
    session_kind: readout.kind || "unknown",
    source,
    source_kind: "private_vault_transcript",
    source_transform: "reviewed_readout_to_evidence_card",
    source_access: "private-vault",
    source_review_status: sourceReviewStatus(readout),
    evidence_level: "inferred",
    confidence,
    confidence_pct: confidencePct,
    confidence_basis: confidenceBasis,
    consent: readout.consent || "unknown",
    sharing_boundary: sharingBoundary,
    attribution,
    review_status: "generated",
    surface_recommendation: sharingBoundary.max_surface === "public_candidate" ? "review_for_public_candidate" : "review_for_cohort",
    verbatim: false,
    teams,
    people,
    themes,
    claims,
    qa,
    references,
    review_questions: [
      "Does each claim accurately reflect the reviewed transcript readout?",
      "Are team and person references appropriate for this sharing boundary?",
      "Should any claim be promoted, held, merged, or narrowed before weekly use?",
    ],
  };

  assertNoRawPointers(card, `evidence card ${artifactId}`);
  return card;
}

function validateEntityRefs(cards, options = {}) {
  const teamIds = options.teamIds instanceof Set ? options.teamIds : new Set(options.teamIds || []);
  const personIds = options.personIds instanceof Set ? options.personIds : new Set(options.personIds || []);
  const errors = [];

  for (const card of cards) {
    for (const team of card.teams) {
      if (teamIds.size > 0 && !teamIds.has(team)) {
        errors.push(`${card.artifact_id} references unknown team ${team}`);
      }
    }
    for (const person of card.people) {
      if (personIds.size > 0 && !personIds.has(person)) {
        errors.push(`${card.artifact_id} references unknown person ${person}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Transcript evidence entity validation failed:\n${errors.join("\n")}`);
  }
}

function mergeSurface(left, right) {
  if (left === "cohort" || right === "cohort") return "cohort";
  if (left === "public_candidate" || right === "public_candidate") return "public_candidate";
  return left || right || "cohort";
}

function addGraphNode(map, id, kind, label, extra = {}) {
  if (!map.has(id)) {
    map.set(id, { id, kind, label, ...extra });
  }
}

function graphEdge(id, from, to, kind, extra = {}) {
  return { id, from, to, kind, ...extra };
}

function buildRoleViews(cards) {
  const weekly = new Map();
  const teams = new Map();
  const people = new Map();
  const nodes = new Map();
  const edges = [];

  for (const card of cards) {
    const sessionNode = `session:${card.vault_id}`;
    addGraphNode(nodes, sessionNode, "session", card.title, {
      artifact_id: card.artifact_id,
      date: card.date,
      week_start: card.week_start,
      source: card.source,
    });

    const weekKey = card.week_start || "undated";
    if (!weekly.has(weekKey)) {
      weekly.set(weekKey, {
        week_start: weekKey,
        evidence_card_ids: [],
        claim_count: 0,
        teams: [],
        people: [],
        themes: [],
        top_claims: [],
        source_note: "Compiled from generated transcript evidence cards, not raw transcript blobs.",
        sharing_boundary: { max_surface: "public_candidate", raw_allowed: false },
      });
    }
    const week = weekly.get(weekKey);
    week.evidence_card_ids.push(card.artifact_id);
    week.claim_count += card.claims.length;
    week.teams.push(...card.teams);
    week.people.push(...card.people);
    week.themes.push(...card.themes);
    week.sharing_boundary.max_surface = mergeSurface(
      week.sharing_boundary.max_surface,
      card.sharing_boundary.max_surface,
    );

    for (const theme of card.themes) {
      const themeId = `theme:${safeIdPart(theme)}`;
      addGraphNode(nodes, themeId, "theme", theme);
      edges.push(graphEdge(`${sessionNode}->${themeId}`, sessionNode, themeId, "session_has_theme"));
    }

    for (const team of card.teams) {
      const teamNode = `team:${team}`;
      addGraphNode(nodes, teamNode, "team", team);
      edges.push(graphEdge(`${sessionNode}->${teamNode}`, sessionNode, teamNode, "session_mentions_team"));
      if (!teams.has(team)) {
        teams.set(team, {
          team_id: team,
          evidence_card_ids: [],
          claim_ids: [],
          claim_count: 0,
          weeks: [],
          people: [],
          themes: [],
          top_claims: [],
          open_questions: [],
          source_note: "Compiled from generated transcript evidence cards, not raw transcript blobs.",
          sharing_boundary: { max_surface: "public_candidate", raw_allowed: false },
        });
      }
      const teamView = teams.get(team);
      teamView.evidence_card_ids.push(card.artifact_id);
      teamView.weeks.push(card.week_start);
      teamView.people.push(...card.people);
      teamView.themes.push(...card.themes);
      teamView.sharing_boundary.max_surface = mergeSurface(
        teamView.sharing_boundary.max_surface,
        card.sharing_boundary.max_surface,
      );
    }

    for (const person of card.people) {
      const personNode = `person:${person}`;
      addGraphNode(nodes, personNode, "person", person);
      edges.push(graphEdge(`${sessionNode}->${personNode}`, sessionNode, personNode, "session_mentions_person"));
      if (!people.has(person)) {
        people.set(person, {
          person_id: person,
          evidence_card_ids: [],
          claim_ids: [],
          claim_count: 0,
          weeks: [],
          teams: [],
          themes: [],
          top_claims: [],
          open_questions: [],
          source_note: "Compiled from generated transcript evidence cards, not raw transcript blobs.",
          sharing_boundary: { max_surface: "public_candidate", raw_allowed: false },
        });
      }
      const personView = people.get(person);
      personView.evidence_card_ids.push(card.artifact_id);
      personView.weeks.push(card.week_start);
      personView.teams.push(...card.teams);
      personView.themes.push(...card.themes);
      personView.sharing_boundary.max_surface = mergeSurface(
        personView.sharing_boundary.max_surface,
        card.sharing_boundary.max_surface,
      );
    }

    for (const claim of card.claims) {
      const claimNode = `claim:${claim.claim_id}`;
      addGraphNode(nodes, claimNode, "claim", claim.text, {
        claim_type: claim.claim_type,
        source: claim.source,
        confidence: claim.confidence,
        confidence_pct: claim.confidence_pct,
        evidence_level: claim.evidence_level,
      });
      edges.push(graphEdge(`${claimNode}->${sessionNode}`, claimNode, sessionNode, "claim_from_session"));

      if (week.top_claims.length < 20) {
        week.top_claims.push(pickClaimForView(claim, card));
      }

      for (const team of claim.teams) {
        const teamView = teams.get(team);
        if (!teamView) continue;
        teamView.claim_ids.push(claim.claim_id);
        teamView.claim_count += 1;
        if (teamView.top_claims.length < 20) {
          teamView.top_claims.push(pickClaimForView(claim, card));
        }
        edges.push(graphEdge(`${claimNode}->team:${team}`, claimNode, `team:${team}`, "claim_mentions_team"));
      }

      for (const person of claim.people) {
        const personView = people.get(person);
        if (!personView) continue;
        personView.claim_ids.push(claim.claim_id);
        personView.claim_count += 1;
        if (personView.top_claims.length < 20) {
          personView.top_claims.push(pickClaimForView(claim, card));
        }
        edges.push(graphEdge(`${claimNode}->person:${person}`, claimNode, `person:${person}`, "claim_mentions_person"));
      }
    }

    for (const item of card.qa) {
      const question = {
        qa_id: item.qa_id,
        question: item.question,
        source_artifact_id: card.artifact_id,
        source: item.source,
        confidence: item.confidence,
        confidence_pct: item.confidence_pct,
      };
      for (const team of card.teams) {
        const teamView = teams.get(team);
        if (teamView && teamView.open_questions.length < 12) {
          teamView.open_questions.push(question);
        }
      }
      for (const person of card.people) {
        const personView = people.get(person);
        if (personView && personView.open_questions.length < 12) {
          personView.open_questions.push(question);
        }
      }
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    source_artifact_count: cards.length,
    weekly: Array.from(weekly.values()).map(finalizeView).sort((a, b) => a.week_start.localeCompare(b.week_start)),
    teams: Array.from(teams.values()).map(finalizeView).sort((a, b) => a.team_id.localeCompare(b.team_id)),
    people: Array.from(people.values()).map(finalizeView).sort((a, b) => a.person_id.localeCompare(b.person_id)),
    graph: {
      nodes: Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
      edges: dedupeEdges(edges).sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

function pickClaimForView(claim, card) {
  return {
    claim_id: claim.claim_id,
    claim_type: claim.claim_type,
    text: claim.text,
    source_artifact_id: card.artifact_id,
    source: claim.source,
    confidence: claim.confidence,
    confidence_pct: claim.confidence_pct,
    evidence_level: claim.evidence_level,
    teams: claim.teams,
    people: claim.people,
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

function finalizeView(view) {
  const finalized = { ...view };
  for (const key of ["evidence_card_ids", "claim_ids", "weeks", "teams", "people", "themes"]) {
    if (Array.isArray(finalized[key])) {
      finalized[key] = unique(finalized[key]).sort();
    }
  }
  finalized.confidence = confidenceForView(finalized);
  finalized.confidence_pct = confidencePctForView(finalized);
  finalized.why_we_believe_it = [
    `${finalized.evidence_card_ids.length} generated evidence card(s)`,
    `${finalized.claim_count || finalized.top_claims.length} inferred claim(s)`,
    "all cards point back to private-vault provenance and require review before promotion",
  ];
  return finalized;
}

function confidenceForView(view) {
  const evidenceCount = Array.isArray(view.evidence_card_ids) ? view.evidence_card_ids.length : 0;
  const claimCount = view.claim_count || 0;
  if (evidenceCount >= 3 && claimCount >= 8) return "medium";
  if (evidenceCount >= 1 && claimCount >= 1) return "low";
  return "low";
}

function confidencePctForView(view) {
  const evidenceCount = Array.isArray(view.evidence_card_ids) ? view.evidence_card_ids.length : 0;
  const claimCount = view.claim_count || 0;
  if (evidenceCount >= 3 && claimCount >= 8) return 76;
  if (evidenceCount >= 1 && claimCount >= 1) return 52;
  return 35;
}

function buildManifest(cards, generatedAt) {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    artifact_count: cards.length,
    artifacts: cards.map((card) => ({
      artifact_id: card.artifact_id,
      artifact_kind: card.artifact_kind,
      record_id: card.record_id,
      date: card.date,
      week_start: card.week_start,
      file: artifactFileName(card),
      review_status: card.review_status,
      confidence_pct: card.confidence_pct,
      surface_recommendation: card.surface_recommendation,
      sharing_boundary: card.sharing_boundary.max_surface,
    })),
    derived_views: [
      {
        artifact_id: "transcript-evidence:views",
        artifact_kind: "transcript_evidence_role_views",
        file: "views.json",
      },
    ],
  };
}

function artifactFileName(card) {
  return `transcript-evidence-${safeIdPart(card.vault_id)}.json`;
}

function buildEvidenceBundle(readouts, options = {}) {
  if (!Array.isArray(readouts)) {
    throw new Error("Expected an array of transcript readouts");
  }

  const generatedAt = options.generatedAt || new Date().toISOString();
  const cards = readouts
    .map(buildEvidenceCard)
    .sort((a, b) => `${a.date || ""}:${a.vault_id}`.localeCompare(`${b.date || ""}:${b.vault_id}`));

  validateEntityRefs(cards, options);

  const views = {
    ...buildRoleViews(cards),
    generated_at: generatedAt,
  };
  const manifest = buildManifest(cards, generatedAt);
  return { schema_version: SCHEMA_VERSION, generated_at: generatedAt, cards, views, manifest };
}

function listEntityIdsFromFiles(files) {
  return new Set(
    files
      .filter((file) => path.extname(file) === ".md")
      .map((file) => path.basename(file, ".md"))
      .filter(Boolean),
  );
}

module.exports = {
  SCHEMA_VERSION,
  artifactFileName,
  buildEvidenceBundle,
  buildEvidenceCard,
  buildRoleViews,
  classifyClaim,
  hasForbiddenRawPointer,
  isoWeekStart,
  listEntityIdsFromFiles,
  safeIdPart,
  stableJson,
};
