import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "apps", "web", "calendar-runtime-config.js");

function googleCalendarSubscribeUrl(calendarId) {
  const id = String(calendarId || "").trim();
  return id ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(id)}` : "";
}

function existingMemberGoogleHref() {
  if (!fs.existsSync(outPath)) return "";
  const current = fs.readFileSync(outPath, "utf8");
  const match = /\bmemberGoogleHref:\s*("(?:\\.|[^"\\])*")/.exec(current);
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

// Single shared cohort calendar: members subscribe read-only to the same
// calendar admins edit directly (GOOGLE_CALENDAR_ID). The explicit
// SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL override still wins when set.
const memberGoogleHref = String(
  process.env.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL
    || process.env.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL
    || googleCalendarSubscribeUrl(process.env.GOOGLE_CALENDAR_ID)
    || existingMemberGoogleHref()
    || "",
).trim();

if (memberGoogleHref) {
  const parsed = new URL(memberGoogleHref);
  if (parsed.origin !== "https://calendar.google.com" || !parsed.pathname.startsWith("/calendar/")) {
    throw new Error("SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL or GOOGLE_CALENDAR_ID must produce a Google Calendar URL");
  }
}

const configLines = memberGoogleHref
  ? [`  memberGoogleHref: ${JSON.stringify(memberGoogleHref)},`]
  : [];
const contents = [
  "window.SHAPE_CALENDAR_LINKS = Object.freeze({",
  "  ...(window.SHAPE_CALENDAR_LINKS || {}),",
  ...configLines,
  "});",
  "",
].join("\n");
fs.writeFileSync(outPath, contents);

if (memberGoogleHref) {
  console.log("Wrote web calendar member subscription link.");
} else {
  console.log("Wrote blank web calendar runtime config.");
}
