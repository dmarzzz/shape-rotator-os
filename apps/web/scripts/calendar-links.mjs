export function googleCalendarUrl(feedHref) {
  const href = String(feedHref || "").trim();
  if (!href || href === "#") return "#";
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(href)}`;
}

export function buildCalendarExportLinks({
  host = globalThis.location?.host || "",
} = {}) {
  const feedHost = String(host || "").trim();
  const webcalHref = feedHost ? `webcal://${feedHost}/calendar.ics` : "#";
  return {
    adminHref: "#calendar-ingress",
    icsHref: "/calendar.ics",
    webcalHref,
    googleHref: googleCalendarUrl(webcalHref),
  };
}

export function wireCalendarExportLinks({
  documentRef = globalThis.document,
  host = globalThis.location?.host || "",
} = {}) {
  const links = buildCalendarExportLinks({ host });
  const ics = documentRef?.getElementById?.("cal-ics");
  const admin = documentRef?.getElementById?.("cal-admin");
  const webcal = documentRef?.getElementById?.("cal-webcal");
  const google = documentRef?.getElementById?.("cal-google");
  if (admin) admin.href = links.adminHref;
  if (ics) ics.href = links.icsHref;
  if (webcal) webcal.href = links.webcalHref;
  if (google) google.href = links.googleHref;
  return links;
}
