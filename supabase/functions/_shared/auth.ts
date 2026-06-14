import { supabaseRest } from "./supabase_rest.ts";

function statusError(message: string, status: number) {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

export function bearerToken(req: Request) {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export function verifiedJwtClaims(req: Request) {
  const token = bearerToken(req);
  if (!token) throw statusError("authorization bearer token is required", 401);
  const parts = token.split(".");
  if (parts.length < 2) throw statusError("authorization bearer token is malformed", 401);
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw statusError("authorization bearer token payload is invalid", 401);
  }
}

export function authenticatedUserId(req: Request) {
  const claims = verifiedJwtClaims(req);
  const userId = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!userId) throw statusError("authenticated user is required", 401);
  return userId;
}

export async function requireOrgRole({
  req,
  supabaseUrl,
  serviceRoleKey,
  orgId,
  roles,
}: {
  req: Request;
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
  roles: string[];
}) {
  if (!orgId) throw statusError("org_id is required", 400);
  const userId = authenticatedUserId(req);
  const rows = await supabaseRest({
    supabaseUrl,
    serviceRoleKey,
    table: "org_memberships",
    method: "GET",
    query: {
      select: "role",
      org_id: `eq.${orgId}`,
      user_id: `eq.${userId}`,
      limit: "1",
    },
  });
  const role = Array.isArray(rows) && rows[0]?.role ? String(rows[0].role) : "";
  if (!roles.includes(role)) {
    throw statusError("insufficient org role", 403);
  }
  return { userId, role };
}
