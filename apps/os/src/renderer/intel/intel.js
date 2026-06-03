import { SANITIZED_INTEL_DATA } from "./intel-data.js";
import { INTEL_SIGNALS } from "./intel-signals.js";

const state = {
  data: SANITIZED_INTEL_DATA,
  query: "",
  tier: "all",
  kind: "all",
  selectedSignalId: INTEL_SIGNALS[0]?.id || "",
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
  transcript: "#9ccb78",
  pack: "#e08272",
  osint: "#b4a2d6",
  source: "#b4a2d6",
};

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

function metricTiles() {
  const counts = tierCounts();
  const actorCount = new Set(INTEL_SIGNALS.flatMap((signal) => signal.displayEntities || signal.entities || [])).size;
  const receiptCount = new Set(INTEL_SIGNALS.flatMap((signal) => signal.sourceReceipts || [])).size;
  const metrics = [
    ["moves", INTEL_SIGNALS.length],
    ["grounded", counts.grounded],
    ["inferred", counts.inferred],
    ["speculative", counts.speculative],
    ["actors", actorCount],
    ["receipts", receiptCount],
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
      <input type="search" data-intel-query aria-label="Filter signals by title, entity, kind, or evidence receipt" placeholder="filter signals, entities, receipts" value="${esc(state.query)}" />
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
  if (!paths?.length) return `<p class="intel-muted">No source receipts attached.</p>`;
  return paths.map((path) => `
    <div class="intel-path-row">
      <code>${esc(path)}</code>
      <button type="button" data-intel-copy="${esc(path)}">copy receipt</button>
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
          <span>coordinator move</span>
          ${esc(signal.coordinatorMove || signal.whyItMatters)}
        </div>
        <div>
          <span>watch for</span>
          ${esc(signal.watchFor || signal.whatWouldConfirm)}
        </div>
      </footer>
      ${renderBriefingField("limits", signal.limits, "limits")}
      <section class="intel-source-section">
        <h3>Evidence receipts</h3>
        ${renderSourceReceipts(signal.sourceReceipts || [])}
      </section>
    </section>
  `;
}

function sourceMix(entity) {
  return (entity?.sourceMix || []).map((item) =>
    `<span class="intel-pill"><strong>${esc(item.count)}</strong> ${esc(item.label)}</span>`
  ).join("");
}

function renderEntityContext(signal, data) {
  const items = signalEntities(signal, data).filter(({ entity }) => entity);
  if (!items.length) return `<aside class="intel-context"><p class="intel-empty">No mapped public entities for this signal.</p></aside>`;
  return `
    <aside class="intel-context">
      <div class="intel-section-head">
        <h3>Mapped context</h3>
        <p>supporting receipts</p>
      </div>
      ${items.map(({ entity }) => {
        const neighbors = neighborsFor(data, entity);
        return `
          <article class="intel-context-item">
            <p class="intel-kicker">${esc(entityType(entity))}</p>
            <h4>${esc(entityTitle(entity))}</h4>
            <p>${esc(entity.subtitle || entity.path || entity.id)}</p>
            <div class="intel-source-mix">${sourceMix(entity) || `<span class="intel-pill">source mix pending</span>`}</div>
            <div class="intel-context-neighbors">
              ${neighbors.slice(0, 4).map((neighbor) => `<span>${esc(entityTitle(neighbor))}</span>`).join("") || `<span>no visible neighbors</span>`}
            </div>
          </article>
        `;
      }).join("")}
    </aside>
  `;
}

function renderShell(container, data) {
  const signals = filteredSignals();
  const signal = selectedSignal(signals);
  const generatedDate = (data.statusGeneratedAt || data.generatedAt || "").slice(0, 10);
  container.innerHTML = `
    <section class="intel-panel">
      <header class="intel-hero">
        <div>
          <p class="intel-kicker">Shape Rotator Intelligence Vault</p>
          <h1>Intel</h1>
          <p>Coordinator moves from the vault's cognitive lens layer. ${esc(INTEL_SIGNALS.length)} compressed reads; corpus packs remain truth.</p>
        </div>
        <div class="intel-hero-note">
          <span>snapshot ${esc(generatedDate || "unknown")}</span>
          <span>curated preview · coordinator-facing</span>
        </div>
      </header>
      <div class="intel-metrics">${metricTiles()}</div>
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
    </section>
  `;
}

export function renderIntel(container) {
  if (!container) return;
  renderShell(container, state.data);
}

function rerender(container, { focusQuery = false } = {}) {
  renderIntel(container);
  wireIntel(container);
  if (focusQuery) {
    const input = container.querySelector("[data-intel-query]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

export function wireIntel(container) {
  if (!container) return;
  const query = container.querySelector("[data-intel-query]");
  if (query) {
    query.addEventListener("input", () => {
      state.query = query.value || "";
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
  for (const button of container.querySelectorAll("[data-intel-copy]")) {
    button.addEventListener("click", async () => {
      const text = button.dataset.intelCopy || "";
      const old = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "copied";
      } catch {
        button.textContent = "copy failed";
      } finally {
        setTimeout(() => { button.textContent = old; }, 900);
      }
    });
  }
}
