import {
  mountShapesIn,
  escHtml,
  escAttr,
  normalizeLinkHref,
  buildEditPRUrl,
  shapeForTeam,
  domainLabel,
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
  return h.startsWith("#") ? decodeURIComponent(h.slice(1)) || null : null;
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

function collabBoardHref(recordId) {
  return `/#collab:${encodeURIComponent(recordId || "")}`;
}

function prettyLinkLabel(key) {
  const labels = {
    github: "GitHub",
    repo: "Repo",
    repository: "Repo",
    website: "Website",
    site: "Website",
    demo: "Demo",
    docs: "Docs",
    deck: "Deck",
    linkedin: "LinkedIn",
    x: "X",
    twitter: "X",
  };
  const k = String(key || "").toLowerCase();
  return labels[k] || labelize(k || "link").replace(/\b\w/g, c => c.toUpperCase());
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
  const teamById = new Map(teams.map(t => [t.record_id, t]));

  mount.innerHTML = `
    <section class="cohort-browse">
      <div id="cohort-grid" class="cohort-grid"></div>
    </section>
    <div id="cohort-detail" class="cohort-detail" hidden></div>
  `;
  const browse = mount.querySelector(".cohort-browse");
  const pageHead = document.querySelector(".cohort-page-head");
  const membershipNav = document.getElementById("cohort-membership-filter");
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
    return people.filter(p =>
      p.team === teamId || asArray(p.secondary_teams).includes(teamId)
    );
  }

  function surfaceLinkAnchors(links = {}) {
    return Object.entries(links || {})
      .filter(([, value]) => !isBlank(value))
      .map(([key, value]) => {
        const href = normalizeLinkHref(key, value);
        const label = prettyLinkLabel(key);
        if (!href) return `<span>${escHtml(label)}</span>`;
        return `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`;
      });
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
      ? (rec.role || team?.name || labelize(rec.role_class || "individual"))
      : (rec.focus || rec.record_id);
    const tags = isPerson
      ? [idLabel, labelize(rec.role_class || rec.role || "individual"), rec.domain ? domainLabel(rec.domain) : "", rec.geo].filter(Boolean)
      : [idLabel, shapeKind, rec.membership ? labelize(rec.membership) : "", rec.domain ? domainLabel(rec.domain) : "", rec.geo].filter(Boolean);
    const hints = isPerson
      ? [...asArray(rec.go_to_them_for).slice(0, 2), ...asArray(rec.recurring_themes).slice(0, 2)]
      : [...asArray(rec.skill_areas).slice(0, 2), ...asArray(rec.success_dimensions).slice(0, 1)];
    const routes = renderSurfaceRoutes(rec, isPerson, team, members);
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
            ${memberLinks ? `<div><span>${kind === "project" ? "contributors" : "members"}</span><span class="cd-rail-members">${memberLinks}</span></div>` : ""}
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
          ${renderSection(`timeline · ${timelineItems.length}`, renderTimelineItems(timelineItems), false, timelinePreview(timelineItems))}
          ${renderSection("routes / asks", routeRows, false, "other teams, asks")}
        </div>
      </section>
    `;
  }

  function renderTeamDetail(rec, editUrl, fam, kind) {
    const teamPeople = people.filter(p => p.team === rec.record_id);
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
    const collab = renderQuickRow("routes / asks", [
      quickLink(`${rec.name || rec.record_id} on collab board`, collabBoardHref(rec.record_id), false),
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

    return `
      ${renderTeamRail(rec, teamPeople, fam, kind)}
      <section class="cd-ledger">
        <div class="cd-ledger-head">
          <span class="cd-h">${escHtml(kind)} read</span>
        </div>
        <div class="cd-quick cd-team-quick">${nextMove}${needs}${provides}${guild}${trajectory}${collab}${explore}</div>
        <div class="cd-section-stack">
          ${renderSection("trajectory", trajectoryRows, false, "stage, proof, next test")}
          ${renderSection("evidence", evidenceRows, false, "traction, paper, shipping")}
          ${renderSection(`timeline · ${timelineItems.length}`, renderTimelineItems(timelineItems), false, timelinePreview(timelineItems))}
        </div>
      </section>
    `;
  }

  function renderDetail(rec) {
    const kind = recordKind(rec);
    const editUrl = recordSourceUrl(rec, kind);
    const shapeKind = kind === "person" ? "person" : teamKind(rec);
    const fam = shapeFamily(rec, kind);
    detailHost.innerHTML = `
      <header class="cd-bar">
        <a class="cd-back" href="#" aria-label="back to grid"><span aria-hidden="true">&lt;-</span> back</a>
        <div class="cd-tag">
          <span>${escHtml(String(rec.record_id || "").toUpperCase())}</span>
          <span class="cd-sep">/</span>
          <span class="cd-kind cd-kind-${escAttr(shapeKind)}">${escHtml(shapeKind)}</span>
        </div>
        <a class="cd-edit" href="${escAttr(editUrl)}" target="_blank" rel="noopener noreferrer">edit on github -&gt;</a>
      </header>
      <article class="cd-dossier cd-dossier-${escAttr(kind)}">
        ${kind === "person"
          ? renderPersonDetail(rec, editUrl, fam)
          : renderTeamDetail(rec, editUrl, fam, shapeKind)}
      </article>
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
      editPanel.innerHTML = `<h3 class="cd-h">edit ${escHtml(isTeam ? shapeKind : "person")}</h3>`;
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
