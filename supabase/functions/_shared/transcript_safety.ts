export type TranscriptSafetyFinding = {
  label: string;
  excerpt: string;
};

export type TranscriptSafetyScope = "cohort" | "public";

type TranscriptSafetyPattern = {
  label: string;
  pattern: RegExp;
  scopes: TranscriptSafetyScope[];
};

const TRANSCRIPT_SAFETY_PATTERNS: TranscriptSafetyPattern[] = [
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, scopes: ["cohort", "public"] },
  { label: "private vault pointer", pattern: /\bprivate-vault:/i, scopes: ["cohort", "public"] },
  { label: "Drive source ref", pattern: /\bdrive:\/\//i, scopes: ["cohort", "public"] },
  { label: "source artifact id field", pattern: /"source_artifact_id"\s*:/i, scopes: ["cohort", "public"] },
  { label: "processing job id field", pattern: /"processing_job_id"\s*:/i, scopes: ["cohort", "public"] },
  { label: "storage ref field", pattern: /"storage_ref"\s*:/i, scopes: ["cohort", "public"] },
  { label: "local user path", pattern: /\b[A-Z]:\\Users\\|\/Users\//i, scopes: ["cohort", "public"] },
  { label: "speaker timestamp turn", pattern: /\bSpeaker\s+\d+\s+\d{1,2}:\d{2}\b/i, scopes: ["cohort", "public"] },
  { label: "raw transcript marker", pattern: /\braw[-_ ]?transcript\b/i, scopes: ["public"] },
  { label: "source artifacts table marker", pattern: /\bsource_artifacts\b/i, scopes: ["public"] },
  { label: "processing jobs table marker", pattern: /\bprocessing_jobs\b/i, scopes: ["public"] },
];

function asSurfaceText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value || {});
}

export function scanTranscriptSurface(value: unknown, scope: TranscriptSafetyScope = "cohort") {
  const text = asSurfaceText(value);
  const findings: TranscriptSafetyFinding[] = [];
  for (const { label, pattern, scopes } of TRANSCRIPT_SAFETY_PATTERNS) {
    if (!scopes.includes(scope)) continue;
    const match = pattern.exec(text);
    if (!match) continue;
    findings.push({
      label,
      excerpt: match[0].slice(0, 120),
    });
  }
  return findings;
}

export function assertTranscriptSurfaceSafe(
  value: unknown,
  {
    scope = "cohort",
    label = "transcript surface",
  }: {
    scope?: TranscriptSafetyScope;
    label?: string;
  } = {},
) {
  const findings = scanTranscriptSurface(value, scope);
  if (!findings.length) return;
  const error = new Error(
    `${label} blocked by private transcript marker: ${findings.map((finding) => finding.label).join(", ")}`,
  ) as Error & { status?: number; findings?: TranscriptSafetyFinding[] };
  error.status = 400;
  error.findings = findings;
  throw error;
}
