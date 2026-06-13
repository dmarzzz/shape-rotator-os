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
  return `
    <section class="context-summary" aria-label="context intel summary">
      ${renderMetric("weeks", asArray(intel.weekly).length)}
      ${renderMetric("team evidence", asArray(intel.teams).length)}
      ${renderMetric("person evidence", asArray(intel.people).length)}
      ${renderMetric("distillations", distillations?.artifact_count ?? asArray(distillations?.artifacts).length)}
      ${renderMetric("public candidates", asArray(intel.context_public_candidates).length)}
    </section>
  `;
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
