import { DEFAULT_ROUTING_POLICY, policyDecisionForSession } from "../_shared/calendar.ts";
import { bearerToken, requireOrgRole } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse, optionalEnv, readJson, requiredEnv } from "../_shared/http.ts";
import { supabaseRest, supabaseRpc, upsertRows } from "../_shared/supabase_rest.ts";
import { assertTranscriptSurfaceSafe } from "../_shared/transcript_safety.ts";

const TEXT_SOURCE_KINDS = new Set([
  "manual_upload",
  "meet_transcript",
  "meet_smart_notes",
  "otter_transcript",
  "otter_summary",
  "drive_doc",
  "router",
]);

function statusError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function workerAuthorized(req: Request) {
  const expected = optionalEnv("TRANSCRIPT_WORKER_TOKEN") || optionalEnv("SHAPE_TRANSCRIPT_WORKER_TOKEN");
  return !!expected && bearerToken(req) === expected;
}

async function authorizeTranscriptWorker({
  req,
  supabaseUrl,
  serviceRoleKey,
  orgId,
}: {
  req: Request;
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
}) {
  if (workerAuthorized(req)) return { mode: "worker-token", role: "worker" };
  const requester = await requireOrgRole({
    req,
    supabaseUrl,
    serviceRoleKey,
    orgId,
    roles: ["coordinator", "admin"],
  });
  return { mode: "user-jwt", role: requester.role, userId: requester.userId };
}

async function refreshGoogleAccessToken({ clientId, clientSecret, refreshToken }: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const error = new Error(`Google OAuth token refresh ${response.status}`) as Error & { status?: number; body?: unknown };
    error.status = 500;
    error.body = payload;
    throw error;
  }
  return payload.access_token;
}

async function resolveGoogleAccessToken() {
  const refreshToken = optionalEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (refreshToken && clientId && clientSecret) {
    return await refreshGoogleAccessToken({ clientId, clientSecret, refreshToken });
  }
  const googleAccessToken = optionalEnv("GOOGLE_CALENDAR_ACCESS_TOKEN") || optionalEnv("GOOGLE_ACCESS_TOKEN");
  if (googleAccessToken) return googleAccessToken;
  throw new Error("Google OAuth refresh credentials or access token are required");
}

function parseDriveFileId(storageRef: string | null | undefined) {
  const ref = String(storageRef || "").trim();
  const driveMatch = /^drive:\/\/([^/?#]+)/i.exec(ref);
  if (driveMatch) return driveMatch[1];
  const fileMatch = /\/file\/d\/([^/]+)/i.exec(ref);
  if (fileMatch) return fileMatch[1];
  const openMatch = /[?&]id=([^&#]+)/i.exec(ref);
  return openMatch ? decodeURIComponent(openMatch[1]) : null;
}

async function googleJson(url: URL, accessToken: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google Drive request ${response.status}`) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

function driveMetadataUrl(fileId: string) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,size,modifiedTime,md5Checksum");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

function driveContentUrl(file: { id: string; mimeType?: string }) {
  if (file.mimeType === "application/vnd.google-apps.document") {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`);
    url.searchParams.set("mimeType", "text/plain");
    return url;
  }
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUuid(value: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value)));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash.slice(0, 16)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function fetchDriveText({ storageRef, accessToken }: { storageRef: string; accessToken: string }) {
  const fileId = parseDriveFileId(storageRef);
  if (!fileId) throw statusError("source artifact storage_ref is not a Drive ref", 400);
  const metadata = await googleJson(driveMetadataUrl(fileId), accessToken);
  const response = await fetch(driveContentUrl(metadata), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const error = new Error(`Google Drive download ${response.status}`) as Error & { status?: number; body?: unknown };
    error.status = response.status;
    error.body = new TextDecoder().decode(bytes.slice(0, 500));
    throw error;
  }
  return {
    text: new TextDecoder().decode(bytes),
    metadata,
    sourceHash: `sha256:${await sha256Hex(bytes)}`,
    sizeBytes: bytes.byteLength,
    mimeType: metadata.mimeType === "application/vnd.google-apps.document" ? "text/plain" : (metadata.mimeType || "text/plain"),
  };
}

function redactedText(value: string) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(/https?:\/\/\S+/gi, "[redacted url]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted token]")
    .replace(/\b[A-Za-z]:\\[^\s]+/g, "[redacted local path]");
}

function textSentences(text: string) {
  return redactedText(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 24);
}

const TOPIC_DETECTORS = [
  {
    key: "agentic_organizations",
    label: "agentic organizations and workflow design",
    pattern: /\b(agentic|autonomous organization|organization|workflow|swarm|coordinat|operator|agent)\b/i,
  },
  {
    key: "tee_verifiability",
    label: "TEE, attestation, verifiability, and private compute",
    pattern: /\b(tee|attestation|verifiable|confidential|enclave|dstack|cvm|privacy|private compute)\b/i,
  },
  {
    key: "product_market",
    label: "product direction, users, buyers, and market wedge",
    pattern: /\b(product|customer|user|buyer|market|pricing|paid|activation|gtm|go[- ]?to[- ]?market|pmf)\b/i,
  },
  {
    key: "collaboration",
    label: "cohort collaboration, dependencies, and handoffs",
    pattern: /\b(collaborat|dependency|handoff|intro|connect|cohort|team|shared|redundant|conflict)\b/i,
  },
  {
    key: "research",
    label: "research, prototypes, and whiteboarding questions",
    pattern: /\b(research|prototype|experiment|whiteboard|idea|hypothesis|question|paper|model)\b/i,
  },
];

function detectedTopics(text: string) {
  const redacted = redactedText(text);
  return TOPIC_DETECTORS
    .filter((topic) => topic.pattern.test(redacted))
    .map((topic) => ({ key: topic.key, label: topic.label }));
}

function wordCount(text: string) {
  const matches = redactedText(text).match(/\b[\p{L}\p{N}_-]+\b/gu);
  return matches ? matches.length : 0;
}

function fallbackTopic() {
  return { key: "general_session_context", label: "general session context requiring human review" };
}

function cardTitleForTopic(label: string) {
  return String(label || "session evidence")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (ch) => ch.toUpperCase());
}

function distillTranscriptText(text: string, {
  mode,
  title,
  sessionType,
}: {
  mode?: string;
  title?: string;
  sessionType?: string;
} = {}) {
  const topics = detectedTopics(text);
  const candidateTopics = topics.length ? topics : [fallbackTopic()];
  const topicLabels = topics.map((topic) => topic.label);
  const scopedTitle = String(title || "this session").trim();
  const scope = mode === "aggregate_only"
    ? "aggregate-only signal"
    : "cohort-internal draft signal";
  const detected = topicLabels.length
    ? topicLabels.join("; ")
    : "general session context requiring human review";
  return {
    summary: [
      `${scopedTitle} produced ${candidateTopics.length} reviewer candidate${candidateTopics.length === 1 ? "" : "s"} for ${scope}: ${detected}.`,
      "The worker stored topic-level synthesis only; a reviewer must verify claims against the private source before cohort or public use.",
      `Source size signal: about ${wordCount(text)} redacted word-like tokens were processed inside the worker.`,
    ],
    themes: topicLabels,
    reviewer_candidates: candidateTopics.slice(0, 8).map((topic, index) => {
      const attributionScope = mode === "aggregate_only" ? "aggregate" : "room";
      const evidenceLevel = mode === "aggregate_only" ? "aggregate" : "inferred";
      return {
        claim_type: "insight",
        title: cardTitleForTopic(topic.label),
        claim_text: `${scopedTitle} appears to contain a reviewed ${attributionScope} signal about ${topic.label}. Verify this against the private transcript before using it as evidence.`,
        summary: `${topic.label} surfaced as a candidate reviewed signal.`,
        evidence_level: evidenceLevel,
        confidence: Math.max(0.5, 0.68 - index * 0.03),
        attribution_scope: attributionScope,
        surface_tier: mode === "aggregate_only" ? "T2" : "T2",
        source_boundary: "derived_only",
        review_prompt: `Confirm whether the private source supports this ${evidenceLevel} claim without copying speaker turns.`,
        content_json: {
          topic_key: topic.key,
          topic_label: topic.label,
          routing_mode: mode || "distilled_readout",
          source_basis: "redacted topic detector",
          raw_allowed: false,
        },
      };
    }),
    action_items: [
      "Review the private transcript against Tina's routing policy before changing this artifact from needs_review.",
      "Convert any useful points into evidence cards with claim type, confidence, provenance, and sharing boundary.",
      ...(mode === "aggregate_only"
        ? ["Keep individual attribution out of cohort views; promote only aggregate signals."]
        : ["Resolve attribution conservatively at team, room, or speaker level before naming people."]),
    ],
    open_questions: [
      "Which claims are grounded enough to become weekly evidence cards?",
      "What should remain T0/T1 only because it depends on room context, external subjects, or private critique?",
      ...(sessionType ? [`Does the ${sessionType} routing ceiling still match the actual room contents?`] : []),
    ],
    redaction_notes: [
      "Raw transcript text was processed inside the transcript worker and was not returned in the API response.",
      "The stored draft contains topic-level synthesis only; transcript sentences, timestamps, and raw speaker turns are intentionally excluded.",
      "This deterministic draft remains needs_review until a human creates or approves evidence cards.",
    ],
  };
}

function publicDistillationFor(distillation: ReturnType<typeof distillTranscriptText>) {
  return {
    summary: (distillation.summary || []).slice(0, 2),
    themes: distillation.themes || [],
    reviewer_candidates: (distillation.reviewer_candidates || []).map((candidate) => ({
      claim_type: "insight",
      title: String(candidate.title || "General public insight"),
      claim_text: String(candidate.summary || candidate.claim_text || "Generalized no-name insight candidate."),
      summary: String(candidate.summary || candidate.claim_text || "Generalized no-name insight candidate."),
      evidence_level: "inferred",
      confidence: candidate.confidence,
      attribution_scope: "anonymous_public",
      surface_tier: "T3",
      source_boundary: "derived_only",
      public_anonymous: true,
      public_article_mode: "generalized_no_named_insights",
      content_json: {
        topic_key: candidate.content_json?.topic_key || null,
        topic_label: candidate.content_json?.topic_label || candidate.title || null,
        article_mode: "generalized_no_named_insights",
        raw_allowed: false,
      },
    })),
    public_notes: [
      "Generalized no-name public candidate.",
      "Publish only after every approval gate is cleared.",
    ],
  };
}

function claimTypeForEvidenceText(text: string) {
  const value = String(text || "");
  if (/\b(risk|block|blocked|fails?|failure|privacy|security|leak|concern|unclear)\b/i.test(value)) return "risk";
  if (/\b(review|convert|keep|resolve|promote|hold|merge|narrow|should|must|needs?)\b/i.test(value)) return "action_item";
  if (/\?$|which|what|how|does\b/i.test(value)) return "open_question";
  if (/\b(topic|theme|signal|pattern|workflow|product|market|research)\b/i.test(value)) return "insight";
  return "claim";
}

function artifactTierForDecision(decision: ReturnType<typeof policyDecisionForSession>) {
  if (decision.max_tier === "T1") return "T1";
  if (decision.cohort_mode === "aggregate_only") return "T2";
  return "T2";
}

function sourceTransformForDecision(decision: ReturnType<typeof policyDecisionForSession>) {
  if (decision.cohort_mode === "aggregate_only") return "aggregate";
  return "paraphrased_distillation";
}

function renderDerivedMarkdown({
  session,
  decision,
  distillation,
  publicSurface = false,
}: {
  session: Record<string, unknown>;
  decision: ReturnType<typeof policyDecisionForSession>;
  distillation: {
    summary?: string[];
    themes?: string[];
    reviewer_candidates?: Array<Record<string, unknown>>;
    action_items?: string[];
    open_questions?: string[];
    redaction_notes?: string[];
    public_notes?: string[];
  };
  publicSurface?: boolean;
}) {
  const title = String(session.public_title || session.title || decision.label || "Session readout");
  const lines = [`# ${title}`, ""];
  lines.push(`Type: ${decision.session_type}`);
  lines.push(`Routing ceiling: ${decision.max_tier}`);
  lines.push(`Cohort mode: ${decision.cohort_mode}`);
  lines.push("");
  lines.push("## Summary");
  for (const item of distillation.summary || []) lines.push(`- ${item}`);
  if (distillation.themes?.length) {
    lines.push("", "## Detected Themes");
    for (const item of distillation.themes) lines.push(`- ${item}`);
  }
  if (distillation.reviewer_candidates?.length) {
    lines.push("", "## Reviewer Candidates");
    for (const item of distillation.reviewer_candidates) {
      lines.push(`- ${String(item.claim_text || item.summary || item.title || "").trim()}`);
    }
  }
  if (distillation.action_items?.length) {
    lines.push("", "## Action Items");
    for (const item of distillation.action_items) lines.push(`- ${item}`);
  }
  if (distillation.open_questions?.length) {
    lines.push("", "## Open Questions");
    for (const item of distillation.open_questions) lines.push(`- ${item}`);
  }
  lines.push("", publicSurface ? "## Publication Boundary" : "## Handling");
  const notes = publicSurface ? distillation.public_notes || [] : distillation.redaction_notes || [];
  for (const item of notes) lines.push(`- ${item}`);
  return lines.join("\n");
}

async function buildDerivedRows({
  orgId,
  session,
  sourceArtifact,
  processingJob,
  transcriptText,
}: {
  orgId: string;
  session: Record<string, unknown>;
  sourceArtifact: Record<string, unknown>;
  processingJob: Record<string, unknown>;
  transcriptText: string;
}) {
  const decision = policyDecisionForSession(DEFAULT_ROUTING_POLICY, String(session.session_type || "office_hours"));
  if (decision.cohort_mode === "never") {
    return { derivedArtifacts: [], approvalGates: [], evidenceCards: [] };
  }
  const distillation = distillTranscriptText(transcriptText, {
    mode: decision.cohort_mode,
    title: String(session.public_title || session.title || decision.label || "Session readout"),
    sessionType: decision.session_type,
  });
  const publicDistillation = publicDistillationFor(distillation);
  const readoutId = await stableUuid(`transcript-worker:readout:${processingJob.id}:${sourceArtifact.id}`);
  const publicId = await stableUuid(`transcript-worker:public:${processingJob.id}:${sourceArtifact.id}`);
  const readout = {
    id: readoutId,
    org_id: orgId,
    session_id: String(session.id || sourceArtifact.session_id || ""),
    source_artifact_id: String(sourceArtifact.id || ""),
    processing_job_id: String(processingJob.id || ""),
    artifact_kind: "readout",
    tier: artifactTierForDecision(decision),
    source_transform: sourceTransformForDecision(decision),
    review_status: "needs_review",
    approval_state: "not_required",
    confidence: 0.65,
    content_json: {
      policy_key: decision.policy_key,
      policy_version: decision.policy_version,
      session_type: decision.session_type,
      max_tier: decision.max_tier,
      cohort_mode: decision.cohort_mode,
      confidence_pct: 65,
      confidence_basis: [
        "deterministic cloud worker distillation",
        "review required before cohort/public promotion",
      ],
      distillation,
    },
    content_md: renderDerivedMarkdown({ session, decision, distillation }),
  };
  const derivedArtifacts = [readout];
  const approvalGates = [];
  const evidenceCards = (distillation.reviewer_candidates || []).slice(0, 12).map(async (candidate, index) => ({
    id: await stableUuid(`transcript-worker:evidence:${readout.id}:${index + 1}`),
    org_id: orgId,
    session_id: readout.session_id,
    derived_artifact_id: readout.id,
    source_artifact_id: readout.source_artifact_id,
    processing_job_id: readout.processing_job_id,
    claim_type: String(candidate.claim_type || claimTypeForEvidenceText(String(candidate.claim_text || ""))),
    title: String(candidate.title || session.public_title || session.title || decision.label || "Session evidence"),
    claim_text: String(candidate.claim_text || candidate.summary || "Review this candidate against the private source."),
    summary: candidate.summary ? String(candidate.summary) : null,
    evidence_level: String(candidate.evidence_level || (decision.cohort_mode === "aggregate_only" ? "aggregate" : "inferred")),
    confidence: Number(candidate.confidence ?? readout.confidence),
    attribution_scope: String(candidate.attribution_scope || (decision.cohort_mode === "aggregate_only" ? "aggregate" : "room")),
    surface_tier: String(candidate.surface_tier || readout.tier),
    source_boundary: String(candidate.source_boundary || "derived_only"),
    review_status: "needs_review",
    approval_state: "not_required",
    public_anonymous: false,
    public_article_mode: null,
    content_json: {
      policy_key: decision.policy_key,
      policy_version: decision.policy_version,
      session_type: decision.session_type,
      confidence_pct: Math.round(Number(candidate.confidence ?? readout.confidence) * 100),
      confidence_basis: [
        "generated from structured topic-level worker candidate",
        "reviewer must verify against private source before weekly use",
      ],
      review_prompt: candidate.review_prompt || "Verify support against the private source without copying speaker turns.",
      ...(candidate.content_json && typeof candidate.content_json === "object" ? candidate.content_json : {}),
      raw_allowed: false,
    },
  }));
  if (decision.public_allowed) {
    const publicCandidate = {
      ...readout,
      id: publicId,
      artifact_kind: "public_candidate",
      tier: "T3",
      source_transform: "public_edit",
      review_status: "needs_review",
      approval_state: "pending",
      content_json: {
        policy_key: decision.policy_key,
        policy_version: decision.policy_version,
        session_type: decision.session_type,
        max_tier: "T3",
        cohort_mode: decision.cohort_mode,
        confidence_pct: 65,
        confidence_basis: [
          "deterministic public candidate from structured topic-level distillation",
          "public use requires approval gates",
        ],
        public_article_mode: "generalized_no_named_insights",
        distillation: publicDistillation,
      },
      content_md: renderDerivedMarkdown({ session, decision, distillation: publicDistillation, publicSurface: true }),
    };
    assertTranscriptSurfaceSafe({
      content_json: publicCandidate.content_json,
      content_md: publicCandidate.content_md,
    }, { scope: "public", label: "public candidate" });
    derivedArtifacts.push(publicCandidate);
    evidenceCards.push(...(publicDistillation.reviewer_candidates || []).slice(0, 6).map(async (candidate, index) => {
      const text = String(candidate.claim_text || candidate.summary || "Generalized public insight candidate.");
      const publicCard = {
        id: await stableUuid(`transcript-worker:public-evidence:${publicCandidate.id}:${index + 1}`),
        org_id: orgId,
        session_id: publicCandidate.session_id,
        derived_artifact_id: publicCandidate.id,
        source_artifact_id: publicCandidate.source_artifact_id,
        processing_job_id: publicCandidate.processing_job_id,
        claim_type: "insight",
        title: String(candidate.title || "General public insight"),
        claim_text: text,
        summary: String(candidate.summary || text),
        evidence_level: "inferred",
        confidence: Number(candidate.confidence ?? publicCandidate.confidence),
        attribution_scope: "anonymous_public",
        surface_tier: "T3",
        source_boundary: "derived_only",
        review_status: "needs_review",
        approval_state: "pending",
        public_anonymous: true,
        public_article_mode: "generalized_no_named_insights",
        content_json: {
          policy_key: decision.policy_key,
          policy_version: decision.policy_version,
          session_type: decision.session_type,
          confidence_pct: 65,
          confidence_basis: [
            "generated from abstract worker distillation",
            "public use requires approval gates",
          ],
          article_mode: "generalized_no_named_insights",
          ...(candidate.content_json && typeof candidate.content_json === "object" ? candidate.content_json : {}),
          raw_allowed: false,
        },
      };
      assertTranscriptSurfaceSafe({
        title: publicCard.title,
        claim_text: publicCard.claim_text,
        summary: publicCard.summary,
        content_json: publicCard.content_json,
      }, { scope: "public", label: "public evidence card" });
      return publicCard;
    }));
    for (const gateKey of decision.required_public_approvals || []) {
      approvalGates.push({
        id: await stableUuid(`transcript-worker:gate:${publicId}:${gateKey}`),
        org_id: publicCandidate.org_id,
        session_id: publicCandidate.session_id,
        derived_artifact_id: publicCandidate.id,
        gate_key: gateKey,
        gate_status: "pending",
      });
    }
  }
  return { derivedArtifacts, approvalGates, evidenceCards: await Promise.all(evidenceCards) };
}

async function fetchQueuedJobs({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  limit,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  limit: number;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "processing_jobs",
    method: "GET",
    query: {
      select: "*",
      org_id: `eq.${orgId}`,
      job_kind: "eq.artifact_fetch",
      processor_status: "eq.queued",
      order: "due_at.asc.nullslast,created_at.asc",
      limit: String(limit),
    },
  });
}

async function claimQueuedJobs({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  limit,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  limit: number;
}) {
  return await supabaseRpc({
    supabaseUrl,
    serviceRoleKey,
    functionName: "claim_transcript_processing_jobs",
    body: {
      p_org_id: orgId,
      p_limit: limit,
    },
  });
}

async function fetchRowsById({
  supabaseUrl,
  serviceRoleKey,
  table,
  ids,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  ids: string[];
}) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return [];
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "GET",
    query: {
      select: "*",
      id: `in.(${unique.join(",")})`,
    },
  });
}

async function patchRow({ supabaseUrl, serviceRoleKey, table, id, body }: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  id: string;
  body: Record<string, unknown>;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "PATCH",
    query: { id: `eq.${id}` },
    body,
  });
}

async function processOneJob({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  job,
  sourceArtifact,
  session,
  googleAccessToken,
  apply,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  job: Record<string, unknown>;
  sourceArtifact: Record<string, unknown>;
  session: Record<string, unknown>;
  googleAccessToken: string;
  apply: boolean;
}) {
  if (!sourceArtifact?.id) throw new Error("source artifact not found");
  if (!session?.id) throw new Error("session not found");
  if (!TEXT_SOURCE_KINDS.has(String(sourceArtifact.source_kind || ""))) {
    throw new Error(`source kind is not text-distillable: ${sourceArtifact.source_kind || "unknown"}`);
  }
  if (String(sourceArtifact.storage_mode || "") !== "external_ref") {
    throw new Error("artifact_fetch worker expects external_ref source artifacts");
  }
  if (apply) {
    await patchRow({
      supabaseUrl,
      serviceRoleKey,
      table: "processing_jobs",
      id: String(job.id),
      body: {
        processor_status: "running",
        started_at: new Date().toISOString(),
        error: null,
      },
    });
  }

  const fetched = await fetchDriveText({
    storageRef: String(sourceArtifact.storage_ref || ""),
    accessToken: googleAccessToken,
  });
  const rows = await buildDerivedRows({
    orgId,
    session,
    sourceArtifact,
    processingJob: job,
    transcriptText: fetched.text,
  });
  const finishedAt = new Date().toISOString();
  const hasReadout = rows.derivedArtifacts.length > 0;

  if (apply) {
    await patchRow({
      supabaseUrl,
      serviceRoleKey,
      table: "source_artifacts",
      id: String(sourceArtifact.id),
      body: {
        source_hash: fetched.sourceHash,
        mime_type: fetched.mimeType,
        size_bytes: fetched.sizeBytes,
      },
    });
    await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "derived_artifacts",
      rows: rows.derivedArtifacts,
      onConflict: "id",
    });
    await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "approval_gates",
      rows: rows.approvalGates,
      onConflict: "derived_artifact_id,gate_key",
    });
    await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "evidence_cards",
      rows: rows.evidenceCards,
      onConflict: "id",
    });
    await patchRow({
      supabaseUrl,
      serviceRoleKey,
      table: "processing_jobs",
      id: String(job.id),
      body: {
        processor_status: "complete",
        finished_at: finishedAt,
        error: null,
      },
    });
    await patchRow({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      id: String(session.id),
      body: {
        transcript_status: hasReadout ? "distilled" : "source_ready",
        bot_status: "processed",
        ...(hasReadout ? { first_readout_at: finishedAt } : {}),
      },
    });
  }

  return {
    processing_job_id: job.id,
    source_artifact_id: sourceArtifact.id,
    session_id: session.id,
    derived_artifact_ids: rows.derivedArtifacts.map((row) => row.id),
    evidence_card_ids: rows.evidenceCards.map((row) => row.id),
    approval_gate_count: rows.approvalGates.length,
    source_hash: fetched.sourceHash,
    size_bytes: fetched.sizeBytes,
    mime_type: fetched.mimeType,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  try {
    const body = await readJson(req);
    const orgId = body.org_id || body.orgId || requiredEnv("ORG_ID");
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const limit = Math.max(1, Math.min(25, Number(body.limit || 5) || 5));
    const apply = body.dry_run === true ? false : body.apply !== false;
    const auth = await authorizeTranscriptWorker({ req, supabaseUrl, serviceRoleKey, orgId });

    const jobs = apply
      ? await claimQueuedJobs({ supabaseUrl, serviceRoleKey, orgId, limit })
      : await fetchQueuedJobs({ supabaseUrl, serviceRoleKey, orgId, limit });
    const sourceArtifacts = await fetchRowsById({
      supabaseUrl,
      serviceRoleKey,
      table: "source_artifacts",
      ids: jobs.map((job) => String(job.source_artifact_id || "")),
    });
    const sourceById = new Map(sourceArtifacts.map((row) => [String(row.id), row]));
    const sessions = await fetchRowsById({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      ids: sourceArtifacts.map((artifact) => String(artifact.session_id || "")),
    });
    const sessionById = new Map(sessions.map((row) => [String(row.id), row]));

    const googleAccessToken = jobs.length ? await resolveGoogleAccessToken() : "";
    const processed = [];
    const failed = [];
    for (const job of jobs) {
      const sourceArtifact = sourceById.get(String(job.source_artifact_id || ""));
      const session = sourceArtifact ? sessionById.get(String(sourceArtifact.session_id || "")) : null;
      try {
        processed.push(await processOneJob({
          supabaseUrl,
          serviceRoleKey,
          orgId,
          job,
          sourceArtifact,
          session,
          googleAccessToken,
          apply,
        }));
      } catch (error) {
        const message = error?.message || String(error);
        failed.push({
          processing_job_id: job.id,
          source_artifact_id: job.source_artifact_id,
          error: message,
        });
        if (apply && job?.id) {
          // C5-4: requeue transient failures with bounded exponential backoff
          // instead of failing terminally. `attempts` was already incremented at
          // claim time, so on the max_attempts-th failure we give up for good.
          const attempts = Number(job.attempts ?? 0);
          const maxAttempts = Number(job.max_attempts ?? 5);
          const exhausted = attempts >= maxAttempts;
          const backoffMinutes = Math.min(2 ** Math.max(1, attempts), 30);
          const failureBody = exhausted
            ? {
                processor_status: "failed",
                finished_at: new Date().toISOString(),
                error: message.slice(0, 1000),
              }
            : {
                processor_status: "queued",
                started_at: null,
                due_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
                error: message.slice(0, 1000),
              };
          await patchRow({
            supabaseUrl,
            serviceRoleKey,
            table: "processing_jobs",
            id: String(job.id),
            body: failureBody,
          });
        }
      }
    }

    return jsonResponse({
      ok: failed.length === 0,
      apply,
      auth_mode: auth.mode,
      fetched_jobs: jobs.length,
      processed_count: processed.length,
      failed_count: failed.length,
      processed,
      failed,
    }, failed.length ? 207 : 200);
  } catch (error) {
    return errorResponse(error);
  }
});
