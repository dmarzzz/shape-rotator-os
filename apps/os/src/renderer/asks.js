// Shared ask-board logic. Keep this module DOM-free so the membrane panel
// and the full alchemy rail board cannot disagree about freshness, ownership,
// or ask status grouping.

export const ASK_EXPIRY_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const ASK_INTENT_ALIASES = {
  help: "ask",
  request: "ask",
  pair: "ask",
  pairing: "ask",
  join: "come_join",
  "come-join": "come_join",
  activity: "come_join",
  event: "come_join",
  invite: "come_join",
  social: "come_join",
  fyi: "come_join",
  announcement: "come_join",
  update: "come_join",
  note: "come_join",
};
const ASK_INTENT_META = {
  ask: {
    label: "ask",
    section: "asks",
    action: "claim",
    color: "#5E4310",
    light: "#EADBA8",
    paths: `<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/>`,
  },
  come_join: {
    label: "come join",
    section: "come join",
    action: "join",
    color: "#1E4A2A",
    light: "#CAE3C8",
    paths: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>`,
  },
};

export function isoDateOnly(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function askIntent(ask) {
  let raw = String(ask?.intent || ask?.kind || ask?.category || "").trim().toLowerCase();
  if (!raw) raw = "ask";
  raw = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return ASK_INTENT_META[raw] ? raw : (ASK_INTENT_ALIASES[raw] || "ask");
}

export function askIntentLabel(ask) {
  return ASK_INTENT_META[askIntent(ask)]?.label || "ask";
}

export function askIntentSection(ask) {
  return ASK_INTENT_META[askIntent(ask)]?.section || "asks";
}

export function askPrimaryActionLabel(ask) {
  return ASK_INTENT_META[askIntent(ask)]?.action || "claim";
}

export function askStatus(ask) {
  return String(ask?.status || "open").trim().toLowerCase() || "open";
}

export function askTopic(ask) {
  return String(ask?.topic || ask?.title || ask?.text || ask?.ask || "").trim();
}

export function askAgeLabel(ask) {
  const days = ask?._ageDays;
  if (days == null) return "";
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 0) return "scheduled";
  return `${days} days ago`;
}

function relativeDateLabel(value, nowMs = Date.now()) {
  const d = isoDateOnly(value);
  if (!d) return "";
  const today = isoDateOnly(new Date(nowMs).toISOString());
  const dayOffset = today ? Math.floor((d.getTime() - today.getTime()) / DAY_MS) : null;
  let base;
  if (dayOffset === 0) base = "today";
  else if (dayOffset === 1) base = "tomorrow";
  else if (dayOffset === -1) base = "yesterday";
  else {
    base = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(d);
  }
  const m = String(value || "").match(/(?:T|\s)(\d{1,2}:\d{2})/);
  return m ? `${base} ${m[1]}` : base;
}

export function askStartsLabel(ask, nowMs = Date.now()) {
  return relativeDateLabel(ask?.starts_at || ask?.start_at || ask?.date, nowMs);
}

export function askExpiresLabel(ask, nowMs = Date.now()) {
  const label = relativeDateLabel(ask?.expires_at || ask?.ends_at || ask?.end_at, nowMs);
  return label ? `until ${label}` : "";
}

export function askTimeLabel(ask) {
  return askStartsLabel(ask) || askAgeLabel(ask);
}

export function askLocation(ask) {
  return String(ask?.location || ask?.where || "").trim();
}

export function askContact(ask) {
  return String(ask?.contact || ask?.contact_info || ask?.how_to_reach || "").trim();
}

export function askCapacityLabel(ask) {
  const raw = String(ask?.capacity || ask?.spots || "").trim();
  if (!raw) return "";
  return /^\d+$/.test(raw) ? `${raw} spots` : raw;
}

export function askJoinedBy(ask) {
  const raw = ask?.joined_by || ask?.going || ask?.rsvps || [];
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  return values.map((v) => String(v).trim()).filter(Boolean);
}

export function askHasJoined(ask, context = {}) {
  const mine = askIdentityKeys(context);
  if (mine.size === 0) return false;
  for (const value of askJoinedBy(ask)) {
    if (mine.has(normalizeAskIdentity(value))) return true;
  }
  return false;
}

export function askIsOpen(ask) {
  return !!ask && askStatus(ask) === "open" && askIsCurrent(ask);
}

export function askIsCurrent(ask) {
  return !!ask && !ask._expired;
}

export function compareAsksByFreshness(a, b) {
  if (!!a?._expired !== !!b?._expired) return a?._expired ? 1 : -1;
  if (a?._startOffsetDays != null || b?._startOffsetDays != null) {
    const aStart = a?._startOffsetDays == null ? Number.POSITIVE_INFINITY : a._startOffsetDays;
    const bStart = b?._startOffsetDays == null ? Number.POSITIVE_INFINITY : b._startOffsetDays;
    if (aStart !== bStart) return aStart - bStart;
  }
  if (a?._expiresOffsetDays != null || b?._expiresOffsetDays != null) {
    const aExpires = a?._expiresOffsetDays == null ? Number.POSITIVE_INFINITY : a._expiresOffsetDays;
    const bExpires = b?._expiresOffsetDays == null ? Number.POSITIVE_INFINITY : b._expiresOffsetDays;
    if (aExpires !== bExpires) return aExpires - bExpires;
  }
  const aAge = a?._ageDays == null ? 0 : a._ageDays;
  const bAge = b?._ageDays == null ? 0 : b._ageDays;
  if (aAge !== bAge) return aAge - bAge;
  return String(a?.record_id || "").localeCompare(String(b?.record_id || ""));
}

export function asksWithStatus(rawAsks, nowMs = Date.now()) {
  const all = Array.isArray(rawAsks) ? rawAsks.slice() : [];
  const today = isoDateOnly(new Date(nowMs).toISOString());
  return all.map((ask) => {
    const posted = isoDateOnly(ask?.posted_at);
    const starts = isoDateOnly(ask?.starts_at || ask?.start_at || ask?.date);
    const expires = isoDateOnly(ask?.expires_at || ask?.ends_at || ask?.end_at);
    const ageDays = posted ? Math.floor((nowMs - posted.getTime()) / DAY_MS) : null;
    const startOffsetDays = starts && today ? Math.floor((starts.getTime() - today.getTime()) / DAY_MS) : null;
    const expiresOffsetDays = expires && today ? Math.floor((expires.getTime() - today.getTime()) / DAY_MS) : null;
    return {
      ...ask,
      _intent: askIntent(ask),
      _ageDays: ageDays,
      _startOffsetDays: startOffsetDays,
      _expiresOffsetDays: expiresOffsetDays,
      _expired: expiresOffsetDays != null
        ? expiresOffsetDays < 0
        : startOffsetDays != null
          ? startOffsetDays < 0
          : ageDays != null && ageDays >= ASK_EXPIRY_DAYS,
    };
  }).sort(compareAsksByFreshness);
}

export function normalizeAskIdentity(value) {
  let s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^mailto:/, "");
  s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//, "");
  s = s.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, "");
  s = s.replace(/^(?:www\.)?github\.com\//, "");
  s = s.replace(/^(?:www\.)?(?:x|twitter)\.com\//, "");
  s = s.replace(/^@+/, "");
  s = s.split(/[/?#]/)[0];
  return s.trim();
}

function addIdentityKey(set, value) {
  const key = normalizeAskIdentity(value);
  if (key) set.add(key);
}

export function personAskIdentityKeys(person) {
  const keys = new Set();
  if (!person) return keys;
  addIdentityKey(keys, person.record_id);
  addIdentityKey(keys, person.handle);
  addIdentityKey(keys, person.gh_handle);
  addIdentityKey(keys, person.github);
  addIdentityKey(keys, person.email);
  addIdentityKey(keys, person.links?.github);
  addIdentityKey(keys, person.links?.x);
  return keys;
}

export function findPersonByAskIdentity(people, value) {
  const key = normalizeAskIdentity(value);
  if (!key) return null;
  for (const person of Array.isArray(people) ? people : []) {
    if (personAskIdentityKeys(person).has(key)) return person;
  }
  return null;
}

export function resolveAskAuthor(ask, people) {
  return findPersonByAskIdentity(people, ask?.author || ask?.owner);
}

export function resolveAskIdentityPerson({ identity, profileUser, people } = {}) {
  const candidates = [
    identity?.kind === "person" ? identity.record_id : "",
    profileUser?.record_id,
    profileUser?.github,
    profileUser?.gh_handle,
    profileUser?.handle,
    profileUser?.links?.github,
  ];
  for (const candidate of candidates) {
    const person = findPersonByAskIdentity(people, candidate);
    if (person) return person;
  }
  return null;
}

export function askIdentityKeys({ identity, profileUser, people } = {}) {
  const keys = new Set();
  addIdentityKey(keys, identity?.kind === "person" ? identity.record_id : "");
  addIdentityKey(keys, profileUser?.record_id);
  addIdentityKey(keys, profileUser?.github);
  addIdentityKey(keys, profileUser?.gh_handle);
  addIdentityKey(keys, profileUser?.handle);
  addIdentityKey(keys, profileUser?.links?.github);

  const person = resolveAskIdentityPerson({ identity, profileUser, people });
  for (const key of personAskIdentityKeys(person)) keys.add(key);
  return keys;
}

export function askAuthorKeys(ask, people) {
  const keys = new Set();
  addIdentityKey(keys, ask?.author);
  addIdentityKey(keys, ask?.owner);

  const author = resolveAskAuthor(ask, people);
  for (const key of personAskIdentityKeys(author)) keys.add(key);
  return keys;
}

export function isAskMine(ask, context = {}) {
  const mine = askIdentityKeys(context);
  if (mine.size === 0) return false;
  for (const key of askAuthorKeys(ask, context.people)) {
    if (mine.has(key)) return true;
  }
  return false;
}

// ─── verb icons (shared display tokens) ──────────────────────────────
// An ask `verb` carries a leading emoji baked into the stored string
// (e.g. "🤝 pair on") — that data is never modified. This maps the emoji
// to a Lucide line icon + two container hues so the asks UI (alchemy
// board AND the membrane panel) render the icon set instead of the raw
// emoji, consistently. `color` = deep hue (dark mode, white icon);
// `light` = pastel (light mode, black icon). Both emitted as CSS vars.
// Lives here (not in a renderer) so both consumers share one source.
export const ASK_VERB_ICONS = {
  "🤝": { color: "#5E4310", light: "#EADBA8", paths: `<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>` },
  "🎨": { color: "#114248", light: "#BFE1DF", paths: `<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>` },
  "🔬": { color: "#6E241A", light: "#F1CCC4", paths: `<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/>` },
  "🧪": { color: "#1E4A2A", light: "#CAE3C8", paths: `<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>` },
  "📣": { color: "#3E2E58", light: "#DBD0ED", paths: `<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>` },
  "🪛": { color: "#7A3A0F", light: "#F3D8BE", paths: `<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>` },
};
export function askVerbVars(glyph) {
  const def = ASK_VERB_ICONS[glyph];
  if (!def) return null;
  return `--verb-color:${def.color};--verb-color-light:${def.light}`;
}
export function askVerbIconSvg(glyph) {
  const def = ASK_VERB_ICONS[glyph];
  if (!def) return null;
  return `<svg class="alch-asks-verb-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.paths}</svg>`;
}

export function askIntentVars(intent) {
  const def = ASK_INTENT_META[ASK_INTENT_META[intent] ? intent : askIntent({ intent })];
  if (!def) return null;
  return `--verb-color:${def.color};--verb-color-light:${def.light}`;
}

export function askIntentIconSvg(intent) {
  const def = ASK_INTENT_META[ASK_INTENT_META[intent] ? intent : askIntent({ intent })];
  if (!def) return null;
  return `<svg class="alch-asks-verb-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.paths}</svg>`;
}

export function askDisplayVerb(askOrVerb, fallbackIntent = "ask") {
  const ask = askOrVerb && typeof askOrVerb === "object" ? askOrVerb : null;
  const verb = String(ask ? ask.verb || "" : askOrVerb || "").trim();
  const intent = ask ? askIntent(ask) : askIntent({ intent: fallbackIntent });
  const chars = Array.from(verb);
  const glyph = chars[0] || "";
  if (glyph && ASK_VERB_ICONS[glyph]) {
    return {
      verb: verb || askIntentLabel({ intent }),
      glyph,
      label: chars.slice(1).join("").trim() || verb,
      vars: askVerbVars(glyph),
      icon: askVerbIconSvg(glyph),
    };
  }
  return {
    verb: verb || askIntentLabel({ intent }),
    glyph: "",
    label: verb || askIntentLabel({ intent }),
    vars: askIntentVars(intent),
    icon: askIntentIconSvg(intent),
  };
}
