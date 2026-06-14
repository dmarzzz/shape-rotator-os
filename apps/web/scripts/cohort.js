import {
  mountShapesIn,
  escHtml,
  escAttr,
  normalizeLinkHref,
  buildEditPRUrl,
  renderProfileForm,
  shapeForTeam,
  domainLabel,
  cohortRosterForTeam,
  compactCohortLinkItems,
} from "@shape-rotator/shape-ui";

const TEAM_CHIPS = [
  { id: "all",      label: "all",              match: () => true },
  { id: "cohort",   label: "cohort teams",     match: (t) => (t.membership || "visiting") === "cohort" },
  { id: "visiting", label: "visiting",         match: (t) => (t.membership || "visiting") !== "cohort" },
];
const PERSON_CHIPS = [
  { id: "all",              label: "all",               match: () => true },
  { id: "cohort-member",    label: "cohort members",    match: (p) => (p.role_class || "visiting-scholar") === "cohort-member" },
  { id: "visiting-scholar", label: "visiting scholars", match: (p) => (p.role_class || "visiting-scholar") === "visiting-scholar" },
  { id: "coordinator",      label: "coordinators",      match: (p) => (p.role_class || "visiting-scholar") === "coordinator" },
];
const DEFAULT_MEMBERSHIP = "all";
const JOURNEY_STAGE_LABELS = [
  "side project",
  "idea",
  "problem discovery",
  "problem-solution fit",
  "mvp / product validation",
  "early traction",
  "emerging pmf",
  "strong pmf",
  "scale fit",
];
const JOURNEY_EVIDENCE_LABELS = [
  null,
  "vibes / thesis",
  "interviews",
  "pilots / lois",
  "usage / revenue",
  "repeatable pull",
];

const state = {
  kind: "works",
  membership: DEFAULT_MEMBERSHIP,
  detail: null,
};

function parseDetailHash() {
  const h = (typeof location !== "undefined" ? location.hash : "") || "";
  if (!h.startsWith("#")) return null;
  try {
    return decodeURIComponent(h.slice(1)) || null;
  } catch {
    return null;
  }
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(s || "").length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(x => !isBlank(x));
  return isBlank(v) ? [] : [v];
}

function firstValue(v) {
  const values = asArray(v);
  return values.length ? values[0] : "";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function journeySummary(rec) {
  const journey = rec && typeof rec.journey === "object" && rec.journey ? rec.journey : null;
  if (!journey) return null;
  const stage = clampInt(journey.stage, 0, JOURNEY_STAGE_LABELS.length - 1, 1);
  const evidence = clampInt(journey.evidence_quality, 1, JOURNEY_EVIDENCE_LABELS.length - 1, 1);
  const upside = clampInt(journey.market_upside, 1, 5, 3);
  return {
    stage,
    evidence,
    upside,
    stageLabel: JOURNEY_STAGE_LABELS[stage] || "idea",
    evidenceLabel: JOURNEY_EVIDENCE_LABELS[evidence] || "",
    bottleneck: journey.primary_bottleneck || "",
    companyType: journey.company_type || "",
    confidence: journey.confidence || "",
    icp: journey.icp || "",
    problem: journey.problem || "",
    solution: journey.solution || "",
    evidenceNotes: journey.evidence_notes || "",
    next: journey.next_milestone || "",
  };
}

function labelize(v) {
  return String(v || "not declared").replace(/[-_]+/g, " ");
}

function dateText(v) {
  if (!v) return "";
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;
}

function dateRange(start, end) {
  const a = dateText(start);
  const b = dateText(end);
  return a || b ? `${a || "open"} to ${b || "open"}` : "";
}

function recordKind(rec) {
  return (rec.record_type === "person" || rec.role_class || rec.kind === "person") ? "person" : "team";
}

function teamKind(t) {
  if (!t) return "team";
  const k = String(t.kind || "team").toLowerCase();
  return k === "project" ? "project" : "team";
}

function shapeFamily(rec, kind) {
  if (kind === "person") return hashString(rec.record_id || rec.name || "person") % 6;
  const s = shapeForTeam ? shapeForTeam(rec) : null;
  return Number(s?.fam ?? rec.shape_fam ?? rec.shape ?? 0) || 0;
}

function recordSourceUrl(rec, kind) {
  if (buildEditPRUrl) {
    return buildEditPRUrl({ recordType: kind === "person" ? "person" : "team", recordId: rec.record_id });
  }
  return `https://github.com/dmarzzz/shape-rotator-os/blob/main/cohort-data/${kind === "person" ? "people" : "teams"}/${rec.record_id}.md`;
}

function renderValue(v) {
  const values = asArray(v);
  if (!values.length) return "";
  if (values.length === 1) return escHtml(values[0]);
  return `<ul class="cd-bullet-list">${values.map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>`;
}

function renderRow(label, value) {
  if (isBlank(value)) return "";
  return `
    <div class="cd-row">
      <span class="cd-row-k">${escHtml(label)}</span>
      <span class="cd-row-v">${renderValue(value)}</span>
    </div>
  `;
}

function renderHtmlRow(label, html) {
  if (!html) return "";
  return `
    <div class="cd-row">
      <span class="cd-row-k">${escHtml(label)}</span>
      <span class="cd-row-v">${html}</span>
    </div>
  `;
}

function renderProse(md) {
  const raw = String(md || "").trim();
  if (!raw) return "";
  const blocks = raw.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  if (!blocks.length) return "";
  return `
    <div class="cd-prose">
      ${blocks.map(block => {
        const lines = block.split(/\n/).map(line => line.trim()).filter(Boolean);
        const isList = lines.length > 1 && lines.every(line => /^[-*]\s+/.test(line));
        if (isList) {
          return `<ul>${lines.map(line => `<li>${escHtml(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
        }
        return `<p>${escHtml(lines.join(" "))}</p>`;
      }).join("")}
    </div>
  `;
}

function compactSentenceList(value, limit = 2) {
  const values = asArray(value)
    .map(item => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit);
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function sentenceText(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s && /[.!?]$/.test(s) ? s : (s ? `${s}.` : "");
}

function renderProofRead(rec) {
  const prior = compactSentenceList(rec.prior_work, 2);
  const signature = rec.making_signature && typeof rec.making_signature === "object" ? rec.making_signature : null;
  const builtDomain = compactSentenceList(signature?.built_domain, 3);
  const sentences = [];
  if (prior) {
    sentences.push(`Public proof points include ${prior}.`);
  }
  if (signature?.note || builtDomain || signature?.shape) {
    const parts = [];
    if (builtDomain) parts.push(`${builtDomain} work`);
    if (signature?.shape) parts.push(`${signature.shape} making pattern`);
    const read = parts.length ? `The making signature points to ${parts.join(" with a ")}` : "The making signature is present";
    sentences.push(signature?.note ? `${read}: ${sentenceText(signature.note)}` : `${read}.`);
  }
  return renderProse(sentences.join("\n\n"));
}

function renderSection(title, body, open = false, preview = "") {
  const cleaned = asArray(body).join("");
  if (!cleaned.trim()) return "";
  const previewHtml = preview
    ? `<span class="cd-section-preview"><span aria-hidden="true">/</span> ${escHtml(preview)}</span>`
    : "";
  return `
    <details class="cd-section" ${open ? "open" : ""}>
      <summary>
        <span class="cd-section-label"><span>${escHtml(title)}</span>${previewHtml}</span>
        <span class="cd-section-mark" aria-hidden="true"></span>
      </summary>
      <div class="cd-section-body">${cleaned}</div>
    </details>
  `;
}

function timelinePreview(items = []) {
  const labels = [...new Set(asArray(items)
    .map(item => labelize(item.type || item.source || ""))
    .filter(Boolean))]
    .slice(0, 3);
  return labels.join(", ");
}

function linkTargetAttrs(href) {
  return /^https?:\/\//i.test(String(href || "")) ? ` target="_blank" rel="noopener noreferrer"` : "";
}

function renderTimelineItems(items = []) {
  const rows = asArray(items);
  if (!rows.length) return "";
  return `
    <ol class="cd-timeline">
      ${rows.map(item => {
        const href = item.href || "";
        const title = item.title || item.type || "timeline item";
        const titleHtml = href
          ? `<a class="cd-timeline-title" href="${escAttr(href)}"${linkTargetAttrs(href)}>${escHtml(title)}</a>`
          : `<span class="cd-timeline-title">${escHtml(title)}</span>`;
        return `
          <li class="cd-timeline-item">
            <time class="cd-timeline-date">${escHtml(dateText(item.date) || "undated")}</time>
            <div class="cd-timeline-body">
              <div class="cd-timeline-head">
                ${titleHtml}
                ${item.type ? `<span class="cd-timeline-type">${escHtml(labelize(item.type))}</span>` : ""}
              </div>
              ${item.detail ? `<p>${escHtml(item.detail)}</p>` : ""}
              ${item.source ? `<span class="cd-timeline-source">${escHtml(item.source)}</span>` : ""}
            </div>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function quickLink(label, href, external = true) {
  if (!href) return "";
  const attrs = external ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a class="cd-quick-link" href="${escAttr(href)}"${attrs}>${escHtml(label)}</a>`;
}

function teamQuickLink(team) {
  if (!team) return "";
  const kind = teamKind(team);
  return `
    <a class="cd-quick-link cd-team-token" href="#${escAttr(encodeURIComponent(team.record_id))}">
      <span class="cd-mini-shape" aria-hidden="true">
        <canvas data-shape-fam="${escAttr(shapeFamily(team, "team"))}" data-shape-kind="${escAttr(kind)}" data-shape-seed="${escAttr(team.record_id)}"></canvas>
      </span>
      <span>${escHtml(team.name || team.record_id)}</span>
    </a>
  `;
}

function renderQuickRow(label, items) {
  const html = items.filter(Boolean).join("");
  if (!html) return "";
  return `
    <div class="cd-quick-row">
      <span class="cd-quick-k">${escHtml(label)}</span>
      <span class="cd-quick-v">${html}</span>
    </div>
  `;
}

function linkForKey(links, key) {
  const value = links?.[key];
  if (!value || !String(value).trim()) return "";
  return normalizeLinkHref(key, value);
}

function pill(label, value) {
  if (isBlank(value)) return "";
  return `<span class="cd-pill"><span>${escHtml(label)}</span>${escHtml(value)}</span>`;
}

function quickText(label, value) {
  const values = asArray(value);
  if (!values.length) return "";
  return `<span class="cd-quick-text">${label ? `<span>${escHtml(label)}</span>` : ""}${escHtml(values.join(" · "))}</span>`;
}

function cohortDetailHref(recordId) {
  return `#${encodeURIComponent(recordId || "")}`;
}

function compactPills(items) {
  const rows = asArray(items)
    .map(item => String(item || "").trim())
    .filter(item => item && item.length <= 28)
    .slice(0, 3);
  if (!rows.length) return "";
  return `<div class="cic-pills">${rows.map(item => `<span>${escHtml(item)}</span>`).join("")}</div>`;
}

(async function init() {
  const surfaceUrl = new URL("/cohort-surface.json", location.origin);
  const previewVersion = new URLSearchParams(location.search).get("v");
  if (previewVersion) surfaceUrl.searchParams.set("v", previewVersion);
  const r = await fetch(`${surfaceUrl.pathname}${surfaceUrl.search}`).catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }

  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const dependencyRecords = cohort.dependencies || [];
  const teamById = new Map(teams.map(t => [t.record_id, t]));
  const personById = new Map(people.map(p => [p.record_id, p]));

  mount.innerHTML = `
    <section class="cohort-browse">
      <section id="cohort-insight-board" class="cohort-insight-board" aria-label="cohort signal charts"></section>
      <div id="cohort-grid" class="cohort-grid"></div>
    </section>
    <div id="cohort-detail" class="cohort-detail" hidden></div>
  `;
  const browse = mount.querySelector(".cohort-browse");
  const pageHead = document.querySelector(".cohort-page-head");
  const membershipNav = document.getElementById("cohort-membership-filter");
  const insightBoard = mount.querySelector("#cohort-insight-board");
  const grid = mount.querySelector("#cohort-grid");
  const detailHost = mount.querySelector("#cohort-detail");
  const countsEl = document.getElementById("cohort-counts");

  function activeChipSet() {
    return state.kind === "people" ? PERSON_CHIPS : TEAM_CHIPS;
  }

  function findRecord(recordId) {
    return teams.find(t => t.record_id === recordId)
        || people.find(p => p.record_id === recordId)
        || null;
  }

  function teamPeopleFor(teamId) {
    return cohortRosterForTeam(people, teamId);
  }

  function countByRows(rows, keyFn) {
    const counts = new Map();
    for (const row of asArray(rows)) {
      const key = String(keyFn(row) || "not declared").trim() || "not declared";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function pct(count, total) {
    return total ? Math.max(2, Math.round((count / total) * 100)) : 0;
  }

  function bottleneckClass(value) {
    return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  }

  function chartBarRows(rows, total, { labelFor = labelize, hrefFor = () => "", detailFor = null } = {}) {
    return asArray(rows).map(([key, count]) => {
      const label = labelFor(key);
      const href = hrefFor(key);
      const detail = detailFor ? detailFor(key, count) : `${label}: ${count} record${count === 1 ? "" : "s"}`;
      const inner = `
        <span>${escHtml(label)}</span>
        <i style="--w:${pct(count, total)}%"></i>
        <b>${escHtml(count)}</b>
      `;
      const attrs = `class="cohort-chart-bar-row" data-chart-detail="${escAttr(detail)}"`;
      return href
        ? `<a ${attrs} href="${escAttr(href)}">${inner}</a>`
        : `<span ${attrs} tabindex="0">${inner}</span>`;
    }).join("");
  }

  function journeyRows(records) {
    return asArray(records)
      .map(rec => ({ rec, journey: journeySummary(rec) }))
      .filter(item => item.journey);
  }

  function renderWorksInsightBoard(records, activeLabel) {
    const rows = journeyRows(records);
    if (!rows.length) return "";
    const bottlenecks = countByRows(rows, item => item.journey.bottleneck || "not declared");
    const avgStage = rows.reduce((sum, item) => sum + item.journey.stage, 0) / rows.length;
    const avgEvidence = rows.reduce((sum, item) => sum + item.journey.evidence, 0) / rows.length;
    const avgUpside = rows.reduce((sum, item) => sum + item.journey.upside, 0) / rows.length;
    const width = 560;
    const height = 246;
    const left = 42;
    const right = 18;
    const top = 18;
    const bottom = 34;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const xFor = stage => left + (clampInt(stage, 0, 8, 0) / 8) * plotW;
    const yFor = evidence => top + ((5 - clampInt(evidence, 1, 5, 1)) / 4) * plotH;
    const xTicks = [0, 2, 4, 6, 8].map(stage => {
      const x = xFor(stage);
      return `<g><line class="cohort-chart-grid" x1="${x}" x2="${x}" y1="${top}" y2="${height - bottom}"></line><text x="${x}" y="${height - 10}" text-anchor="middle">${stage}</text></g>`;
    }).join("");
    const yTicks = [1, 2, 3, 4, 5].map(evidence => {
      const y = yFor(evidence);
      return `<g><line class="cohort-chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"></line><text x="28" y="${y + 4}" text-anchor="end">${evidence}</text></g>`;
    }).join("");
    const dots = rows.map(({ rec, journey }) => {
      const detail = `${rec.name || rec.record_id}: stage ${journey.stage} ${journey.stageLabel}; evidence ${journey.evidence}/5; upside ${journey.upside}/5; bottleneck ${journey.bottleneck || "not declared"}.`;
      return `
        <a href="${escAttr(cohortDetailHref(rec.record_id))}" class="cohort-chart-dot-link" data-chart-detail="${escAttr(detail)}">
          <circle class="cohort-chart-dot is-${escAttr(bottleneckClass(journey.bottleneck))}" cx="${xFor(journey.stage).toFixed(1)}" cy="${yFor(journey.evidence).toFixed(1)}" r="${(4 + journey.upside * 1.7).toFixed(1)}"></circle>
          <title>${escHtml(detail)}</title>
        </a>
      `;
    }).join("");
    return `
      <header class="cohort-insight-head">
        <div>
          <span>public cohort read</span>
          <h2>journey evidence map</h2>
        </div>
        <p>${escHtml(rows.length)} ${escHtml(activeLabel)} with journey metadata. Dots map stage against evidence; dot size carries market upside.</p>
      </header>
      <div class="cohort-insight-grid">
        <figure class="cohort-chart-panel">
          <svg class="cohort-journey-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Journey stage by evidence quality for visible cohort teams">
            <g class="cohort-chart-axis">${xTicks}${yTicks}</g>
            <text class="cohort-axis-label" x="${left + plotW / 2}" y="${height - 2}" text-anchor="middle">stage</text>
            <text class="cohort-axis-label" x="10" y="${top + plotH / 2}" text-anchor="middle" transform="rotate(-90 10 ${top + plotH / 2})">evidence</text>
            ${dots}
          </svg>
          <figcaption>
            <b>${avgStage.toFixed(1)}</b> avg stage / <b>${avgEvidence.toFixed(1)}</b> avg evidence / <b>${avgUpside.toFixed(1)}</b> avg upside
          </figcaption>
        </figure>
        <div class="cohort-chart-panel cohort-bar-panel">
          <h3>bottlenecks</h3>
          <div class="cohort-chart-bars" role="list">
            ${chartBarRows(bottlenecks, rows.length, {
              detailFor: (key, count) => `${labelize(key)} is the primary bottleneck for ${count} visible team${count === 1 ? "" : "s"}.`,
            })}
          </div>
        </div>
      </div>
      <p class="cohort-chart-readout" data-chart-readout data-default-text="Focus a mark for exact values.">Focus a mark for exact values.</p>
    `;
  }

  function renderPeopleInsightBoard(records, activeLabel) {
    const roleRows = countByRows(records, person => person.role_class || person.role || "not declared");
    const teamRows = countByRows(records.filter(person => person.team), person => person.team).slice(0, 10);
    if (!roleRows.length && !teamRows.length) return "";
    return `
      <header class="cohort-insight-head">
        <div>
          <span>public people read</span>
          <h2>role and affiliation graph</h2>
        </div>
        <p>${escHtml(records.length)} ${escHtml(activeLabel)}. Bars show public profile grouping only; transcript-derived claims stay in record cards and detail views.</p>
      </header>
      <div class="cohort-insight-grid">
        <div class="cohort-chart-panel cohort-bar-panel">
          <h3>role class</h3>
          <div class="cohort-chart-bars" role="list">
            ${chartBarRows(roleRows, records.length, {
              detailFor: (key, count) => `${labelize(key)}: ${count} visible profile${count === 1 ? "" : "s"}.`,
            })}
          </div>
        </div>
        <div class="cohort-chart-panel cohort-bar-panel">
          <h3>team affiliation</h3>
          <div class="cohort-chart-bars" role="list">
            ${chartBarRows(teamRows, records.length || 1, {
              labelFor: key => teamById.get(key)?.name || labelize(key),
              hrefFor: key => teamById.has(key) ? cohortDetailHref(key) : "",
              detailFor: (key, count) => `${teamById.get(key)?.name || labelize(key)} has ${count} visible affiliated profile${count === 1 ? "" : "s"}.`,
            })}
          </div>
        </div>
      </div>
      <p class="cohort-chart-readout" data-chart-readout data-default-text="Focus a bar for exact counts.">Focus a bar for exact counts.</p>
    `;
  }

  function renderCohortInsightBoard(records, activeLabel) {
    return state.kind === "people"
      ? renderPeopleInsightBoard(records, activeLabel)
      : renderWorksInsightBoard(records, activeLabel);
  }

  function wireInsightBoard() {
    if (!insightBoard) return;
    const readout = insightBoard.querySelector("[data-chart-readout]");
    if (!readout) return;
    const marks = [...insightBoard.querySelectorAll("[data-chart-detail]")];
    const show = (mark) => {
      marks.forEach(item => item.removeAttribute("data-active"));
      mark.setAttribute("data-active", "true");
      readout.textContent = mark.dataset.chartDetail || readout.dataset.defaultText || "";
    };
    for (const mark of marks) {
      mark.addEventListener("mouseenter", () => show(mark));
      mark.addEventListener("focus", () => show(mark));
      mark.addEventListener("click", () => show(mark));
    }
  }

  function teamTextLink(team, fallbackId = "") {
    const rid = team?.record_id || fallbackId;
    if (!rid) return "";
    return `<a class="cd-text-link" href="#${escAttr(encodeURIComponent(rid))}">${escHtml(team?.name || rid)}</a>`;
  }

  function transcriptEvidenceView(recordId, kind) {
    const source = kind === "person"
      ? (cohort.transcript_evidence?.people || [])
      : (cohort.transcript_evidence?.teams || []);
    const key = kind === "person" ? "person_id" : "team_id";
    return source.find(item => String(item?.[key] || "") === String(recordId || "")) || null;
  }

  function cardSignalForRecord(recordId, kind) {
    const source = kind === "person"
      ? (cohort.cohort_intel?.card_signals?.people || [])
      : (cohort.cohort_intel?.card_signals?.teams || []);
    return source.find(item => String(item?.record_id || "") === String(recordId || "")) || null;
  }

  function signalRelatedLinks(signal) {
    const teamLinks = asArray(signal?.teams).slice(0, 3).map(id => {
      const team = teamById.get(id);
      return team ? teamTextLink(team, id) : "";
    }).filter(Boolean);
    const personLinks = asArray(signal?.people).slice(0, 2).map(id => {
      const person = personById.get(id);
      return person?.record_id
        ? `<a class="cd-text-link" href="#${escAttr(encodeURIComponent(person.record_id))}">${escHtml(person.name || person.record_id)}</a>`
        : "";
    }).filter(Boolean);
    const links = [...teamLinks, ...personLinks].slice(0, 4);
    return links.length ? `<span class="cic-signal-links">${links.join("<i>/</i>")}</span>` : "";
  }

  function renderCardSignal(signal) {
    if (!signal?.text) return "";
    const meta = [
      signal.specificity ? labelize(signal.specificity) : "",
      signal.evidence_card_count ? `${signal.evidence_card_count} source${signal.evidence_card_count === 1 ? "" : "s"}` : "",
      signal.confidence ? `${signal.confidence} confidence` : "",
      signal.review_status ? labelize(signal.review_status) : "",
    ].filter(Boolean);
    const sourceTitle = asArray(signal.source_card_ids).join(" / ") || signal.source_card || "transcript evidence signal";
    return `
      <div class="cic-signal" title="${escAttr(sourceTitle)}">
        <div class="cic-signal-head">
          <span>${escHtml(signal.label || labelize(signal.signal_type || "signal"))}</span>
          ${signal.week ? `<time>${escHtml(signal.week)}</time>` : ""}
        </div>
        <p>${escHtml(signal.text)}</p>
        <div class="cic-signal-meta">
          ${meta.map(item => `<span>${escHtml(item)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  function renderEvidenceClaimList(view) {
    const claims = asArray(view?.top_claims).slice(0, 5);
    if (!claims.length) return "";
    return `
      <ol class="cd-evidence-list">
        ${claims.map(claim => {
          const meta = [claim.claim_type, claim.evidence_level, claim.confidence]
            .filter(Boolean)
            .map(labelize)
            .join(" · ");
          return `
            <li>
              <p>${escHtml(claim.text || "")}</p>
              <span>${escHtml(meta || "transcript evidence")} · ${escHtml(claim.source_artifact_id || "evidence card")}</span>
            </li>
          `;
        }).join("")}
      </ol>
    `;
  }

  function renderTranscriptEvidence(recordId, kind) {
    const view = transcriptEvidenceView(recordId, kind);
    if (!view) return "";
    const stats = [
      `${asArray(view.evidence_card_ids).length} evidence source${asArray(view.evidence_card_ids).length === 1 ? "" : "s"}`,
      `${view.claim_count || asArray(view.top_claims).length} inferred claim${(view.claim_count || asArray(view.top_claims).length) === 1 ? "" : "s"}`,
      `${view.confidence || "low"} confidence`,
      `${view.sharing_boundary?.max_surface || "cohort"} · raw hidden`,
    ];
    const themes = asArray(view.themes).slice(0, 6);
    return `
      <div class="cd-evidence">
        <div class="cd-evidence-meta">${stats.map(item => `<span>${escHtml(item)}</span>`).join("")}</div>
        ${themes.length ? `<div class="cd-evidence-themes">${themes.map(theme => `<span>${escHtml(theme)}</span>`).join("")}</div>` : ""}
        ${renderEvidenceClaimList(view)}
        <p class="cd-evidence-note">${escHtml(view.source_note || "Compiled from generated transcript evidence cards, not raw transcript blobs.")}</p>
      </div>
    `;
  }

  function dependencyPairKey(source, target) {
    return `${String(source || "").toLowerCase()}>${String(target || "").toLowerCase()}`;
  }

  function renderRelationshipList(team) {
    const rid = String(team?.record_id || "");
    if (!rid) return "";
    const ridLower = rid.toLowerCase();
    const typed = dependencyRecords.filter(dep =>
      dep && (String(dep.source || "").toLowerCase() === ridLower || String(dep.target || "").toLowerCase() === ridLower)
    );
    const typedPairs = new Set(typed.map(dep => dependencyPairKey(dep.source, dep.target)));
    const rows = typed.map(dep => {
      const outgoing = String(dep.source || "").toLowerCase() === ridLower;
      const otherId = outgoing ? dep.target : dep.source;
      const other = teamById.get(otherId);
      const meta = [labelize(dep.relation || "relationship"), dep.status ? labelize(dep.status) : "", dep.confidence ? `${labelize(dep.confidence)} confidence` : ""]
        .filter(Boolean)
        .join(" · ");
      const evidence = asArray(dep.evidence);
      return `
        <li>
          <strong>${outgoing ? "to" : "from"} ${teamTextLink(other, otherId)}</strong>
          ${meta ? `<span>${escHtml(meta)}</span>` : ""}
          ${dep.reason ? `<p>${escHtml(dep.reason)}</p>` : ""}
          ${evidence.length ? `<ul>${evidence.slice(0, 3).map(item => `<li>${escHtml(item)}</li>`).join("")}</ul>` : ""}
          ${dep.next_action ? `<p><em>next:</em> ${escHtml(dep.next_action)}</p>` : ""}
        </li>
      `;
    });
    for (const targetId of asArray(team.dependencies)) {
      if (typedPairs.has(dependencyPairKey(rid, targetId))) continue;
      const target = teamById.get(targetId);
      rows.push(`
        <li>
          <strong>to ${teamTextLink(target, targetId)}</strong>
          <span>profile mention · declared link</span>
        </li>
      `);
    }
    if (!rows.length) return "";
    return `<ul class="cd-bullet-list cd-relationship-list">${rows.join("")}</ul>`;
  }

  function surfaceLinkAnchors(links = {}) {
    return compactCohortLinkItems({ links })
      .map(item => `<a href="${escAttr(item.href)}" target="_blank" rel="noopener noreferrer" title="${escAttr(item.display)}">${escHtml(item.label)}</a>`);
  }

  function renderSurfaceRoutes(rec, isPerson, team, members) {
    const rows = [];
    if (isPerson && team) {
      rows.push({
        label: "team",
        items: [`<a href="#${escAttr(encodeURIComponent(team.record_id))}">${escHtml(team.name || team.record_id)}</a>`],
      });
    }
    if (!isPerson && members.length) {
      const visible = members.slice(0, 2).map(member =>
        `<a href="#${escAttr(encodeURIComponent(member.record_id))}">${escHtml(member.name || member.record_id)}</a>`
      );
      if (members.length > visible.length) {
        visible.push(`<a href="#${escAttr(encodeURIComponent(rec.record_id))}">+${members.length - visible.length}</a>`);
      }
      rows.push({ label: teamKind(rec) === "project" ? "contributors" : "team", items: visible });
    }
    const links = surfaceLinkAnchors(rec.links || {});
    if (links.length) rows.push({ label: "links", items: links.slice(0, 4) });
    if (!rows.length) return "";
    return `
      <div class="cic-routes" aria-label="record routes">
        ${rows.map(row => `
          <div class="cic-route-line">
            <span>${escHtml(row.label)}</span>
            <p>${row.items.join('<i>, </i>')}</p>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderSurfaceCard(rec, idx, sourceName) {
    const isPerson = sourceName === "people";
    const shapeKind = isPerson ? "person" : teamKind(rec);
    const fam = shapeFamily(rec, isPerson ? "person" : "team");
    const idLabel = `${isPerson ? "person" : "shape"}-${String(idx + 1).padStart(2, "0")}`;
    const team = isPerson && rec.team ? teamById.get(rec.team) : null;
    const members = isPerson ? [] : teamPeopleFor(rec.record_id);
    const title = rec.name || rec.record_id;
    const subtitle = isPerson
      ? (team && rec.role
        ? `${team.name || team.record_id} · ${rec.role}`
        : (team?.name || rec.role || labelize(rec.role_class || "individual")))
      : (rec.focus || rec.record_id);
    const tags = isPerson
      ? [idLabel, labelize(rec.role_class || rec.role || "individual"), rec.domain ? domainLabel(rec.domain) : "", rec.geo].filter(Boolean)
      : [idLabel, shapeKind, rec.membership ? labelize(rec.membership) : "", rec.domain ? domainLabel(rec.domain) : "", rec.geo].filter(Boolean);
    const hints = isPerson
      ? [...asArray(rec.go_to_them_for).slice(0, 2), ...asArray(rec.recurring_themes).slice(0, 2)]
      : [...asArray(rec.skill_areas).slice(0, 2), ...asArray(rec.success_dimensions).slice(0, 1)];
    const routes = renderSurfaceRoutes(rec, isPerson, team, members);
    const signal = cardSignalForRecord(rec.record_id, isPerson ? "person" : "team");
    const card = document.createElement("article");
    card.className = `cohort-item-card ${isPerson ? "is-person" : `is-${shapeKind}`}`;
    card.dataset.recordId = rec.record_id || "";
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `${title} - open record`);
    card.innerHTML = `
      <div class="cic-head">
        <div class="cic-shape"><canvas data-shape-fam="${fam}" data-shape-kind="${escAttr(shapeKind)}" data-shape-seed="${escAttr(rec.record_id)}"></canvas></div>
        <div class="cic-title-block">
          <div class="cic-tag">${tags.map(tag => `<span>${escHtml(tag)}</span>`).join("<i>·</i>")}</div>
          <h3>${escHtml(title)}</h3>
          <p>${escHtml(subtitle)}</p>
        </div>
      </div>
      ${routes}
      ${renderCardSignal(signal)}
      ${compactPills(hints)}
    `;
    const open = () => {
      if (rec.record_id) location.hash = `#${encodeURIComponent(rec.record_id)}`;
    };
    card.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.target.closest("a")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    return card;
  }

  function renderGrid() {
    const chipSet = activeChipSet();
    if (!membershipNav) return;
    if (!chipSet.some(c => c.id === state.membership)) state.membership = DEFAULT_MEMBERSHIP;
    const source = state.kind === "people" ? people : teams;
    const counts = new Map(chipSet.map(c => [c.id, source.filter(c.match).length]));
    membershipNav.innerHTML = chipSet.map(chip => {
      const count = chip.id === "all"
        ? ""
        : ` <span class="cohort-chip-count">${counts.get(chip.id) || 0}</span>`;
      return `
        <button class="cohort-chip cohort-chip-membership" data-membership="${escAttr(chip.id)}" type="button" role="tab" aria-selected="${chip.id === state.membership}">${escHtml(chip.label)}${count}</button>
      `;
    }).join("");
    for (const btn of membershipNav.querySelectorAll(".cohort-chip[data-membership]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.membership === state.membership) return;
        state.membership = btn.dataset.membership;
        renderGrid();
      });
    }

    const active = chipSet.find(c => c.id === state.membership) || chipSet[0];
    const records = source.filter(active.match);
    if (insightBoard) {
      const insightHtml = renderCohortInsightBoard(records, active.label);
      insightBoard.innerHTML = insightHtml;
      insightBoard.hidden = !insightHtml.trim();
      wireInsightBoard();
    }
    grid.innerHTML = "";
    if (!records.length) {
      grid.innerHTML = `<p class="page-empty">no ${escHtml(active.label)} yet.</p>`;
    } else {
      records.forEach((rec, idx) => {
        try {
          const card = renderSurfaceCard(rec, idx, state.kind === "people" ? "people" : "teams");
          if (card instanceof Node) grid.appendChild(card);
        } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
      });
    }

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] shape mount failed:", e); }
    });
  }

  function renderKindFilter() {
    if (!countsEl) return;
    countsEl.innerHTML = `
      <button class="cohort-kind-count" data-kind="works" type="button" role="tab" aria-selected="${state.kind === "works"}"><span>${teams.length}</span> teams &amp; projects</button>
      <span class="cohort-kind-sep" aria-hidden="true">/</span>
      <button class="cohort-kind-count" data-kind="people" type="button" role="tab" aria-selected="${state.kind === "people"}"><span>${people.length}</span> individuals</button>
    `;
    countsEl.hidden = false;
    for (const btn of countsEl.querySelectorAll("button[data-kind]")) {
      btn.addEventListener("click", () => {
        const nextKind = btn.dataset.kind;
        const changed = nextKind !== state.kind;
        if (!changed && !state.detail) return;
        if (changed) {
          state.kind = nextKind;
          state.membership = DEFAULT_MEMBERSHIP;
        }
        renderKindFilter();
        if (location.hash) {
          location.hash = "";
          return;
        }
        renderGrid();
      });
    }
  }

  function renderPersonRail(rec, team, fam) {
    const dates = dateRange(rec.dates_start, rec.dates_end);
    return `
      <aside class="cd-rail">
        <div class="cd-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-seed="${escAttr(rec.record_id)}"></canvas></div>
        <div class="cd-rail-read">
          <span class="cd-rail-kicker">individual</span>
          <h2 class="cd-name">${escHtml(rec.name || rec.record_id)}</h2>
          ${rec.role ? `<p class="cd-focus">${escHtml(rec.role)}</p>` : ""}
          <div class="cd-rail-list">
            <div><span>status</span>${escHtml(labelize(rec.role_class || "person"))}</div>
            ${team ? `<div><span>team</span><a href="#${escAttr(encodeURIComponent(team.record_id))}">${escHtml(team.name || team.record_id)}</a></div>` : ""}
            ${rec.geo ? `<div><span>geo</span>${escHtml(rec.geo)}</div>` : ""}
            ${rec.domain ? `<div><span>domain</span>${escHtml(domainLabel(rec.domain))}</div>` : ""}
            ${dates ? `<div><span>window</span>${escHtml(dates)}</div>` : ""}
          </div>
        </div>
      </aside>
    `;
  }

  function renderTeamRail(rec, teamPeople, fam, kind) {
    const memberLinks = teamPeople.map(person => `
      <span class="cd-rail-member">
        <a href="#${escAttr(encodeURIComponent(person.record_id))}">${escHtml(person.name || person.record_id)}</a>${person.role ? ` <em>(${escHtml(person.role)})</em>` : ""}
      </span>
    `).join("");
    return `
      <aside class="cd-rail">
        <div class="cd-shape"><canvas data-shape-fam="${fam}" data-shape-kind="${escAttr(kind)}" data-shape-seed="${escAttr(rec.record_id)}"></canvas></div>
        <div class="cd-rail-read">
          <span class="cd-rail-kicker">${escHtml(kind)}</span>
          <h2 class="cd-name">${escHtml(rec.name || rec.record_id)}</h2>
          ${rec.focus ? `<p class="cd-focus">${escHtml(rec.focus)}</p>` : ""}
          <div class="cd-rail-list">
            ${rec.domain ? `<div><span>domain</span>${escHtml(domainLabel(rec.domain))}</div>` : ""}
            ${rec.geo ? `<div><span>geo</span>${escHtml(rec.geo)}</div>` : ""}
            ${memberLinks ? `<div><span>${kind === "project" ? "contributors" : "team"}</span><span class="cd-rail-members">${memberLinks}</span></div>` : ""}
            ${rec.membership ? `<div><span>status</span>${escHtml(labelize(rec.membership))}</div>` : ""}
          </div>
        </div>
      </aside>
    `;
  }

  function renderPersonDetail(rec, editUrl, fam) {
    const team = rec.team ? teamById.get(rec.team) : null;
    const secondary = asArray(rec.secondary_teams).map(id => teamById.get(id)).filter(Boolean);
    const timelineItems = cohort.person_timeline?.[rec.record_id] || [];
    const links = rec.links || {};
    const explore = renderQuickRow("explore", [
      quickLink("GitHub", linkForKey(links, "github")),
      quickLink("X", linkForKey(links, "x")),
      quickLink("Website", linkForKey(links, "website")),
      quickLink("LinkedIn", linkForKey(links, "linkedin")),
      quickLink("calendar", "/calendar", false),
      quickLink("availability", "/availability", false),
      quickLink("source", editUrl),
    ]);
    const askMeAbout = renderQuickRow("ask me about",
      asArray(rec.go_to_them_for).slice(0, 4).map(value => quickText("", value))
    );
    const themes = renderQuickRow("themes",
      asArray(rec.recurring_themes).slice(0, 4).map(value => quickText("", value))
    );
    const teamContext = team ? renderQuickRow("team context", [
      teamQuickLink(team),
      quickText("focus", team.focus),
    ]) : "";
    const bioSection = renderSection("about / bio", renderProse(rec.bio_md), true, "profile context");
    const currentRows = [
      renderRow("now", rec.now),
      renderRow("weekly intention", rec.weekly_intention),
    ];
    const workingRows = [
      renderRow("comm style", rec.comm_style),
      renderRow("availability", rec.availability_pref),
      renderRow("working style", rec.working_style),
      renderRow("best contexts", rec.best_contexts),
      renderRow("contributes", rec.contribute_interests),
      renderRow("seeking", rec.seeking),
      renderRow("offering", rec.offering),
    ];
    const routeRows = [
      secondary.length ? renderHtmlRow("also contributes", secondary.map(t => `<a class="cd-text-link" href="#${escAttr(encodeURIComponent(t.record_id))}">${escHtml(t.name || t.record_id)}</a>`).join(" ")) : "",
    ];
    const proofRead = renderProofRead(rec);
    const evidenceRead = renderTranscriptEvidence(rec.record_id, "person");

    return `
      ${renderPersonRail(rec, team, fam)}
      <section class="cd-ledger">
        <div class="cd-ledger-head">
          <span class="cd-h">individual read</span>
        </div>
        ${bioSection ? `<div class="cd-section-stack cd-priority-stack">${bioSection}</div>` : ""}
        <div class="cd-quick">${explore}${askMeAbout}${themes}${teamContext}</div>
        <div class="cd-section-stack">
          ${renderSection("current read", currentRows, !bioSection, "now, weekly intention")}
          ${renderSection("working with", workingRows, false, "style, availability, seeks")}
          ${renderSection("proof / prior work", proofRead, false, "shipping, lineage")}
          ${renderSection("distilled transcript evidence", evidenceRead, false, evidenceRead ? "claims, provenance, confidence" : "")}
          ${renderSection(`timeline · ${timelineItems.length}`, renderTimelineItems(timelineItems), false, timelinePreview(timelineItems))}
          ${renderSection("routes / asks", routeRows, false, "other teams, asks")}
        </div>
      </section>
    `;
  }

  function renderTeamDetail(rec, editUrl, fam, kind) {
    const teamPeople = teamPeopleFor(rec.record_id);
    const memberClusters = (cohort.clusters || []).filter(cl =>
      Array.isArray(cl.teams) && cl.teams.includes(rec.record_id)
    );
    const timelineItems = cohort.team_timeline?.[rec.record_id] || [];
    const links = rec.links || {};
    const journey = journeySummary(rec);
    const nextMove = renderQuickRow("next move", [
      quickText("", rec.now || journey?.next),
    ]);
    const needs = renderQuickRow("needs",
      asArray(rec.seeking).slice(0, 2).map(value => quickText("", value))
    );
    const provides = renderQuickRow("provides",
      asArray(rec.offering).slice(0, 2).map(value => quickText("", value))
    );
    const guild = renderQuickRow("guild",
      memberClusters.map(cl => quickText("", cl.label))
    );
    const trajectory = journey ? renderQuickRow("trajectory", [
      pill("stage", `${journey.stage} ${journey.stageLabel}`),
      pill("evidence", `${journey.evidence}/5${journey.evidenceLabel ? ` ${journey.evidenceLabel}` : ""}`),
      pill("upside", `${journey.upside}/5`),
      pill("bottleneck", journey.bottleneck),
      quickText("next", journey.next),
    ]) : "";
    const routes = renderQuickRow("routes / asks", [
      quickLink(`${rec.name || rec.record_id} cohort detail`, cohortDetailHref(rec.record_id), false),
    ]);
    const explore = renderQuickRow("explore", [
      quickLink("GitHub", linkForKey(links, "github")),
      quickLink("Repo", linkForKey(links, "repo")),
      quickLink("X", linkForKey(links, "x")),
      quickLink("Website", linkForKey(links, "website")),
      quickLink("Demo", linkForKey(links, "demo")),
      quickLink("Deck", linkForKey(links, "deck")),
      quickLink("source", editUrl),
    ]);
    const evidenceRows = [
      renderRow("traction", rec.traction),
      renderRow("paper basis", rec.paper_basis),
      renderRow("prior shipping", rec.prior_shipping),
      renderRow("hackathon note", rec.hackathon_note),
    ];
    const trajectoryRows = journey ? [
      renderRow("company type", journey.companyType),
      renderRow("confidence", journey.confidence),
      renderRow("icp", journey.icp),
      renderRow("problem", journey.problem),
      renderRow("solution", journey.solution),
      renderRow("evidence notes", journey.evidenceNotes),
      renderRow("next milestone", journey.next),
    ] : [];
    const relationshipBody = renderRelationshipList(rec);
    const evidenceRead = renderTranscriptEvidence(rec.record_id, "team");

    return `
      ${renderTeamRail(rec, teamPeople, fam, kind)}
      <section class="cd-ledger">
        <div class="cd-ledger-head">
          <span class="cd-h">${escHtml(kind)} read</span>
        </div>
        <div class="cd-quick cd-team-quick">${nextMove}${needs}${provides}${guild}${trajectory}${routes}${explore}</div>
        <div class="cd-section-stack">
          ${renderSection("trajectory", trajectoryRows, false, "stage, proof, next test")}
          ${renderSection("evidence", evidenceRows, false, "traction, paper, shipping")}
          ${renderSection("distilled transcript evidence", evidenceRead, false, evidenceRead ? "claims, provenance, confidence" : "")}
          ${renderSection("relationships", relationshipBody, false, "records, dependencies")}
          ${renderSection(`timeline · ${timelineItems.length}`, renderTimelineItems(timelineItems), false, timelinePreview(timelineItems))}
        </div>
      </section>
    `;
  }

  function renderDetail(rec) {
    const kind = recordKind(rec);
    const recordType = kind === "person" ? "person" : "team";
    const editUrl = recordSourceUrl(rec, kind);
    const shapeKind = kind === "person" ? "person" : teamKind(rec);
    const fam = shapeFamily(rec, kind);
    detailHost.innerHTML = `
      <header class="cd-bar">
        <a class="cd-back" href="#" aria-label="back to grid"><span aria-hidden="true">&lt;-</span> back</a>
        <div class="cd-tag">
          <span>${escHtml(String(rec.record_id || "").toUpperCase())}</span>
        </div>
        <div class="cd-actions">
          <button class="cd-edit" type="button" data-edit-toggle>edit details</button>
          <a class="cd-edit cd-edit-raw" href="${escAttr(editUrl)}" target="_blank" rel="noopener noreferrer">raw github</a>
        </div>
      </header>
      <article class="cd-dossier cd-dossier-${escAttr(kind)}">
        ${kind === "person"
          ? renderPersonDetail(rec, editUrl, fam)
          : renderTeamDetail(rec, editUrl, fam, shapeKind)}
      </article>
      <section class="cd-section cd-edit-panel" data-edit-panel hidden></section>
    `;

    detailHost.querySelector(".cd-back")?.addEventListener("click", (e) => {
      e.preventDefault();
      location.hash = "";
    });
    const editToggle = detailHost.querySelector("[data-edit-toggle]");
    const editPanel = detailHost.querySelector("[data-edit-panel]");
    let editController = null;
    editToggle?.addEventListener("click", () => {
      if (!editPanel) return;
      if (!editPanel.hidden) {
        editController?.destroy?.();
        editController = null;
        editPanel.hidden = true;
        editPanel.innerHTML = "";
        editToggle.textContent = "edit details";
        return;
      }
      editPanel.hidden = false;
      editPanel.innerHTML = `<h3 class="cd-h">edit ${escHtml(recordType === "team" ? shapeKind : "person")}</h3>`;
      const formMount = document.createElement("div");
      formMount.className = "cd-edit-form";
      editPanel.appendChild(formMount);
      editController = renderProfileForm({
        recordType,
        recordId: rec.record_id,
        initialData: rec,
        container: formMount,
      });
      editToggle.textContent = "hide editor";
      try { editPanel.scrollIntoView({ block: "start", behavior: "smooth" }); } catch {}
    });

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] detail shape mount failed:", e); }
    });
  }

  function syncFromHash() {
    const id = parseDetailHash();
    const rec = id ? findRecord(id) : null;
    state.detail = rec ? rec.record_id : null;
    if (rec) {
      const detailKind = recordKind(rec) === "person" ? "people" : "works";
      if (state.kind !== detailKind) {
        state.kind = detailKind;
        state.membership = DEFAULT_MEMBERSHIP;
        renderKindFilter();
      }
      pageHead?.classList.add("is-detail");
      browse.hidden = true;
      detailHost.hidden = false;
      renderDetail(rec);
      window.scrollTo({ top: 0, behavior: "auto" });
    } else {
      pageHead?.classList.remove("is-detail");
      detailHost.hidden = true;
      detailHost.innerHTML = "";
      browse.hidden = false;
      renderGrid();
    }
  }

  renderKindFilter();

  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
})();
