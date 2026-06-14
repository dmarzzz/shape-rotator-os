function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
}

function compactText(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameTerms(records = [], kind) {
  const out = [];
  for (const record of asArray(records)) {
    for (const value of [record?.name, record?.title, record?.record_id]) {
      const text = String(value || "").trim();
      if (text.length >= 3) out.push({ text, kind });
    }
  }
  return out;
}

function publicArticleBlockedNames({ teams = [], people = [] } = {}) {
  return [
    ...nameTerms(teams, "team"),
    ...nameTerms(people, "person"),
  ].sort((a, b) => b.text.length - a.text.length);
}

function replacementFor(kind) {
  return kind === "person" ? "a participant" : "a cohort team";
}

function sanitizePublicArticleText(value, blockedNames = []) {
  let text = compactText(value, 420);
  for (const item of blockedNames) {
    const term = String(item?.text || "").trim();
    if (term.length < 3) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi");
    text = text.replace(pattern, replacementFor(item.kind));
  }
  return compactText(text, 360);
}

function publicArticleCandidateFromReadout(readout, { blockedNames = [] } = {}) {
  const sourceText = readout?.one_liner || readout?.summary || readout?.title || "";
  const cleaned = sanitizePublicArticleText(sourceText, blockedNames);
  return {
    artifact_kind: "public_article_candidate",
    article_mode: "generalized_no_named_insights",
    date: readout?.date || null,
    title: cleaned || "General insight from a public-cleared session",
    summary: cleaned || "Public-cleared transcript material should be rewritten as a general insight before publication.",
    consent: readout?.consent || "public-cleared",
    named_entities_allowed: false,
    verbatim: false,
    provenance: {
      source_access: "public-cleared-derived-readout",
      raw_allowed: false,
      transcript_source_named: false,
    },
  };
}

module.exports = {
  publicArticleBlockedNames,
  publicArticleCandidateFromReadout,
  sanitizePublicArticleText,
};
