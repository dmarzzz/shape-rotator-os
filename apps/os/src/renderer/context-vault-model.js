// Pure helpers for resolving Context Vault manifest records. The renderer owns
// state mutation and IPC; this module only derives local lookups from the latest
// manifest snapshot.

export function contextSourceById(manifest, id) {
  return (manifest?.sources || []).find(source => source.id === id) || null;
}

export function contextRawScriptById(manifest, id) {
  return (manifest?.raw_scripts || []).find(source => source.id === id) || null;
}

export function normalizeContextPath(pathValue) {
  return String(pathValue || "").replace(/\\/g, "/").toLowerCase();
}

export function contextPathBasename(pathValue) {
  const normalized = normalizeContextPath(pathValue);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

export function contextRawScriptByPath(manifest, pathValue) {
  const target = normalizeContextPath(pathValue);
  if (!target) return null;
  const targetBase = contextPathBasename(target);
  return (manifest?.raw_scripts || []).find(source => {
    const sourcePath = normalizeContextPath(source?.path);
    if (!sourcePath) return false;
    return sourcePath.endsWith(target)
      || sourcePath.endsWith(`/${targetBase}`)
      || contextPathBasename(sourcePath) === targetBase;
  }) || null;
}

export function pendingContextRawScript(manifest, pendingPath) {
  if (!pendingPath || !manifest) return null;
  return contextRawScriptByPath(manifest, pendingPath);
}
