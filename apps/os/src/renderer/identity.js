// identity.js — the local "who am I in this cohort" record. Stored only
// in localStorage (private to this device); nothing here travels to
// swf-node or github. The published cohort record is whatever lives in
// cohort-data/{teams,people}/<slug>.md — this module just remembers
// which one of those records belongs to the user so the app can
// (a) show their team name in the top-right, (b) jump straight to
// their record from the profile editor, and (c) skip the onboarding
// modal on subsequent launches.

import { getCohortSurface, subscribeToCohortChanges, refreshCohortFromGithub } from "./cohort-source.js";
import { mountShape, hashColors, sphereAttrs } from "@shape-rotator/shape-ui";
import { SPHERE_DEFAULTS, SPHERE_BG_DEFAULT, SPHERE_BG_MIX_DEFAULT, normalizeHex } from "./supabase-sphere.mjs";
import { compileUserExpr } from "./shader-dsl.mjs";

// Resolve a person's sphere into mountShape opts (saved Supabase override →
// hash-derived default). Mirrors the editor's dial→uniform mapping so the pill
// avatar reflects ALL five saved dials. (u_phase/u_hue2 stay hash-derived and
// the rim glow is fixed inside mountShape regardless of the column values.)
function personSphereMountOpts(recordId, cohort, scale = 1.0) {
  const saved = cohort?.person_spheres?.[recordId] || null;
  const base = hashColors(recordId || "");
  const num = (v, d) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : d);
  return {
    seed: recordId, kind: "person", scale,
    hue:   num(saved?.hue, base.hue),                        // Spectral Phase
    warp:  num(saved?.phase, 0),                             // Fracture Field
    progress: num(saved?.complexity, SPHERE_DEFAULTS.complexity),  // Recursion Depth
    iters: num(saved?.hue2, SPHERE_DEFAULTS.hue2),           // Strata
    sharp: num(saved?.intensity, SPHERE_DEFAULTS.intensity), // Filament
    bg: normalizeHex(saved?.bg) || SPHERE_BG_DEFAULT,        // Orb Core colour
    bgMix: num(saved?.bg_mix, SPHERE_BG_MIX_DEFAULT),        // Orb Core amount
    // Custom shader: validate the UNTRUSTED stored text → safe GLSL (null if
    // empty/invalid; mountShape falls back to the standard shader either way).
    shaderExpr: compileUserExpr(saved?.shader_src || "").glsl || null,
  };
}

const IDENTITY_LS_KEY = "srwk:identity_v1";
const ONBOARDING_SKIP_LS_KEY = "srwk:identity_onboarding_skipped_v1";
const ONBOARDING_SKIP_EVENT = "srwk:identity-onboarding-skip-changed";

// Listeners fire whenever the identity changes (claim, switch, clear).
// Used by the top-right pill to repaint and by alchemy.js to surface
// the user's record in the editor on demand.
const _listeners = new Set();

let _cached = null;

export function getIdentity() {
  if (_cached) return _cached;
  try {
    const raw = localStorage.getItem(IDENTITY_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !v.record_id || !v.kind) return null;
    _cached = v;
    return v;
  } catch {
    return null;
  }
}

export function setIdentity(record) {
  // Accept either {kind, record_id, display_name} or a raw cohort record.
  const v = {
    kind: record.kind || record.record_type || "person",
    record_id: String(record.record_id),
    display_name: record.display_name || record.name || record.record_id,
    claimed_at: record.claimed_at || new Date().toISOString(),
  };
  _cached = v;
  try { localStorage.setItem(IDENTITY_LS_KEY, JSON.stringify(v)); } catch {}
  setIdentityOnboardingSkipped(false);
  for (const cb of _listeners) { try { cb(v); } catch {} }
  return v;
}

export function clearIdentity() {
  _cached = null;
  try { localStorage.removeItem(IDENTITY_LS_KEY); } catch {}
  for (const cb of _listeners) { try { cb(null); } catch {} }
}

export function onIdentityChanged(cb) {
  if (typeof cb !== "function") return () => {};
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export function hasSkippedIdentityOnboarding() {
  try { return localStorage.getItem(ONBOARDING_SKIP_LS_KEY) === "1"; }
  catch { return false; }
}

export function setIdentityOnboardingSkipped(skipped) {
  const next = !!skipped;
  try {
    if (next) localStorage.setItem(ONBOARDING_SKIP_LS_KEY, "1");
    else localStorage.removeItem(ONBOARDING_SKIP_LS_KEY);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(ONBOARDING_SKIP_EVENT, { detail: { skipped: next } }));
  } catch {}
}

// Resolve the identity to a *displayable* {label, avatar, kind} bundle.
// Person claims surface their NAME (not team) per UI feedback, with an
// avatar derived from the linked github handle when present. Team/project
// claims still surface the record's name. Falls back to the persisted
// display_name when cohort can't resolve.
export async function resolveIdentityLabel() {
  const id = getIdentity();
  if (!id) return null;
  let cohort;
  try { cohort = await getCohortSurface(); } catch { cohort = null; }
  if (!cohort) {
    return { label: id.display_name, kind: id.kind, record_id: id.record_id, avatar: null };
  }
  if (id.kind === "person") {
    const person = (cohort.people || []).find(p => p.record_id === id.record_id);
    const gh = person?.links?.github || null;
    const avatar = gh ? `https://github.com/${encodeURIComponent(gh)}.png?size=80` : null;
    return {
      label: person?.name || id.display_name,
      kind: "person",
      record_id: id.record_id,
      avatar,
      gh,
    };
  }
  // team / project → look up the live record so renames flow through.
  const t = (cohort.teams || []).find(x => x.record_id === id.record_id);
  const tgh = t?.links?.github || null;
  return {
    label: t?.name || id.display_name,
    kind: id.kind,
    record_id: id.record_id,
    avatar: tgh ? `https://github.com/${encodeURIComponent(tgh)}.png?size=80` : null,
    gh: tgh,
  };
}

// ─── identity pill ───────────────────────────────────────────────────
// Mounted into a hidden staging host, then relocated by boot.js into the
// footer row overlaying the bottom of the left side panel. Click → open the profile
// page (alchemy mode "profile"), which hosts the inline re-seal card.
// (alchemy.js exposes window-level helpers `__srwkGoProfilePage()` /
// `__srwkOpenProfile(id)` so we can route without importing it and
// creating a cycle.)

let _pillEl = null;
let _pillSphereCtl = null;   // dedicated mountShape for the pill avatar (global; the alchemy-only overlay can't paint it off-tab)

export function mountIdentityPill(host) {
  if (!host || _pillEl) return;
  const pill = document.createElement("button");
  pill.id = "identity-pill";
  pill.className = "identity-pill";
  pill.type = "button";
  pill.title = "your profile — click to open";
  pill.innerHTML = `
    <span class="ip-avatar" aria-hidden="true"><span class="ip-glyph">◐</span></span>
    <span class="ip-label">claim profile</span>
  `;
  // The whole pill opens the profile page (the orb here is a still avatar — the
  // editor is reached by clicking the orb in the "your seal" card on that page).
  pill.addEventListener("click", openIdentityFlow);
  host.appendChild(pill);
  _pillEl = pill;
  paintIdentityPill();
  onIdentityChanged(paintIdentityPill);
  // Cohort changes can rename the team — repaint when bundles arrive.
  subscribeToCohortChanges(() => paintIdentityPill());
}

async function paintIdentityPill() {
  if (!_pillEl) return;
  const id = getIdentity();
  const avatarEl = _pillEl.querySelector(".ip-avatar");
  const labelEl  = _pillEl.querySelector(".ip-label");
  if (_pillSphereCtl) { try { _pillSphereCtl.destroy(); } catch {} _pillSphereCtl = null; }
  if (!id) {
    _pillEl.dataset.state = "unclaimed";
    labelEl.textContent = "claim profile";
    _pillEl.title = "tell shape rotator who you are";
    // Reset avatar to the glyph fallback.
    avatarEl.innerHTML = `<span class="ip-glyph">◐</span>`;
    return;
  }
  const resolved = await resolveIdentityLabel();
  _pillEl.dataset.state = "claimed";
  _pillEl.dataset.kind = resolved?.kind || id.kind;
  labelEl.textContent = resolved?.label || id.display_name;
  _pillEl.title = `you: ${id.kind} · ${id.record_id}${resolved?.gh ? ` · @${resolved.gh}` : ""}\nclick to open your profile`;
  // Avatar: a claimed PERSON shows their live sphere medallion (their
  // customizable identity); team/project/no-handle fall back to the github
  // image or two-letter initials.
  const fallbackInitials = labelInitials(resolved?.label || id.display_name);
  if (id.kind === "person") {
    const cohort = await getCohortSurface().catch(() => null);
    avatarEl.innerHTML = `<canvas class="ip-avatar-sphere"></canvas>`;
    const cv = avatarEl.querySelector("canvas");
    // animate:false → a STILL orb in the pill (no spin in the bottom-left corner).
    try { _pillSphereCtl = mountShape(cv, { ...personSphereMountOpts(id.record_id, cohort, 1.0), animate: false }); } catch {}
  } else if (resolved?.avatar) {
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.className = "ip-avatar-img";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    img.src = resolved.avatar;
    // Network failure / 404 → swap in the initials fallback in place.
    img.addEventListener("error", () => {
      avatarEl.innerHTML = `<span class="ip-initials">${escHtml(fallbackInitials)}</span>`;
    }, { once: true });
    avatarEl.appendChild(img);
  } else {
    avatarEl.innerHTML = `<span class="ip-initials">${escHtml(fallbackInitials)}</span>`;
  }
}

function labelInitials(label) {
  const s = String(label || "").trim();
  if (!s) return "·";
  // Take the first letter of each word, up to two; uppercased.
  const parts = s.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map(p => p[0]).join("").toUpperCase() || s[0].toUpperCase();
}

// Click on the pill: open the profile page. The re-seal controls that
// used to live in a popup here are now rendered inline at the bottom of
// that page (mountResealInline, called by alchemy's renderProfile). The
// modal survives only as the automatic first-launch onboarding flow.
function openIdentityFlow() {
  if (!getIdentity()) {
    setIdentityOnboardingSkipped(false);
    showOnboardingModal();
    return;
  }
  if (typeof window.__srwkGoProfilePage === "function") {
    window.__srwkGoProfilePage();
  } else {
    // alchemy hasn't registered its navigation hook yet (very early
    // boot) — fall back to the modal so the click still does something.
    showOnboardingModal();
  }
}

try { window.__srwkOpenIdentityFlow = openIdentityFlow; } catch {}
// Repaint the pill avatar (its live sphere) on demand — alchemy calls this right
// after a sphere save so the pill reflects the new look without a full reload.
try { window.__srwkRepaintIdentityAvatars = () => { try { paintIdentityPill(); } catch {} }; } catch {}

// ─── onboarding modal ────────────────────────────────────────────────
// First-launch (or when the user clears identity) prompt. Shows the
// existing cohort records they could claim, plus a "create new" path.

let _modalEl = null;

export async function maybeShowOnboarding() {
  if (getIdentity()) return; // already claimed
  if (hasSkippedIdentityOnboarding()) return; // user explicitly chose "not yet"
  // Defer until cohort is available — there's nothing to claim otherwise.
  let cohort = null;
  try { cohort = await getCohortSurface(); } catch {}
  if (!cohort) return;
  showOnboardingModal(cohort);
}

async function showOnboardingModal(cohortHint) {
  if (_modalEl) return; // already open
  const overlay = document.createElement("div");
  overlay.className = "identity-modal-backdrop";
  _modalEl = overlay; // claim the slot before the await so a second call can't double-open
  const card = document.createElement("div");
  card.className = "identity-modal enroll lg-track";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-labelledby", "im-title");
  overlay.appendChild(card);

  let cleanup = () => {};
  const close = () => {
    try { cleanup(); } catch {}
    overlay.remove();
    _modalEl = null;
  };
  cleanup = await renderResealCard(card, { variant: "modal", cohortHint, close });
  document.body.appendChild(overlay);

  // Click outside the card → close (treat as skip).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      if (!getIdentity()) setIdentityOnboardingSkipped(true);
      close();
    }
  });
}

// ─── re-seal card (shared by modal + profile page) ──────────────────
// Renders the claim / re-seal / strike-new / resync controls into `host`
// and wires them. Two variants:
//   "modal"  — the first-launch onboarding popup. Actions close the
//              overlay (via the `close` hook); a skip/close button is
//              present in the footer.
//   "inline" — the section at the bottom of the profile page (merged
//              from the pill popup 2026-06). No skip button; actions
//              repaint the card in place (via `repaint`) or hand off to
//              the editor on the same page via __srwkOpenProfile.
// Returns a cleanup fn (drops the cohort-change subscription).
async function renderResealCard(host, { variant, cohortHint, close, repaint, sealExtras = {} }) {
  const inline = variant === "inline";
  const cohort = cohortHint || (await getCohortSurface().catch(() => null));
  const teams = cohort?.teams || [];
  const pools = {
    person:  cohort?.people || [],
    team:    teams.filter(t => (t.kind || "team") === "team"),
    project: teams.filter(t => (t.kind || "team") === "project"),
  };

  const currentId = getIdentity();
  const currentResolved = currentId ? await resolveIdentityLabel() : null;
  const claimed = !!currentId;

  // Pre-select the current claim's record in the matching dropdown so
  // switching is "open dropdown, pick a different name." Otherwise the
  // selects start empty.
  const optHtml = (records, kind) => records.map(r => {
    const isCurrent = claimed && currentId.kind === kind && currentId.record_id === r.record_id;
    return `<option value="${escAttr(r.record_id)}" ${isCurrent ? "selected" : ""}>${escHtml(r.name || r.record_id)}${kind === "person" && r.team ? ` · ${escHtml(r.team)}` : ""}</option>`;
  }).join("");

  // Record pickers — shared between both variants; only the row class
  // differs (modal keeps the ember .im-row grid, inline rides the same
  // .alch-pf-row grid the editor above it uses).
  const selectRows = (rowCls) => `
    <label class="${rowCls}"><span>person</span>
      <select data-im-pick="person">
        <option value="">— you —</option>
        ${optHtml(pools.person, "person")}
      </select>
    </label>
    <label class="${rowCls}"><span>team</span>
      <select data-im-pick="team">
        <option value="">— your team —</option>
        ${optHtml(pools.team, "team")}
      </select>
    </label>
    <label class="${rowCls}"><span>project</span>
      <select data-im-pick="project">
        <option value="">— your project —</option>
        ${optHtml(pools.project, "project")}
      </select>
    </label>
  `;

  if (inline) {
    // Editorial variant — the seal is a SUMMARY card only. Editing,
    // switching, and creating records all happen in the record editor on
    // the same page: its picker plus the "this is me" claim button
    // (alchemy.js) replaced the duplicate re-seal pickers, "+ new"
    // buttons, and "edit my record" that used to live here. What's left
    // is identity state plus its two rare actions.
    const label = currentResolved?.label || currentId?.display_name || "";
    const initials = labelInitials(label);
    const resyncHtml = `
      <button class="alch-seal-btn" data-im-resync type="button"
              title="re-pull cohort-data/*.md from github. background pulls run hourly; click to refresh now.">
        <span class="im-resync-label">re-sync the rolls</span>
      </button>
    `;
    // Contact block — pulled from the full cohort record so the card
    // answers "is this really me?": github + x handles, each tagged with its
    // platform logo so the handle is unambiguous; then email + team.
    let contactHtml = "";
    if (claimed) {
      const rec = (pools[currentId.kind] || []).find(r => r.record_id === currentId.record_id) || null;
      const teamName = rec?.team
        ? ((pools.team.find(t => t.record_id === rec.team) || pools.project.find(t => t.record_id === rec.team))?.name || rec.team)
        : null;
      const stripAt = (h) => String(h || "").replace(/^@+/, "").trim();
      const ghHandle = stripAt(rec?.links?.github || currentResolved?.gh || "");
      const xHandle = stripAt(rec?.links?.x || "");
      const GH_LOGO = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;
      const X_LOGO = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`;
      const handles = [];
      if (ghHandle) handles.push(`<a class="alch-seal-handle" href="https://github.com/${encodeURIComponent(ghHandle)}" data-seal-link title="github · open in browser">${GH_LOGO}<span>${escHtml(ghHandle)}</span></a>`);
      if (xHandle) handles.push(`<a class="alch-seal-handle" href="https://x.com/${encodeURIComponent(xHandle)}" data-seal-link title="x / twitter · open in browser">${X_LOGO}<span>${escHtml(xHandle)}</span></a>`);
      const handlesHtml = handles.length ? `<div class="alch-seal-handles">${handles.join("")}</div>` : "";
      // Team / project → clickable: opens that record's page in a new app tab.
      const teamId = rec?.team || null;
      const teamHtml = teamName
        ? (teamId
            ? `<a class="alch-seal-team" href="#" data-seal-team="${escAttr(teamId)}" title="open ${escAttr(teamName)} in a new tab">${escHtml(teamName)}</a>`
            : escHtml(teamName))
        : "";
      const metaPieces = [];
      if (rec?.email) metaPieces.push(escHtml(rec.email));
      if (teamHtml) metaPieces.push(teamHtml);
      const metaHtml = metaPieces.length ? `<span class="alch-seal-contact">${metaPieces.join(" · ")}</span>` : "";
      contactHtml = handlesHtml + metaHtml;
    }
    // Edges + "system read" — carried over from the retired membrane self
    // panel so "your seal" now leads with everything that card showed.
    let edgesHtml = "";
    let readHtml = "";
    if (claimed) {
      const connCount = Array.isArray(sealExtras.connections) ? sealExtras.connections.length : 0;
      const edgeCount = sealExtras.edgeCount;
      if (edgeCount != null && edgeCount !== "") {
        edgesHtml = `
          <div class="alch-seal-edges">
            <span class="alch-seal-edges-v">${escHtml(String(edgeCount))} · ${connCount} connection${connCount === 1 ? "" : "s"}</span>
          </div>`;
      }
      const readText = sealExtras.read?.text || "";
      if (readText) {
        readHtml = `
          <div class="alch-seal-read">
            <p class="alch-seal-read-body">${escHtml(readText)}</p>
          </div>`;
      }
    }
    host.innerHTML = `
      <h3 class="alch-profile-h">your seal</h3>
      ${claimed ? `
        <div class="alch-seal-box">
        <div class="alch-seal-current">
          <span class="alch-seal-avatar${currentId?.kind === "person" ? " alch-seal-avatar-sphere" : ""}"${currentId?.kind === "person"
            ? ` role="button" tabindex="0" title="customize your sphere" data-seal-edit-sphere`
            : ` aria-hidden="true"`}>${currentId?.kind === "person"
            ? `<canvas class="alch-seal-avatar-canvas" data-shape-fam="0" data-shape-kind="person" data-shape-scale="1.85" data-shape-seed="${escAttr(currentId.record_id)}" ${sphereAttrs(cohort?.person_spheres?.[currentId.record_id])}></canvas>`
            : (currentResolved?.avatar
                ? `<img class="alch-seal-avatar-img" alt="" />`
                : `<span class="alch-seal-initials">${escHtml(initials)}</span>`)}</span>
          <div class="alch-seal-who">
            <span class="alch-seal-name">${escHtml(label)}</span>
            ${contactHtml}
          </div>
          <div class="alch-seal-actions">
            ${resyncHtml}
            <button class="alch-seal-btn alch-seal-btn-danger" type="button" data-im-action="unclaim">break the seal</button>
          </div>
        </div>
        ${edgesHtml}
        ${readHtml}
        </div>
      ` : `
        <p class="alch-seal-empty">no seal yet — pick your record in the editor below and press <strong>this is me</strong>. stored on this device, never broadcast.</p>
        <div class="alch-seal-btnrow">${resyncHtml}</div>
      `}
    `;
    // Avatar image: src + error fallback wired here (not in the template)
    // so a 404/offline github swaps in the initials without inline JS.
    const avatarImg = host.querySelector(".alch-seal-avatar-img");
    if (avatarImg && currentResolved?.avatar) {
      avatarImg.referrerPolicy = "no-referrer";
      avatarImg.loading = "lazy";
      avatarImg.src = currentResolved.avatar;
      avatarImg.addEventListener("error", () => {
        const wrap = avatarImg.closest(".alch-seal-avatar");
        if (wrap) wrap.innerHTML = `<span class="alch-seal-initials">${escHtml(initials)}</span>`;
      }, { once: true });
    }
    // Person seal avatar is the live sphere — click (or Enter/Space) opens the
    // sphere editor popup, same as clicking the bottom-left pill avatar.
    const sealSphere = host.querySelector("[data-seal-edit-sphere]");
    if (sealSphere) {
      const openIt = () => { try { window.__srwkOpenSphereEditor?.(); } catch {} };
      sealSphere.addEventListener("click", openIt);
      sealSphere.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); }
      });
    }
    // github / x handles open in the system browser. preventDefault so the
    // anchor never navigates the renderer itself.
    host.querySelectorAll("[data-seal-link]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = a.getAttribute("href");
        if (!url) return;
        try { window.api?.openExternal?.(url); } catch {}
      });
    });
    // Team / project → opens that record's cohort page in a new app tab.
    host.querySelectorAll("[data-seal-team]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const id = a.getAttribute("data-seal-team");
        if (!id) return;
        try { window.__srwkOpenInNewTab?.({ tab: "alchemy", mode: "shapes", recordId: id }); } catch {}
      });
    });
  } else {
    host.innerHTML = `
    <div class="enroll-scan" aria-hidden="true"></div>
    <div class="enroll-band">
      <span class="enroll-issuer"><svg class="issuer-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg> shape rotator · alchemy</span>
      <span class="enroll-doc">${claimed ? "re-seal" : "the threshold"}</span>
    </div>

    <header class="im-head">
      <h2 id="im-title" class="im-title">
        ${claimed ? "re-seal" : "identify yourself"}
      </h2>
      <p class="im-sub">
        ${claimed
          ? `sealed as <strong>${escHtml(currentResolved?.label || currentId.display_name)}</strong> <span class="im-current-kind">(${escHtml(currentId.kind)} · ${escHtml(currentId.record_id)})</span>. choose another shape to re-seal, or use the controls below.`
          : "strike your seal to cross into the cohort. your shape, your record — stored on this device, never broadcast."}
      </p>
      ${claimed ? `
        <div class="im-current-actions">
          <button class="im-btn im-current-edit"    type="button" data-im-action="edit">edit my record →</button>
          <button class="im-btn im-current-unclaim" type="button" data-im-action="unclaim">break the seal</button>
        </div>
      ` : ""}
    </header>

    <section class="im-section">
      <h3 class="im-h"><span class="im-h-no">01</span> ${claimed ? "re-seal as another shape" : "find your shape"}</h3>
      ${selectRows("im-row")}
    </section>

    <section class="im-section">
      <h3 class="im-h"><span class="im-h-no">02</span> ${claimed ? "or strike a new shape" : "not on the rolls yet"}</h3>
      <p class="im-sub" style="margin:0 0 12px 0">opens the editor with a blank shape — submit a PR to join.</p>
      <div class="im-create-row">
        <button class="im-btn im-create" data-create="person"  type="button">+ new person</button>
        <button class="im-btn im-create" data-create="team"    type="button">+ new team</button>
        <button class="im-btn im-create" data-create="project" type="button">+ new project</button>
      </div>
    </section>

    <footer class="im-foot">
      <button class="im-resync" data-im-resync type="button"
              title="re-pull cohort-data/*.md from github. background pulls run hourly; click to refresh now.">
        <span class="im-resync-label">re-sync the rolls</span>
      </button>
      <button class="im-skip" data-im-skip type="button">${claimed ? "close" : "not yet →"}</button>
    </footer>
  `;
  }

  // Re-populate the person/team/project dropdowns when the cohort
  // surface refreshes. On a cold first-launch the LS cache or fixture
  // can be sparse (or missing the user entirely) before the GitHub
  // tree fetch lands; without this subscription, the card opens with
  // a half-empty dropdown, the user shrugs and dismisses, and never
  // claims. The subscription gives the dropdown a chance to fill in.
  const refreshSelects = async () => {
    try {
      const fresh = await getCohortSurface();
      const freshTeams = fresh?.teams || [];
      pools.person  = fresh?.people || [];
      pools.team    = freshTeams.filter(t => (t.kind || "team") === "team");
      pools.project = freshTeams.filter(t => (t.kind || "team") === "project");
      const personSel  = host.querySelector('select[data-im-pick="person"]');
      const teamSel    = host.querySelector('select[data-im-pick="team"]');
      const projectSel = host.querySelector('select[data-im-pick="project"]');
      if (personSel) personSel.innerHTML = `<option value="">— pick yourself —</option>${optHtml(pools.person, "person")}`;
      if (teamSel)   teamSel.innerHTML   = `<option value="">— pick a team —</option>${optHtml(pools.team, "team")}`;
      if (projectSel && pools.project.length) {
        projectSel.innerHTML = `<option value="">— pick a project —</option>${optHtml(pools.project, "project")}`;
      }
    } catch {}
  };
  const unsubscribe = subscribeToCohortChanges(() => {
    // Inline cards die by DOM replacement (the profile page re-renders
    // its canvas), not by an explicit close — drop the subscription the
    // first time it fires against a detached host.
    if (!host.isConnected) { try { unsubscribe(); } catch {} return; }
    refreshSelects();
  });
  const cleanup = () => { try { unsubscribe(); } catch {} };

  // Hand off to the editor (same page when inline). Inline: the profile
  // page re-renders with the record loaded, so scroll back up to it.
  const goEditor = (opts) => {
    if (!inline && typeof close === "function") close();
    if (typeof window.__srwkOpenProfile === "function") window.__srwkOpenProfile(opts);
    if (inline) {
      try { document.getElementById("alchemy-canvas")?.scrollTo({ top: 0 }); } catch {}
    }
  };

  // Current-claim quick actions (only present when claimed).
  for (const btn of host.querySelectorAll("[data-im-action]")) {
    btn.addEventListener("click", () => {
      const a = btn.dataset.imAction;
      if (a === "edit") {
        goEditor({ kind: currentId.kind, record_id: currentId.record_id, mode: "edit" });
      } else if (a === "unclaim") {
        // Confirm-in-place — flips the button to "really clear?" so an
        // accidental click doesn't drop the user's saved identity.
        if (btn.dataset.confirming === "1") {
          clearIdentity();
          if (inline) { if (typeof repaint === "function") repaint(); }
          else if (typeof close === "function") close();
        } else {
          btn.dataset.confirming = "1";
          btn.textContent = "really clear? · click again";
        }
      }
    });
  }

  // Pickers: claim by record. On first claim we drop the user into their
  // editor so they can verify the record. On a SWITCH (already claimed,
  // picking a different record) the modal just closes / the inline card
  // repaints — the user is mid-task and doesn't want to be yanked into a
  // form. Picking the SAME record is a no-op close.
  const wirePick = (kind) => {
    const sel = host.querySelector(`select[data-im-pick="${kind}"]`);
    if (!sel) return;
    sel.addEventListener("change", () => {
      const id = sel.value;
      if (!id) return;
      const rec = (pools[kind] || []).find(r => r.record_id === id);
      if (!rec) return;
      const isSame = claimed
        && currentId.kind === kind
        && currentId.record_id === rec.record_id;
      if (isSame) {
        if (!inline && typeof close === "function") close();
        return;
      }
      setIdentity({ kind, record_id: rec.record_id, display_name: rec.name || rec.record_id });
      if (!claimed) {
        // First claim → land in the editor so they can verify their record.
        goEditor({ kind, record_id: rec.record_id, mode: "edit" });
        return;
      }
      // Switch case: the bottom-left pill repaints via the
      // onIdentityChanged listener; the user stays where they were.
      if (inline) { if (typeof repaint === "function") repaint(); }
      else if (typeof close === "function") close();
    });
  };
  wirePick("person");
  wirePick("team");
  wirePick("project");

  // Create paths: route to alchemy/profile/add — they can claim after PR merges.
  for (const btn of host.querySelectorAll("[data-create]")) {
    btn.addEventListener("click", () => {
      goEditor({ kind: btn.dataset.create, mode: "add" });
    });
  }

  host.querySelector("[data-im-skip]")?.addEventListener("click", () => {
    if (!claimed) setIdentityOnboardingSkipped(true);
    if (typeof close === "function") close();
  });

  // Manual github resync. Background refresh is throttled to once per
  // hour (the cohort 60 req/hr unauth GH budget is the constraint on a
  // LAN where multiple cohort members share an IP — see cohort-source.js).
  // This button bypasses the throttle so a user can pull fresh data
  // immediately after a PR merges.
  const resyncBtn = host.querySelector("[data-im-resync]");
  resyncBtn?.addEventListener("click", async () => {
    if (resyncBtn.dataset.busy === "1") return;
    resyncBtn.dataset.busy = "1";
    const labelEl = resyncBtn.querySelector(".im-resync-label");
    const originalLabel = labelEl?.textContent || "resync from github";
    if (labelEl) labelEl.textContent = "resyncing…";
    try {
      await refreshCohortFromGithub();
      if (labelEl) labelEl.textContent = "synced";
      refreshSelects(); // dropdowns in this card reflect the newest cohort
    } catch (e) {
      if (labelEl) labelEl.textContent = "resync failed";
      console.warn("[identity] manual cohort resync failed:", e?.message || e);
    } finally {
      // Settle back to the original label so a second click reads correctly.
      setTimeout(() => {
        if (labelEl) labelEl.textContent = originalLabel;
        resyncBtn.dataset.busy = "0";
      }, 1500);
    }
  });

  return cleanup;
}

// ─── inline re-seal section on the profile page ──────────────────────
// Called by alchemy's profile renderer with the host <section>. Repaints
// in place on claim / switch / unclaim; cleans up the previous render's
// subscription when remounted into the same host.
export async function mountResealInline(host, sealExtras = {}) {
  if (!host) return;
  try { if (typeof host.__resealCleanup === "function") host.__resealCleanup(); } catch {}
  host.classList.add("alch-profile-section", "alch-seal-section");
  host.__resealCleanup = await renderResealCard(host, {
    variant: "inline",
    sealExtras,
    // Identity changes alter the editor too (its "this is me" claim
    // button keys off the current seal), so repaint the whole profile
    // page, not just this card. Falls back to a card-only repaint if
    // alchemy hasn't registered its navigation hook.
    repaint: () => {
      if (typeof window.__srwkGoProfilePage === "function") window.__srwkGoProfilePage();
      else if (host.isConnected) mountResealInline(host, sealExtras);
    },
  });
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(s) { return escHtml(s); }
