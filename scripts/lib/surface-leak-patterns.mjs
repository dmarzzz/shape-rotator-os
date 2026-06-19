// Shared pattern library for the surface leak scanners.
//
// Merged from the former transcript-surface-leak-scan.mjs (generated app/public
// bundles) and web-public-surface-leak-scan.mjs (the static web app). Every check
// from BOTH scanners is preserved verbatim; the only genuine overlap ("local user
// path") lives once in SHARED_PATTERNS and is spread into each mode in its
// original position. This module is pure (no fs) so the patterns stay unit-testable
// on their own; file walking + CLI live in scripts/surface-leak-scan.mjs.

// Google Calendar system identifiers (shared "group", subscribed "import", and
// room/equipment "resource" calendars) are email-shaped — `<id>@group.calendar.
// google.com` — but they are calendar IDs, not personal email addresses, so they
// are not PII. The `$` anchor is load-bearing: it prevents a real address smuggled
// as `victim@group.calendar.google.com.attacker.com` from being silently allowed.
export const CALENDAR_SYSTEM_ID = /@(?:group|import|resource)\.calendar\.google\.com$/i;

// The single genuine overlap between the two scans.
export const SHARED_PATTERNS = [
  { label: "local user path", pattern: /\b[A-Z]:\\Users\\|\/Users\//i },
];

// transcript mode — private transcript markers in generated app/public bundles.
export const TRANSCRIPT_PATTERNS = [
  {
    label: "email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    allow: CALENDAR_SYSTEM_ID,
  },
  { label: "private vault pointer", pattern: /\bprivate-vault:/i },
  { label: "Drive source ref", pattern: /\bdrive:\/\//i },
  { label: "source artifact id field", pattern: /"source_artifact_id"\s*:/i },
  { label: "storage ref field", pattern: /"storage_ref"\s*:/i },
  { label: "raw transcript marker", pattern: /\braw[-_ ]?transcript\b/i },
  { label: "source artifacts table marker", pattern: /\bsource_artifacts\b/i },
  { label: "processing jobs table marker", pattern: /\bprocessing_jobs\b/i },
  ...SHARED_PATTERNS,
  // A parenthesized H:MM:SS is a transcript/recording timecode (e.g. an
  // attributed quote "… — Tina, Apr 27 (01:47:57)"). Schedule times in these
  // surfaces are H:MM ranges ("16:00 - 19:00") with no seconds, so requiring
  // the seconds component inside parentheses avoids matching them.
  { label: "transcript timecode", pattern: /\([0-9]{1,2}:[0-9]{2}:[0-9]{2}\)/ },
];

// web mode — operator/admin calendar surfaces leaking into the static web app.
export const WEB_PATTERNS = [
  { label: "calendar ingress operator asset", pattern: /\bcalendar-ingress(?:-client)?\b/i },
  { label: "calendar operator UI copy", pattern: /\boperator (?:controls|setup|queue|workers)\b/i },
  { label: "calendar operator runbook command", pattern: /\b(?:admin ACL check|calendar:acl:google|calendar:sync:google|artifacts:drive)\b/i },
  { label: "browser credential prompt", pattern: /\b(?:Supabase anon key|signed-in access token|access token \(not saved\)|calendar connection ID)\b/i },
  { label: "calendar admin endpoint or table", pattern: /\b(?:private_invite_contacts|event_requests|processing_jobs|approval_gates|create-calendar-event|review-transcript-artifact|ingest-artifacts)\b/i },
  { label: "private source marker", pattern: /\braw[-_ ]?transcripts?\b|drive:\/\/|["']?(?:source_artifact_id|storage_ref)["']?\s*:|\.(?:source_artifact_id|storage_ref)\b/i },
  ...SHARED_PATTERNS,
];

// Per-mode scan configuration: which patterns, which default targets, which file
// extensions, and whether an explicitly-named FILE target must match an extension.
export const MODES = {
  transcript: {
    label: "transcript",
    description: "generated app/public transcript surfaces",
    patterns: TRANSCRIPT_PATTERNS,
    targets: [
      // The committed, app-shipped surface — the bundle that rides inside the
      // published Electron app, so the primary thing that must stay free of
      // private transcript markers.
      "apps/os/src/cohort-surface.json",
      "apps/web/cohort-surface.json",
      "apps/web/calendar.json",
      "cohort-data/artifacts/public-transcript-articles/generated/manifest.json",
      "cohort-data/artifacts/public-transcript-articles/generated",
      // Defensive: distilled per-session inputs live outside the public repo
      // (cohort-data/.private/, gitignored). If any get re-committed at their old
      // canonical paths these targets catch it. Absent paths are tolerated.
      "cohort-data/session-insights.json",
      "cohort-data/constellation-cues.json",
      "cohort-data/session-readouts",
    ],
    extensions: /\.(json|md|html|txt)$/i,
    // Directly-named file targets above are specific known files (e.g. the
    // committed bundles) and are always scanned regardless of extension.
    filterExplicitFile: false,
  },
  web: {
    label: "web",
    description: "static public web app (operator/admin leaks)",
    patterns: WEB_PATTERNS,
    targets: ["apps/web"],
    extensions: /\.(css|html|js|json|md|markdown|mjs|txt|xml)$/i,
    // The web target is a directory tree; a directly-named file must still match
    // a text extension to be scanned.
    filterExplicitFile: true,
  },
};

export function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

// Returns the first match that is NOT cleared by `allow`. When an allowlist is
// present we iterate every match (not just the first) so a real leak later in the
// text is not masked by an allowlisted match earlier in the text.
export function firstReportableMatch(text, { pattern, allow }) {
  if (!allow) return pattern.exec(text);
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    if (!allow.test(match[0])) return match;
  }
  return null;
}

export function scanText(text, file = "<memory>", patterns = []) {
  const findings = [];
  for (const entry of patterns) {
    const match = firstReportableMatch(text, entry);
    if (!match) continue;
    findings.push({
      file,
      line: lineForIndex(text, match.index),
      label: entry.label,
      excerpt: match[0].slice(0, 120),
    });
  }
  return findings;
}
