function trimBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

export async function supabaseRest({ supabaseUrl, serviceRoleKey, table, method = "POST", body, query = {}, prefer = "return=representation" }) {
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  const url = new URL(`${trimBaseUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      prefer,
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

export async function supabaseRpc({ supabaseUrl, serviceRoleKey, functionName, body }) {
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!functionName) throw new Error("functionName is required");
  const url = new URL(`${trimBaseUrl(supabaseUrl)}/rest/v1/rpc/${functionName}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Supabase rpc ${functionName} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

export async function upsertRows({ supabaseUrl, serviceRoleKey, table, rows, onConflict }) {
  const body = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!body.length) return [];
  return supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table,
    body,
    query: onConflict ? { on_conflict: onConflict } : {},
    prefer: onConflict ? "resolution=merge-duplicates,return=representation" : "return=representation",
  });
}
