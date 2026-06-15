"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildEvidenceBundle,
  classifyClaim,
  hasForbiddenRawPointer,
  isoWeekStart,
} = require("./lib/transcript-evidence.cjs");

const ROOT = path.resolve(__dirname, "..");

function idsFromMarkdownDir(dir) {
  return new Set(
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((file) => file.endsWith(".md"))
      .map((file) => path.basename(file, ".md")),
  );
}

test("classifies transcript claims into useful evidence types", () => {
  assert.equal(classifyClaim("The team decided to standardize the review gate."), "decision");
  assert.equal(classifyClaim("The next step is to instrument onboarding friction."), "action_item");
  assert.equal(classifyClaim("They need help with buyer intros."), "ask");
  assert.equal(classifyClaim("Authentication friction is a launch risk."), "risk");
  assert.equal(classifyClaim("The workflow demo showed a product wedge."), "product_signal");
});

test("builds generated evidence cards and role views without raw transcript leakage", () => {
  const readouts = [
    {
      vault_id: "sample-session-2026-06-08",
      date: "2026-06-08",
      title: "Sample transcript review",
      one_liner: "A reviewed session about onboarding risk and partner asks.",
      kind: "office_hours",
      consent: "speaker-pending",
      themes: ["Onboarding evidence", "Partner asks"],
      insights: [
        "The next step is to instrument onboarding friction before the team treats the demo as conversion evidence.",
        "The team needs help with buyer intros and a sharper partner handoff.",
      ],
      qa: [
        {
          q: "What changed?",
          a: "The team moved from general feedback to an explicit onboarding measurement plan.",
        },
      ],
      references: [{ label: "Public project page", href: "https://example.com/project" }],
      teams: ["conclave"],
      people: ["prakhar"],
    },
  ];

  const bundle = buildEvidenceBundle(readouts, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    teamIds: new Set(["conclave"]),
    personIds: new Set(["prakhar"]),
  });

  assert.equal(bundle.cards.length, 1);
  const card = bundle.cards[0];
  assert.equal(card.review_status, "generated");
  assert.equal(card.source, "private-vault:sample-session-2026-06-08");
  assert.equal(card.sharing_boundary.max_surface, "cohort");
  assert.equal(card.confidence, "medium");
  assert.equal(card.confidence_pct, 76);
  assert.ok(card.confidence_basis.includes("speaker/public clearance pending"));
  assert.equal(card.verbatim, false);
  assert.equal(card.claims.length, 2);
  assert.ok(card.claims.every((claim) => claim.verbatim === false));
  assert.ok(card.claims.every((claim) => claim.source === card.source));
  assert.ok(card.claims.every((claim) => claim.confidence_pct === card.confidence_pct));
  assert.ok(!hasForbiddenRawPointer(card));

  assert.equal(bundle.views.weekly.length, 1);
  assert.equal(bundle.views.weekly[0].week_start, "2026-06-08");
  assert.equal(bundle.views.teams[0].team_id, "conclave");
  assert.equal(bundle.views.people[0].person_id, "prakhar");
  assert.ok(bundle.views.graph.nodes.some((node) => node.id === "session:sample-session-2026-06-08"));
  assert.ok(bundle.views.graph.nodes.some((node) => node.id === `claim:${card.claims[0].claim_id}`));
});

test("builds a contract-compliant bundle from a multi-session readout fixture", () => {
  // Distilled session readouts are gated cohort-internal material and no longer
  // committed to this public repo, so this contract check runs against an inline
  // multi-session fixture rather than reading cohort-data/session-insights.json.
  // It still asserts the cross-session aggregation and the private-vault sharing
  // boundary the builder must guarantee. Team/person ids are validated against
  // the committed roster so the fixture stays realistic.
  const teamIds = idsFromMarkdownDir("cohort-data/teams");
  const personIds = idsFromMarkdownDir("cohort-data/people");
  const [teamA, teamB] = [...teamIds];
  const [personA, personB] = [...personIds];
  const readouts = [
    {
      vault_id: "fixture-session-2026-06-08",
      date: "2026-06-08",
      title: "Fixture office hours",
      one_liner: "A reviewed session about onboarding risk and partner asks.",
      kind: "office_hours",
      consent: "cohort-internal",
      themes: ["Onboarding evidence"],
      insights: [
        "The next step is to instrument onboarding friction before treating the demo as conversion evidence.",
        "The team needs help with buyer intros and a sharper partner handoff.",
      ],
      qa: [{ q: "What changed?", a: "The team moved to an explicit onboarding measurement plan." }],
      references: [{ label: "Public project page", href: "https://example.com/project" }],
      teams: [teamA],
      people: [personA],
    },
    {
      vault_id: "fixture-session-2026-06-01",
      date: "2026-06-01",
      title: "Fixture salon",
      one_liner: "An earlier session about routing reliability.",
      kind: "salon",
      consent: "speaker-pending",
      themes: ["Routing reliability"],
      insights: [
        "Reliability is a launch risk until the fallback path is measured.",
        "The team decided to standardize the review gate.",
      ],
      qa: [{ q: "What is next?", a: "Instrument the fallback path." }],
      references: [{ label: "Public docs", href: "https://example.com/docs" }],
      teams: [teamB],
      people: [personB],
    },
  ];
  const bundle = buildEvidenceBundle(readouts, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    teamIds,
    personIds,
  });

  assert.equal(bundle.cards.length, readouts.length);
  assert.ok(bundle.cards.length > 0);
  assert.ok(bundle.views.weekly.length > 0);
  assert.ok(bundle.views.teams.length > 0);
  assert.ok(bundle.views.people.length > 0);
  assert.ok(bundle.views.graph.edges.length > bundle.cards.length);
  assert.ok(bundle.cards.every((card) => card.source.startsWith("private-vault:")));
  assert.ok(bundle.cards.every((card) => card.review_status === "generated"));
  assert.ok(bundle.cards.every((card) => Number.isFinite(card.confidence_pct)));
  assert.ok(bundle.cards.every((card) => card.sharing_boundary.raw_allowed === false));
  assert.ok(bundle.cards.every((card) => !hasForbiddenRawPointer(card)));
});

test("computes ISO week starts for transcript grouping", () => {
  assert.equal(isoWeekStart("2026-06-13"), "2026-06-08");
  assert.equal(isoWeekStart("2026-06-08"), "2026-06-08");
  assert.equal(isoWeekStart(null), "undated");
});
