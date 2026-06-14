export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-goog-channel-id, x-goog-channel-token, x-goog-resource-id, x-goog-resource-state, x-goog-message-number",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export async function readJson(req) {
  const text = await req.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export function optionalEnv(name) {
  const value = Deno.env.get(name);
  return value && value.trim() ? value.trim() : null;
}

export function requiredEnv(name) {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function envJson(name, fallback) {
  const value = optionalEnv(name);
  if (!value) return fallback;
  return JSON.parse(value);
}

export function errorResponse(error, status = 500) {
  return jsonResponse({
    error: error?.message || String(error),
    details: error?.body || undefined,
  }, error?.status || status);
}
