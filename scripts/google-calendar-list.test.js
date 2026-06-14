const test = require("node:test");
const assert = require("node:assert/strict");
const {
  runGoogleCalendarListSetup,
} = require("./setup-google-calendar-list.js");

function calendarListFetch({ entry, tokenEmail = "admin@example.com", calls = [] } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path: parsed.pathname, body });

    if (parsed.hostname === "oauth2.googleapis.com") {
      return Response.json({ email: tokenEmail });
    }

    assert.equal(options.headers.authorization, "Bearer admin-token");

    if (method === "GET") {
      if (!entry) {
        return Response.json({ error: { code: 404, message: "Not found" } }, { status: 404 });
      }
      return Response.json(entry);
    }

    if (method === "POST") {
      assert.equal(parsed.pathname.endsWith("/users/me/calendarList"), true);
      return Response.json({
        id: body.id,
        summary: "Shape Rotator OS",
        accessRole: "writer",
        selected: body.selected,
        hidden: body.hidden,
      });
    }

    if (method === "PATCH") {
      return Response.json({
        ...entry,
        selected: body.selected,
        hidden: body.hidden,
      });
    }

    throw new Error(`unexpected method ${method}`);
  };
}

test("Google calendar list verify plans insert when current user is missing the calendar", async () => {
  const calls = [];
  const result = await runGoogleCalendarListSetup({
    calendarId: "calendar@example.com",
    accessToken: "admin-token",
    fetchImpl: calendarListFetch({ entry: null, calls }),
  });

  assert.equal(result.token_email, "admin@example.com");
  assert.equal(result.missing, 1);
  assert.equal(result.would_insert, 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.create_dropdown_expected, false);
  assert.deepEqual(result.actions.map((action) => action.action), ["would_insert"]);
});

test("Google calendar list apply inserts visible selected calendar for current user", async () => {
  const calls = [];
  const result = await runGoogleCalendarListSetup({
    calendarId: "calendar@example.com",
    accessToken: "admin-token",
    apply: true,
    fetchImpl: calendarListFetch({ entry: null, calls }),
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.access_role, "writer");
  assert.equal(result.selected, true);
  assert.equal(result.hidden, false);
  assert.equal(result.create_dropdown_expected, true);
  assert.equal(calls.some((call) => call.method === "POST"), true);
});

test("Google calendar list apply patches hidden or unselected entry", async () => {
  const calls = [];
  const result = await runGoogleCalendarListSetup({
    calendarId: "calendar@example.com",
    accessToken: "admin-token",
    apply: true,
    fetchImpl: calendarListFetch({
      calls,
      entry: {
        id: "calendar@example.com",
        summary: "Shape Rotator OS",
        accessRole: "owner",
        selected: false,
        hidden: true,
      },
    }),
  });

  assert.equal(result.updated, 1);
  assert.equal(result.access_role, "owner");
  assert.equal(result.selected, true);
  assert.equal(result.hidden, false);
  assert.equal(result.create_dropdown_expected, true);
  assert.equal(calls.some((call) => call.method === "PATCH"), true);
});

test("Google calendar list reports visible subscribed calendar that is not writable", async () => {
  const result = await runGoogleCalendarListSetup({
    calendarId: "calendar@example.com",
    accessToken: "admin-token",
    fetchImpl: calendarListFetch({
      entry: {
        id: "calendar@example.com",
        summary: "Shape Rotator OS",
        accessRole: "reader",
        selected: true,
      },
    }),
  });

  assert.equal(result.unchanged, 1);
  assert.equal(result.access_ok, false);
  assert.equal(result.visible_ok, true);
  assert.equal(result.create_dropdown_expected, false);
  assert.deepEqual(result.actions.map((action) => action.action), ["insufficient_access"]);
});
