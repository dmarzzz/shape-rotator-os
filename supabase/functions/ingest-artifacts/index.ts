import {
  buildProcessingJobsFromSourceArtifacts,
  captureArtifactToSourceArtifact,
  manualSourceArtifactRowsFromManifest,
  meetArtifactRowsFromManifest,
  otterArtifactRowsFromManifest,
} from "../_shared/calendar.ts";
import { requireOrgRole } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, jsonResponse, readJson, requiredEnv } from "../_shared/http.ts";
import { supabaseRest, upsertRows } from "../_shared/supabase_rest.ts";

function statusError(message, status) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function captureKey(row) {
  return [
    row?.session_id || "",
    row?.provider || "",
    row?.artifact_kind || "",
    row?.provider_resource_name || "",
  ].join("\u0001");
}

function sourceSignature(row) {
  return [
    row?.source_kind || "",
    row?.storage_ref || "",
    row?.source_hash || "",
    row?.mime_type || "",
  ].join("\u0001");
}

function linkedSourceArtifacts({ orgId, sessionId, rows, persistedCaptureArtifacts, fetchedRaw }) {
  const wanted = new Set((rows.sourceArtifacts || []).map(sourceSignature));
  const persistedByKey = new Map((persistedCaptureArtifacts || []).map((row) => [captureKey(row), row]));
  return (rows.captureArtifacts || [])
    .map((captureArtifact) => {
      const persisted = persistedByKey.get(captureKey(captureArtifact));
      if (!persisted?.id) return null;
      const candidate = captureArtifactToSourceArtifact({
        orgId,
        sessionId,
        captureArtifact: {
          ...captureArtifact,
          ...persisted,
          metadata: persisted.metadata || captureArtifact.metadata,
        },
        fetchedRaw,
      });
      return wanted.has(sourceSignature(candidate)) ? candidate : null;
    })
    .filter(Boolean);
}

function sourceArtifactConflict(rows) {
  return rows.length && rows.every((row) => row.capture_artifact_id && row.source_kind)
    ? "capture_artifact_id,source_kind"
    : undefined;
}

function enforceManualMemberGuard({ role, sourceArtifacts }) {
  if (role !== "member") return;
  const allowed = (sourceArtifacts || []).every((artifact) => (
    artifact.source_tier === "T0"
    && ["local_only", "external_ref"].includes(artifact.storage_mode)
    && artifact.raw_available_to_server !== true
  ));
  if (!allowed) {
    throw statusError("members can only submit T0 local/external source refs without raw server access", 403);
  }
}

async function markSessionsSourceReady({ supabaseUrl, serviceRoleKey, orgId, sourceArtifacts }) {
  const now = new Date().toISOString();
  const sessionIds = Array.from(new Set(
    (sourceArtifacts || [])
      .map((artifact) => artifact?.session_id)
      .filter(Boolean),
  ));
  const updated = [];
  for (const sessionId of sessionIds) {
    const rows = await supabaseRest({
      supabaseUrl,
      serviceRoleKey,
      table: "sessions",
      method: "PATCH",
      query: {
        id: `eq.${sessionId}`,
        org_id: `eq.${orgId}`,
      },
      body: {
        transcript_status: "source_ready",
        bot_status: "transcript_uploaded",
        first_source_artifact_at: now,
      },
      prefer: "return=representation",
    });
    updated.push(...(Array.isArray(rows) ? rows : []));
  }
  return updated;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);
  try {
    const body = await readJson(req);
    const orgId = body.org_id;
    if (!orgId) {
      throw statusError("org_id is required", 400);
    }
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const provider = String(body.provider || body.manifest?.provider || "").trim().toLowerCase();
    const requester = await requireOrgRole({
      req,
      supabaseUrl,
      serviceRoleKey,
      orgId,
      roles: provider === "manual" ? ["member", "coordinator", "admin"] : ["coordinator", "admin"],
    });
    const args = {
      orgId,
      sessionId: body.session_id,
      manifest: body.manifest || {},
      fetchedRaw: body.fetched_raw === true || body.fetchedRaw === true,
    };
    const rows = provider === "otter"
      ? otterArtifactRowsFromManifest(args)
      : provider === "manual"
        ? { captureArtifacts: [], ...manualSourceArtifactRowsFromManifest(args) }
        : meetArtifactRowsFromManifest(args);

    if (provider === "manual") {
      rows.sourceArtifacts = (rows.sourceArtifacts || []).map((artifact) => ({
        ...artifact,
        uploaded_by: requester.userId,
      }));
      enforceManualMemberGuard({ role: requester.role, sourceArtifacts: rows.sourceArtifacts });
    }

    if (body.dry_run === true || body.persist === false) {
      return jsonResponse({ dry_run: body.dry_run === true, provider: provider || "google_meet", ...rows });
    }

    const ingestionEvents = await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "ingestion_events",
      rows: rows.ingestionEvents,
    });
    const captureArtifacts = await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "capture_artifacts",
      rows: rows.captureArtifacts,
      onConflict: "session_id,provider,artifact_kind,provider_resource_name",
    });
    const sourceArtifactRows = provider === "manual"
      ? rows.sourceArtifacts
      : linkedSourceArtifacts({
        orgId: args.orgId,
        sessionId: args.sessionId,
        rows,
        persistedCaptureArtifacts: captureArtifacts,
        fetchedRaw: args.fetchedRaw,
      });
    const sourceArtifacts = await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "source_artifacts",
      rows: sourceArtifactRows,
      onConflict: sourceArtifactConflict(sourceArtifactRows),
    });
    const processingJobRows = buildProcessingJobsFromSourceArtifacts({
      orgId: args.orgId,
      sourceArtifacts,
      policyVersion: body.policy_version || body.policyVersion,
      dueAt: body.due_at || body.dueAt,
      processorMode: body.processor_mode || body.processorMode || "local",
    });
    const processingJobs = await upsertRows({
      supabaseUrl,
      serviceRoleKey,
      table: "processing_jobs",
      rows: processingJobRows,
      onConflict: "source_artifact_id,job_kind,prompt_version",
    });
    const updatedSessions = await markSessionsSourceReady({
      supabaseUrl,
      serviceRoleKey,
      orgId: args.orgId,
      sourceArtifacts,
    });
    return jsonResponse({
      provider: provider || "google_meet",
      ingestionEvents: rows.ingestionEvents,
      captureArtifacts: rows.captureArtifacts,
      sourceArtifacts: sourceArtifactRows,
      processingJobs: processingJobRows,
      persisted: { ingestionEvents, captureArtifacts, sourceArtifacts, processingJobs, updatedSessions },
    });
  } catch (error) {
    return errorResponse(error);
  }
});
