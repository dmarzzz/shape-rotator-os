import { loadCalendarIngressConfig } from "./calendar-ingress-client.mjs";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid date: ${value}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  if (out.hour === "24") out.hour = "00";
  return out;
}

function mondayKey(parts) {
  const month = MONTH_INDEX[parts.month];
  const day = Number(parts.day);
  const year = Number(parts.year);
  const utc = new Date(Date.UTC(year, month, day));
  const offset = WEEKDAYS.indexOf(parts.weekday);
  const monday = new Date(utc.getTime() - offset * 86400000);
  return monday.toISOString().slice(0, 10);
}

function formatWeekDateRange(mondayIso) {
  const monday = new Date(`${mondayIso}T00:00:00Z`);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(monday);
  const sundayMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(sunday);
  const startDay = monday.getUTCDate();
  const endDay = sunday.getUTCDate();
  return month === sundayMonth ? `${month} ${startDay}-${endDay}` : `${month} ${startDay}-${sundayMonth} ${endDay}`;
}

function sessionCellText(session, timeZone) {
  const start = zonedParts(session.starts_at, timeZone);
  const end = zonedParts(session.ends_at, timeZone);
  const title = session.public_title || session.title || "Untitled session";
  const bits = [`${start.hour}:${start.minute}-${end.hour}:${end.minute} ${title}`];
  if (session.session_type || session.max_tier) {
    bits.push(`Type: ${session.session_type || "unknown"}${session.max_tier ? ` / ${session.max_tier}` : ""}`);
  }
  if (session.location) bits.push(`Location: ${session.location}`);
  if (session.google_meet_url) bits.push(`Meet: ${session.google_meet_url}`);
  return bits.join("\n");
}

export function calendarJsonFromSessions({ sessions, lastRefresh = new Date().toISOString(), tabName = "Supabase Sessions", timeZone = "America/New_York" } = {}) {
  if (!Array.isArray(sessions)) throw new Error("sessions array is required");
  const byWeek = new Map();
  for (const session of sessions) {
    if (!session || session.status === "cancelled" || !session.starts_at || !session.ends_at) continue;
    const effectiveTz = session.timezone || timeZone;
    const startParts = zonedParts(session.starts_at, effectiveTz);
    const weekKey = mondayKey(startParts);
    const offset = WEEKDAYS.indexOf(startParts.weekday);
    if (offset === -1) continue;
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, Array.from({ length: 7 }, () => []));
    byWeek.get(weekKey)[offset].push({ session, text: sessionCellText(session, effectiveTz) });
  }
  const rows = [[
    "Week",
    "Dates",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
    "On-Site / Available for Team Support",
    "Feedback loop goals",
    "Notes",
  ]];
  for (const [weekKey, cells] of Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push([
      String(rows.length),
      formatWeekDateRange(weekKey),
      ...cells.map((items) => items
        .sort((a, b) => String(a.session.starts_at).localeCompare(String(b.session.starts_at)))
        .map((item) => item.text)
        .join("\n\n")),
      "",
      "",
      "",
    ]);
  }
  return {
    last_refresh: lastRefresh,
    source: "supabase-sessions",
    tabs: { [tabName]: rows },
  };
}

export async function fetchSupabaseSessions({ config = loadCalendarIngressConfig(), fetchImpl = fetch } = {}) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey || !config?.accessToken || !config?.orgId) return null;
  const base = config.supabaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/rest/v1/sessions`);
  url.searchParams.set("select", [
    "id",
    "title",
    "public_title",
    "session_type",
    "max_tier",
    "status",
    "starts_at",
    "ends_at",
    "timezone",
    "location",
    "google_meet_url",
  ].join(","));
  url.searchParams.set("org_id", `eq.${config.orgId}`);
  url.searchParams.set("status", "in.(scheduled,completed)");
  url.searchParams.set("order", "starts_at.asc");
  const response = await fetchImpl(url, {
    headers: {
      apikey: config.supabaseAnonKey,
      authorization: `Bearer ${config.accessToken}`,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`sessions fetch failed: ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

export async function loadSupabaseCalendarSnapshot({ config = loadCalendarIngressConfig(), fetchImpl = fetch } = {}) {
  const sessions = await fetchSupabaseSessions({ config, fetchImpl });
  if (!sessions) return null;
  return calendarJsonFromSessions({ sessions });
}
