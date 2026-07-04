export const TEXT_TRANSCRIPT_EXTS = new Set([".txt", ".md", ".markdown", ".vtt", ".srt", ".csv", ".json", ".rtf"]);

export const VISIBLE_TRANSCRIPT_PATH_KEYS = ["drive_inbox", "metadata", "supabase_raw", "local_agent"];

export const TRANSCRIPT_PATH_COPY = {
  drive_inbox: {
    label: "Drive inbox",
    short: "private Drive upload",
    note: "Uploads the original to the private Google Drive inbox. Shape OS keeps a local manifest and uses Drive pointers downstream.",
    submit: "Send to Drive",
    submitMany: "Send {count} files to Drive",
    badge: "Drive inbox",
  },
  metadata: {
    label: "Private pointer",
    short: "file stays private",
    note: "Stages the file locally. Shape OS stores only a private source pointer.",
    submit: "Add pointer",
    submitMany: "Add {count} pointers",
    badge: "pointer only",
  },
  supabase_raw: {
    label: "Send full text",
    short: "private Engine inbox",
    note: "Sends transcript text to the private Shape OS DB for Engine processing.",
    submit: "Send full text",
    submitMany: "Send {count} files",
    badge: "full text",
  },
  local_agent: {
    label: "Local readout",
    short: "this device only",
    note: "Runs the Engine prompt through a local model command. Raw text stays off the Shape OS DB.",
    submit: "Run local readout",
    submitMany: "Run {count} readouts",
    badge: "local only",
  },
};

export function normalizeVisibleTranscriptPath(key) {
  return VISIBLE_TRANSCRIPT_PATH_KEYS.includes(key) ? key : "metadata";
}

export function buildVisibleTranscriptPathRows(processingPaths = []) {
  const byKey = new Map((Array.isArray(processingPaths) ? processingPaths : [])
    .filter((item) => item && item.key)
    .map((item) => [item.key, item]));
  return VISIBLE_TRANSCRIPT_PATH_KEYS.map((key) => {
    const source = byKey.get(key) || {};
    const copy = TRANSCRIPT_PATH_COPY[key];
    return {
      ...source,
      key,
      label: copy.label,
      short: copy.short,
      description: copy.note,
    };
  });
}

export function isFullTextTranscriptPath(key) {
  const path = normalizeVisibleTranscriptPath(key);
  return path === "supabase_raw" || path === "local_agent";
}

export function isTextTranscriptExtension(ext) {
  return TEXT_TRANSCRIPT_EXTS.has(String(ext || "").toLowerCase());
}

export function transcriptPathBlocker({ fileName = "selected file", ext = "", processingPath = "metadata" } = {}) {
  if (!isFullTextTranscriptPath(processingPath) || isTextTranscriptExtension(ext)) return "";
  return `${fileName} is not a text transcript. Use Private pointer for PDFs and docs.`;
}

export function transcriptPathNoteText(processingPath = "metadata") {
  return TRANSCRIPT_PATH_COPY[normalizeVisibleTranscriptPath(processingPath)].note;
}

export function transcriptSubmitLabel(processingPath = "metadata", count = 1) {
  const copy = TRANSCRIPT_PATH_COPY[normalizeVisibleTranscriptPath(processingPath)];
  if (Number(count) > 1) return copy.submitMany.replace("{count}", String(Number(count) || 0));
  return copy.submit;
}

export function transcriptStorageBadgeLabel(processingPath = "metadata") {
  return TRANSCRIPT_PATH_COPY[normalizeVisibleTranscriptPath(processingPath)].badge;
}
