function trimBaseUrl(url) {
  const value = String(url || "").trim();
  if (!value) throw new Error("supabaseUrl is required");
  return value.replace(/\/+$/, "");
}

function restUrl(supabaseUrl, table, onConflict) {
  const url = new URL(`${trimBaseUrl(supabaseUrl)}/rest/v1/${table}`);
  if (onConflict) url.searchParams.set("on_conflict", onConflict);
  return String(url);
}

function restQueryUrl(supabaseUrl, table, query = {}) {
  const url = new URL(`${trimBaseUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return String(url);
}

function compactRows(rows) {
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

function sessionConflict(rows) {
  if (rows.length && rows.every((row) => row.id)) return "id";
  if (rows.length && rows.every((row) => row.calendar_connection_id && row.google_event_id)) {
    return "calendar_connection_id,google_event_id";
  }
  return null;
}

function sourceArtifactConflict(rows) {
  if (rows.length && rows.every((row) => row.id)) return "id";
  if (rows.length && rows.every((row) => row.capture_artifact_id && row.source_kind)) {
    return "capture_artifact_id,source_kind";
  }
  return null;
}

function processingJobConflict(rows) {
  if (rows.length && rows.every((row) => row.source_artifact_id && row.job_kind && row.prompt_version)) {
    return "source_artifact_id,job_kind,prompt_version";
  }
  return null;
}

function approvalGateConflict(rows) {
  if (rows.length && rows.every((row) => row.derived_artifact_id && row.gate_key)) {
    return "derived_artifact_id,gate_key";
  }
  return null;
}

function requestForRows({ supabaseUrl, table, rows, onConflict }) {
  const body = compactRows(rows);
  if (!body.length) return null;
  return {
    table,
    method: "POST",
    url: restUrl(supabaseUrl, table, onConflict),
    headers: {
      "content-type": "application/json",
      prefer: onConflict ? "resolution=merge-duplicates,return=representation" : "return=representation",
    },
    body,
  };
}

function buildSupabaseUpsertRequests({
  supabaseUrl,
  sessions = [],
  attendees = [],
  ingestionEvents = [],
  captureArtifacts = [],
  sourceArtifacts = [],
  processingJobs = [],
  derivedArtifacts = [],
  approvalGates = [],
  artifactReviews = [],
} = {}) {
  const requests = [
    requestForRows({
      supabaseUrl,
      table: "sessions",
      rows: sessions,
      onConflict: sessionConflict(compactRows(sessions)),
    }),
    requestForRows({
      supabaseUrl,
      table: "session_attendees",
      rows: attendees,
      onConflict: compactRows(attendees).every((row) => row.session_id && row.email) ? "session_id,email" : null,
    }),
    requestForRows({
      supabaseUrl,
      table: "ingestion_events",
      rows: ingestionEvents,
    }),
    requestForRows({
      supabaseUrl,
      table: "capture_artifacts",
      rows: captureArtifacts,
      onConflict: "session_id,provider,artifact_kind,provider_resource_name",
    }),
    requestForRows({
      supabaseUrl,
      table: "source_artifacts",
      rows: sourceArtifacts,
      onConflict: sourceArtifactConflict(compactRows(sourceArtifacts)),
    }),
    requestForRows({
      supabaseUrl,
      table: "processing_jobs",
      rows: processingJobs,
      onConflict: processingJobConflict(compactRows(processingJobs)),
    }),
    requestForRows({
      supabaseUrl,
      table: "derived_artifacts",
      rows: derivedArtifacts,
      onConflict: compactRows(derivedArtifacts).every((row) => row.id) ? "id" : null,
    }),
    requestForRows({
      supabaseUrl,
      table: "approval_gates",
      rows: approvalGates,
      onConflict: approvalGateConflict(compactRows(approvalGates)),
    }),
    requestForRows({
      supabaseUrl,
      table: "artifact_reviews",
      rows: artifactReviews,
    }),
  ].filter(Boolean);
  return requests;
}

async function executeSupabaseRequests({ requests, serviceRoleKey, fetchImpl = fetch } = {}) {
  if (!serviceRoleKey) throw new Error("serviceRoleKey is required");
  const results = [];
  for (const request of requests || []) {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        ...request.headers,
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify(request.body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Supabase ${request.table} ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    results.push({ table: request.table, status: response.status, rows: data });
  }
  return results;
}

async function supabaseServiceRequest({
  supabaseUrl,
  serviceRoleKey,
  table,
  method = "GET",
  query = {},
  body,
  prefer = "return=representation",
  fetchImpl = fetch,
} = {}) {
  if (!serviceRoleKey) throw new Error("serviceRoleKey is required");
  const response = await fetchImpl(restQueryUrl(supabaseUrl, table, query), {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      ...(prefer ? { prefer } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Supabase ${table} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

module.exports = {
  buildSupabaseUpsertRequests,
  executeSupabaseRequests,
  supabaseServiceRequest,
};
