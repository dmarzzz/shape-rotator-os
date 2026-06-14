const ROLE_RANK = {
  none: 0,
  freeBusyReader: 1,
  reader: 2,
  writer: 3,
  owner: 4,
};

function googleCalendarListEntryUrl(calendarId) {
  return new URL(`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`);
}

function googleTokenInfoUrl(accessToken) {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("access_token", accessToken);
  return url;
}

function roleRank(role) {
  return ROLE_RANK[role] ?? -1;
}

async function fetchJson({ url, accessToken, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function inspectGoogleCalendarToken({
  calendarId,
  accessToken,
  expectedEmail,
  requiredAccessRole = "owner",
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if (!accessToken) throw new Error("accessToken is required");

  const calendarCheck = await fetchJson({
    url: googleCalendarListEntryUrl(calendarId),
    accessToken,
    fetchImpl,
  });
  if (!calendarCheck.response.ok) {
    const error = new Error(`Google Calendar token cannot read managed calendar: ${calendarCheck.response.status}`);
    error.status = calendarCheck.response.status;
    error.body = calendarCheck.data;
    throw error;
  }

  const accessRole = calendarCheck.data?.accessRole || "none";
  if (roleRank(accessRole) < roleRank(requiredAccessRole)) {
    throw new Error(`Google Calendar token has ${accessRole} access; ${requiredAccessRole} access is required`);
  }

  const tokenInfo = await fetchJson({
    url: googleTokenInfoUrl(accessToken),
    fetchImpl,
  }).catch(() => null);
  const tokenEmail = tokenInfo?.response?.ok ? tokenInfo.data?.email || null : null;
  const normalizedExpected = String(expectedEmail || "").trim().toLowerCase();
  const normalizedTokenEmail = String(tokenEmail || "").trim().toLowerCase();
  if (normalizedExpected && normalizedTokenEmail && normalizedExpected !== normalizedTokenEmail) {
    throw new Error(`Google OAuth token email ${tokenEmail} does not match organizer ${expectedEmail}`);
  }

  return {
    calendar_id: calendarId,
    access_role: accessRole,
    required_access_role: requiredAccessRole,
    token_email: tokenEmail,
    expected_email: expectedEmail || null,
    email_verified: !!normalizedExpected && normalizedExpected === normalizedTokenEmail,
  };
}

module.exports = {
  googleCalendarListEntryUrl,
  googleTokenInfoUrl,
  inspectGoogleCalendarToken,
  roleRank,
};
