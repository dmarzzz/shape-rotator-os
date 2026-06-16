import { loadStylesheetOnce } from "./stylesheet-loader.js";

const LS_KEY = "sros.net-view-mode";
const SEARCH_HISTORY_MAX = 500;
const GLANCE_HUES = [
  "var(--gpeer-sage)",
  "var(--gpeer-ochre)",
  "var(--gpeer-azure)",
  "var(--gpeer-plum)",
  "var(--gpeer-teal)",
  "var(--gpeer-amber)",
  "var(--gpeer-violet)",
  "var(--gpeer-moss)",
  "var(--gpeer-rose)",
];

let srwk = null;
let setIntervalVisibleRef = null;
let initialized = false;
let refreshTimerStarted = false;
let searchListenerAttached = false;
let stylesPromise = null;

const searchHistory = [];

function currentState() {
  return srwk || window.srwk || {
    peers: new Map(),
    liveSeen: new Map(),
    nodes: [],
    recentEvents: [],
  };
}

function ensureStyles() {
  if (!stylesPromise) stylesPromise = loadStylesheetOnce("renderer/network-glance.css");
  return stylesPromise;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function clear(el) {
  if (el) el.replaceChildren();
}

function escapeHtmlSafe(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function eventTsMs(event) {
  const raw = event?.ts ?? event?.ts_ms ?? event?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function recordSearch(tsMs) {
  searchHistory.push({ ts: tsMs });
  if (searchHistory.length > SEARCH_HISTORY_MAX) searchHistory.shift();
}

function maybeAttachSearchListener() {
  if (searchListenerAttached) return;
  const state = currentState();
  const es = state.eventSource;
  if (!es || typeof es.addEventListener !== "function") return;
  const handler = () => recordSearch(Date.now());
  try {
    es.addEventListener("web_search_completed", handler);
    es.addEventListener("web_search_started", handler);
    searchListenerAttached = true;
  } catch {}
}

function peersList() {
  const state = currentState();
  if (state.peers instanceof Map) return [...state.peers.values()].filter(Boolean);
  if (Array.isArray(state.peers)) return state.peers.filter(Boolean);
  return [];
}

function peerByPubkey(pubkey) {
  const state = currentState();
  if (!pubkey || !(state.peers instanceof Map)) return null;
  return state.peers.get(pubkey) || null;
}

function nodeList() {
  const nodes = currentState().nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function recentEvents() {
  const events = currentState().recentEvents;
  return Array.isArray(events) ? events : [];
}

function peerStateFor(peer, nowMs = performance.now()) {
  const state = currentState();
  if (peer?.pubkey && peer.pubkey === state.selfPubkey) return "live";
  const liveSeen = state.liveSeen;
  const lastSeen = liveSeen instanceof Map ? liveSeen.get(peer?.pubkey) : null;
  const ageMs = lastSeen != null ? (performance.now() - lastSeen) : Infinity;
  if (ageMs < 60_000) return "live";
  if (ageMs < 6 * 3600_000) return "recent";
  if (peer?.last_seen_at) {
    const parsed = Date.parse(peer.last_seen_at);
    if (Number.isFinite(parsed)) {
      const wallAge = Date.now() - parsed;
      if (wallAge < 60_000) return "live";
      if (wallAge < 6 * 3600_000) return "recent";
    }
  }
  return "offline";
}

function peerHue(pubkey, idx = 0) {
  const state = currentState();
  if (pubkey && pubkey === state.selfPubkey) return "var(--gpeer-self)";
  if (!pubkey) return GLANCE_HUES[idx % GLANCE_HUES.length];
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  return GLANCE_HUES[Math.abs(hash) % GLANCE_HUES.length];
}

function fmtRelative(deltaMs) {
  if (deltaMs == null || !Number.isFinite(deltaMs)) return "-";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function lastSeenMs(peer) {
  const state = currentState();
  const liveSeen = state.liveSeen;
  const sse = liveSeen instanceof Map ? liveSeen.get(peer?.pubkey) : null;
  if (sse != null) return performance.now() - sse;
  if (peer?.last_seen_at) {
    const parsed = Date.parse(peer.last_seen_at);
    if (Number.isFinite(parsed)) return Date.now() - parsed;
  }
  return null;
}

function pageCountFor(pubkey) {
  if (!pubkey) return 0;
  let count = 0;
  for (const node of nodeList()) {
    if (node?.primary_contributor === pubkey) count++;
  }
  return count;
}

function renderGlanceHero() {
  const peers = peersList();
  const now = performance.now();
  const live = peers.filter((peer) => peerStateFor(peer, now) === "live").length;
  const total = peers.length;

  setText("glance-state-line", `${live} live · ${total} reachable`);

  const prefix = document.getElementById("glance-headline-prefix");
  const emphasis = document.getElementById("glance-headline-emphasis");
  if (!prefix || !emphasis) return;
  if (live <= 1) {
    prefix.textContent = "You're the only one";
    emphasis.textContent = "here right now.";
    return;
  }
  if (live === 2) {
    prefix.textContent = "Two of us are";
    emphasis.textContent = "here right now.";
    return;
  }
  const names = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  prefix.textContent = `${live <= 10 ? names[live] : live} of us are`;
  emphasis.textContent = "here right now.";
}

function renderGlanceNumbers() {
  const state = currentState();
  const peers = peersList();
  const now = performance.now();
  const live = peers.filter((peer) => peerStateFor(peer, now) === "live").length;
  const recent = peers.filter((peer) => peerStateFor(peer, now) === "recent").length;
  let shared = 0;
  let pulled = 0;
  for (const node of nodeList()) {
    if (!node?.primary_contributor) continue;
    if (node.primary_contributor === state.selfPubkey) shared++;
    else pulled++;
  }
  const dayAgo = Date.now() - 24 * 3600_000;
  const todayQueries = searchHistory.filter((event) => event.ts > dayAgo).length;

  setText("glance-num-cohort", String(peers.length));
  setText("glance-cohort-sub", `peers known · ${live} live now · ${live + recent} active today`);
  setText("glance-num-shared", String(shared));
  setText("glance-num-pulled", String(pulled));
  setText("glance-num-queries", String(todayQueries));
  setText("glance-num-queries-frac", todayQueries > 0 ? ` · ${todayQueries} hits` : "");
}

function renderGlanceRing() {
  const state = currentState();
  const peers = peersList().filter((peer) => peer?.pubkey !== state.selfPubkey);
  const raysGroup = document.getElementById("glance-rays");
  const peersGroup = document.getElementById("glance-peers");
  if (!raysGroup || !peersGroup) return;
  clear(raysGroup);
  clear(peersGroup);

  const now = performance.now();
  const positions = peers.map((peer, idx) => {
    let hash = 0;
    const key = peer.pubkey || String(idx);
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    const angle = ((Math.abs(hash) % 1000) / 1000) * Math.PI * 2 - Math.PI / 2;
    return { peer, idx, x: Math.cos(angle) * 95, y: Math.sin(angle) * 95 };
  });

  for (const { peer, x, y, idx } of positions) {
    const status = peerStateFor(peer, now);
    const color = status === "offline" ? null : peerHue(peer.pubkey, idx);
    const ray = document.createElementNS("http://www.w3.org/2000/svg", "line");
    ray.setAttribute("class", `ray ${status}`);
    ray.setAttribute("x1", "0");
    ray.setAttribute("y1", "0");
    ray.setAttribute("x2", String(x * 0.92));
    ray.setAttribute("y2", String(y * 0.92));
    if (color) ray.setAttribute("stroke", color);
    ray.setAttribute("opacity", status === "live" ? "0.55" : status === "recent" ? "0.28" : "0.18");
    raysGroup.appendChild(ray);
  }

  const livePositions = positions.filter(({ peer }) => peerStateFor(peer, now) === "live");
  for (let i = 0; i < livePositions.length; i++) {
    for (let j = i + 1; j < livePositions.length; j++) {
      const a = livePositions[i];
      const b = livePositions[j];
      const chord = document.createElementNS("http://www.w3.org/2000/svg", "path");
      chord.setAttribute("d", `M ${a.x * 0.9} ${a.y * 0.9} Q ${(a.x + b.x) * 0.3} ${(a.y + b.y) * 0.3} ${b.x * 0.9} ${b.y * 0.9}`);
      chord.setAttribute("fill", "none");
      chord.setAttribute("stroke", "var(--goxide-soft)");
      chord.setAttribute("stroke-width", "0.6");
      chord.setAttribute("opacity", "0.35");
      raysGroup.appendChild(chord);
    }
  }

  let live = 0;
  let recent = 0;
  let offline = 0;
  for (const { peer, x, y, idx } of positions) {
    const status = peerStateFor(peer, now);
    const color = status === "offline" ? null : peerHue(peer.pubkey, idx);
    if (status === "live") {
      live++;
      if (color) {
        const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        halo.setAttribute("class", "peer-halo");
        halo.setAttribute("cx", String(x));
        halo.setAttribute("cy", String(y));
        halo.setAttribute("r", "7");
        halo.setAttribute("fill", color);
        peersGroup.appendChild(halo);
      }
    } else if (status === "recent") {
      recent++;
    } else {
      offline++;
    }
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", `peer-dot ${status}`);
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", status === "live" ? "4" : status === "recent" ? "3" : "2.4");
    if (color) dot.setAttribute("fill", color);
    peersGroup.appendChild(dot);
  }

  setText("glance-legend-live", String(live));
  setText("glance-legend-recent", String(recent));
  setText("glance-legend-offline", String(offline));

  const selfPeer = peerByPubkey(state.selfPubkey);
  setText("glance-self-host", selfPeer?.nickname || "self");
}

function renderGlancePeerList() {
  const state = currentState();
  const list = document.getElementById("glance-peer-list");
  if (!list) return;
  const now = performance.now();
  const peers = peersList().sort((a, b) => {
    if (a.pubkey === state.selfPubkey) return -1;
    if (b.pubkey === state.selfPubkey) return 1;
    const order = { live: 0, recent: 1, offline: 2 };
    const aState = order[peerStateFor(a, now)] ?? 3;
    const bState = order[peerStateFor(b, now)] ?? 3;
    if (aState !== bState) return aState - bState;
    return (lastSeenMs(a) ?? Infinity) - (lastSeenMs(b) ?? Infinity);
  });

  clear(list);
  const visible = peers.filter((peer) => peerStateFor(peer, now) !== "offline").slice(0, 6);
  visible.forEach((peer, idx) => {
    const status = peerStateFor(peer, now);
    const isSelf = peer.pubkey === state.selfPubkey;
    const color = peerHue(peer.pubkey, idx);
    const card = document.createElement("div");
    card.className = "glance-peer-card";
    card.style.color = color;

    const dot = document.createElement("span");
    dot.className = `glance-peer-pdot ${status}`;
    dot.style.background = status === "offline" ? "transparent" : color;

    const name = document.createElement("span");
    name.className = `glance-peer-name${isSelf ? " is-self" : ""}`;
    name.textContent = isSelf ? "you" : (peer.nickname || `peer-${(peer.pubkey || "").slice(0, 8)}`);

    const pages = document.createElement("span");
    pages.className = "glance-peer-pages";
    pages.textContent = `${pageCountFor(peer.pubkey)}p`;

    const when = document.createElement("span");
    when.className = "glance-peer-when";
    when.textContent = isSelf ? "live" : fmtRelative(lastSeenMs(peer));

    const what = document.createElement("span");
    what.className = "glance-peer-what";
    what.textContent = isSelf
      ? "indexing locally · sharing to the cohort"
      : status === "live"
        ? "live · responding to pulls"
        : status === "recent"
          ? `connected · last contact ${fmtRelative(lastSeenMs(peer))}`
          : "offline";

    card.append(dot, name, pages, when, what);
    list.appendChild(card);
  });

  const live = peers.filter((peer) => peerStateFor(peer, now) === "live").length;
  const recent = peers.filter((peer) => peerStateFor(peer, now) === "recent").length;
  const offline = peers.filter((peer) => peerStateFor(peer, now) === "offline").length;
  setText("glance-peer-strip-num", `${live} / ${peers.length}`);
  setText("glance-show-more-n", String(recent));
  setText("glance-show-more-i", String(offline));
}

function renderGlanceTopics() {
  const flow = document.getElementById("glance-topics-flow");
  if (!flow) return;
  const byHost = new Map();
  for (const node of nodeList()) {
    const host = String(node?.host || "").replace(/^www\./, "");
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, { count: 0, contributor: node.primary_contributor });
    byHost.get(host).count++;
  }
  const buckets = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  clear(flow);
  setText("glance-topics-meta", `across ${nodeList().length} pages · last 7d`);
  if (buckets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "glance-topic size-1";
    empty.textContent = "no pages yet - index a few searches to populate this";
    flow.appendChild(empty);
    return;
  }
  const max = buckets[0][1].count || 1;
  buckets.forEach(([host, data]) => {
    const ratio = data.count / max;
    const size = ratio > 0.66 ? 4 : ratio > 0.4 ? 3 : ratio > 0.2 ? 2 : 1;
    const topic = document.createElement("span");
    topic.className = `glance-topic size-${size}`;
    const peerIndex = peersList().findIndex((peer) => peer.pubkey === data.contributor);
    if (peerIndex >= 0) {
      const color = peerHue(data.contributor, peerIndex);
      topic.style.borderColor = color;
      topic.style.color = color;
    }
    topic.textContent = host;
    const count = document.createElement("span");
    count.className = "ct";
    count.textContent = String(data.count);
    topic.append(" ", count);
    flow.appendChild(topic);
  });
}

function renderGlanceReach() {
  const state = currentState();
  const wrap = document.getElementById("glance-reach");
  if (!wrap) return;
  const now = performance.now();
  const visible = peersList()
    .filter((peer) => peer.pubkey !== state.selfPubkey)
    .filter((peer) => peerStateFor(peer, now) !== "offline")
    .slice(0, 5);
  clear(wrap);
  setText("glance-reach-meta", `latest bundle · ${visible.length} peers visible`);
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "var(--gpaper-faint)";
    empty.style.fontSize = "12px";
    empty.textContent = "no peers reachable right now - waiting for cohort to come online.";
    wrap.appendChild(empty);
    return;
  }
  visible.forEach((peer, idx) => {
    const color = peerHue(peer.pubkey, idx);
    const ageMs = lastSeenMs(peer);
    const pct = ageMs == null ? 0 : ageMs < 60_000 ? 100 : ageMs < 600_000 ? 80 : ageMs < 3600_000 ? 60 : 30;

    const bar = document.createElement("div");
    bar.className = "glance-reach-bar";
    bar.style.color = color;

    const name = document.createElement("div");
    name.className = "nm";
    const swatch = document.createElement("span");
    swatch.className = "sw";
    swatch.style.background = color;
    name.append(swatch, peer.nickname || `peer-${(peer.pubkey || "").slice(0, 8)}`);

    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const pctEl = document.createElement("div");
    pctEl.className = "pct";
    pctEl.textContent = `${pct}%`;

    bar.append(name, track, pctEl);
    wrap.appendChild(bar);
  });
}

function renderGlanceRhythm() {
  const rhythm = document.getElementById("glance-rhythm");
  if (!rhythm) return;
  const now = Date.now();
  const data = new Array(24).fill(0);
  for (const event of searchHistory) {
    const ageMs = now - event.ts;
    if (ageMs < 0 || ageMs >= 24 * 3600_000) continue;
    const bucket = 23 - Math.floor(ageMs / 3600_000);
    if (bucket >= 0 && bucket < 24) data[bucket]++;
  }
  const peak = Math.max(1, ...data);
  const peakHour = data.indexOf(peak);
  clear(rhythm);
  data.forEach((value, idx) => {
    const bar = document.createElement("div");
    bar.className = `glance-rhythm-bar${idx === 23 ? " now" : idx === peakHour && value > 0 ? " peak" : ""}`;
    bar.style.height = `${Math.max(2, (value / peak) * 100)}%`;
    bar.title = `${24 - idx}h ago - ${value} ${value === 1 ? "query" : "queries"}`;
    rhythm.appendChild(bar);
  });

  const total = data.reduce((sum, value) => sum + value, 0);
  const summary = document.getElementById("glance-rhythm-summary");
  if (!summary) return;
  if (total === 0) {
    summary.textContent = "Quiet day so far - no queries yet.";
    return;
  }
  const peakAgo = 24 - peakHour;
  summary.innerHTML = `${total} ${total === 1 ? "query" : "queries"} today · peak ${peakAgo}h ago (<strong style="color: var(--gpaper)">${peak}</strong> ${peak === 1 ? "query" : "queries"} that hour).`;
}

function renderGlanceTicker() {
  const line = document.getElementById("glance-ticker-line");
  if (!line) return;
  let mostRecent = null;
  const events = recentEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === "contribution_merged" || events[i]?.kind === "page_added") {
      mostRecent = events[i];
      break;
    }
  }
  if (!mostRecent) {
    line.textContent = "awaiting cohort activity...";
    setText("glance-ticker-when", "-");
    return;
  }
  const state = currentState();
  const payload = mostRecent.payload || {};
  const page = (payload.pages && payload.pages[0]) || payload;
  const contributor = payload.contributor || payload.source_pubkey;
  const isSelf = contributor === state.selfPubkey;
  const peer = peerByPubkey(contributor);
  const who = isSelf ? "you" : peer?.nickname || "a peer";
  const title = String(page.title || page.url || "a new page");
  line.innerHTML = `${escapeHtmlSafe(who)} ${isSelf ? "indexed" : "shared"} <em>${escapeHtmlSafe(title.slice(0, 80))}</em>${title.length > 80 ? "..." : ""}`;
  setText("glance-ticker-when", fmtRelative(Date.now() - eventTsMs(mostRecent)));
}

function renderGlanceHealth() {
  const state = currentState();
  setText("glance-health-daemon", "v0.13.4 · :7777");
  const cursor = state._manifest?.manifest?.cursor ?? state._manifest?.cursor;
  setText("glance-health-cursor", cursor != null ? `@${cursor}` : "@-");

  const events = recentEvents();
  let lastPub = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === "contribution_merged" && event.payload?.contributor === state.selfPubkey) {
      lastPub = event;
      break;
    }
  }
  setText("glance-health-publish", lastPub ? fmtRelative(Date.now() - eventTsMs(lastPub)) : "-");
  if (state._lastRttMs != null) setText("glance-health-lat", `${Math.round(state._lastRttMs)}ms`);
  const hourAgo = Date.now() - 3600_000;
  const errors = events.filter((event) => eventTsMs(event) > hourAgo && (
    event.kind === "peer_unreachable" || event.kind === "scraper_error"
  )).length;
  setText("glance-health-err", errors > 0 ? `${errors} · check log` : "0");
}

export function renderGlanceAll() {
  if (document.body.dataset.netViewMode !== "glance") return;
  if (document.body.dataset.activeTab !== "network") return;
  maybeAttachSearchListener();
  try { renderGlanceHero(); } catch (error) { console.warn("[glance hero]", error); }
  try { renderGlanceNumbers(); } catch (error) { console.warn("[glance numbers]", error); }
  try { renderGlanceRing(); } catch (error) { console.warn("[glance ring]", error); }
  try { renderGlancePeerList(); } catch (error) { console.warn("[glance peers]", error); }
  try { renderGlanceTopics(); } catch (error) { console.warn("[glance topics]", error); }
  try { renderGlanceReach(); } catch (error) { console.warn("[glance reach]", error); }
  try { renderGlanceRhythm(); } catch (error) { console.warn("[glance rhythm]", error); }
  try { renderGlanceTicker(); } catch (error) { console.warn("[glance ticker]", error); }
  try { renderGlanceHealth(); } catch (error) { console.warn("[glance health]", error); }
}

function syncModeButtons(mode) {
  for (const button of document.querySelectorAll(".net-mode-btn")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function setMode(mode, { render = true } = {}) {
  const nextMode = mode === "glance" ? "glance" : "debug";
  document.body.dataset.netViewMode = nextMode;
  try { localStorage.setItem(LS_KEY, nextMode); } catch {}
  syncModeButtons(nextMode);
  if (nextMode === "glance" && render) renderGlanceAll();
}

function wireModeButtons() {
  for (const button of document.querySelectorAll(".net-mode-btn")) {
    if (button.dataset.glanceWired === "1") continue;
    button.dataset.glanceWired = "1";
    button.addEventListener("click", () => {
      const nextMode = button.dataset.mode === "glance" ? "glance" : "debug";
      if (nextMode === "glance") {
        forceNetworkGlance().catch((error) => console.warn("[glance] failed to load:", error?.message || error));
      } else {
        setMode("debug");
      }
    });
  }
}

function startRefreshTimer() {
  if (refreshTimerStarted) return;
  refreshTimerStarted = true;
  const schedule = setIntervalVisibleRef || ((fn, ms) => window.setInterval(fn, ms));
  schedule(renderGlanceAll, 5000);
}

export function initNetworkGlance({ srwk: nextState, setIntervalVisible } = {}) {
  srwk = nextState || window.srwk || srwk;
  setIntervalVisibleRef = setIntervalVisible || setIntervalVisibleRef;
  window.__forceGlance = forceNetworkGlance;
  if (initialized) return { forceNetworkGlance, renderGlanceAll };
  initialized = true;
  setMode("debug", { render: false });
  wireModeButtons();
  startRefreshTimer();
  return { forceNetworkGlance, renderGlanceAll };
}

export async function forceNetworkGlance() {
  if (!initialized) initNetworkGlance();
  await ensureStyles();
  setMode("glance");
  renderGlanceAll();
}
