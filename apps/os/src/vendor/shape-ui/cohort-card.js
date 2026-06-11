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

// Markdown → one-line plain text for the about peek. Strips the obvious
// md syntax and squeezes whitespace; the dossier renders the real thing.
function mdToPlainText(md, max = 240) {
  const text = String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
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
  const peek = (key, body) =>
    `<span class="alch-card-peek" data-peek="${key}" tabindex="0" role="button" aria-label="${key} — hover to preview" data-no-card-click>${key}` +
      `<span class="alch-card-peek-layer alch-card-peek-${key}" role="tooltip" data-no-card-click>` +
        `<span class="acp-k">${key}</span>${escHtml(body)}` +
      `</span>` +
    `</span>`;
  const anchors = [];
  if (about) anchors.push(peek("about", about));
  if (now) anchors.push(peek("now", now));
  // Layers ride inside their anchors, so the whole feature is this one
  // title-block row — nothing trails the card foot.
  return anchors.length ? `<div class="alch-card-peeks">${anchors.join("")}</div>` : "";
}

// One "links" row of label anchors (github · x · site · linkedin). The
// full handles live on the dossier; the card only needs the routes —
// labels keep every card the same height whether a record has one link
// or four.
function linksRowHtml(anchors) {
  return `<div class="alch-card-meta-row alch-card-links-row"><span class="cm-k">links</span><span class="cm-v">${anchors.join('<span class="acm-sep">·</span>')}</span></div>`;
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
  // Social links collapse to one labelled row — see linksRowHtml. Only the
  // repo keeps a dedicated row (it's the feed-tracking signal, not a route).
  const socials = [];
  if (gh) {
    const href = normalizeLinkHref("github", gh);
    if (href) socials.push(`<a href="${escAttr(href)}" data-external>github</a>`);
  }
  if (x) {
    const href = normalizeLinkHref("x", x);
    if (href) socials.push(`<a href="${escAttr(href)}" data-external>x</a>`);
  }
  if (socials.length) links.push(linksRowHtml(socials));
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
        ${membersRow}
        ${links.join("")}
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
  // Resolve the team slug to its display name when the caller hands us
  // the teams list; the raw record_id is the fallback, never a dead end.
  const teams = Array.isArray(ctx.teams) ? ctx.teams : [];
  const team = p.team ? teams.find(t => t.record_id === p.team) : null;
  const teamLabel = team ? (team.name || team.record_id) : (p.team || "");
  // Social links collapse to one labelled row (github · x · site ·
  // linkedin) — handle text varied 0–4 rows per person and made the grid
  // ragged; the labels are the routes, the dossier carries the handles.
  const socials = [];
  const gh = p?.links?.github;
  const x  = p?.links?.x;
  const w  = p?.links?.website;
  const li = p?.links?.linkedin;
  if (gh) {
    const href = normalizeLinkHref("github", gh);
    if (href) socials.push(`<a href="${escAttr(href)}" data-external>github</a>`);
  }
  if (x) {
    const href = normalizeLinkHref("x", x);
    if (href) socials.push(`<a href="${escAttr(href)}" data-external>x</a>`);
  }
  if (w) {
    const href = normalizeLinkHref("website", w);
    if (href) socials.push(`<a href="${escAttr(href)}" data-external>site</a>`);
  }
  if (li) socials.push(`<a href="https://linkedin.com/in/${escAttr(li)}" data-external>linkedin</a>`);
  const linksRow = socials.length ? linksRowHtml(socials) : "";
  const roleClass = p.role_class || "visiting-scholar";
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
        ${teamLabel ? `<div class="alch-card-meta-row"><span class="cm-k">team</span><span class="cm-v">${escHtml(teamLabel)}</span></div>` : ""}
        <div class="alch-card-meta-row"><span class="cm-k">geo</span><span class="cm-v">${escHtml(p.geo || "—")}</span></div>
        ${linksRow}
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
