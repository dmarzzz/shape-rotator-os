const WEEKLY_CLAIM_LIMIT = 8;
const ENTITY_CLAIM_LIMIT = 4;
const DEFAULT_CONTEXT_CONFIG_KEY = "srfg:context_config";
const CALENDAR_CONFIG_KEY = "srfg:calendar_ingress_config";
const PUBLIC_EVIDENCE_TABLE = "public_transcript_evidence_cards";
const DEFAULT_PUBLIC_EVIDENCE_LIMIT = 200;
const PUBLIC_CONTENT_KEYS = [
  "claim_type",
  "date",
  "named_entities_allowed",
  "raw_allowed",
  "source_note",
  "themes",
  "week_start",
];

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

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cleanConfigValue(value) {
  return String(value || "").trim();
}

function readJsonStorage(storage, key) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadContextSupabaseConfig({
  windowRef = globalThis,
  storage = globalThis.localStorage,
} = {}) {
  const runtime = windowRef?.SHAPE_ROTATOR_RUNTIME?.context
    || windowRef?.SHAPE_ROTATOR_CONTEXT_CONFIG
    || windowRef?.SHAPE_CONTEXT_CONFIG
    || null;
  const stored = readJsonStorage(storage, DEFAULT_CONTEXT_CONFIG_KEY)
    || readJsonStorage(storage, CALENDAR_CONFIG_KEY)
    || {};
  const source = { ...stored, ...(runtime || {}) };
  const supabaseUrl = cleanConfigValue(source.supabaseUrl || source.supabase_url);
  const supabaseAnonKey = cleanConfigValue(
    source.supabaseAnonKey
      || source.supabase_anon_key
      || source.anonKey
      || source.anon_key
  );
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { supabaseUrl, supabaseAnonKey };
}

function contextSupabaseUrl(config, table, query = {}) {
  const url = new URL(`${trimSlash(config.supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function contextSupabaseHeaders(config) {
  return {
    apikey: config.supabaseAnonKey,
    authorization: `Bearer ${config.supabaseAnonKey}`,
  };
}

function publicSafeContentJson(content = {}) {
  const source = content && typeof content === "object" && !Array.isArray(content) ? content : {};
  const safe = {};
  for (const key of PUBLIC_CONTENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) safe[key] = source[key];
  }
  safe.raw_allowed = false;
  safe.named_entities_allowed = false;
  return safe;
}

export function sanitizePublicEvidenceRow(row = {}) {
  const content = publicSafeContentJson(row.content_json);
  return {
    id: row.id || "",
    claim_type: row.claim_type || content.claim_type || "insight",
    title: row.title || "Public transcript insight",
    claim_text: row.claim_text || row.summary || row.title || "Reviewed public transcript insight.",
    summary: row.summary || "",
    evidence_level: row.evidence_level || "aggregate",
    confidence: row.confidence,
    attribution_scope: "anonymous_public",
    content_json: content,
    created_at: row.created_at || "",
  };
}

export async function fetchPublicTranscriptEvidence({
  config,
  fetchImpl = globalThis.fetch,
  limit = DEFAULT_PUBLIC_EVIDENCE_LIMIT,
} = {}) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return [];
  const url = contextSupabaseUrl(config, PUBLIC_EVIDENCE_TABLE, {
    select: "id,claim_type,title,claim_text,summary,evidence_level,confidence,attribution_scope,content_json,created_at",
    order: "created_at.desc",
    limit,
  });
  const response = await fetchImpl(url, {
    headers: contextSupabaseHeaders(config),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`public transcript evidence fetch failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return Array.isArray(data) ? data.map(sanitizePublicEvidenceRow) : [];
}

function confidenceText(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const pct = value <= 1 ? value * 100 : value;
    return `${Math.round(pct)}%`;
  }
  return labelize(value || "unknown");
}

function uniqueValues(values) {
  return [...new Set(asArray(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function publicEvidenceRowsToWeekly(rows = []) {
  const groups = new Map();
  for (const rawRow of asArray(rows)) {
    const row = sanitizePublicEvidenceRow(rawRow);
    const content = row.content_json && typeof row.content_json === "object" ? row.content_json : {};
    const weekStart = dateText(content.week_start || content.date || row.created_at) || "undated";
    if (!groups.has(weekStart)) {
      groups.set(weekStart, {
        week_start: weekStart,
        evidence_card_count: 0,
        claim_count: 0,
        confidence: "unknown",
        sharing_boundary: { max_surface: "public", raw_allowed: false },
        themes: [],
        teams: [],
        people: [],
        top_claims: [],
        source_note: "Live anonymous public transcript evidence from Supabase.",
      });
    }
    const group = groups.get(weekStart);
    const confidence = confidenceText(row.confidence);
    const themes = uniqueValues(content.themes);
    group.evidence_card_count += 1;
    group.claim_count += 1;
    if (group.confidence === "unknown" && confidence !== "unknown") group.confidence = confidence;
    group.themes = uniqueValues([...group.themes, ...themes]);
    group.top_claims.push({
      claim_type: row.claim_type || content.claim_type || "insight",
      evidence_level: row.evidence_level || "aggregate",
      confidence,
      text: row.claim_text || row.summary || row.title || "Reviewed public evidence card.",
      source: "reviewed public evidence",
      teams: [],
      people: [],
    });
  }
  return Array.from(groups.values()).sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)));
}

export function mergePublicTranscriptEvidence(cohort = {}, rows = []) {
  const weekly = publicEvidenceRowsToWeekly(rows);
  if (!weekly.length) return cohort;
  const currentIntel = cohort.cohort_intel || {};
  return {
    ...cohort,
    cohort_intel: {
      ...currentIntel,
      weekly: weekly.concat(asArray(currentIntel.weekly)),
      raw_allowed: false,
      generated_from: currentIntel.generated_from || "anonymous public transcript evidence cards",
    },
    transcript_evidence: {
      ...(cohort.transcript_evidence || {}),
      public_evidence_card_count: rows.length,
      source: PUBLIC_EVIDENCE_TABLE,
      raw_allowed: false,
    },
  };
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
  const raw = boundary?.raw_allowed === true ? "source text allowed" : "source text hidden";
  return `${labelize(maxSurface)} max surface / ${raw}`;
}

function evidenceQualityText(value) {
  const key = String(value || "").toLowerCase();
  if (key === "weak") return "low evidence";
  if (key === "none") return "no evidence";
  return labelize(value || "");
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
  const count = asArray(ids).filter(Boolean).length;
  if (!count) return "";
  return `
    <div class="context-source-strip">
      <span>${escHtml(label)}</span>
      <p>${escHtml(countLabel(count, "reviewed source"))}</p>
    </div>
  `;
}

function renderProvenance(claim, boundary) {
  const source = publicSourceLabel(claim?.source || claim?.provenance?.source_access || "");
  return `
    <dl class="context-provenance">
      ${source ? `<div><dt>source</dt><dd>${escHtml(source)}</dd></div>` : ""}
      <div><dt>boundary</dt><dd>${escHtml(boundaryText(boundary))}</dd></div>
    </dl>
  `;
}

function publicSourceLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower.includes("private") || lower.includes("vault") || lower === "restricted") return "";
  if (text === PUBLIC_EVIDENCE_TABLE) return "reviewed public evidence";
  return labelize(text);
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
        <p>Private source text is not app-visible. This page renders reviewed evidence cards and exported distillations only.</p>
      </div>
      <dl>
        <div><dt>source text</dt><dd>${rawAllowed ? "allowed" : "hidden"}</dd></div>
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
      ${renderMetric("project rollups", asArray(intel.project_progress_rollups).length)}
      ${renderMetric("project weeks", asArray(intel.project_week_snapshots).length)}
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

function renderSnapshotClaim(claim) {
  return `
    <li class="context-inventory-signal">
      <span>${escHtml(claim.label || labelize(claim.claim_type || "claim"))}</span>
      <p>${escHtml(claim.text || "")}</p>
      ${renderMetrics([
        renderMetric("confidence", labelize(claim.confidence || "")),
        renderMetric("level", labelize(claim.evidence_level || "")),
        renderMetric("score", claim.signal_score ?? ""),
      ])}
      ${renderChips(claim.matched_tokens, { limit: 5 })}
    </li>
  `;
}

function renderProgressHistory(history = []) {
  const rows = asArray(history);
  if (!rows.length) return `<p class="context-note">no transcript-backed status history yet.</p>`;
  return `
    <div class="context-progress-history" aria-label="project status history">
      ${rows.map((item) => `
        <span class="context-progress-tick context-drift-${escAttr(item.drift_status || "insufficient_evidence")}">
          <b>${escHtml(item.week_start || "undated")}</b>
          ${escHtml(labelize(item.drift_status || ""))}
        </span>
      `).join("")}
    </div>
  `;
}

function renderProjectProgressRollup(rollup, maps, index = 0) {
  const projectName = rollup.project_name || recordName(maps.teams, rollup.project_id) || rollup.project_id || "project";
  const priority = rollup.intervention_priority || "medium";
  const summaryMeta = [
    labelize(priority),
    labelize(rollup.trajectory || "unknown"),
    rollup.latest_week_start || "no dated week",
    labelize(rollup.current_drift_status || "no evidence"),
  ].join(" / ");
  const coverage = rollup.coverage || {};
  return `
    <details class="context-project-week context-progress-rollup context-priority-${escAttr(priority)}" ${index < 5 ? "open" : ""}>
      <summary>
        <span>${escHtml(projectName)}</span>
        <span>${escHtml(summaryMeta)}</span>
      </summary>
      <div class="context-project-week-body">
        ${renderMetrics([
          renderMetric("priority", labelize(priority)),
          renderMetric("trajectory", labelize(rollup.trajectory || "")),
          renderMetric("latest", rollup.latest_week_start || "none"),
          renderMetric("status", labelize(rollup.current_drift_status || "")),
          renderMetric("quality", evidenceQualityText(rollup.current_evidence_quality || "")),
          renderMetric("dated weeks", coverage.dated_week_count ?? 0),
          renderMetric("undated", coverage.undated_evidence_count ?? 0),
          renderMetric("specific signals", coverage.project_specific_signal_count ?? 0),
        ])}
        <div class="context-snapshot-grid">
          <div class="context-snapshot-lane">
            <h4>current read</h4>
            <p><b>declared</b> ${escHtml(rollup.declared_bottleneck || "not declared")}</p>
            <p><b>observed</b> ${escHtml(rollup.observed_bottleneck || "no evidence")}</p>
          </div>
          <div class="context-snapshot-lane">
            <h4>operator question</h4>
            <p>${escHtml(rollup.operator_question || "")}</p>
          </div>
          <div class="context-snapshot-lane context-snapshot-action">
            <h4>next check</h4>
            <p>${escHtml(rollup.recommended_next_check || "")}</p>
          </div>
        </div>
        ${renderProgressHistory(rollup.status_history)}
      </div>
    </details>
  `;
}

function renderProjectProgressRollups(intel = {}, maps = { teams: new Map(), people: new Map() }) {
  const rollups = asArray(intel.project_progress_rollups);
  if (!rollups.length) return "";
  const quality = intel.project_progress_rollup_quality || {};
  const priorityCounts = quality.priority_counts || {};
  const body = `
    <article class="context-project-week-board">
      ${renderMetrics([
        renderMetric("projects", quality.rollup_count ?? rollups.length),
        renderMetric("high", priorityCounts.high ?? 0),
        renderMetric("medium", priorityCounts.medium ?? 0),
        renderMetric("low", priorityCounts.low ?? 0),
        renderMetric("coverage gaps", quality.coverage_gap_count ?? 0),
        renderMetric("no evidence", quality.no_evidence_count ?? 0),
        renderMetric("undated", quality.undated_evidence_project_count ?? 0),
      ])}
      ${rollups.map((rollup, index) => renderProjectProgressRollup(rollup, maps, index)).join("")}
    </article>
  `;
  return renderSection(
    "project trajectory rollups",
    `${rollups.length} project status rows`,
    body,
    "no project trajectory rollups are exported in this bundle."
  );
}

function renderProjectWeekSnapshot(snapshot, maps, index = 0) {
  const projectName = snapshot.project_name || recordName(maps.teams, snapshot.project_id) || snapshot.project_id || "project";
  const declared = snapshot.declared_state || {};
  const observed = snapshot.observed_state || {};
  const drift = snapshot.drift || {};
  const evidence = snapshot.evidence || {};
  const status = drift.status || "insufficient_evidence";
  const claims = asArray(observed.top_observed_claims);
  const summaryMeta = [
    snapshot.week_start || "undated",
    labelize(status),
    `${evidence.project_specific_signal_count ?? 0}/${evidence.signal_count ?? 0} specific`,
    labelize(observed.evidence_quality || "unknown"),
  ].join(" / ");
  return `
    <details class="context-project-week context-drift-${escAttr(status)}" ${index < 4 ? "open" : ""}>
      <summary>
        <span>${escHtml(projectName)}</span>
        <span>${escHtml(summaryMeta)}</span>
      </summary>
      <div class="context-project-week-body">
        ${renderMetrics([
          renderMetric("week", snapshot.week_start || "undated"),
          renderMetric("declared", declared.bottleneck || "not declared"),
          renderMetric("observed", observed.inferred_bottleneck || "insufficient evidence"),
          renderMetric("movement", observed.movement || ""),
          renderMetric("quality", evidenceQualityText(observed.evidence_quality || "")),
          renderMetric("drift", labelize(status)),
        ])}
        <div class="context-snapshot-grid">
          <div class="context-snapshot-lane">
            <h4>declared state</h4>
            ${declared.now ? `<p>${escHtml(declared.now)}</p>` : ""}
            ${declared.next_milestone ? `<p><b>milestone</b> ${escHtml(declared.next_milestone)}</p>` : ""}
          </div>
          <div class="context-snapshot-lane">
            <h4>observed week</h4>
            ${observed.evidence_summary ? `<p>${escHtml(observed.evidence_summary)}</p>` : ""}
            ${drift.reason ? `<p><b>drift</b> ${escHtml(drift.reason)}</p>` : ""}
          </div>
          <div class="context-snapshot-lane context-snapshot-action">
            <h4>intervention</h4>
            <p>${escHtml(snapshot.recommended_intervention || "Collect one more week of project-level evidence.")}</p>
          </div>
        </div>
        ${claims.length ? `<ol class="context-inventory-list">${claims.map(renderSnapshotClaim).join("")}</ol>` : `<p class="context-note">no project-specific claim was strong enough to drive observed status.</p>`}
        ${renderSourceCards(evidence.source_card_ids, "source cards")}
      </div>
    </details>
  `;
}

function renderProjectWeekSnapshots(intel = {}, maps = { teams: new Map(), people: new Map() }) {
  const snapshots = asArray(intel.project_week_snapshots);
  if (!snapshots.length) return "";
  const quality = intel.project_week_snapshot_quality || {};
  const driftCounts = quality.drift_status_counts || {};
  const body = `
    <article class="context-project-week-board">
      ${renderMetrics([
        renderMetric("snapshots", quality.snapshot_count ?? snapshots.length),
        renderMetric("projects", quality.project_count ?? new Set(snapshots.map(item => item.project_id)).size),
        renderMetric("aligned", driftCounts.aligned ?? 0),
        renderMetric("drift", (driftCounts.partial_drift || 0) + (driftCounts.status_conflict || 0)),
        renderMetric("insufficient", driftCounts.insufficient_evidence ?? 0),
        renderMetric("low evidence", quality.weak_snapshot_count ?? 0),
      ])}
      ${snapshots.map((snapshot, index) => renderProjectWeekSnapshot(snapshot, maps, index)).join("")}
    </article>
  `;
  return renderSection(
    "project-week snapshots",
    `${snapshots.length} project-week status checks`,
    body,
    "no project-week snapshots are exported in this bundle."
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
        <span>${escHtml(source.title || "reviewed source")}</span>
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
        renderMetric("source records", inventory.source_card_count ?? 0),
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
        renderMetric("project weeks", quality.project_week_snapshot_count ?? 0),
        renderMetric("project drift", quality.project_week_drift_count ?? 0),
        renderMetric("low-evidence weeks", quality.project_week_weak_count ?? 0),
        renderMetric("project rollups", quality.project_progress_rollup_count ?? 0),
        renderMetric("high priority", quality.project_progress_high_priority_count ?? 0),
        renderMetric("coverage gaps", quality.project_progress_coverage_gap_count ?? 0),
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
        <div class="context-block">
          <h4>project week snapshot inputs</h4>
          <ul>${asArray(contract.project_week_snapshot_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
        <div class="context-block">
          <h4>project progress rollup inputs</h4>
          <ul>${asArray(contract.project_progress_rollup_inputs).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>
        </div>
      </div>
      ${contract.promotion_rule ? `<p class="context-note">${escHtml(contract.promotion_rule)}</p>` : ""}
    </article>
  `;
  return renderSection("data contract", "inputs needed for cards and notes", body);
}

function renderDistillationArtifact(artifact) {
  const boundary = artifact.provenance || { raw_allowed: false, source_access: "restricted" };
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
    ${renderProjectProgressRollups(intel, maps)}
    ${renderProjectWeekSnapshots(intel, maps)}
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
    let rendered = cohort;
    try {
      const config = loadContextSupabaseConfig();
      const publicRows = await fetchPublicTranscriptEvidence({ config, fetchImpl });
      rendered = mergePublicTranscriptEvidence(cohort, publicRows);
    } catch (error) {
      rendered = {
        ...cohort,
        transcript_evidence: {
          ...(cohort.transcript_evidence || {}),
          public_evidence_error: error?.message || String(error),
        },
      };
    }
    mount.innerHTML = renderContextSurface(rendered);
    return rendered;
  } catch (error) {
    mount.innerHTML = `<p class="page-empty">context data unavailable: ${escHtml(error?.message || String(error))}</p>`;
    return null;
  }
}

if (typeof document !== "undefined") {
  initContextSurface();
}
