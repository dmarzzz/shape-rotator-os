// selectors.mjs — single source of truth for DOM selectors, mirroring
// apps/os/src/index.html. When the markup changes, change it here once.
//
// Selectors are stable IDs / data-attributes / ARIA roles already present in
// the shipping markup — we deliberately drive accessibility-instrumented
// affordances (role="tab", data-tab, aria-selected, aria-label) rather than
// brittle nth-child paths.

export const S = {
  // top-level chrome
  tabBar: "#tab-bar",
  tab: (name) => `#tab-bar .tab-btn[data-tab="${name}"]`,
  tabIndicator: "#tab-indicator",
  versionChip: "#fg-version-chip",
  atlasSearchToggle: "#atlas-search-toggle",

  // operating system (alchemy) view + its left rail
  alchemyView: "#alchemy-view",
  alchemyCanvas: "#alchemy-canvas",
  alchRailBtn: (mode) => `.alchemy-rail-btn[data-alch-mode="${mode}"]`,

  // apps tab + the two app cards
  appsGrid: "#apps-grid",
  appCard: (key) => `.app-card[data-app-key="${key}"]`,
  appsBack: "[data-apps-back]",

  // atlas app
  atlasView: "#atlas-view",
  atlasStage: "#atlas-stage",
  atlasEmpty: "#atlas-empty",
  atlasOffline: "#atlas-offline",
  atlasHelpToggle: "#atlas-help-toggle",
  atlasHelpPanel: "#atlas-help-panel",
  atlasRetry: "#ao-retry",

  // easel app
  easelView: "#easel-view",
  easelStage: "#easel-stage",

  // network tab
  networkSubtabs: "#network-subtabs",
  netSubtab: (sub) => `.net-subtab[data-net-sub="${sub}"]`,
  netModeBtn: (mode) => `.net-mode-btn[data-mode="${mode}"]`,
  glanceView: "#network-glance-view",
  networkView: "#network-view",
  netPeersList: "#net-peers-list",
  netPeersCount: "#net-peers-count",
  trafficChip: (filter) => `.traffic-chip[data-filter="${filter}"]`,
  trafficList: "#traffic-panel-list",

  // metrics sub-tab
  metricsView: "#metrics-view",
  metricsRangeBtn: (range) => `.metrics-range-btn[data-range="${range}"]`,
  metricsRefresh: "#metrics-refresh",
  metricsStatus: "#metrics-status",

  // sidebar (graph-only) controls
  sidebar: "#sidebar",
  lensSelect: "#lens-select",
  shapeSelect: "#shape-select",
  sourceChip: (src) => `.source-chip[data-source="${src}"]`,
  sidebarSearch: "#search",
  eventsPanelHead: "#events-panel-head",
  eventsPanel: "#events-panel",
  peerCountBtn: "#peer-count-btn",
  peersPanel: "#peers-panel",
  peersPanelClose: "#peers-panel-close",

  // search view (network search overlay)
  searchView: "#search-view",
  searchForm: "#search-form",
  searchInput: "#search-input",
  searchSubmit: "#search-submit",
  searchAskAgent: "#search-ask-agent",
  searchPolicy: "#search-policy",
  searchEgress: "#search-confirm-egress",
  searchTopK: "#search-topk",
  searchMeta: "#search-meta",
  searchStatus: "#search-status",
  searchResults: "#search-results",

  // swarm panel (ask my agent)
  swarmPanel: "#swarm-panel",
  swarmQuery: "#swarm-query",
  swarmModel: "#swarm-model",
  swarmStart: "#swarm-start-btn",
  swarmStop: "#swarm-stop-btn",
  swarmSettingsBtn: "#swarm-settings-btn",
  swarmSettings: "#swarm-settings",
  swarmSettingsClose: "#swarm-settings-close",
  swarmAnthropicKey: "#swarm-anthropic-key",
  swarmClose: "[data-swarm-close]",

  // command palette (Cmd/Ctrl+K) + keyboard overlay (?), created at runtime
  cmdBackdrop: ".ux-cmd-backdrop",
  cmdInput: ".ux-cmd-input",

  // links view
  linksView: "#links-view",
  linkCard: ".link-card",
};

// the four top tabs, in DOM order
export const TOP_TABS = ["alchemy", "apps", "network", "links"];

// alchemy rail modes wired in index.html (pulse is retired in the markup)
export const ALCHEMY_MODES = [
  "membrane",
  "shapes",
  "constellation",
  "collab",
  "calendar",
  "profile",
  "onboarding",
  "program",
  "asks",
  "context",
];
