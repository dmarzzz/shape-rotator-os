#!/usr/bin/env node

const { loadEnvFile } = require("./lib/env-file.cjs");

const ROLE_RANK = {
  none: 0,
  freeBusyReader: 1,
  reader: 2,
  writer: 3,
  owner: 4,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/setup-google-calendar-list.js --calendar-id CALENDAR_ID [--verify]",
    "  node scripts/setup-google-calendar-list.js --calendar-id CALENDAR_ID --apply",
    "",
    "What it does:",
    "  Checks or repairs the current OAuth user's personal Google CalendarList entry.",
    "  ACL grants are calendar-wide; CalendarList state is per-user and controls",
    "  whether the calendar appears as a normal visible/write target in Google Calendar.",
    "",
    "Options:",
    "  --apply                    Insert/update the user's CalendarList entry. Default is verify-only.",
    "  --verify                   Read and report CalendarList state without writing. This is the default.",
    "  --calendar-id ID           Google Calendar ID.",
    "  --access-token TOKEN       OAuth token for the admin user being checked.",
    "  --env-file FILE            Load local KEY=value secrets before env fallbacks.",
    "  --required-role ROLE       Minimum role expected for event creation. Default: writer.",
    "  --selected true|false      Desired selected state. Default: true.",
    "  --hidden true|false        Desired hidden state. Default: false.",
    "",
    "Environment fallbacks:",
    "  GOOGLE_CALENDAR_ID",
    "  GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_ACCESS_TOKEN",
    "",
    "Important:",
    "  This script fixes only the OAuth account attached to the supplied token.",
    "  To repair Michael's browser state, run it with Michael's OAuth token, not",
    "  the organizer/capture-bot token.",
  ].join("\n");
}

function arg(name, argv = process.argv) {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1];
}

function flag(name, argv = process.argv) {
  return argv.includes(name);
}

function boolArg(name, fallback, argv = process.argv) {
  const value = arg(name, argv);
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeRole(value) {
  const role = String(value || "writer").trim();
  if (!["none", "freeBusyReader", "reader", "writer", "owner"].includes(role)) {
    throw new Error(`unsupported role: ${role}`);
  }
  return role;
}

function roleRank(role) {
  return ROLE_RANK[role] ?? -1;
}

function calendarListUrl(suffix = "") {
  return new URL(`https://www.googleapis.com/calendar/v3/users/me/calendarList${suffix}`);
}

function calendarListEntryUrl(calendarId) {
  return calendarListUrl(`/${encodeURIComponent(calendarId)}`);
}

function tokenInfoUrl(accessToken) {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("access_token", accessToken);
  return url;
}

async function googleRequest({ url, accessToken, method = "GET", body, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`Google CalendarList ${method} ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function fetchTokenEmail({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(tokenInfoUrl(accessToken));
  const data = await response.json().catch(() => null);
  if (!response.ok) return null;
  return data?.email || null;
}

async function fetchCalendarListEntry({ calendarId, accessToken, fetchImpl = fetch }) {
  try {
    return await googleRequest({
      url: calendarListEntryUrl(calendarId),
      accessToken,
      fetchImpl,
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function insertCalendarListEntry({
  calendarId,
  accessToken,
  selected = true,
  hidden = false,
  fetchImpl = fetch,
}) {
  return googleRequest({
    url: calendarListUrl(),
    accessToken,
    method: "POST",
    body: { id: calendarId, selected, hidden },
    fetchImpl,
  });
}

async function patchCalendarListEntry({
  calendarId,
  accessToken,
  selected = true,
  hidden = false,
  fetchImpl = fetch,
}) {
  return googleRequest({
    url: calendarListEntryUrl(calendarId),
    accessToken,
    method: "PATCH",
    body: { selected, hidden },
    fetchImpl,
  });
}

function entryState(entry) {
  if (!entry) {
    return {
      found: false,
      summary: null,
      access_role: "none",
      selected: false,
      hidden: false,
    };
  }
  return {
    found: true,
    summary: entry.summary || null,
    access_role: entry.accessRole || "none",
    selected: entry.selected === true,
    hidden: entry.hidden === true,
  };
}

async function runGoogleCalendarListSetup({
  calendarId,
  accessToken,
  apply = false,
  selected = true,
  hidden = false,
  requiredRole = "writer",
  fetchImpl = fetch,
} = {}) {
  if (!calendarId) throw new Error("calendarId is required");
  if (!accessToken) throw new Error("accessToken is required");

  const requiredAccessRole = normalizeRole(requiredRole);
  const tokenEmail = await fetchTokenEmail({ accessToken, fetchImpl }).catch(() => null);
  const existing = await fetchCalendarListEntry({ calendarId, accessToken, fetchImpl });
  const current = entryState(existing);
  const result = {
    calendar_id: calendarId,
    token_email: tokenEmail,
    apply: !!apply,
    required_access_role: requiredAccessRole,
    desired: { selected: !!selected, hidden: !!hidden },
    ...current,
    access_ok: roleRank(current.access_role) >= roleRank(requiredAccessRole),
    visible_ok: current.selected === !!selected && current.hidden === !!hidden,
    create_dropdown_expected: false,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    would_insert: 0,
    would_update: 0,
    actions: [],
  };

  result.create_dropdown_expected = result.access_ok && current.selected === true && current.hidden === false;

  if (!existing) {
    result.missing = 1;
    if (!apply) {
      result.would_insert = 1;
      result.actions.push({
        action: "would_insert",
        calendar_id: calendarId,
        selected: !!selected,
        hidden: !!hidden,
      });
      return result;
    }
    const inserted = await insertCalendarListEntry({
      calendarId,
      accessToken,
      selected: !!selected,
      hidden: !!hidden,
      fetchImpl,
    });
    Object.assign(result, entryState(inserted));
    result.inserted = 1;
    result.visible_ok = result.selected === !!selected && result.hidden === !!hidden;
    result.access_ok = roleRank(result.access_role) >= roleRank(requiredAccessRole);
    result.create_dropdown_expected = result.access_ok && result.selected === true && result.hidden === false;
    result.actions.push({
      action: "inserted",
      calendar_id: calendarId,
      access_role: result.access_role,
      selected: result.selected,
      hidden: result.hidden,
    });
    return result;
  }

  const needsPatch = current.selected !== !!selected || current.hidden !== !!hidden;
  if (needsPatch) {
    if (!apply) {
      result.would_update = 1;
      result.actions.push({
        action: "would_update",
        calendar_id: calendarId,
        from: { selected: current.selected, hidden: current.hidden },
        to: { selected: !!selected, hidden: !!hidden },
      });
      return result;
    }
    const patched = await patchCalendarListEntry({
      calendarId,
      accessToken,
      selected: !!selected,
      hidden: !!hidden,
      fetchImpl,
    });
    Object.assign(result, entryState(patched));
    result.updated = 1;
    result.visible_ok = result.selected === !!selected && result.hidden === !!hidden;
    result.access_ok = roleRank(result.access_role) >= roleRank(requiredAccessRole);
    result.create_dropdown_expected = result.access_ok && result.selected === true && result.hidden === false;
    result.actions.push({
      action: "updated",
      calendar_id: calendarId,
      access_role: result.access_role,
      selected: result.selected,
      hidden: result.hidden,
    });
    return result;
  }

  result.unchanged = 1;
  result.actions.push({
    action: result.access_ok ? "unchanged" : "insufficient_access",
    calendar_id: calendarId,
    access_role: current.access_role,
    required_access_role: requiredAccessRole,
    selected: current.selected,
    hidden: current.hidden,
  });
  return result;
}

async function main(argv = process.argv) {
  if (flag("--help", argv)) {
    console.log(usage());
    return;
  }
  loadEnvFile(arg("--env-file", argv));
  const result = await runGoogleCalendarListSetup({
    calendarId: arg("--calendar-id", argv) || process.env.GOOGLE_CALENDAR_ID,
    accessToken: arg("--access-token", argv) || process.env.GOOGLE_CALENDAR_ACCESS_TOKEN || process.env.GOOGLE_ACCESS_TOKEN,
    requiredRole: arg("--required-role", argv) || "writer",
    selected: boolArg("--selected", true, argv),
    hidden: boolArg("--hidden", false, argv),
    apply: flag("--apply", argv),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}

module.exports = {
  calendarListEntryUrl,
  calendarListUrl,
  entryState,
  runGoogleCalendarListSetup,
};
