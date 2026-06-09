// pr-url.js — builders for GitHub web-editor URLs that target a
// cohort-data record file. Both Shape Rotator OS Electron renderer and
// the sibling web app need to drop users into the same edit-and-PR flow,
// so the convention lives here.
//
// `quick_pull=1` forces GitHub's commit dialog to default to
// "create a new branch and start a pull request" instead of letting a
// user with push access commit directly to main. Without it, anyone
// holding the keys can accidentally bypass review.

// Map a singular record type to its on-disk folder name. cohort-data is
// organised by pluralised type: teams/, people/, clusters/.
const RECORD_TYPE_TO_FOLDER = {
  team:    "teams",
  person:  "people",
  cluster: "clusters",
};

function folderFor(recordType) {
  const f = RECORD_TYPE_TO_FOLDER[recordType];
  if (f) return f;
  // Fallback: naive pluralisation so a new record type doesn't hard
  // crash. Caller can add an explicit mapping above when needed.
  const s = String(recordType || "");
  if (!s) return "";
  if (s.endsWith("s")) return s;
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  return s + "s";
}

export function buildRecordPath({ recordType, recordId }) {
  const folder = folderFor(recordType);
  const safeId = encodeURIComponent(String(recordId ?? ""));
  return `cohort-data/${folder}/${safeId}.md`;
}

// Build the GitHub /edit/ URL for an existing cohort-data record file.
// Returns: https://github.com/{repo}/edit/{branch}/cohort-data/{folder}/{recordId}.md?quick_pull=1
export function buildEditPRUrl({
  recordType,
  recordId,
  repo = "dmarzzz/shape-rotator-os",
  branch = "main",
}) {
  return `https://github.com/${repo}/edit/${branch}/${buildRecordPath({ recordType, recordId })}?quick_pull=1`;
}

// Build the GitHub /new/ URL with a filename and optional prefilled file
// contents. Used by structured editors that generate the markdown before
// handing the user off to GitHub's commit/PR flow.
export function buildNewPRUrl({
  path,
  value,
  repo = "dmarzzz/shape-rotator-os",
  branch = "main",
}) {
  const safePath = encodeURIComponent(String(path ?? ""));
  let url = `https://github.com/${repo}/new/${branch}?filename=${safePath}&quick_pull=1`;
  if (value != null) url += `&value=${encodeURIComponent(String(value))}`;
  return url;
}
