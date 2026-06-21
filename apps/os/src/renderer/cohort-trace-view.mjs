// cohort-trace-view.mjs — the ONE reusable "follow the trace" renderer.
//
// Every insight card the engine emits carries content_json.trace { method, version,
// basis, confidence, confidence_basis, signals[], inputs[], recompute }. This module
// turns that into HTML, identically wherever an insight is shown (say/did/shipped row,
// ecosystem-map edge inspector, evidence card, dossier). At rest it is a compact
// evidence chip — basis + confidence — that the resting label already explains; click
// to expand the full reasoning: each weighted signal, the source it was computed from,
// and how to recompute it. One renderer = one vocabulary = low complexity, and the
// `basis` axis (observed | declared | inferred) is always visible so an inference is
// never read as an observed fact.

// How we KNOW the claim (its mood). Kept distinct from review_status (whether a human
// confirmed it). The split[0] of the key also drives the colour class so the four
// basis values read as a calm three-step honesty scale.
const BASIS_META = {
  observed: { label: "observed", tone: "observed", note: "a public artifact / metadata fact" },
  declared: { label: "declared", tone: "declared", note: "the team's own field, unverified" },
  inferred: { label: "inferred", tone: "inferred", note: "derived by the engine, not confirmed" },
  observed_with_inferred_identity: { label: "observed · inferred identity", tone: "inferred", note: "commits observed; the author→person match is heuristic" },
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function shortText(value, max = 120) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The human label for a source ref — kind + the most resolvable id we have.
function refLabel(ref) {
  if (!ref || typeof ref !== "object") return "";
  const kind = String(ref.kind || "ref").replace(/_/g, " ");
  const id = ref.artifact_id || ref.record_id || ref.label || ref.source_repo || ref.path || "";
  return id ? `${kind}: ${id}` : kind;
}

// The pointer a reader could open to verify the step (path / repo / week).
function refLocator(ref) {
  if (!ref || typeof ref !== "object") return "";
  return ref.path || ref.source_repo || (ref.week_start ? `week ${ref.week_start}` : "") || ref.record_id || "";
}

// Flatten a signal value to a short human string. Arrays of {term}/{person_name}/{name}
// read as a comma list; scalars pass through; objects fall back to compact JSON.
function signalValueText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item == null) return "";
      if (typeof item === "object") {
        const head = item.term || item.person_name || item.name || (item.from_team && `${item.from_team}→${item.to_team}`) || "";
        const weight = Number.isFinite(item.idf_weight) ? ` (${item.idf_weight})` : "";
        return head ? `${head}${weight}` : "";
      }
      return String(item);
    }).filter(Boolean).join(", ");
  }
  if (typeof value === "object") return "";
  return String(value);
}

function signalRow(signal) {
  const name = esc(String(signal.name || "").replace(/_/g, " "));
  const contribution = Number.isFinite(signal.contribution) && Number.isFinite(signal.of)
    ? `<span class="trace-sig-weight" title="contribution to the score">${signal.contribution}<span class="trace-sig-of">/${signal.of}</span></span>`
    : "";
  const valueText = signalValueText(signal.value);
  const value = valueText ? `<span class="trace-sig-value">${esc(shortText(valueText, 150))}</span>` : "";
  const detail = signal.detail ? `<span class="trace-sig-detail">${esc(shortText(signal.detail, 90))}</span>` : "";
  const refs = (Array.isArray(signal.source_refs) ? signal.source_refs : [])
    .slice(0, 4)
    .map((ref) => `<span class="trace-ref" title="${esc(refLocator(ref))}">${esc(shortText(refLabel(ref), 64))}</span>`)
    .join("");
  const refsBlock = refs ? `<span class="trace-sig-refs">${refs}</span>` : "";
  return `<li class="trace-sig"><span class="trace-sig-head"><span class="trace-sig-name">${name}</span>${contribution}</span>${value}${detail}${refsBlock}</li>`;
}

// Shared inner pieces, so the standalone disclosure and the embedded (bare) form render
// identically. Returns null when there is no real trace.
function traceParts(trace) {
  if (!trace || typeof trace !== "object" || !trace.method) return null;
  const basis = String(trace.basis || "");
  const meta = BASIS_META[basis] || { label: basis.replace(/_/g, " ") || "ungraded", tone: "x", note: "" };
  const confidence = esc(String(trace.confidence || "").replace(/-/g, "–"));
  const chip = `<span class="trace-basis trace-basis-${esc(meta.tone)}" title="${esc(meta.note)}">${esc(meta.label)}</span>`;
  const conf = confidence ? `<span class="trace-conf">${confidence} confidence</span>` : "";
  const why = trace.confidence_basis ? `<p class="trace-why">${esc(shortText(trace.confidence_basis, 260))}</p>` : "";
  const signals = (Array.isArray(trace.signals) ? trace.signals : []).filter((s) => s && s.name);
  const sigList = signals.length ? `<ul class="trace-signals">${signals.map(signalRow).join("")}</ul>` : "";
  const stamp = `${esc(trace.method)}@${esc(String(Number.isFinite(trace.version) ? trace.version : 1))}`;
  const recompute = trace.recompute
    ? `<p class="trace-recompute"><span class="trace-method">${stamp}</span><span class="trace-recompute-note">recompute · ${esc(shortText(trace.recompute, 170))}</span></p>`
    : `<p class="trace-recompute"><span class="trace-method">${stamp}</span></p>`;
  return { chip, conf, why, sigList, recompute };
}

// Standalone "follow the trace" disclosure. Returns "" when there is no trace, so callers
// can append it unconditionally. `open` expands it at first paint.
export function traceViewHtml(trace, { open = false } = {}) {
  const p = traceParts(trace);
  if (!p) return "";
  return `<details class="trace-view"${open ? " open" : ""}>`
    + `<summary class="trace-summary">${p.chip}${p.conf}<span class="trace-summary-cue">why</span></summary>`
    + `<div class="trace-body">${p.why}${p.sigList}${p.recompute}</div>`
    + `</details>`;
}

// Bare form (no disclosure) for embedding inside a panel/section that is ALREADY an
// expandable — e.g. a team inspector "how this reads" section. Shows the basis + confidence
// header then the reasoning, always visible.
export function traceBodyHtml(trace) {
  const p = traceParts(trace);
  if (!p) return "";
  return `<div class="trace-view trace-bare">`
    + `<div class="trace-head">${p.chip}${p.conf}</div>`
    + `<div class="trace-body">${p.why}${p.sigList}${p.recompute}</div>`
    + `</div>`;
}

function cardTrace(card) {
  return card && card.content_json && typeof card.content_json === "object" ? card.content_json.trace : null;
}

// Convenience: pull the trace off a card's content_json and render it.
export function cardTraceHtml(card, opts) {
  return traceViewHtml(cardTrace(card), opts);
}

export function cardTraceBodyHtml(card) {
  return traceBodyHtml(cardTrace(card));
}

export const __testing = { esc, shortText, refLabel, refLocator, signalValueText, BASIS_META };
