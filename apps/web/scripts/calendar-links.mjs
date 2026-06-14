export function googleCalendarUrl(feedHref) {
  const href = String(feedHref || "").trim();
  if (!href || href === "#") return "#";
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(href)}`;
}

export function configuredMemberGoogleHref({
  documentRef = globalThis.document,
  runtime = globalThis,
} = {}) {
  const direct = String(
    runtime?.SHAPE_CALENDAR_MEMBER_SUBSCRIBE_URL
      || runtime?.SHAPE_CALENDAR_AUTHORIZED_SUBSCRIBE_URL
      || "",
  ).trim();
  if (direct) return direct;

  const links = runtime?.SHAPE_CALENDAR_LINKS;
  if (links && typeof links === "object") {
    const fromConfig = String(
      links.memberGoogleHref
        || links.authorizedGoogleHref
        || links.authorizedSubscribeUrl
        || "",
    ).trim();
    if (fromConfig) return fromConfig;
  }

  const meta = documentRef?.querySelector?.(
    'meta[name="shape-calendar-member-subscribe-url"], meta[name="shape-calendar-authorized-subscribe-url"]',
  );
  return String(meta?.content || meta?.getAttribute?.("content") || "").trim();
}

export function buildCalendarExportLinks({
  host = globalThis.location?.host || "",
  memberGoogleHref = "",
} = {}) {
  const feedHost = String(host || "").trim();
  const webcalHref = feedHost ? `webcal://${feedHost}/calendar.ics` : "#";
  return {
    icsHref: "/calendar.ics",
    webcalHref,
    googleHref: googleCalendarUrl(webcalHref),
    memberGoogleHref: String(memberGoogleHref || "").trim(),
  };
}

export function wireCalendarExportLinks({
  documentRef = globalThis.document,
  host = globalThis.location?.host || "",
  runtime = globalThis,
  memberGoogleHref = "",
} = {}) {
  const links = buildCalendarExportLinks({
    host,
    memberGoogleHref: memberGoogleHref || configuredMemberGoogleHref({ documentRef, runtime }),
  });
  const ics = documentRef?.getElementById?.("cal-ics");
  const webcal = documentRef?.getElementById?.("cal-webcal");
  const google = documentRef?.getElementById?.("cal-google");
  const memberGoogle = documentRef?.getElementById?.("cal-google-member");
  if (ics) ics.href = links.icsHref;
  if (webcal) webcal.href = links.webcalHref;
  if (google) google.href = links.googleHref;
  if (memberGoogle) {
    memberGoogle.href = links.memberGoogleHref || "#";
    memberGoogle.hidden = !links.memberGoogleHref;
  }
  return links;
}
