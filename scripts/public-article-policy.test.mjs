import test from "node:test";
import assert from "node:assert/strict";

import {
  publicArticleBlockedNames,
  publicArticleCandidateFromReadout,
  sanitizePublicArticleText,
} from "./lib/public-article-policy.cjs";

test("public article sanitizer replaces known people and project names", () => {
  const blockedNames = publicArticleBlockedNames({
    teams: [{ record_id: "contexto", name: "Contexto" }],
    people: [{ record_id: "tina", name: "Tina" }],
  });
  const text = sanitizePublicArticleText(
    "Tina and Contexto surfaced a reusable pattern for memory workflows.",
    blockedNames,
  );

  assert.doesNotMatch(text, /Tina|Contexto/);
  assert.match(text, /a participant/);
  assert.match(text, /a cohort team/);
});

test("public article candidates do not carry named cohort provenance", () => {
  const blockedNames = publicArticleBlockedNames({
    teams: [{ record_id: "contexto", name: "Contexto" }],
    people: [{ record_id: "tina", name: "Tina" }],
  });
  const candidate = publicArticleCandidateFromReadout({
    vault_id: "private-vault-with-name",
    title: "Contexto and Tina discussed memory workflows",
    one_liner: "Contexto and Tina showed why evidence cards should precede weekly summaries.",
    teams: ["contexto"],
    people: ["tina"],
    source: "private-vault:private-vault-with-name",
    consent: "public-cleared",
  }, { blockedNames });

  assert.equal(candidate.artifact_kind, "public_article_candidate");
  assert.equal(candidate.article_mode, "generalized_no_named_insights");
  assert.equal(candidate.named_entities_allowed, false);
  assert.equal(candidate.verbatim, false);
  assert.equal(candidate.provenance.raw_allowed, false);
  assert.equal(Object.hasOwn(candidate, "teams"), false);
  assert.equal(Object.hasOwn(candidate, "people"), false);
  assert.equal(Object.hasOwn(candidate, "vault_id"), false);
  assert.equal(Object.hasOwn(candidate, "source"), false);
  assert.doesNotMatch(JSON.stringify(candidate), /Contexto|Tina|private-vault-with-name/);
});
