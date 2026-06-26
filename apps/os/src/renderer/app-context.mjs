// app-context.mjs — the coarse, non-identifying app context ({ appVersion,
// platform }) attached to anon writes (cohort_events, contests, feedback). One
// source of truth for the value, read from the Electron main process via
// window.api.getAppInfo(). Both columns are nullable, so a miss is harmless.
export async function getAppContext() {
  try {
    const info = await globalThis.window?.api?.getAppInfo?.();
    if (info && typeof info === "object") {
      return { appVersion: info.version || null, platform: info.platform || null };
    }
  } catch { /* nullable — a miss is harmless */ }
  return { appVersion: null, platform: null };
}
