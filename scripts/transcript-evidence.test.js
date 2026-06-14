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

test("validates current reviewed session insights against known teams and people", () => {
  const readouts = JSON.parse(fs.readFileSync(path.join(ROOT, "cohort-data", "session-insights.json"), "utf8"));
  const bundle = buildEvidenceBundle(readouts, {
    generatedAt: "2026-06-13T00:00:00.000Z",
    teamIds: idsFromMarkdownDir("cohort-data/teams"),
    personIds: idsFromMarkdownDir("cohort-data/people"),
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
