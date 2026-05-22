// escape.js — tiny HTML/attribute escapers used by the card and form
// renderers. Lifted verbatim from alchemy.js so both the Electron app
// and the sibling web app reach for the same helper.

export function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Attribute-safe variant — double-quote is the only char that can break
// an attribute once escHtml has run, but it's a no-op redundancy that
// keeps the alchemy.js call sites untouched.
export function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

// Profile/detail link normalization. `cohort-data/` stores most link
// fields as bare handles (github: "amiller", linkedin: "AlbionaHoti")
// or hostnames missing a scheme (website: "albiona.dev"). Detail
// renderers used to drop the raw value straight into an href, which
// the browser then resolved as a relative URL — every link 404'd.
//
// Returns a usable absolute URL, or null if the value can't be turned
// into one. Callers should fall through to plain text when null.
export function normalizeLinkHref(key, value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^mailto:/i.test(raw)) return raw;
  const k = String(key || "").toLowerCase();
  if (k === "github") {
    return `https://github.com/${raw.replace(/^\/+/, "")}`;
  }
  if (k === "repo") {
    // Same shape as github, but the OS renderer only accepts owner/repo.
    return `https://github.com/${raw.replace(/^\/+/, "")}`;
  }
  if (k === "x" || k === "twitter") {
    return `https://x.com/${raw.replace(/^@/, "")}`;
  }
  if (k === "linkedin") {
    // Allow either a bare handle or a "in/handle" / "company/foo" path.
    const path = raw.replace(/^\/+/, "");
    return /^(in|company|school)\//.test(path)
      ? `https://www.linkedin.com/${path}`
      : `https://www.linkedin.com/in/${path}`;
  }
  // website / demo / deck / article / slides / alt / generic — assume
  // hostname or path; HTTPS is the only sensible default in 2026.
  return `https://${raw.replace(/^\/+/, "")}`;
}
