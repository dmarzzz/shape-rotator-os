import {
  renderCohortCard,
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

function renderSection(title, body, open = false) {
  const cleaned = asArray(body).join("");
  if (!cleaned.trim()) return "";
  return `
    <details class="cd-section" ${open ? "open" : ""}>
      <summary><span>${escHtml(title)}</span><span class="cd-section-mark" aria-hidden="true">+</span></summary>
      <div class="cd-section-body">${cleaned}</div>
    </details>
  `;
}

function renderLinkList(links = {}) {
  const entries = Object.entries(links).filter(([, v]) => v && String(v).trim());
  if (!entries.length) return "";
  return `
    <ul class="cd-links">
      ${entries.map(([k, v]) => {
        const href = normalizeLinkHref(k, v);
        const display = String(v).replace(/^https?:\/\//, "");
        if (href) {
          return `<li><a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"><span class="cd-link-k">${escHtml(k)}</span><span class="cd-link-v">${escHtml(display)}</span></a></li>`;
        }
        return `<li><span class="cd-link-static"><span class="cd-link-k">${escHtml(k)}</span><span class="cd-link-v">${escHtml(display)}</span></span></li>`;
      }).join("")}
    </ul>
  `;
}

function quickLink(label, href, external = true) {
  if (!href) return "";
  const attrs = external ? ` target="_blank" rel="noopener noreferrer"` : "";
  return `<a class="cd-quick-link" href="${escAttr(href)}"${attrs}>${escHtml(label)}</a>`;
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

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }

  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const teamById = new Map(teams.map(t => [t.record_id, t]));

  mount.innerHTML = `
    <section class="cohort-surface">
      <div class="cohort-surface-head">
        <div class="cohort-surface-title">
          <span>cohort records</span>
          <span data-cohort-view-count></span>
        </div>
        <div class="cohort-toolbar">
          <nav class="cohort-filter cohort-filter-kind" role="tablist" aria-label="filter by kind">
            <button class="cohort-chip" data-kind="works" type="button" aria-selected="true">teams &amp; projects <span class="cohort-chip-count">${teams.length}</span></button>
            <button class="cohort-chip" data-kind="people" type="button" aria-selected="false">individuals <span class="cohort-chip-count">${people.length}</span></button>
          </nav>
          <nav class="cohort-filter cohort-filter-membership" role="tablist" aria-label="filter by membership"></nav>
        </div>
      </div>
      <div id="cohort-grid" class="cohort-grid"></div>
    </section>
    <div id="cohort-detail" class="cohort-detail" hidden></div>
  `;
  const surface = mount.querySelector(".cohort-surface");
  const toolbar = mount.querySelector(".cohort-toolbar");
  const membershipNav = mount.querySelector(".cohort-filter-membership");
  const surfaceCount = mount.querySelector("[data-cohort-view-count]");
  const grid = mount.querySelector("#cohort-grid");
  const detailHost = mount.querySelector("#cohort-detail");

  function activeChipSet() {
    return state.kind === "people" ? PERSON_CHIPS : TEAM_CHIPS;
  }

  function findRecord(recordId) {
    return teams.find(t => t.record_id === recordId)
        || people.find(p => p.record_id === recordId)
        || null;
  }

  function renderGrid() {
    const chipSet = activeChipSet();
    if (!chipSet.some(c => c.id === state.membership)) state.membership = DEFAULT_MEMBERSHIP;
    const source = state.kind === "people" ? people : teams;
    const counts = new Map(chipSet.map(c => [c.id, source.filter(c.match).length]));
    membershipNav.innerHTML = chipSet.map(chip => `
      <button class="cohort-chip cohort-chip-membership" data-membership="${escAttr(chip.id)}" type="button" aria-selected="${chip.id === state.membership}">${escHtml(chip.label)} <span class="cohort-chip-count">${counts.get(chip.id) || 0}</span></button>
    `).join("");
    for (const btn of membershipNav.querySelectorAll(".cohort-chip[data-membership]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.membership === state.membership) return;
        state.membership = btn.dataset.membership;
        renderGrid();
      });
    }

    const active = chipSet.find(c => c.id === state.membership) || chipSet[0];
    const records = source.filter(active.match);
    if (surfaceCount) {
      surfaceCount.textContent = `${records.length} shown / ${source.length} ${state.kind === "people" ? "individuals" : "teams + projects"}`;
    }
    grid.innerHTML = "";
    if (!records.length) {
      grid.innerHTML = `<p class="page-empty">no ${escHtml(active.label)} yet.</p>`;
    } else {
      records.forEach((rec, idx) => {
        try {
          const card = renderCohortCard(rec, {
            idx,
            people,
            onClick: (event) => {
              const person = event?.target?.closest?.("[data-person]");
              const id = person?.dataset?.person || rec.record_id;
              if (id) location.hash = `#${encodeURIComponent(id)}`;
            },
          });
          if (card instanceof Node) grid.appendChild(card);
        } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
      });
    }

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] shape mount failed:", e); }
    });
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
            <div><span>${kind === "project" ? "contributors" : "team"}</span>${teamPeople.length} ${teamPeople.length === 1 ? "person" : "people"}</div>
            ${rec.membership ? `<div><span>status</span>${escHtml(labelize(rec.membership))}</div>` : ""}
          </div>
        </div>
      </aside>
    `;
  }

  function renderPersonDetail(rec, editUrl, fam) {
    const team = rec.team ? teamById.get(rec.team) : null;
    const secondary = asArray(rec.secondary_teams).map(id => teamById.get(id)).filter(Boolean);
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
    const route = renderQuickRow("route", [
      pill("status", labelize(rec.role_class || "person")),
      pill("role", rec.role),
      pill("domain", rec.domain ? domainLabel(rec.domain) : ""),
      pill("geo", rec.geo),
    ]);
    const askMeAbout = renderQuickRow("ask me about",
      asArray(rec.go_to_them_for).slice(0, 4).map(value => quickText("", value))
    );
    const themes = renderQuickRow("themes",
      asArray(rec.recurring_themes).slice(0, 4).map(value => quickText("", value))
    );
    const teamContext = team ? renderQuickRow("team context", [
      quickLink(team.name || team.record_id, `#${encodeURIComponent(team.record_id)}`, false),
      quickText("focus", team.focus),
    ]) : "";
    const absences = asArray(rec.absences).map(a => {
      if (!a || typeof a !== "object") return String(a);
      const range = dateRange(a.start, a.end);
      return `${range}${a.note ? ` (${a.note})` : ""}`;
    });
    const currentRows = [
      renderRow("window", dateRange(rec.dates_start, rec.dates_end)),
      renderRow("now", rec.now),
      renderRow("weekly intention", rec.weekly_intention),
      renderRow("contributes", rec.contribute_interests),
      renderRow("comm style", rec.comm_style),
      renderRow("availability", rec.availability_pref),
      renderRow("absences", absences),
    ];
    const routeRows = [
      secondary.length ? renderHtmlRow("also contributes", secondary.map(t => `<a class="cd-text-link" href="#${escAttr(encodeURIComponent(t.record_id))}">${escHtml(t.name || t.record_id)}</a>`).join(" ")) : "",
      renderRow("best contexts", rec.best_contexts),
      renderRow("working style", rec.working_style),
      renderRow("seeking", rec.seeking),
      renderRow("offering", rec.offering),
    ];
    const evidenceRows = [
      renderRow("prior work", rec.prior_work),
      renderRow("making signature", rec.making_signature?.note),
      renderRow("built domain", rec.making_signature?.built_domain),
    ];

    return `
      ${renderPersonRail(rec, team, fam)}
      <section class="cd-ledger">
        <div class="cd-ledger-head">
          <span class="cd-h">individual read</span>
        </div>
        <div class="cd-quick">${explore}${route}${askMeAbout}${themes}${teamContext}</div>
        <div class="cd-section-stack">
          ${renderSection("current read", currentRows, true)}
          ${renderSection("routes / asks", routeRows)}
          ${renderSection("evidence", evidenceRows)}
        </div>
      </section>
    `;
  }

  function renderTeamPeople(teamId, kind) {
    const teamPeople = people.filter(p => p.team === teamId);
    if (!teamPeople.length) return "";
    return `
      <ul class="cd-people">
        ${teamPeople.map(p => `
          <li>
            <a class="cd-person-link" href="#${escAttr(encodeURIComponent(p.record_id))}">
              <span class="adp-name">${escHtml(p.name || p.record_id)}</span>
              ${p.role ? `<span class="adp-role">${escHtml(p.role)}</span>` : ""}
            </a>
          </li>
        `).join("")}
      </ul>
    `;
  }

  function renderTeamDetail(rec, editUrl, fam, kind) {
    const teamPeople = people.filter(p => p.team === rec.record_id);
    const memberClusters = (cohort.clusters || []).filter(cl =>
      Array.isArray(cl.teams) && cl.teams.includes(rec.record_id)
    );
    const links = rec.links || {};
    const journey = journeySummary(rec);
    const current = renderQuickRow("current", [
      pill("status", labelize(rec.membership || "visiting")),
      pill(kind === "project" ? "contributors" : "members", `${teamPeople.length}`),
      pill("domain", rec.domain ? domainLabel(rec.domain) : ""),
      pill("geo", rec.geo),
    ]);
    const nextMove = renderQuickRow("next move", [
      quickText("", rec.now || journey?.next),
    ]);
    const needs = renderQuickRow("needs",
      asArray(rec.seeking).slice(0, 2).map(value => quickText("", value))
    );
    const provides = renderQuickRow("provides",
      asArray(rec.offering).slice(0, 2).map(value => quickText("", value))
    );
    const proof = renderQuickRow("proof", [
      quickText("traction", rec.traction),
      quickText("shipping", firstValue(rec.prior_shipping)),
      quickText("paper", firstValue(rec.paper_basis)),
    ]);
    const trajectory = journey ? renderQuickRow("trajectory", [
      pill("stage", `${journey.stage} ${journey.stageLabel}`),
      pill("evidence", `${journey.evidence}/5${journey.evidenceLabel ? ` ${journey.evidenceLabel}` : ""}`),
      pill("upside", `${journey.upside}/5`),
      pill("bottleneck", journey.bottleneck),
      quickText("next", journey.next),
    ]) : "";
    const explore = renderQuickRow("explore", [
      quickLink("GitHub", linkForKey(links, "github")),
      quickLink("Repo", linkForKey(links, "repo")),
      quickLink("X", linkForKey(links, "x")),
      quickLink("Website", linkForKey(links, "website")),
      quickLink("Demo", linkForKey(links, "demo")),
      quickLink("Deck", linkForKey(links, "deck")),
      quickLink("source", editUrl),
    ]);
    const aboutRows = [
      renderRow("focus", rec.focus),
      renderRow("current work", rec.now),
      renderRow(kind === "project" ? "contributors" : "members", `${teamPeople.length} ${teamPeople.length === 1 ? "person" : "people"}`),
    ];
    const routeRows = [
      renderRow("dependencies", rec.dependencies),
      renderRow("skill areas", rec.skill_areas),
      renderRow("success dimensions", rec.success_dimensions),
    ];
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
    const guild = memberClusters.length
      ? `<div class="cd-clusters">${memberClusters.map(cl => `<span class="cd-cluster">${escHtml(cl.label)}</span>`).join("")}</div>`
      : "";

    return `
      ${renderTeamRail(rec, teamPeople, fam, kind)}
      <section class="cd-ledger">
        <div class="cd-ledger-head">
          <span class="cd-h">${escHtml(kind)} read</span>
        </div>
        <div class="cd-quick">${current}${nextMove}${needs}${provides}${proof}${trajectory}${explore}</div>
        <div class="cd-section-stack">
          ${renderSection("current read", aboutRows, true)}
          ${renderSection("routes / asks", routeRows)}
          ${renderSection("trajectory", trajectoryRows)}
          ${renderSection("evidence", evidenceRows)}
          ${renderSection(kind === "project" ? "contributors" : "members", renderTeamPeople(rec.record_id, kind))}
          ${renderSection("links", renderLinkList(links))}
          ${renderSection("guild", guild)}
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
      surface.hidden = true;
      toolbar.hidden = true;
      grid.hidden = true;
      detailHost.hidden = false;
      renderDetail(rec);
      window.scrollTo({ top: 0, behavior: "auto" });
    } else {
      detailHost.hidden = true;
      detailHost.innerHTML = "";
      surface.hidden = false;
      toolbar.hidden = false;
      grid.hidden = false;
      renderGrid();
    }
  }

  for (const btn of mount.querySelectorAll(".cohort-chip[data-kind]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === state.kind) return;
      state.kind = btn.dataset.kind;
      state.membership = DEFAULT_MEMBERSHIP;
      for (const b of mount.querySelectorAll(".cohort-chip[data-kind]")) {
        b.setAttribute("aria-selected", String(b.dataset.kind === state.kind));
      }
      renderGrid();
    });
  }

  const countsEl = document.getElementById("cohort-counts");
  if (countsEl) {
    const teamWord = teams.length === 1 ? "team" : "teams";
    const personWord = people.length === 1 ? "person" : "people";
    countsEl.textContent = `${teams.length} ${teamWord} / ${people.length} ${personWord}`;
    countsEl.hidden = false;
  }

  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
})();
