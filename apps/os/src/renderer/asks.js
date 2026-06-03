// Shared ask-board logic. Keep this module DOM-free so the membrane panel
// and the full alchemy rail board cannot disagree about freshness, ownership,
// or ask status grouping.

export const ASK_EXPIRY_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoDateOnly(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
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

export function askIsOpen(ask) {
  return !!ask && askStatus(ask) === "open";
}

export function askIsCurrent(ask) {
  return !!ask && !ask._expired;
}

export function compareAsksByFreshness(a, b) {
  if (!!a?._expired !== !!b?._expired) return a?._expired ? 1 : -1;
  const aAge = a?._ageDays == null ? 0 : a._ageDays;
  const bAge = b?._ageDays == null ? 0 : b._ageDays;
  if (aAge !== bAge) return aAge - bAge;
  return String(a?.record_id || "").localeCompare(String(b?.record_id || ""));
}

export function asksWithStatus(rawAsks, nowMs = Date.now()) {
  const all = Array.isArray(rawAsks) ? rawAsks.slice() : [];
  return all.map((ask) => {
    const posted = isoDateOnly(ask?.posted_at);
    const ageDays = posted ? Math.floor((nowMs - posted.getTime()) / DAY_MS) : null;
    return {
      ...ask,
      _ageDays: ageDays,
      _expired: ageDays != null && ageDays >= ASK_EXPIRY_DAYS,
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
