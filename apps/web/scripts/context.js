const WEEKLY_CLAIM_LIMIT = 8;
const ENTITY_CLAIM_LIMIT = 4;

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
}

function labelize(value) {
  return String(value || "not declared").replace(/[-_]+/g, " ");
}

function dateText(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1] : raw;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function countLabel(value, singular) {
  const n = Number(value) || 0;
  return plural(n, singular);
}

function byId(records = []) {
  return new Map(asArray(records).map((record) => [String(record.record_id || ""), record]));
}

function recordName(map, id) {
  const record = map.get(String(id || ""));
  return record?.name || id;
}

function cohortHref(kind, id) {
  const safeId = encodeURIComponent(String(id || ""));
  return kind === "person" ? `../cohort/#${safeId}` : `../cohort/#${safeId}`;
}

function chip(label, className = "") {
  const extra = className ? ` ${className}` : "";
  return `<span class="context-chip${extra}">${escHtml(label)}</span>`;
}

function linkedChip(kind, id, label) {
  if (!id) return "";
  return `<a class="context-chip context-chip-link" href="${escAttr(cohortHref(kind, id))}">${escHtml(label || id)}</a>`;
}

function renderChips(values, { limit = 12, empty = "" } = {}) {
  const rows = asArray(values).slice(0, limit);
  if (!rows.length) return empty;
  return `<div class="context-chips">${rows.map((value) => chip(value)).join("")}</div>`;
}

function renderEntityLinks(ids, kind, map, limit = 12) {
  const rows = asArray(ids).slice(0, limit);
  if (!rows.length) return "";
  return `
    <div class="context-entities">
      ${rows.map((id) => linkedChip(kind, id, recordName(map, id))).join("")}
    </div>
  `;
}

function boundaryText(boundary = {}) {
  const maxSurface = boundary?.max_surface || "cohort";
  const raw = boundary?.raw_allowed === true ? "raw transcript allowed" : "raw transcript hidden";
  return `${labelize(maxSurface)} max surface / ${raw}`;
}

function renderMetric(label, value) {
  if (value === "" || value == null) return "";
  return `<span><b>${escHtml(label)}</b>${escHtml(value)}</span>`;
}

function renderMetrics(items) {
  const rows = items.filter(Boolean);
  if (!rows.length) return "";
  return `<div class="context-metrics">${rows.join("")}</div>`;
}

function renderSourceCards(ids, label = "sources") {
  const rows = asArray(ids).slice(0, 8);
  if (!rows.length) return "";
  return `
    <div class="context-source-strip">
      <span>${escHtml(label)}</span>
      <p>${rows.map(id => `<code>${escHtml(id)}</code>`).join("")}</p>
    </div>
  `;
}

function renderProvenance(claim, boundary) {
  const sourceId = claim?.source_artifact_id || claim?.provenance?.source_artifact_id || "";
  const source = claim?.source || claim?.provenance?.source_access || "";
  return `
    <dl class="context-provenance">
      ${sourceId ? `<div><dt>source artifact</dt><dd>${escHtml(sourceId)}</dd></div>` : ""}
      ${source ? `<div><dt>source</dt><dd>${escHtml(source)}</dd></div>` : ""}
      <div><dt>boundary</dt><dd>${escHtml(boundaryText(boundary))}</dd></div>
    </dl>
  `;
}

function renderClaimCard(claim, boundary, maps) {
  const teams = renderEntityLinks(claim?.teams, "team", maps.teams, 6);
  const people = renderEntityLinks(claim?.people, "person", maps.people, 6);
  const meta = [
    claim?.claim_type ? renderMetric("type", labelize(claim.claim_type)) : "",
    claim?.evidence_level ? renderMetric("level", labelize(claim.evidence_level)) : "",
    claim?.confidence ? renderMetric("confidence", labelize(claim.confidence)) : "",
  ];
  return `
    <li class="context-claim">
      <p>${escHtml(claim?.text || "No claim text.")}</p>
      ${renderMetrics(meta)}
      ${teams || people ? `<div class="context-claim-entities">${teams}${people}</div>` : ""}
      ${renderProvenance(claim, boundary)}
    </li>
  `;
}

function renderClaimList(claims, boundary, maps, limit) {
  const rows = asArray(claims).slice(0, limit);
  if (!rows.length) return `<p class="page-empty">no claims exported for this record.</p>`;
  return `<ol class="context-claim-list">${rows.map((claim) => renderClaimCard(claim, boundary, maps)).join("")}</ol>`;
}

function renderEvidenceGroup(item, kind, maps, index = 0) {
  const isWeek = kind === "week";
  const id = isWeek ? dateText(item.week_start) || "undated" : (item.team_id || item.person_id || "record");
  const title = isWeek
    ? `week ${id}`
    : recordName(kind === "team" ? maps.teams : maps.people, id);
  const boundary = item.sharing_boundary || { max_surface: "cohort", raw_allowed: false };
  const claims = asArray(item.top_claims);
  const claimLimit = isWeek ? WEEKLY_CLAIM_LIMIT : ENTITY_CLAIM_LIMIT;
  const claimNote = claims.length > claimLimit
    ? `<p class="context-note">showing ${claimLimit} of ${countLabel(item.claim_count || claims.length, "claim")}.</p>`
    : "";
  const metrics = renderMetrics([
    renderMetric("cards", item.evidence_card_count ?? asArray(item.evidence_card_ids).length),
    renderMetric("claims", item.claim_count ?? claims.length),
    renderMetric("confidence", labelize(item.confidence || "unknown")),
    renderMetric("boundary", boundaryText(boundary)),
  ]);
  const body = `
    ${metrics}
    ${renderChips(item.themes, { limit: isWeek ? 14 : 8 })}
    <div class="context-linked-records">
      ${renderEntityLinks(item.teams, "team", maps.teams, isWeek ? 16 : 10)}
      ${renderEntityLinks(item.people, "person", maps.people, isWeek ? 16 : 10)}
    </div>
    ${renderClaimList(claims, boundary, maps, claimLimit)}
    ${claimNote}
    ${item.source_note ? `<p class="context-note">${escHtml(item.source_note)}</p>` : ""}
  `;
  if (isWeek) {
    return `
      <article class="context-evidence context-week">
        <header class="context-evidence-head">
          <h3>${escHtml(title)}</h3>
        </header>
        ${body}
      </article>
    `;
  }
  return `
    <details class="context-record" ${index < 2 ? "open" : ""}>
      <summary>
        <span>${escHtml(title)}</span>
        <span>${escHtml(countLabel(item.claim_count || claims.length, "claim"))} / ${escHtml(labelize(item.confidence || "unknown"))}</span>
      </summary>
      <div class="context-record-body">
        ${body}
      </div>
    </details>
  `;
}

function renderSection(title, meta, body, emptyText = "no records exported.") {
  const cleaned = String(body || "").trim();
  return `
    <section class="context-section" aria-labelledby="${escAttr(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">
      <header class="context-section-head">
        <h2 id="${escAttr(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${escHtml(title)}</h2>
        ${meta ? `<p>${escHtml(meta)}</p>` : ""}
      </header>
      ${cleaned || `<p class="page-empty">${escHtml(emptyText)}</p>`}
    </section>
  `;
}

function renderPolicy(intel, distillations) {
  const rawAllowed = intel?.raw_allowed === true;
  const generated = intel?.generated_from || "reviewed transcript evidence cards";
  const distillationPolicy = distillations?.default_export_policy || "reviewed exports only";
  return `
    <section class="context-policy" aria-label="transcript routing policy">
      <div>
        <span>routing policy</span>
        <p>Raw transcripts are not app-visible. This page renders reviewed evidence cards and exported distillations only.</p>
      </div>
      <dl>
        <div><dt>raw allowed</dt><dd>${rawAllowed ? "yes" : "no"}</dd></div>
        <div><dt>intel source</dt><dd>${escHtml(generated)}</dd></div>
        <div><dt>distillation export</dt><dd>${escHtml(distillationPolicy)}</dd></div>
        ${intel?.context_policy_note ? `<div><dt>context note</dt><dd>${escHtml(intel.context_policy_note)}</dd></div>` : ""}
      </dl>
    </section>
  `;
}

function renderSummary(intel, distillations) {
  const inventory = intel.signal_inventory || {};
  return `
    <section class="context-summary" aria-label="context intel summary">
      ${renderMetric("weeks", asArray(intel.weekly).length)}
      ${renderMetric("team evidence", asArray(intel.teams).length)}
      ${renderMetric("person evidence", asArray(intel.people).length)}
      ${renderMetric("card signals", asArray(intel.card_signals?.teams).length + asArray(intel.card_signals?.people).length)}
      ${renderMetric("field notes", asArray(intel.field_notes).length)}
      ${renderMetric("session notes", asArray(intel.session_notes).length)}
      ${renderMetric("signals audited", inventory.total_signal_count ?? 0)}
      ${renderMetric("distillations", distillations?.artifact_count ?? asArray(distillations?.artifacts).length)}
      ${renderMetric("public candidates", asArray(intel.context_public_candidates).length)}
    </section>
  `;
}

function renderNoteClaim(claim) {
  return `
    <li>
      <strong>${escHtml(claim.label || labelize(claim.claim_type || "claim"))}</strong>
      <p>${escHtml(claim.text || "")}</p>
      ${renderMetrics([
        renderMetric("type", labelize(claim.claim_type || "")),
        renderMetric("level", labelize(claim.evidence_level || "")),
        renderMetric("confidence", labelize(claim.confidence || "")),
      ])}
    </li>
  `;
}

function renderNoteQuestion(item) {
  return `
    <li class="context-question">
      <strong>question</strong>
      <p>${escHtml(item.question || "")}</p>
      ${item.answer ? `<blockquote>${escHtml(item.answer)}</blockquote>` : ""}
      ${renderMetrics([
        renderMetric("level", labelize(item.evidence_level || "")),
        renderMetric("confidence", labelize(item.confidence || "")),
      ])}
    </li>
  `;
}

function renderNoteSection(section) {
  const claims = asArray(section.claims).map(renderNoteClaim).join("");
  const qa = asArray(section.qa).map(renderNoteQuestion).join("");
  if (!claims && !qa) return "";
  return `
    <div class="context-note-section">
      <h4>${escHtml(section.title || "section")}</h4>
      <ul>${claims}${qa}</ul>
    </div>
  `;
}

function renderFieldNote(note) {
  const boundary = note.sharing_boundary || { max_surface: "cohort", raw_allowed: false };
  const metrics = renderMetrics([
    renderMetric("week", note.week_start || "undated"),
    renderMetric("cards", note.evidence_card_count ?? ""),
    renderMetric("claims", note.claim_count ?? ""),
    renderMetric("confidence", labelize(note.confidence || "unknown")),
    renderMetric("review", labelize(note.review_status || "generated")),
    renderMetric("boundary", boundaryText(boundary)),
  ]);
  const sections = asArray(note.sections).map(renderNoteSection).join("");
  return `
    <article class="context-field-note">
      <header class="context-evidence-head">
        <h3>${escHtml(note.title || "cohort field note")}</h3>
        <p>${escHtml(note.summary || "")}</p>
      </header>
      ${metrics}
      ${renderChips(note.themes, { limit: 10 })}
      ${renderSourceCards(note.source_card_ids, "source cards")}
      ${sections || `<p class="page-empty">no note sections exported.</p>`}
      <details class="context-note-copy">
        <summary>copyable field note markdown</summary>
        <textarea readonly>${escHtml(note.markdown || "")}</textarea>
      </details>
    </article>
  `;
}

function renderFieldNotes(intel = {}) {
  const notes = asArray(intel.field_notes);
  return renderSection(
    "field notes",
    `${notes.length} generated notes`,
    notes.map(renderFieldNote).join(""),
    "no cohort field notes are exported in this bundle."
  );
}

function renderSessionNote(note, maps = { teams: new Map(), people: new Map() }) {
  const boundary = note.sharing_boundary || { max_surface: "cohort", raw_allowed: false };
  const metrics = renderMetrics([
    renderMetric("date", note.date || note.week_start || "undated"),
    renderMetric("kind", labelize(note.session_kind || "session")),
    renderMetric("claims", note.claim_count ?? ""),
    renderMetric("questions", note.question_count ?? ""),
    renderMetric("review", labelize(note.review_status || "generated")),
    renderMetric("boundary", boundaryText(boundary)),
  ]);
  const sections = asArray(note.sections).map(renderNoteSection).join("");
  return `
    <details class="context-session-note">
      <summary>
        <span>${escHtml(note.title || "session note")}</span>
        <span>${escHtml([note.date || note.week_start || "undated", `${note.claim_count ?? 0} claims`, `${note.question_count ?? 0} q`].filter(Boolean).join(" / "))}</span>
      </summary>
      <div class="context-session-body">
        <header class="context-evidence-head">
          <p>${escHtml(note.summary || "")}</p>
        </header>
        ${metrics}
        ${renderChips(note.themes, { limit: 8 })}
        <div class="context-linked-records">
          ${renderEntityLinks(note.teams, "team", maps.teams, 8)}
          ${renderEntityLinks(note.people, "person", maps.people, 8)}
        </div>
        ${renderSourceCards(note.source_card_ids, "source card")}
        ${sections || `<p class="page-empty">no session-note sections exported.</p>`}
        <details class="context-note-copy">
          <summary>copyable session note markdown</summary>
          <textarea readonly>${escHtml(note.markdown || "")}</textarea>
        </details>
      </div>
    </details>
  `;
}

function renderSessionNotes(intel = {}, maps = { teams: new Map(), people: new Map() }) {
  const notes = asArray(intel.session_notes);
  return renderSection(
    "session notes",
    `${notes.length} transcript notes`,
    notes.map(note => renderSessionNote(note, maps)).join(""),
    "no per-session transcript notes are exported in this bundle."
  );
}

function renderTypeCounts(counts = {}) {
  const rows = Object.entries(counts || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!rows.length) return "";
  return `
    <div class="context-type-counts">
      ${rows.map(([key, value]) => `<span><b>${escHtml(labelize(key))}</b>${escHtml(value)}</span>`).join("")}
    </div>
  `;
}

function renderInventorySignal(signal) {
  return `
    <li class="context-inventory-signal">
      <span>${escHtml(signal.label || labelize(signal.signal_type || signal.signal_kind || "signal"))}</span>
      <p>${escHtml(signal.text || "")}</p>
      ${signal.answer ? `<blockquote>${escHtml(signal.answer)}</blockquote>` : ""}
      ${renderMetrics([
        renderMetric("kind", labelize(signal.signal_kind || "")),
        renderMetric("confidence", labelize(signal.confidence || "")),
        renderMetric("level", labelize(signal.evidence_level || "")),
      ])}
    </li>
  `;
}

function renderInventorySource(source, maps) {
  const boundary = source.sharing_boundary || { max_surface: "cohort", raw_allowed: false };
  const summaryMeta = [
    source.date || source.week_start || "undated",
    `${source.total_signal_count ?? asArray(source.signals).length} signals`,
    `${source.claim_signal_count ?? 0} claims`,
    `${source.qa_signal_count ?? 0} q&a`,
  ].join(" / ");
  return `
    <details class="context-signal-source">
      <summary>
        <span>${escHtml(source.title || source.source_card_id || "transcript source")}</span>
        <span>${escHtml(summaryMeta)}</span>
      </summary>
      <div class="context-signal-source-body">
        ${source.summary ? `<p class="context-note">${escHtml(source.summary)}</p>` : ""}
        ${renderMetrics([
          renderMetric("kind", labelize(source.session_kind || "session")),
          renderMetric("consent", labelize(source.consent || "unknown")),
          renderMetric("review", labelize(source.review_status || "generated")),
          renderMetric("confidence", labelize(source.confidence || "unknown")),
          renderMetric("boundary", boundaryText(boundary)),
        ])}
        ${renderTypeCounts(source.signal_type_counts)}
        ${renderChips(source.themes, { limit: 10 })}
        <div class="context-linked-records">
          ${renderEntityLinks(source.teams, "team", maps.teams, 10)}
          ${renderEntityLinks(source.people, "person", maps.people, 10)}
        </div>
        ${renderSourceCards(source.source_card_id, "source card")}
        <ol class="context-inventory-list">
          ${asArray(source.signals).map(renderInventorySignal).join("")}
        </ol>
      </div>
    </details>
  `;
}

function renderSignalInventory(intel = {}, maps = { teams: new Map(), people: new Map() }) {
  const inventory = intel.signal_inventory || {};
  const sources = asArray(inventory.sources);
  const coverage = inventory.coverage || {};
  const body = `
    <article class="context-signal-inventory">
      ${renderMetrics([
        renderMetric("source transcripts", inventory.source_card_count ?? 0),
        renderMetric("total signals", inventory.total_signal_count ?? 0),
        renderMetric("claim signals", inventory.claim_signal_count ?? 0),
        renderMetric("q&a signals", inventory.qa_signal_count ?? 0),
        renderMetric("min/source", coverage.min_signals_per_source ?? 0),
        renderMetric("max/source", coverage.max_signals_per_source ?? 0),
      ])}
      ${renderTypeCounts(inventory.signal_type_counts)}
      ${sources.map(source => renderInventorySource(source, maps)).join("")}
    </article>
  `;
  return renderSection(
    "signal inventory",
    `${inventory.total_signal_count ?? 0} extracted transcript signals`,
    body,
    "no transcript signal inventory is exported in this bundle."
  );
}

function renderDataContract(intel = {}) {
  const contract = intel.data_contract || {};
  const quality = contract.quality || {};
  const hasEvidenceInputs = Boolean(
    (quality.team_signal_count || 0)
    + (quality.person_signal_count || 0)
    + (quality.field_note_count || 0)
    + (quality.session_note_count || 0)
    + (quality.total_signal_count || 0)
    + asArray(intel.weekly).length
  );
  if (!hasEvidenceInputs) return "";
  const body = `
    <article class="context-data-contract">
      ${renderMetrics([
        renderMetric("source transcripts", quality.source_transcript_count ?? 0),
        renderMetric("total signals", quality.total_signal_count ?? 0),
        renderMetric("claim signals", quality.claim_signal_count ?? 0),
        renderMetric("q&a signals", quality.qa_signal_count ?? 0),
        renderMetric("team signals", quality.team_signal_count ?? 0),
        renderMetric("person signals", quality.person_signal_count ?? 0),
        renderMetric("field notes", quality.field_note_count ?? 0),
        renderMetric("session notes", quality.session_note_count ?? 0),
        renderMetric("missing team signals", quality.missing_team_signal_count ?? 0),
        renderMetric("missing person signals", quality.missing_person_signal_count ?? 0),
        renderMetric("missing session notes", quality.missing_session_note_count ?? 0),
        renderMetric("sources without claims", quality.sources_without_claims ?? 0),
        renderMetric("sources without q&a", quality.sources_without_questions ?? 0),
      ])}
      <div class="context-contract-grid">
        <div class="context-block">
          <h4>card signal inputs</h4>
          <ul>${asArray(contract.card_signal_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
        <div class="context-block">
          <h4>field note inputs</h4>
          <ul>${asArray(contract.field_note_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
        <div class="context-block">
          <h4>session note inputs</h4>
          <ul>${asArray(contract.session_note_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
        <div class="context-block">
          <h4>signal inventory inputs</h4>
          <ul>${asArray(contract.signal_inventory_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
      </div>
      ${contract.promotion_rule ? `<p class="context-note">${escHtml(contract.promotion_rule)}</p>` : ""}
    </article>
  `;
  return renderSection("data contract", "inputs needed for cards and notes", body);
}

function renderDistillationArtifact(artifact) {
  const boundary = artifact.provenance || { raw_allowed: false, source_access: "private-vault" };
  const metrics = renderMetrics([
    renderMetric("surface", labelize(artifact.surface || "cohort")),
    renderMetric("tier", artifact.tier || ""),
    renderMetric("review", labelize(artifact.review_status || "")),
    renderMetric("approval", labelize(artifact.approval_state || "")),
    renderMetric("confidence", artifact.confidence ?? "unknown"),
  ]);
  return `
    <article class="context-distillation">
      <header class="context-evidence-head">
        <h3>${escHtml(artifact.session_title || artifact.artifact_id || "distillation")}</h3>
        <p>${escHtml([dateText(artifact.starts_at), artifact.session_type, artifact.artifact_kind].filter(Boolean).map(labelize).join(" / "))}</p>
      </header>
      ${metrics}
      ${renderChips(artifact.themes, { limit: 10 })}
      ${asArray(artifact.summary).length ? `<div class="context-block"><h4>summary</h4><ul>${asArray(artifact.summary).map((item) => `<li>${escHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${asArray(artifact.action_items).length ? `<div class="context-block"><h4>action items</h4><ul>${asArray(artifact.action_items).map((item) => `<li>${escHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${asArray(artifact.open_questions).length ? `<div class="context-block"><h4>open questions</h4><ul>${asArray(artifact.open_questions).map((item) => `<li>${escHtml(item)}</li>`).join("")}</ul></div>` : ""}
      ${renderProvenance({ provenance: artifact.provenance }, boundary)}
    </article>
  `;
}

function renderDistillations(distillations = {}) {
  const artifacts = asArray(distillations.artifacts);
  const meta = [
    countLabel(distillations.artifact_count ?? artifacts.length, "artifact"),
    `${distillations.cohort_count ?? 0} cohort`,
    `${distillations.public_count ?? 0} public`,
    `${distillations.operator_review_count ?? 0} operator review`,
  ].join(" / ");
  const body = artifacts.map(renderDistillationArtifact).join("");
  return renderSection(
    "transcript distillations",
    meta,
    body,
    "no reviewed transcript distillations are exported in this bundle."
  );
}

function renderPublicCandidates(intel = {}) {
  const candidates = asArray(intel.context_public_candidates);
  const body = candidates.map((candidate) => `
    <article class="context-distillation">
      <header class="context-evidence-head">
        <h3>${escHtml(candidate.title || candidate.artifact_id || "public candidate")}</h3>
      </header>
      ${renderMetrics([
        renderMetric("confidence", labelize(candidate.confidence || "unknown")),
        renderMetric("boundary", boundaryText(candidate.sharing_boundary || { max_surface: "public", raw_allowed: false })),
      ])}
      ${renderChips(candidate.themes, { limit: 10 })}
      ${candidate.summary ? `<p class="context-note">${escHtml(candidate.summary)}</p>` : ""}
    </article>
  `).join("");
  return renderSection("public candidates", `${candidates.length} candidates`, body, "no transcript readout is public-cleared yet.");
}

export function renderContextSurface(cohort) {
  const intel = cohort?.cohort_intel || {};
  const distillations = cohort?.transcript_distillations || {};
  const maps = {
    teams: byId(cohort?.teams),
    people: byId(cohort?.people),
  };
  const weekly = asArray(intel.weekly)
    .map((item, index) => renderEvidenceGroup(item, "week", maps, index))
    .join("");
  const teams = asArray(intel.teams)
    .map((item, index) => renderEvidenceGroup(item, "team", maps, index))
    .join("");
  const people = asArray(intel.people)
    .map((item, index) => renderEvidenceGroup(item, "person", maps, index))
    .join("");

  return `
    ${renderPolicy(intel, distillations)}
    ${renderSummary(intel, distillations)}
    ${renderFieldNotes(intel)}
    ${renderSignalInventory(intel, maps)}
    ${renderSessionNotes(intel, maps)}
    ${renderDataContract(intel)}
    ${renderSection("weekly evidence", `${asArray(intel.weekly).length} weeks`, weekly)}
    ${renderSection("team evidence", `${asArray(intel.teams).length} records`, teams)}
    ${renderSection("person evidence", `${asArray(intel.people).length} records`, people)}
    ${renderDistillations(distillations)}
    ${renderPublicCandidates(intel)}
  `;
}

function addPreviewVersion(pathname) {
  const params = new URLSearchParams(globalThis.location?.search || "");
  const version = params.get("v");
  return version ? `${pathname}?v=${encodeURIComponent(version)}` : pathname;
}

export async function initContextSurface({
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
} = {}) {
  const mount = documentRef?.getElementById?.("context-mount");
  if (!mount) return null;
  try {
    const surfaceUrl = addPreviewVersion("../cohort-surface.json");
    const response = await fetchImpl(surfaceUrl);
    if (!response?.ok) throw new Error(`cohort surface fetch failed: ${response?.status || "no response"}`);
    const cohort = await response.json();
    mount.innerHTML = renderContextSurface(cohort);
    return cohort;
  } catch (error) {
    mount.innerHTML = `<p class="page-empty">context data unavailable: ${escHtml(error?.message || String(error))}</p>`;
    return null;
  }
}

if (typeof document !== "undefined") {
  initContextSurface();
}
