// cohort-card.js — shared renderer for the cohort "specimen" cards used
// across the alchemy view and the sibling web app. Each card shows a
// shape glyph plus the surface fields (focus, lead, links, members).
//
// Two API styles are exported:
//   - renderTeamCard / renderPersonCard / renderCohortCard
//     → return real HTMLElement nodes (preferred for web app code).
//   - teamCardHtml / personCardHtml
//     → return HTML string (kept so the Electron renderer can keep its
//       existing innerHTML batching flow without per-card append cost).
//
// Both styles share the same markup. The HTML-string form is the
// "implementation"; the element form wraps it via a detached div.

import { escHtml, escAttr, normalizeGithubRepo, normalizeLinkHref } from "./escape.js";
import { shapeForTeam, domainLabel } from "./index.js";

// Display id "SHAPE-NN" / "PERSON-NN" from index. Kept module-local
// because callers always have an index handy.
function displayId(idx) {
  return String(idx + 1).padStart(2, "0");
}

// 32-bit string hash. Mirrors alchemy.js's hashStr so per-person card
// hues / fams match what the rest of the surface already shows.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function teamKind(t) { return (t && t.kind) || "team"; }

// Journey stage vocabulary — mirrors JOURNEY_STAGE_LABELS in
// apps/os/src/renderer/alchemy.js and apps/web/scripts/cohort.js (the
// detail surfaces). Kept module-local so the card stays dependency-free;
// if the canonical list changes, change all three.
const STAGE_LABELS = [
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

// Stage micro-mark: nine ticks filled to the journey stage, plus the
// stage's name. Readable at rest (the mark answers "where are they?");
// the title attribute carries the exact reading on hover.
function stageRowHtml(t) {
  const journey = t && typeof t.journey === "object" && t.journey ? t.journey : null;
  if (!journey) return "";
  const n = Number(journey.stage);
  if (!Number.isFinite(n)) return "";
  const stage = Math.max(0, Math.min(STAGE_LABELS.length - 1, Math.trunc(n)));
  const label = STAGE_LABELS[stage] || "idea";
  const ticks = STAGE_LABELS.map((_, i) => `<i${i <= stage ? ' class="on"' : ""}></i>`).join("");
  return `
    <div class="alch-card-meta-row alch-card-stage-row">
      <span class="cm-k">stage</span>
      <span class="cm-v"><span class="sr-stage" title="stage ${stage} of ${STAGE_LABELS.length - 1} — ${escAttr(label)}">
        <span class="sr-stage-ticks" aria-hidden="true">${ticks}</span>
        <span class="sr-stage-label">${escHtml(label)}</span>
      </span></span>
    </div>`;
}

// Hover layer: the record's `now` line, revealed over the shape area so
// the card's footprint never shifts. Glance = card, hover = what they're
// doing this week, click = full dossier.
function nowOverlayHtml(rec) {
  const now = String(rec?.now || "").trim();
  if (!now) return "";
  return `<div class="alch-card-now"><span>now</span>${escHtml(now)}</div>`;
}

function compactGithubLabel(value) {
  const raw = String(value || "").trim().replace(/^@+/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (/(^|\.)github\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[0] || raw;
    }
  } catch {}
  return raw.replace(/^(?:www\.)?github\.com\/+/i, "");
}

function compactXLabel(value) {
  const raw = String(value || "").trim().replace(/^@+/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (/(^|\.)(?:x|twitter)\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[0] ? `@${parts[0]}` : raw;
    }
  } catch {}
  return raw ? `@${raw.replace(/^(?:www\.)?(?:x|twitter)\.com\/+/i, "").replace(/^@+/, "")}` : raw;
}

// ── HTML-string renderers ──────────────────────────────────────────────

export function teamCardHtml(t, idx, ctx = {}) {
  const s = shapeForTeam(t);
  const links = [];
  const gh   = t?.links?.github;
  const repoRaw = t?.links?.repo;
  const repo = normalizeGithubRepo(repoRaw);
  const x    = t?.links?.x;
  if (repo) {
    links.push(`<div class="alch-card-meta-row"><span class="cm-k">repo</span><span class="cm-v"><a href="https://github.com/${escAttr(repo)}" data-external class="alch-card-repo-link">${escHtml(repo)}</a></span></div>`);
  } else if (repoRaw) {
    const href = normalizeLinkHref("repo", repoRaw);
    const label = String(repoRaw).replace(/^https?:\/\//i, "");
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">repo</span><span class="cm-v"><a href="${escAttr(href)}" data-external class="alch-card-repo-link">${escHtml(label)}</a></span></div>`);
  }
  if (gh) {
    const href = normalizeLinkHref("github", gh);
    const label = compactGithubLabel(gh);
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">github</span><span class="cm-v"><a href="${escAttr(href)}" data-external>${escHtml(label)}</a></span></div>`);
  }
  if (x) {
    const href = normalizeLinkHref("x", x);
    const label = compactXLabel(x);
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">x</span><span class="cm-v"><a href="${escAttr(href)}" data-external>${escHtml(label)}</a></span></div>`);
  }
  const membership = t.membership || "visiting";
  const cardCls = [
    "alch-card",
    t.is_mentor ? "alch-card-mentor" : "",
    `alch-card-membership-${membership}`,
    "is-clickable",
  ].filter(Boolean).join(" ");
  const m = Number(t.members_count) || 0;
  const kind = teamKind(t);
  // People whose primary `team` or `secondary_teams` includes this record.
  const allPeople = Array.isArray(ctx.people) ? ctx.people : [];
  const teamPeople = allPeople.filter(p =>
    p.team === t.record_id || (Array.isArray(p.secondary_teams) && p.secondary_teams.includes(t.record_id))
  );
  // One owner for the roster: the full member list when person records are
  // linked (names imply the count), the declared head-count only as a
  // fallback for teams whose people haven't been linked yet.
  const membersRow = teamPeople.length
    ? `<div class="alch-card-meta-row alch-card-members-row">
         <span class="cm-k">${kind === "project" ? "contributors" : "members"}</span>
         <span class="cm-v">${teamPeople.map(p =>
           `<button type="button" class="alch-card-member" data-person="${escHtml(p.record_id)}">${escHtml(p.name || p.record_id)}</button>`
         ).join('<span class="acm-sep">·</span>')}</span>
       </div>`
    : (m > 0
      ? `<div class="alch-card-meta-row"><span class="cm-k">${kind === "project" ? "contributors" : "team"}</span><span class="cm-v">${m} ${m === 1 ? "person" : "people"}</span></div>`
      : "");
  return `
    <article class="${cardCls}" data-record-id="${escHtml(t.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(t.name)} — open detail">
      <div class="alch-card-shape"><canvas data-shape-fam="${s ? s.fam : 0}" data-shape-kind="${escAttr(kind)}" data-shape-scale="1.1" data-shape-seed="${escAttr(t.record_id)}"></canvas>${nowOverlayHtml(t)}</div>
      <div class="alch-card-name">${escHtml(t.name)}</div>
      <div class="alch-card-domain">${escHtml(domainLabel(t.domain))}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">focus</span><span class="cm-v">${escHtml(t.focus)}</span></div>
        ${stageRowHtml(t)}
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(t.geo)}</span></div>
        ${membersRow}
        ${links.join("")}
      </div>
    </article>`;
}

export function personCardHtml(p, idx, ctx = {}) {
  // People don't have a shape vocabulary — derive a fam from their
  // record_id hash purely so the per-family rotation/symmetry/specimen
  // varies between individuals. The shader sees u_kind=2 and overrides
  // the silhouette to a circle medallion regardless.
  const fam = Math.abs(hashStr(p.record_id || "_")) % 6;
  // Resolve the team slug to its display name when the caller hands us
  // the teams list; the raw record_id is the fallback, never a dead end.
  const teams = Array.isArray(ctx.teams) ? ctx.teams : [];
  const team = p.team ? teams.find(t => t.record_id === p.team) : null;
  const teamLabel = team ? (team.name || team.record_id) : (p.team || "");
  const links = [];
  const gh = p?.links?.github;
  const x  = p?.links?.x;
  const w  = p?.links?.website;
  const li = p?.links?.linkedin;
  if (gh) {
    const href = normalizeLinkHref("github", gh);
    const label = compactGithubLabel(gh);
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">github</span><span class="cm-v"><a href="${escAttr(href)}" data-external>${escHtml(label)}</a></span></div>`);
  }
  if (x) {
    const href = normalizeLinkHref("x", x);
    const label = compactXLabel(x);
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">x</span><span class="cm-v"><a href="${escAttr(href)}" data-external>${escHtml(label)}</a></span></div>`);
  }
  if (w) {
    const href = normalizeLinkHref("website", w);
    const label = String(w).replace(/^https?:\/\//i, "");
    if (href) links.push(`<div class="alch-card-meta-row"><span class="cm-k">site</span><span class="cm-v"><a href="${escAttr(href)}" data-external>${escHtml(label)}</a></span></div>`);
  }
  if (li) links.push(`<div class="alch-card-meta-row"><span class="cm-k">linkedin</span><span class="cm-v"><a href="https://linkedin.com/in/${escHtml(li)}" data-external>${escHtml(li)}</a></span></div>`);
  const roleClass = p.role_class || "visiting-scholar";
  return `
    <article class="alch-card is-clickable alch-card-person alch-card-role-${escAttr(roleClass)}" data-record-id="${escHtml(p.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(p.name)} — open profile">
      <div class="alch-card-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-scale="1.1" data-shape-seed="${escAttr(p.record_id)}"></canvas>${nowOverlayHtml(p)}</div>
      <div class="alch-card-name">${escHtml(p.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">role</span><span class="cm-v">${escHtml(p.role || "—")}</span></div>
        ${teamLabel ? `<div class="alch-card-meta-row"><span class="cm-k">team</span><span class="cm-v">${escHtml(teamLabel)}</span></div>` : ""}
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(p.geo || "—")}</span></div>
        ${links.join("")}
      </div>
    </article>`;
}

// ── HTMLElement renderers (preferred for web app code) ─────────────────
// Each wraps its HTML-string sibling in a detached <div> and lifts out
// the <article> child so callers can append directly into the DOM and
// attach event listeners.

function htmlToElement(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = String(html).trim();
  return wrap.firstElementChild;
}

function isNestedCardControl(event, card) {
  const target = event?.target;
  if (!(target instanceof Element) || target === card) return false;
  return !!target.closest("a, button, input, select, textarea, [data-no-card-click]");
}

function attachOnClick(el, onClick) {
  if (!el || typeof onClick !== "function") return el;
  el.addEventListener("click", (e) => {
    if (isNestedCardControl(e, el)) return;
    onClick(e, el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      if (isNestedCardControl(e, el) || e.target !== el) return;
      e.preventDefault();
      onClick(e, el);
    }
  });
  return el;
}

export function renderTeamCard(team, options = {}) {
  const idx = Number.isFinite(options.idx) ? options.idx : 0;
  const ctx = { people: options.people || [] };
  const el = htmlToElement(teamCardHtml(team, idx, ctx));
  return attachOnClick(el, options.onClick);
}

export function renderPersonCard(person, options = {}) {
  const idx = Number.isFinite(options.idx) ? options.idx : 0;
  const ctx = { teams: options.teams || [] };
  const el = htmlToElement(personCardHtml(person, idx, ctx));
  return attachOnClick(el, options.onClick);
}

// Dispatcher — uses record_type to pick the renderer. Falls back to
// kind ("team" | "project") when record_type isn't on the record.
export function renderCohortCard(record, options = {}) {
  if (!record) return null;
  const t = record.record_type || (record.kind === "person" ? "person" : "team");
  if (t === "person") return renderPersonCard(record, options);
  return renderTeamCard(record, options);
}
