export const SELF_REPORT_AUTORUN_CHOICES_LS_KEY = "srwk:self_report_autorun_choices_v1";

function localStore(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function normalizeSourceChoices(value) {
  const choices = value && typeof value === "object" ? value : {};
  const clean = {
    useSessions: !!choices.useSessions,
    useGithub: !!choices.useGithub,
  };
  return clean.useSessions || clean.useGithub ? clean : null;
}

function readChoiceState(storage) {
  const store = localStore(storage);
  try {
    const raw = store && store.getItem(SELF_REPORT_AUTORUN_CHOICES_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeChoiceState(state, storage) {
  const store = localStore(storage);
  if (!store) return;
  try { store.setItem(SELF_REPORT_AUTORUN_CHOICES_LS_KEY, JSON.stringify(state || {})); } catch {}
}

export function coerceAutoUpdateChoices(value) {
  return normalizeSourceChoices(value);
}

export function getAutoUpdateChoices(recordId, storage) {
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id) return null;
  const state = readChoiceState(storage);
  const entry = state[id];
  const choices = normalizeSourceChoices(entry);
  if (!choices) return null;
  return {
    ...choices,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
  };
}

export function rememberAutoUpdateChoices(recordId, choices, { storage, at = null } = {}) {
  const id = String(recordId == null ? "" : recordId).trim();
  if (!id) return null;
  const state = readChoiceState(storage);
  const clean = normalizeSourceChoices(choices);
  if (!clean) {
    delete state[id];
    writeChoiceState(state, storage);
    return null;
  }
  const next = { ...clean, updatedAt: at || new Date().toISOString() };
  state[id] = next;
  writeChoiceState(state, storage);
  return next;
}
