import { SANITIZED_INTEL_DATA } from "./intel-data.js";
import { INTEL_SIGNALS } from "./intel-signals.js";

const state = {
  data: SANITIZED_INTEL_DATA,
  panel: "signals",
  query: "",
  dataQuery: "",
  dataType: "all",
  tier: "all",
  kind: "all",
  selectedSignalId: INTEL_SIGNALS[0]?.id || "",
  selectedEntityId: "",
};

const TIER_ORDER = ["grounded", "inferred", "speculative"];
const TIER_LABELS = {
  grounded: "Grounded",
  inferred: "Inferred",
  speculative: "Speculative",
};
const KIND_LABELS = {
  "catalytic-pairing": "Catalytic pairing",
  "hidden-teacher": "Hidden teacher",
  "cross-domain": "Cross-domain",
  centrality: "Centrality",
  "proxy-signal": "Proxy signal",
  "negative-space": "Negative space",
  convergence: "Convergence",
  "phase-shape": "Phase-shape",
  "multi-hop": "Multi-hop",
  "tension-map": "Tension map",
  "interpret-decision": "Decision read",
};
const KIND_DOTS = {
  person: "#7cc0c4",
  project: "#d8b25a",
  reference: "#9ccb78",
  pack: "#e08272",
  osint: "#b4a2d6",
  source: "#b4a2d6",
};

// Inline icons for the receipt copy control (replaces the "copy label" text).
const COPY_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function entityTitle(entity) {
  return entity?.displayTitle || entity?.title || entity?.id || "Untitled";
}

function entityType(entity) {
  return entity?.displayType || entity?.type || "Object";
}

function entitySubtitle(entity) {
  const subtitle = entity?.subtitle || "";
  if (/\b(?:corpus|status|graph)\//i.test(subtitle)) {
    return `${entityType(entity)} / audience-facing context`;
  }
  return subtitle || entity?.displayRole || entityType(entity);
}

function byId(data) {
  return new Map((data.entities || []).map((entity) => [entity.id, entity]));
}

function neighborsFor(data, selected) {
  if (!data || !selected) return [];
  const ids = new Set();
  for (const edge of data.edges || []) {
    if (edge.source === selected.id) ids.add(edge.target);
    if (edge.target === selected.id) ids.add(edge.source);
  }
  const entities = byId(data);
  return [...ids]
    .map((id) => entities.get(id))
    .filter(Boolean)
    .sort((a, b) => (b.coverage || 0) - (a.coverage || 0) || entityTitle(a).localeCompare(entityTitle(b)))
    .slice(0, 8);
}

function entitySignalCount(entityId) {
  return INTEL_SIGNALS.filter((signal) => (signal.entities || []).includes(entityId)).length;
}

function selectedSignalEntityIds(signal, data) {
  const entities = byId(data);
  return (signal?.entities || []).filter((id) => entities.has(id));
}

function entityMatchesQuery(entity, query, relatedSignals = []) {
  if (!query) return true;
  return [
    entity.id,
    entityTitle(entity),
    entityType(entity),
    entity.subtitle,
    entity.displayRole,
    ...(entity.surfaces || []),
    ...(entity.repos || []).map((repo) => `${repo.name} ${repo.status}`),
    ...relatedSignals.map((signal) => signal.title),
  ].join(" ").toLowerCase().includes(query);
}

function signalsForEntity(entityId) {
  return INTEL_SIGNALS.filter((signal) => (signal.entities || []).includes(entityId));
}

function signalMatches(signal) {
  const query = state.query.trim().toLowerCase();
  const tierOk = state.tier === "all" || signal.tier === state.tier;
  const kindOk = state.kind === "all" || signal.kind === state.kind;
  if (!tierOk || !kindOk) return false;
  if (!query) return true;
  return [
    signal.title,
    signal.claim,
    signal.shapeRotation,
    signal.coordinatorMove,
    signal.introduction,
    signal.watchFor,
    signal.limits,
    signal.kind,
    signal.tier,
    ...(signal.entities || []),
    ...(signal.displayEntities || []),
    ...(signal.sourceReceipts || []),
  ].join(" ").toLowerCase().includes(query);
}

function filteredSignals() {
  return INTEL_SIGNALS.filter(signalMatches);
}

function selectedSignal(signals) {
  if (!signals.some((signal) => signal.id === state.selectedSignalId)) {
    state.selectedSignalId = signals[0]?.id || INTEL_SIGNALS[0]?.id || "";
  }
  return signals.find((signal) => signal.id === state.selectedSignalId) || signals[0] || INTEL_SIGNALS[0] || null;
}

function signalEntities(signal, data) {
  const entities = byId(data);
  return (signal?.entities || []).map((id) => ({
    id,
    entity: entities.get(id),
  }));
}

function tierCounts() {
  return TIER_ORDER.reduce((acc, tier) => {
    acc[tier] = INTEL_SIGNALS.filter((signal) => signal.tier === tier).length;
    return acc;
  }, {});
}

function metricTiles(data) {
  if (state.panel === "data") {
    const entities = data.entities || [];
    const people = entities.filter((entity) => entity.type === "person").length;
    const projects = entities.filter((entity) => entity.type === "project").length;
    const publicRefs = entities.reduce((total, entity) =>
      total + (entity.surfaces?.length || 0) + (entity.repos?.length || 0), 0);
    const repos = entities.reduce((total, entity) => total + (entity.repos?.length || 0), 0);
    const metrics = [
      ["entities", entities.length],
      ["people", people],
      ["projects", projects],
      ["edges", data.edges?.length || 0],
      ["public refs", publicRefs],
      ["repo refs", repos],
    ];
    return metrics.map(([label, value]) => `
      <div class="intel-metric">
        <strong>${esc(value ?? "—")}</strong>
        <span>${esc(label)}</span>
      </div>
    `).join("");
  }

  const counts = tierCounts();
  const actorCount = new Set(INTEL_SIGNALS.flatMap((signal) => signal.displayEntities || signal.entities || [])).size;
  const receiptCount = new Set(INTEL_SIGNALS.flatMap((signal) => signal.sourceReceipts || [])).size;
  const metrics = [
    ["moves", INTEL_SIGNALS.length],
    ["grounded", counts.grounded],
    ["inferred", counts.inferred],
    ["speculative", counts.speculative],
    ["actors", actorCount],
    ["public receipts", receiptCount],
  ];
  return metrics.map(([label, value]) => `
    <div class="intel-metric">
      <strong>${esc(value ?? "—")}</strong>
      <span>${esc(label)}</span>
    </div>
  `).join("");
}

function renderTierBadge(tier) {
  return `<span class="intel-signal-tier intel-signal-tier--${esc(tier)}">
    <span></span>${esc(TIER_LABELS[tier] || tier)}
  </span>`;
}

function renderFilters() {
  const kinds = [...new Set(INTEL_SIGNALS.map((signal) => signal.kind))];
  return `
    <div class="intel-search">
      <input type="search" data-intel-query aria-label="Filter signals by title, entity, kind, or public receipt" placeholder="filter signals, entities, public receipts" value="${esc(state.query)}" />
      <div class="intel-filter-row" role="group" aria-label="signal tier filter">
        ${["all", ...TIER_ORDER].map((tier) => `
          <button type="button" data-intel-tier="${esc(tier)}" class="${state.tier === tier ? "is-active" : ""}">
            ${esc(tier === "all" ? "all tiers" : TIER_LABELS[tier] || tier)}
          </button>
        `).join("")}
      </div>
      <div class="intel-filter-row" role="group" aria-label="signal kind filter">
        ${["all", ...kinds].map((kind) => `
          <button type="button" data-intel-kind="${esc(kind)}" class="${state.kind === kind ? "is-active" : ""}">
            ${esc(kind === "all" ? "all kinds" : KIND_LABELS[kind] || kind)}
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSignalList(signals, data) {
  if (!signals.length) return `<p class="intel-empty">No signals match this filter.</p>`;
  const entities = byId(data);
  return signals.map((signal, index) => {
    const active = signal.id === state.selectedSignalId ? " is-selected" : "";
    const names = (signal.displayEntities || signal.entities || [])
      .slice(0, 4)
      .map((id) => entities.has(id) ? entityTitle(entities.get(id)) : id)
      .join(", ");
    return `
      <button class="intel-signal-row${active}" type="button" data-intel-signal="${esc(signal.id)}">
        <span class="intel-signal-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="intel-signal-row-main">
          <span class="intel-signal-row-meta">
            ${renderTierBadge(signal.tier)}
            <span>${esc(KIND_LABELS[signal.kind] || signal.kind)}</span>
          </span>
          <strong>${esc(signal.title)}</strong>
          <small>${esc(names || "No mapped entities")}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderDataFilters(data) {
  const types = ["all", ...[...new Set((data.entities || []).map((entity) => entity.type))].sort()];
  return `
    <div class="intel-search">
      <input type="search" data-intel-data-query aria-label="Filter data entities by person, project, surface, public reference, or linked signal" placeholder="filter people, projects, surfaces, public refs" value="${esc(state.dataQuery)}" />
      <div class="intel-filter-row" role="group" aria-label="data type filter">
        ${types.map((type) => `
          <button type="button" data-intel-data-type="${esc(type)}" class="${state.dataType === type ? "is-active" : ""}">
            ${esc(type === "all" ? "all data" : type)}
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function filteredDataEntities(data, signal) {
  const query = state.dataQuery.trim().toLowerCase();
  const scoped = new Set(selectedSignalEntityIds(signal, data));
  return (data.entities || [])
    .filter((entity) => state.dataType === "all" || entity.type === state.dataType)
    .filter((entity) => entityMatchesQuery(entity, query, signalsForEntity(entity.id)))
    .sort((a, b) => {
      const aScoped = scoped.has(a.id) ? 1 : 0;
      const bScoped = scoped.has(b.id) ? 1 : 0;
      return bScoped - aScoped
        || entitySignalCount(b.id) - entitySignalCount(a.id)
        || (b.coverage || 0) - (a.coverage || 0)
        || (b.neighborCount || 0) - (a.neighborCount || 0)
        || entityTitle(a).localeCompare(entityTitle(b));
    });
}

function selectedDataEntity(data, signal, entities) {
  const allEntities = byId(data);
  if (state.selectedEntityId && allEntities.has(state.selectedEntityId)) {
    const visible = entities.some((entity) => entity.id === state.selectedEntityId);
    if (visible) return allEntities.get(state.selectedEntityId);
  }

  const firstSignalEntity = selectedSignalEntityIds(signal, data)[0];
  const fallback = entities[0]?.id || firstSignalEntity || data.defaultId || data.entities?.[0]?.id || "";
  state.selectedEntityId = fallback;
  return allEntities.get(fallback) || null;
}

function renderDataEntityList(entities, signal, data) {
  if (!entities.length) return `<p class="intel-empty">No data entities match this filter.</p>`;
  const scoped = new Set(selectedSignalEntityIds(signal, data));
  return entities.map((entity) => {
    const active = entity.id === state.selectedEntityId ? " is-selected" : "";
    const inSignal = scoped.has(entity.id) ? " is-signal-linked" : "";
    const dot = KIND_DOTS[entity.type] || KIND_DOTS.source;
    const linkedSignals = entitySignalCount(entity.id);
    return `
      <button class="intel-entity${active}${inSignal}" type="button" data-intel-entity="${esc(entity.id)}">
        <span class="intel-entity-dot" style="--dot:${esc(dot)}"></span>
        <span class="intel-entity-main">
          <strong>${esc(entityTitle(entity))}</strong>
          <small>${esc(entitySubtitle(entity))}</small>
          <small>${esc(entityType(entity))}${linkedSignals ? ` · ${esc(linkedSignals)} linked signal${linkedSignals === 1 ? "" : "s"}` : ""}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderChain(chain) {
  return `
    <ol class="intel-chain">
      ${(chain || []).map((step, index) => {
        const conclusion = index === chain.length - 1 || /^\s*therefore\b/i.test(step);
        const body = String(step).replace(/^\s*therefore[\s,:]*/i, "");
        return `
          <li class="${conclusion ? "is-conclusion" : ""}">
            <span>${conclusion ? "∴" : index + 1}</span>
            <p>${conclusion ? `<strong>therefore</strong> ` : ""}${esc(body)}</p>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function renderEntityPills(signal, data) {
  return signalEntities(signal, data).map(({ id, entity }) => {
    const dot = KIND_DOTS[entity?.type] || KIND_DOTS.source;
    return `
      <span class="intel-entity-pill">
        <span style="--dot:${esc(dot)}"></span>
        ${esc(entity ? entityTitle(entity) : id)}
      </span>
    `;
  }).join("");
}

function renderDisplayEntityPills(signal, data) {
  if (!signal.displayEntities?.length) return renderEntityPills(signal, data);
  const entities = byId(data);
  return signal.displayEntities.map((label) => {
    const entity = entities.get(label);
    const dot = KIND_DOTS[entity?.type] || KIND_DOTS.source;
    return `
      <span class="intel-entity-pill">
        <span style="--dot:${esc(dot)}"></span>
        ${esc(entity ? entityTitle(entity) : label)}
      </span>
    `;
  }).join("");
}

function renderSourceReceipts(paths) {
  if (!paths?.length) return `<p class="intel-muted">No public receipts attached.</p>`;
  return paths.map((path) => `
    <div class="intel-path-row">
      <code>${esc(path)}</code>
      <button type="button" class="intel-copy-btn" data-intel-copy="${esc(path)}" aria-label="Copy ${esc(path)}" title="Copy">${COPY_ICON}</button>
    </div>
  `).join("");
}

function renderBriefingField(label, value, tone = "") {
  if (!value) return "";
  return `
    <div class="intel-brief-field${tone ? ` intel-brief-field--${esc(tone)}` : ""}">
      <span>${esc(label)}</span>
      <p>${esc(value)}</p>
    </div>
  `;
}

function renderSignalDetail(signal, data) {
  if (!signal) return `<section class="intel-signal-detail"><p class="intel-empty">No signal selected.</p></section>`;
  return `
    <section class="intel-signal-detail intel-signal-detail--${esc(signal.tier)}">
      <header class="intel-signal-head">
        <div>
          <div class="intel-card-meta">
            ${renderTierBadge(signal.tier)}
            <span class="intel-lens">${esc(KIND_LABELS[signal.kind] || signal.kind)}</span>
          </div>
          <h2>${esc(signal.title)}</h2>
          <p>${esc(signal.claim)}</p>
        </div>
      </header>
      <div class="intel-signal-entities">${renderDisplayEntityPills(signal, data)}</div>
      <section class="intel-brief-grid">
        ${renderBriefingField("shape rotation", signal.shapeRotation, "rotation")}
        ${renderBriefingField("room to stage", signal.introduction, "room")}
      </section>
      <section>
        <h3>Reasoning chain</h3>
        ${renderChain(signal.chain || [])}
      </section>
      <footer class="intel-signal-foot">
        <div>
          <span>cohort move</span>
          ${esc(signal.coordinatorMove || signal.whyItMatters)}
        </div>
        <div>
          <span>watch for</span>
          ${esc(signal.watchFor || signal.whatWouldConfirm)}
        </div>
      </footer>
      ${renderBriefingField("limits", signal.limits, "limits")}
      <section class="intel-source-section">
        <h3>Public receipts</h3>
        ${renderSourceReceipts(signal.sourceReceipts || [])}
      </section>
    </section>
  `;
}

function publicRefs(entity) {
  const surfaces = (entity?.surfaces || []).map((surface) => `<span class="intel-pill">${esc(surface)}</span>`);
  const repos = (entity?.repos || []).map((repo) => `<span class="intel-pill">${esc(repo.name || repo.id || "repo")}</span>`);
  return [...surfaces, ...repos].join("");
}

function renderEntityContext(signal, data) {
  const items = signalEntities(signal, data).filter(({ entity }) => entity);
  if (!items.length) return `<aside class="intel-context"><p class="intel-empty">No mapped public entities for this signal.</p></aside>`;
  return `
    <aside class="intel-context">
      <div class="intel-section-head">
        <h3>Mapped context</h3>
      </div>
      ${items.map(({ entity }) => {
        const neighbors = neighborsFor(data, entity);
        return `
          <article class="intel-context-item">
            <p class="intel-kicker">${esc(entityType(entity))}</p>
            <h4>${esc(entityTitle(entity))}</h4>
            <p>${esc(entitySubtitle(entity))}</p>
            <div class="intel-source-mix">${publicRefs(entity) || `<span class="intel-pill">public refs pending</span>`}</div>
            <div class="intel-context-neighbors">
              ${neighbors.slice(0, 4).map((neighbor) => `<span>${esc(entityTitle(neighbor))}</span>`).join("") || `<span>no visible neighbors</span>`}
            </div>
          </article>
        `;
      }).join("")}
    </aside>
  `;
}

function renderRepoReceipts(entity) {
  if (!entity?.repos?.length) return `<p class="intel-muted">No public repo receipt attached in this export.</p>`;
  return `
    <div class="intel-repo-list">
      ${entity.repos.map((repo) => `
        <div class="intel-repo-row">
          <strong>${esc(repo.name || repo.id || "repo")}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderRelationSummary(entity) {
  const relations = entity?.displayRelations || {};
  const entries = Object.entries(relations);
  if (!entries.length) return `<span class="intel-pill">relation map pending</span>`;
  return entries.map(([label, count]) => `<span class="intel-pill"><strong>${esc(count)}</strong> ${esc(label)}</span>`).join("");
}

function renderDataInspector(entity, data) {
  if (!entity) return `<section class="intel-inspector"><p class="intel-empty">No entity selected.</p></section>`;
  const neighbors = neighborsFor(data, entity);
  const linkedSignals = signalsForEntity(entity.id);
  return `
    <section class="intel-inspector intel-data-inspector">
      <header class="intel-inspector-head">
        <div>
          <p class="intel-kicker">${esc(entityType(entity))}</p>
          <h2>${esc(entityTitle(entity))}</h2>
          <p>${esc(entitySubtitle(entity))}</p>
        </div>
      </header>

      <div class="intel-data-stat-grid">
        <div><strong>${esc(entity.coverage || 0)}</strong><span>coverage</span></div>
        <div><strong>${esc((entity.surfaces?.length || 0) + (entity.repos?.length || 0))}</strong><span>public refs</span></div>
        <div><strong>${esc(entity.neighborCount || neighbors.length || 0)}</strong><span>neighbors</span></div>
        <div><strong>${esc(linkedSignals.length)}</strong><span>signals</span></div>
      </div>

      <section>
        <h3>Public references</h3>
        <div class="intel-source-mix">${publicRefs(entity) || `<span class="intel-pill">public refs pending</span>`}</div>
      </section>

      <section>
        <h3>Relationship shape</h3>
        <div class="intel-source-mix">${renderRelationSummary(entity)}</div>
      </section>

      <section>
        <h3>Repo receipts</h3>
        ${renderRepoReceipts(entity)}
      </section>

      <section>
        <h3>Nearest mapped entities</h3>
        <div class="intel-neighbors">
          ${neighbors.map((neighbor) => `
            <button class="intel-neighbor" type="button" data-intel-entity="${esc(neighbor.id)}">
              <span>${esc(entityTitle(neighbor))}</span>
              <span class="intel-neighbor-type">${esc(entityType(neighbor))}</span>
            </button>
          `).join("") || `<p class="intel-muted">No neighbors in the public-safe graph export.</p>`}
        </div>
      </section>
    </section>
  `;
}

function renderSignalGrounding(signal, entity, data) {
  const linkedSignals = entity ? signalsForEntity(entity.id) : [];
  return `
    <aside class="intel-context intel-grounding">
      <div class="intel-section-head">
        <h3>Signal grounding</h3>
      </div>
      ${signal ? `
        <article class="intel-context-item intel-grounding-signal">
          <p class="intel-kicker">${esc(KIND_LABELS[signal.kind] || signal.kind)}</p>
          <h4>${esc(signal.title)}</h4>
          <p>${esc(signal.coordinatorMove)}</p>
          <button type="button" data-intel-open-signal="${esc(signal.id)}">open signal</button>
        </article>
        <section>
          <h3>Public receipts</h3>
          ${renderSourceReceipts(signal.sourceReceipts || [])}
        </section>
      ` : `<p class="intel-empty">No signal selected.</p>`}

      <section>
        <h3>Related signals for selected entity</h3>
        <div class="intel-related-signals">
          ${linkedSignals.filter((related) => related.id !== signal?.id).map((related) => `
            <button type="button" data-intel-open-signal="${esc(related.id)}">
              <span>${esc(KIND_LABELS[related.kind] || related.kind)}</span>
              <strong>${esc(related.title)}</strong>
            </button>
          `).join("") || `<p class="intel-muted">No other signals reference this entity yet.</p>`}
        </div>
      </section>
    </aside>
  `;
}

function renderSignalsPanel(data, signal, signals) {
  return `
    <section class="intel-layout intel-layout--signals">
      <aside class="intel-sidebar">
        ${renderFilters()}
        <div class="intel-list-head">
          <span>${signals.length} visible signals</span>
          <button type="button" data-intel-reset>reset</button>
        </div>
        <div class="intel-list intel-signal-list">${renderSignalList(signals, data)}</div>
      </aside>
      <main class="intel-main intel-main--signals">
        ${renderSignalDetail(signal, data)}
        ${renderEntityContext(signal, data)}
      </main>
    </section>
  `;
}

function renderDataPanel(data, signal) {
  const entities = filteredDataEntities(data, signal);
  const entity = selectedDataEntity(data, signal, entities);
  return `
    <section class="intel-layout intel-layout--data">
      <aside class="intel-sidebar">
        ${renderDataFilters(data)}
        <div class="intel-list-head">
          <span>${entities.length} visible entities</span>
          <button type="button" data-intel-data-reset>reset</button>
        </div>
        <div class="intel-list intel-data-list">${renderDataEntityList(entities, signal, data)}</div>
      </aside>
      <main class="intel-main intel-main--data">
        ${renderDataInspector(entity, data)}
        ${renderSignalGrounding(signal, entity, data)}
      </main>
    </section>
  `;
}

// ─── embedded shell ───────────────────────────────────────────────────
// Intel renders inside the OS context page (2026-06): the context page
// owns the header and the articles/transcripts/signals/data view nav;
// this module renders just the metrics + active panel into a host node.
function renderShell(container, data) {
  const signals = filteredSignals();
  const signal = selectedSignal(signals);
  container.innerHTML = `
    <section class="intel-panel intel-panel--embedded">
      <div class="intel-metrics">${metricTiles(data)}</div>
      ${state.panel === "data" ? renderDataPanel(data, signal) : renderSignalsPanel(data, signal, signals)}
    </section>
  `;
}

// Host-page hooks — lets the context page keep its view nav in sync when
// an intel cross-link switches panels (e.g. data → "open signal").
let embedHooks = null;

export function renderIntelEmbedded(container, panel) {
  if (!container) return;
  if (panel === "signals" || panel === "data") state.panel = panel;
  renderShell(container, state.data);
}

// Snapshot meta for the host page's header (date + counts for the nav).
export function intelSnapshotMeta() {
  const data = state.data || {};
  return {
    generated: (data.statusGeneratedAt || data.generatedAt || "").slice(0, 10),
    signals: INTEL_SIGNALS.length,
    entities: (data.entities || []).length,
  };
}

function rerender(container, { focusQuery = false } = {}) {
  renderShell(container, state.data);
  wireIntel(container);
  if (focusQuery) {
    const input = container.querySelector(state.panel === "data" ? "[data-intel-data-query]" : "[data-intel-query]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

export function wireIntelEmbedded(container, hooks = null) {
  if (hooks) embedHooks = hooks;
  wireIntel(container);
}

function wireIntel(container) {
  if (!container) return;
  const query = container.querySelector("[data-intel-query]");
  if (query) {
    query.addEventListener("input", () => {
      state.query = query.value || "";
      rerender(container, { focusQuery: true });
    });
  }
  const dataQuery = container.querySelector("[data-intel-data-query]");
  if (dataQuery) {
    dataQuery.addEventListener("input", () => {
      state.dataQuery = dataQuery.value || "";
      rerender(container, { focusQuery: true });
    });
  }
  for (const button of container.querySelectorAll("[data-intel-tier]")) {
    button.addEventListener("click", () => {
      state.tier = button.dataset.intelTier || "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-kind]")) {
    button.addEventListener("click", () => {
      state.kind = button.dataset.intelKind || "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-signal]")) {
    button.addEventListener("click", () => {
      state.selectedSignalId = button.dataset.intelSignal || "";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-entity]")) {
    button.addEventListener("click", () => {
      state.selectedEntityId = button.dataset.intelEntity || "";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-data-type]")) {
    button.addEventListener("click", () => {
      state.dataType = button.dataset.intelDataType || "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-open-signal]")) {
    button.addEventListener("click", () => {
      state.selectedSignalId = button.dataset.intelOpenSignal || state.selectedSignalId;
      state.panel = "signals";
      // Panel jumped — let the host page move its view nav with us. The
      // host re-renders this module, so skip the local repaint then.
      if (embedHooks?.onPanelChange) embedHooks.onPanelChange("signals");
      else rerender(container);
    });
  }
  const reset = container.querySelector("[data-intel-reset]");
  if (reset) {
    reset.addEventListener("click", () => {
      state.query = "";
      state.tier = "all";
      state.kind = "all";
      state.selectedSignalId = INTEL_SIGNALS[0]?.id || "";
      rerender(container);
    });
  }
  const dataReset = container.querySelector("[data-intel-data-reset]");
  if (dataReset) {
    dataReset.addEventListener("click", () => {
      state.dataQuery = "";
      state.dataType = "all";
      state.selectedEntityId = selectedSignalEntityIds(selectedSignal(INTEL_SIGNALS), state.data)[0] || "";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-copy]")) {
    button.addEventListener("click", async () => {
      const text = button.dataset.intelCopy || "";
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("is-copied");
        button.innerHTML = CHECK_ICON;
        setTimeout(() => {
          button.classList.remove("is-copied");
          button.innerHTML = COPY_ICON;
        }, 900);
      } catch {
        // Clipboard blocked — leave the copy icon in place, nothing to confirm.
      }
    });
  }
}
