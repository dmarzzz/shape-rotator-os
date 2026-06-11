// cohort-card.js — shared renderer for the cohort "specimen" cards used
// across the alchemy view and the sibling web app. Each card shows a
// shape glyph plus the surface fields (focus, roster, links, geography).
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

function asArray(value) {
  return Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
}

function personDisplayName(person) {
  return person?.name || person?.record_id || "";
}

export function cohortRosterForTeam(people = [], teamId, opts = {}) {
  const includeSecondary = opts.includeSecondary !== false;
  const seen = new Set();
  const roster = [];
  for (const person of Array.isArray(people) ? people : []) {
    if (!person || !teamId) continue;
    const isPrimary = person.team === teamId;
    const isSecondary = includeSecondary && asArray(person.secondary_teams).includes(teamId);
    if (!isPrimary && !isSecondary) continue;
    const id = person.record_id || personDisplayName(person);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    roster.push({ ...person, _membershipRole: isPrimary ? "primary" : "secondary" });
  }
  return roster.sort((a, b) => {
    const ap = a._membershipRole === "primary" ? 0 : 1;
    const bp = b._membershipRole === "primary" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const al = String(a.role || "").toLowerCase() === "lead" ? 0 : 1;
    const bl = String(b.role || "").toLowerCase() === "lead" ? 0 : 1;
    if (al !== bl) return al - bl;
    return String(personDisplayName(a)).localeCompare(String(personDisplayName(b)));
  });
}

export function cohortRosterSummary({ kind = "team", roster = [], declaredCount = 0, maxNames = 5 } = {}) {
  const label = kind === "project" ? "contributors" : "team";
  const people = Array.isArray(roster) ? roster.filter(personDisplayName) : [];
  const count = people.length || Number(declaredCount) || 0;
  const visible = people.slice(0, Math.max(1, maxNames | 0));
  const overflow = Math.max(0, count - visible.length);
  return {
    label,
    count,
    people,
    visible,
    overflow,
    hasNames: visible.length > 0,
    fallback: count ? `${count} ${count === 1 ? "person" : "people"}` : "—",
  };
}

// Markdown → one-line plain text for the about peek. Heading lines drop
// wholesale (they're labels, not prose — an "## about" heading would
// double the peek's own label); the dossier renders the real thing.
function mdToPlainText(md, max = 240) {
  const text = String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/[*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

// Hover peeks: quiet "about · now" anchors in the title block, each a
// deliberate hover/focus target carrying its OWN glass popover. The
// layer is nested inside its anchor so hovering the popover still counts
// as hovering the anchor — the cursor can travel from tag into popover
// and the panel stays open ("do more from the preview"). The card body
// triggers nothing, so the cursor can rest on a card without opening it.
// Anchors carry data-no-card-click so a click peeks instead of selecting.
// Reveal + the cursor-bridge are CSS-only — see .alch-card-peek in
// cohort-card.css.
function cardPeeks(rec) {
  const about = mdToPlainText(rec?.bio_md);
  const now = String(rec?.now || "").trim();
  // .acp-b is the line-clamp wrapper: the layer itself must keep
  // overflow visible or it clips its own ::before cursor bridge.
  const peek = (key, body) =>
    `<span class="alch-card-peek" data-peek="${key}" tabindex="0" role="button" aria-label="${key} — hover to preview" data-no-card-click>${key}` +
      `<span class="alch-card-peek-layer alch-card-peek-${key}" role="tooltip" data-no-card-click>` +
        `<span class="acp-b"><span class="acp-k">${key}</span>${escHtml(body)}</span>` +
      `</span>` +
    `</span>`;
  const anchors = [];
  if (about) anchors.push(peek("about", about));
  if (now) anchors.push(peek("now", now));
  // Layers ride inside their anchors, so the whole feature is this one
  // title-block row — nothing trails the card foot.
  return anchors.length ? `<div class="alch-card-peeks">${anchors.join("")}</div>` : "";
}

// Compact skill / topic chips along the card foot — same scanning role
// they played on the original specimen cards.
function cardChipsHtml(values, max = 3) {
  const items = (Array.isArray(values) ? values : [])
    .map(v => String(v || "").trim())
    .filter(Boolean)
    .slice(0, max);
  if (!items.length) return "";
  return `<div class="alch-card-chips">${items.map(v => `<span>${escHtml(v)}</span>`).join("")}</div>`;
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

function displayUrl(value) {
  return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function compactCohortLinkItems(record = {}) {
  const links = record?.links || {};
  const out = [];
  const seen = new Set();
  const usedKeys = new Set();
  const LABELS = {
    github: "github",
    repo: "repo",
    repository: "repo",
    website: "site",
    site: "site",
    demo: "demo",
    docs: "docs",
    deck: "deck",
    slides: "slides",
    article: "article",
    alt: "alt site",
    linkedin: "linkedin",
    x: "x",
    twitter: "x",
  };
  const add = (label, href, display = label) => {
    if (!href) return;
    const key = `${label}:${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, href, display });
  };
  const pick = (...keys) => keys.find(key => links[key]);

  const githubKey = pick("github");
  if (githubKey) {
    usedKeys.add(githubKey);
    const href = normalizeLinkHref("github", links[githubKey]);
    add("github", href, compactGithubLabel(links[githubKey]));
  }
  const repoKey = pick("repo", "repository");
  if (repoKey) {
    usedKeys.add(repoKey);
    const repo = normalizeGithubRepo(links[repoKey]);
    if (repo) add("repo", `https://github.com/${repo}`, repo);
    else add("repo", normalizeLinkHref("repo", links[repoKey]), displayUrl(links[repoKey]));
  }
  const xKey = pick("x", "twitter");
  if (xKey) {
    usedKeys.add(xKey);
    const href = normalizeLinkHref("x", links[xKey]);
    add("x", href, compactXLabel(links[xKey]));
  }
  const websiteKey = pick("website", "site");
  if (websiteKey) { usedKeys.add(websiteKey); add("site", normalizeLinkHref("website", links[websiteKey]), displayUrl(links[websiteKey])); }
  if (links.demo) { usedKeys.add("demo"); add("demo", normalizeLinkHref("demo", links.demo), displayUrl(links.demo)); }
  if (links.deck) { usedKeys.add("deck"); add("deck", normalizeLinkHref("deck", links.deck), displayUrl(links.deck)); }
  if (links.slides) { usedKeys.add("slides"); add("slides", normalizeLinkHref("slides", links.slides), displayUrl(links.slides)); }
  if (links.linkedin) {
    usedKeys.add("linkedin");
    const display = displayUrl(links.linkedin).replace(/^www\.linkedin\.com\//i, "");
    add("linkedin", normalizeLinkHref("linkedin", links.linkedin), display);
  }
  for (const [rawKey, value] of Object.entries(links)) {
    const key = String(rawKey || "").toLowerCase();
    if (usedKeys.has(key) || !String(value || "").trim()) continue;
    const label = LABELS[key] || key.replace(/[_-]+/g, " ");
    add(label, normalizeLinkHref(key, value), displayUrl(value));
  }
  return out;
}

function compactLinksRow(record) {
  const items = compactCohortLinkItems(record);
  if (!items.length) {
    return `<div class="alch-card-meta-row"><span class="cm-k">links</span><span class="cm-v" style="opacity:0.55">— not yet submitted</span></div>`;
  }
  return `<div class="alch-card-meta-row alch-card-links-row"><span class="cm-k">links</span><span class="cm-v">${items.map(item =>
    `<a href="${escAttr(item.href)}" data-external title="${escAttr(item.display)}">${escHtml(item.label)}</a>`
  ).join('<span class="acm-sep">·</span>')}</span></div>`;
}

// ── HTML-string renderers ──────────────────────────────────────────────

export function teamCardHtml(t, idx, ctx = {}) {
  const s = shapeForTeam(t);
  const membership = t.membership || "visiting";
  const cardCls = [
    "alch-card",
    t.is_mentor ? "alch-card-mentor" : "",
    `alch-card-membership-${membership}`,
    "is-clickable",
  ].filter(Boolean).join(" ");
  const m = Number(t.members_count) || 0;
  const kind = teamKind(t);
  const allPeople = Array.isArray(ctx.people) ? ctx.people : [];
  const roster = cohortRosterSummary({
    kind,
    roster: cohortRosterForTeam(allPeople, t.record_id),
    declaredCount: m,
    maxNames: 5,
  });
  const rosterValue = roster.hasNames
    ? `${roster.visible.map(p =>
        `<button type="button" class="alch-card-member" data-person="${escAttr(p.record_id)}">${escHtml(personDisplayName(p))}</button>`
      ).join('<span class="acm-sep">·</span>')}${roster.overflow ? `<span class="acm-sep">·</span><span class="alch-card-member-more">+${roster.overflow}</span>` : ""}`
    : escHtml(roster.fallback);
  const peeks = cardPeeks(t);
  return `
    <article class="${cardCls}" data-record-id="${escHtml(t.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(t.name)} — open detail">
      <div class="alch-card-head">
        <div class="alch-card-shape"><canvas data-shape-fam="${s ? s.fam : 0}" data-shape-kind="${escAttr(kind)}" data-shape-scale="1.1" data-shape-seed="${escAttr(t.record_id)}"></canvas></div>
        <div class="alch-card-title">
          <div class="alch-card-domain">${escHtml(domainLabel(t.domain))}</div>
          <div class="alch-card-name">${escHtml(t.name)}</div>
          ${t.focus ? `<p class="alch-card-sub">${escHtml(t.focus)}</p>` : ""}
          ${peeks}
        </div>
      </div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(t.geo)}</span></div>
        <div class="alch-card-meta-row alch-card-members-row"><span class="cm-k">${escHtml(roster.label)}</span><span class="cm-v">${rosterValue}</span></div>
        ${compactLinksRow(t)}
      </div>
      ${cardChipsHtml(t.skill_areas)}
    </article>`;
}

export function personCardHtml(p, idx, ctx = {}) {
  // People don't have a shape vocabulary — derive a fam from their
  // record_id hash purely so the per-family rotation/symmetry/specimen
  // varies between individuals. The shader sees u_kind=2 and overrides
  // the silhouette to a circle medallion regardless.
  const fam = Math.abs(hashStr(p.record_id || "_")) % 6;
  const roleClass = p.role_class || "visiting-scholar";
  const teamById = ctx.teamById instanceof Map
    ? ctx.teamById
    : new Map((Array.isArray(ctx.teams) ? ctx.teams : []).filter(t => t?.record_id).map(t => [t.record_id, t]));
  const team = p.team ? teamById.get(p.team) : null;
  const teamLabel = team?.name || p.team || "";
  const role = p.role || "";
  const teamRoleValue = teamLabel && role
    ? `${teamLabel} · ${role}`
    : (teamLabel || role || "—");
  const teamRoleLabel = teamLabel ? "team" : "role";
  const peeks = cardPeeks(p);
  return `
    <article class="alch-card is-clickable alch-card-person alch-card-role-${escAttr(roleClass)}" data-record-id="${escHtml(p.record_id)}" data-display-id="${displayId(idx)}" tabindex="0" role="button" aria-label="${escHtml(p.name)} — open profile">
      <div class="alch-card-head">
        <div class="alch-card-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-scale="1.1" data-shape-seed="${escAttr(p.record_id)}"></canvas></div>
        <div class="alch-card-title">
          ${p.domain ? `<div class="alch-card-domain">${escHtml(domainLabel(p.domain))}</div>` : ""}
          <div class="alch-card-name">${escHtml(p.name)}</div>
          ${p.role ? `<p class="alch-card-sub">${escHtml(p.role)}</p>` : ""}
          ${peeks}
        </div>
      </div>
      <div class="alch-card-meta">
        ${teamLabel ? `<div class="alch-card-meta-row"><span class="cm-k">${escHtml(teamRoleLabel)}</span><span class="cm-v">${escHtml(teamRoleValue)}</span></div>` : ""}
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(p.geo || "—")}</span></div>
        ${compactLinksRow(p)}
      </div>
      ${cardChipsHtml(p.go_to_them_for)}
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
  const el = htmlToElement(personCardHtml(person, idx, { teams: options.teams || [], teamById: options.teamById }));
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
