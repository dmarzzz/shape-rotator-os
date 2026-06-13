import { requireOrgRole } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse, readJson, requiredEnv } from "../_shared/http.ts";
import { supabaseRest, upsertRows } from "../_shared/supabase_rest.ts";

function statusError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function asText(value: unknown) {
  return String(value || "").trim();
}

function reviewDecisionForStatus(status: string) {
  if (status === "blocked") return "block";
  if (status === "needs_review") return "request_changes";
  return "approve";
}

async function fetchOne({
  supabaseUrl,
  serviceRoleKey,
  table,
  query,
  notFound,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  query: Record<string, string>;
  notFound: string;
}) {
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table,
    method: "GET",
    query: {
      ...query,
      limit: "1",
    },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw statusError(notFound, 404);
  return row;
}

async function fetchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId }: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  artifactId: string;
}) {
  return await fetchOne({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    query: {
      select: "*",
      id: `eq.${artifactId}`,
      org_id: `eq.${orgId}`,
    },
    notFound: "derived artifact not found",
  });
}

async function fetchEvidenceCard({ supabaseUrl, serviceRoleKey, orgId, cardId }: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  cardId: string;
}) {
  return await fetchOne({
    supabaseUrl,
    serviceRoleKey,
    table: "evidence_cards",
    query: {
      select: "*",
      id: `eq.${cardId}`,
      org_id: `eq.${orgId}`,
    },
    notFound: "evidence card not found",
  });
}

async function fetchGate({ supabaseUrl, serviceRoleKey, orgId, gateId }: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  gateId: string;
}) {
  return await fetchOne({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    query: {
      select: "*",
      id: `eq.${gateId}`,
      org_id: `eq.${orgId}`,
    },
    notFound: "approval gate not found",
  });
}

async function fetchArtifactGates({ supabaseUrl, serviceRoleKey, orgId, artifactId }: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  artifactId: string;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    method: "GET",
    query: {
      select: "id,gate_key,gate_status",
      org_id: `eq.${orgId}`,
      derived_artifact_id: `eq.${artifactId}`,
      order: "gate_key.asc",
    },
  });
}

function assertNoPublicContentLeak(artifact: Record<string, unknown>) {
  const text = JSON.stringify({
    content_json: artifact.content_json || {},
    content_md: artifact.content_md || "",
  });
  const patterns = [
    /\bprivate-vault:/i,
    /\bdrive:\/\//i,
    /"storage_ref"\s*:/i,
    /\b[A-Za-z]:\\[^\s"]+/,
  ];
  const hit = patterns.find((pattern) => pattern.test(text));
  if (hit) throw statusError(`T3 publication blocked by private-source marker: ${hit}`, 400);
}

function assertNoPublicEvidenceCardLeak(card: Record<string, unknown>) {
  const text = JSON.stringify({
    title: card.title || "",
    claim_text: card.claim_text || "",
    summary: card.summary || "",
    content_json: card.content_json || {},
  });
  const patterns = [
    /\bprivate-vault:/i,
    /\bdrive:\/\//i,
    /"source_artifact_id"\s*:/i,
    /"storage_ref"\s*:/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b[A-Za-z]:\\[^\s"]+/,
  ];
  const hit = patterns.find((pattern) => pattern.test(text));
  if (hit) throw statusError(`T3 evidence card blocked by private-source marker: ${hit}`, 400);
}

async function assertT3PublishAllowed({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  artifact,
  publishPublic,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  artifact: Record<string, unknown>;
  publishPublic: boolean;
}) {
  if (artifact.tier !== "T3") return;
  if (!publishPublic) throw statusError("T3 publication requires publish_public=true", 400);
  if (artifact.artifact_kind !== "public_candidate") {
    throw statusError("T3 publication requires a public_candidate artifact", 400);
  }
  const gates = await fetchArtifactGates({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    artifactId: String(artifact.id),
  });
  if (!Array.isArray(gates) || !gates.length) throw statusError("T3 publication requires approval gates", 400);
  const blocked = gates.find((gate) => !["approved", "not_required"].includes(String(gate.gate_status || "")));
  if (blocked) throw statusError(`T3 publication gate is not cleared: ${blocked.gate_key || blocked.id}`, 400);
  assertNoPublicContentLeak(artifact);
}

async function patchArtifact({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  artifactId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  artifactId: string;
  body: Record<string, unknown>;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    method: "PATCH",
    query: {
      id: `eq.${artifactId}`,
      org_id: `eq.${orgId}`,
    },
    body,
    prefer: "return=representation",
  });
}

async function patchEvidenceCard({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  cardId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  cardId: string;
  body: Record<string, unknown>;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "evidence_cards",
    method: "PATCH",
    query: {
      id: `eq.${cardId}`,
      org_id: `eq.${orgId}`,
    },
    body,
    prefer: "return=representation",
  });
}

async function patchEvidenceCardsForArtifact({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  artifactId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  artifactId: string;
  body: Record<string, unknown>;
}) {
  return await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "evidence_cards",
    method: "PATCH",
    query: {
      derived_artifact_id: `eq.${artifactId}`,
      org_id: `eq.${orgId}`,
    },
    body,
    prefer: "return=representation",
  });
}

async function insertReviewAndAudit({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  artifactId,
  decision,
  notes,
  action,
  before,
  after,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  actorId: string;
  artifactId: string;
  decision: string;
  notes?: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  const createdAt = nowIso();
  await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "artifact_reviews",
    rows: [{
      org_id: orgId,
      derived_artifact_id: artifactId,
      reviewer_id: actorId,
      decision,
      notes: notes || null,
      created_at: createdAt,
    }],
  });
  await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "audit_log",
    rows: [{
      org_id: orgId,
      actor_id: actorId,
      action,
      object_type: "derived_artifact",
      object_id: artifactId,
      before_json: before || null,
      after_json: after || null,
      created_at: createdAt,
    }],
  });
}

async function insertEvidenceAudit({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  cardId,
  decision,
  notes,
  action,
  before,
  after,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  actorId: string;
  cardId: string;
  decision: string;
  notes?: string;
  action: string;
  before?: unknown;
  after?: unknown;
}) {
  await upsertRows({
    supabaseUrl,
    serviceRoleKey,
    table: "audit_log",
    rows: [{
      org_id: orgId,
      actor_id: actorId,
      action,
      object_type: "evidence_card",
      object_id: cardId,
      before_json: before || null,
      after_json: after || null,
      created_at: nowIso(),
    }],
  });
  if (decision || notes) {
    await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "audit_log",
      rows: [{
        org_id: orgId,
        actor_id: actorId,
        action: `evidence_card.review_note.${decision}`,
        object_type: "evidence_card",
        object_id: cardId,
        before_json: null,
        after_json: { notes: notes || null },
        created_at: nowIso(),
      }],
    });
  }
}

async function reviewArtifact({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  actorId: string;
  body: Record<string, unknown>;
}) {
  const artifactId = asText(body.artifact_id || body.artifactId);
  if (!artifactId) throw statusError("artifact_id is required", 400);
  const artifact = await fetchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId });
  const expectedTier = asText(body.tier);
  if (expectedTier && expectedTier !== String(artifact.tier || "")) {
    throw statusError(`artifact tier mismatch: expected ${expectedTier}, got ${artifact.tier || "unknown"}`, 409);
  }

  const reviewStatus = asText(body.review_status || body.reviewStatus || body.decision || "reviewed");
  if (!["reviewed", "blocked", "published", "needs_review"].includes(reviewStatus)) {
    throw statusError(`unsupported review_status: ${reviewStatus}`, 400);
  }
  let approvalState = asText(body.approval_state || body.approvalState);
  if (!approvalState && reviewStatus === "blocked") approvalState = "blocked";
  if (!approvalState && reviewStatus === "published") approvalState = "approved";
  if (!approvalState && reviewStatus === "needs_review" && artifact.tier === "T3") approvalState = "pending";
  if (!approvalState && artifact.tier === "T2") approvalState = "not_required";
  if (approvalState && !["not_required", "pending", "approved", "blocked"].includes(approvalState)) {
    throw statusError(`unsupported approval_state: ${approvalState}`, 400);
  }
  if (reviewStatus === "published") {
    if (approvalState !== "approved") throw statusError("published artifacts require approval_state=approved", 400);
    await assertT3PublishAllowed({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      artifact,
      publishPublic: body.publish_public === true || body.publishPublic === true,
    });
  }

  const patch = {
    review_status: reviewStatus,
    ...(approvalState ? { approval_state: approvalState } : {}),
  };
  const rows = await patchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId, body: patch });
  const after = Array.isArray(rows) ? rows[0] : null;
  const syncedEvidenceCards = await patchEvidenceCardsForArtifact({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    artifactId,
    body: {
      review_status: reviewStatus,
      ...(approvalState ? { approval_state: approvalState } : {}),
      reviewed_by: actorId,
      reviewed_at: nowIso(),
    },
  });
  await insertReviewAndAudit({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    actorId,
    artifactId,
    decision: reviewDecisionForStatus(reviewStatus),
    notes: asText(body.note || body.notes) || null,
    action: `derived_artifact.${reviewStatus}`,
    before: artifact,
    after,
  });
  return { artifact: after, evidence_cards: syncedEvidenceCards, reviews_written: 1 };
}

async function reviewEvidenceCard({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  actorId: string;
  body: Record<string, unknown>;
}) {
  const cardId = asText(body.card_id || body.cardId || body.evidence_card_id || body.evidenceCardId);
  if (!cardId) throw statusError("card_id is required", 400);
  const card = await fetchEvidenceCard({ supabaseUrl, serviceRoleKey, orgId, cardId });
  const reviewStatus = asText(body.review_status || body.reviewStatus || body.decision || "reviewed");
  if (!["reviewed", "blocked", "published", "needs_review"].includes(reviewStatus)) {
    throw statusError(`unsupported review_status: ${reviewStatus}`, 400);
  }
  let approvalState = asText(body.approval_state || body.approvalState);
  if (!approvalState && reviewStatus === "blocked") approvalState = "blocked";
  if (!approvalState && reviewStatus === "published") approvalState = "approved";
  if (!approvalState && reviewStatus === "needs_review" && card.surface_tier === "T3") approvalState = "pending";
  if (!approvalState && card.surface_tier === "T2") approvalState = "not_required";
  if (approvalState && !["not_required", "pending", "approved", "blocked"].includes(approvalState)) {
    throw statusError(`unsupported approval_state: ${approvalState}`, 400);
  }
  if (reviewStatus === "published") {
    if (card.surface_tier !== "T3") throw statusError("only T3 evidence cards can be published", 400);
    if (approvalState !== "approved") throw statusError("published evidence cards require approval_state=approved", 400);
    if (body.publish_public !== true && body.publishPublic !== true) {
      throw statusError("T3 evidence-card publication requires publish_public=true", 400);
    }
    if (card.public_anonymous !== true || card.public_article_mode !== "generalized_no_named_insights") {
      throw statusError("T3 evidence cards must be no-named generalized insights", 400);
    }
    assertNoPublicEvidenceCardLeak(card);
  }
  const patch = {
    review_status: reviewStatus,
    ...(approvalState ? { approval_state: approvalState } : {}),
    reviewed_by: actorId,
    reviewed_at: nowIso(),
  };
  const rows = await patchEvidenceCard({ supabaseUrl, serviceRoleKey, orgId, cardId, body: patch });
  const after = Array.isArray(rows) ? rows[0] : null;
  await insertEvidenceAudit({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    actorId,
    cardId,
    decision: reviewDecisionForStatus(reviewStatus),
    notes: asText(body.note || body.notes) || null,
    action: `evidence_card.${reviewStatus}`,
    before: card,
    after,
  });
  return { evidence_card: after, reviews_written: 1 };
}

async function decideGate({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  body,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  actorId: string;
  body: Record<string, unknown>;
}) {
  const gateId = asText(body.gate_id || body.gateId);
  if (!gateId) throw statusError("gate_id is required", 400);
  const gateStatus = asText(body.gate_status || body.gateStatus);
  if (!["approved", "blocked", "not_required"].includes(gateStatus)) {
    throw statusError(`unsupported gate_status: ${gateStatus}`, 400);
  }
  const gate = await fetchGate({ supabaseUrl, serviceRoleKey, orgId, gateId });
  const artifactId = String(gate.derived_artifact_id || "");
  const beforeArtifact = artifactId
    ? await fetchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId })
    : null;
  const decidedAt = nowIso();
  const gates = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    method: "PATCH",
    query: {
      id: `eq.${gateId}`,
      org_id: `eq.${orgId}`,
    },
    body: {
      gate_status: gateStatus,
      decided_by: actorId,
      decided_at: decidedAt,
      ...(asText(body.note || body.notes) ? { notes: asText(body.note || body.notes) } : {}),
    },
    prefer: "return=representation",
  });

  let artifactRows = [];
  let evidenceCardRows = [];
  if (artifactId && gateStatus === "blocked") {
    artifactRows = await patchArtifact({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      artifactId,
      body: {
        review_status: "blocked",
        approval_state: "blocked",
      },
    });
    evidenceCardRows = await patchEvidenceCardsForArtifact({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      artifactId,
      body: {
        review_status: "blocked",
        approval_state: "blocked",
        reviewed_by: actorId,
        reviewed_at: decidedAt,
      },
    });
  } else if (artifactId) {
    const allGates = await fetchArtifactGates({ supabaseUrl, serviceRoleKey, orgId, artifactId });
    const hasPendingOrBlocked = allGates.some((item) => ["pending", "blocked"].includes(String(item.gate_status || "")));
    if (!hasPendingOrBlocked) {
      artifactRows = await patchArtifact({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        artifactId,
        body: {
          review_status: "reviewed",
        approval_state: "approved",
      },
    });
      evidenceCardRows = await patchEvidenceCardsForArtifact({
        supabaseUrl,
        serviceRoleKey,
        orgId,
        artifactId,
        body: {
          review_status: "reviewed",
          approval_state: "approved",
          reviewed_by: actorId,
          reviewed_at: decidedAt,
        },
      });
    }
  }

  if (artifactId) {
    await insertReviewAndAudit({
      supabaseUrl,
      serviceRoleKey,
      orgId,
      actorId,
      artifactId,
      decision: gateStatus === "blocked" ? "block" : "approve",
      notes: asText(body.note || body.notes) || `gate ${gate.gate_key || gateId}: ${gateStatus}`,
      action: `approval_gate.${gateStatus}`,
      before: { gate, artifact: beforeArtifact },
      after: {
        gate: Array.isArray(gates) ? gates[0] : null,
        artifact: Array.isArray(artifactRows) ? artifactRows[0] : null,
      },
    });
  }
  return {
    gates,
    artifact: Array.isArray(artifactRows) ? artifactRows[0] || null : null,
    evidence_cards: evidenceCardRows,
    reviews_written: artifactId ? 1 : 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  try {
    const body = await readJson(req);
    const orgId = asText(body.org_id || body.orgId);
    if (!orgId) throw statusError("org_id is required", 400);
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const requester = await requireOrgRole({
      req,
      supabaseUrl,
      serviceRoleKey,
      orgId,
      roles: ["coordinator", "admin"],
    });
    const action = asText(body.action || "review_artifact");
    const result = action === "decide_gate"
      ? await decideGate({ supabaseUrl, serviceRoleKey, orgId, actorId: requester.userId, body })
      : action === "review_artifact"
        ? await reviewArtifact({ supabaseUrl, serviceRoleKey, orgId, actorId: requester.userId, body })
        : action === "review_evidence_card"
          ? await reviewEvidenceCard({ supabaseUrl, serviceRoleKey, orgId, actorId: requester.userId, body })
          : (() => { throw statusError(`unsupported action: ${action}`, 400); })();
    return jsonResponse({ ok: true, action, ...result });
  } catch (error) {
    return errorResponse(error);
  }
});
