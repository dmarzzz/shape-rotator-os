import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(root, "apps", "web", "calendar-runtime-config.js");

const memberGoogleHref = String(
  process.env.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL
    || process.env.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL
    || "",
).trim();

if (memberGoogleHref) {
  const parsed = new URL(memberGoogleHref);
  if (parsed.origin !== "https://calendar.google.com" || !parsed.pathname.startsWith("/calendar/")) {
    throw new Error("SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL must be a Google Calendar URL");
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
  console.log("Wrote web calendar member subscription link from deploy env.");
} else {
  console.log("Wrote blank web calendar runtime config.");
}
