const ACTIONS = new Set(["chat", "search", "settings", "sync", "transcript"]);

const STATUS_COPY = {
  sync: {
    busy: { state: "busy", label: "syncing", hint: "opening review" },
    done: { state: "done", label: "sync", hint: "ready", ttl: 5000 },
    error: { state: "error", label: "sync", hint: "try again", ttl: 5000 },
  },
  transcript: {
    busy: { state: "busy", label: "opening", hint: "intake" },
    done: { state: "done", label: "add", hint: "ready", ttl: 5000 },
    error: { state: "error", label: "add", hint: "try again", ttl: 5000 },
  },
};

export function normalizeLauncherAction(action) {
  const key = String(action || "").trim();
  if (key === "updates") return "sync";
  return ACTIONS.has(key) ? key : "chat";
}

export function launcherStatus(action, phase) {
  const key = normalizeLauncherAction(action);
  const copy = STATUS_COPY[key]?.[phase];
  return copy ? { ...copy } : {};
}
