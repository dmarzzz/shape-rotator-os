// gh-handle.js — shared GitHub handle normalization.
//
// Cohort .md files store `links.github` in a few shapes — bare username
// ("amiller"), URL ("https://github.com/amiller"), with a leading @
// ("@amiller"), or owner/repo ("amiller/something"). Anything that
// hits the GitHub API or interpolates the value into a github.com URL
// must first reduce it to the bare username, or the result is either
// a guaranteed 404 (encoded URL becomes the path) or a malformed URL
// (raw "https://..." spliced into the path). Both bugs are real and
// have shipped — see BUG-006.

export function normalizeHandle(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/^@+/, "");
  // Pull the user segment out of a URL-ish value.
  const m = s.match(/github\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  // Strip any trailing path/query/fragment that snuck through
  // (e.g. "amiller/conclave" → "amiller").
  s = s.split(/[/?#]/)[0];
  return s;
}
