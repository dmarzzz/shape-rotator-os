const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  aclIsVerified,
  backfillIsVerified,
  runGoogleCalendarLaunch,
} = require("./apply-google-calendar-launch.js");

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-google-launch-"));
  const source = path.join(dir, "calendar.json");
  fs.writeFileSync(source, JSON.stringify({
    last_refresh: "2026-06-13T16:12:46.618Z",
    tabs: {
      "May 18 Start": [
        ["Week", "Dates", "Mon", "Tue"],
        ["1", "Jun 1-7", "15:30-16:00 tea on roof", "Office hours"],
      ],
    },
  }, null, 2));
  return source;
}

function fakeGoogleFetch() {
  const eventsByUid = new Map();
  const aclByEmail = new Map();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, body });

    if (parsed.hostname === "oauth2.googleapis.com") {
      return Response.json({ email: "cube@shaperotator.xyz" });
    }

    assert.equal(options.headers.authorization, "Bearer google-token");

    if (parsed.pathname.includes("/calendarList/")) {
      return Response.json({
        id: decodeURIComponent(parsed.pathname.split("/").pop()),
        accessRole: "owner",
      });
    }

    if (parsed.pathname.includes("/events/import")) {
      eventsByUid.set(body.iCalUID, {
        id: `event-${eventsByUid.size + 1}`,
        status: "confirmed",
        summary: body.summary,
        description: body.description,
        start: body.start,
        end: body.end,
        extendedProperties: body.extendedProperties,
      });
      return Response.json({ id: eventsByUid.get(body.iCalUID).id, ...body });
    }
    if (parsed.pathname.includes("/events/") && method === "PATCH") {
      throw new Error("fixture should be unchanged by verification");
    }
    if (parsed.pathname.endsWith("/events") && method === "GET") {
      const uid = parsed.searchParams.get("iCalUID");
      const existing = eventsByUid.get(uid);
      return Response.json({ items: existing ? [existing] : [] });
    }

    if (parsed.pathname.endsWith("/acl") && method === "GET") {
      return Response.json({ items: Array.from(aclByEmail.values()) });
    }
    if (parsed.pathname.endsWith("/acl") && method === "POST") {
      const email = body.scope.value;
      const rule = {
        id: `${body.scope.type}:${email}`,
        role: body.role,
        scope: body.scope,
      };
      aclByEmail.set(email, rule);
      return Response.json(rule);
    }
    if (parsed.pathname.includes("/acl/") && method === "PATCH") {
      throw new Error("fixture should not need ACL patching");
    }

    return Response.json({ error: "unexpected URL" }, { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("Google calendar launch dry-run plans backfill and editor ACLs without fetch", async () => {
  const result = await runGoogleCalendarLaunch({
    sourcePath: writeFixture(),
    calendarId: "calendar@example.com",
    emails: "andrew@flashbots.net,tina@flashbots.net",
    fetchImpl: async () => {
      throw new Error("dry-run should not call fetch");
    },
  });

  assert.equal(result.apply, false);
  assert.equal(result.ready, false);
  assert.equal(result.backfill.planned, 2);
  assert.equal(result.acl.planned, 2);
  assert.equal(result.verification, null);
  assert.deepEqual(result.editor_emails, ["andrew@flashbots.net", "tina@flashbots.net"]);
});

test("Google calendar launch apply writes then verifies idempotent state", async () => {
  const fetchImpl = fakeGoogleFetch();
  const result = await runGoogleCalendarLaunch({
    sourcePath: writeFixture(),
    calendarId: "calendar@example.com",
    accessToken: "google-token",
    emails: "andrew@flashbots.net,tina@flashbots.net",
    organizerEmail: "cube@shaperotator.xyz",
    apply: true,
    fetchImpl,
  });

  assert.equal(result.apply, true);
  assert.equal(result.backfill.inserted, 2);
  assert.equal(result.acl.inserted, 2);
  assert.equal(result.verification.passed, true);
  assert.equal(result.ready, true);
  assert.equal(result.verification.backfill.unchanged, 2);
  assert.equal(result.verification.acl.unchanged, 2);
  assert.equal(result.token_guard.access_role, "owner");
  assert.equal(result.token_guard.email_verified, true);
  assert.ok(fetchImpl.calls.some((call) => call.method === "POST" && call.path.endsWith("/events/import")));
  assert.ok(fetchImpl.calls.some((call) => call.method === "POST" && call.path.endsWith("/acl")));
});

test("Google calendar launch apply requires an OAuth token", async () => {
  await assert.rejects(
    () => runGoogleCalendarLaunch({
      sourcePath: writeFixture(),
      calendarId: "calendar@example.com",
      apply: true,
    }),
    /accessToken is required/,
  );
});

test("Google calendar launch apply rejects the wrong Google account when tokeninfo exposes email", async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "oauth2.googleapis.com") return Response.json({ email: "michaelwilliamsonthego@gmail.com" });
    assert.equal(options.headers.authorization, "Bearer google-token");
    if (parsed.pathname.includes("/calendarList/")) return Response.json({ accessRole: "owner" });
    throw new Error(`unexpected URL: ${url}`);
  };

  await assert.rejects(
    () => runGoogleCalendarLaunch({
      sourcePath: writeFixture(),
      calendarId: "calendar@example.com",
      accessToken: "google-token",
      emails: "andrew@flashbots.net,tina@flashbots.net",
      organizerEmail: "cube@shaperotator.xyz",
      apply: true,
      fetchImpl,
    }),
    /does not match organizer/,
  );
});

test("Google calendar launch apply requires owner access for ACL grants", async () => {
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(options.headers.authorization, "Bearer google-token");
    if (parsed.pathname.includes("/calendarList/")) return Response.json({ accessRole: "writer" });
    throw new Error(`unexpected URL: ${url}`);
  };

  await assert.rejects(
    () => runGoogleCalendarLaunch({
      sourcePath: writeFixture(),
      calendarId: "calendar@example.com",
      accessToken: "google-token",
      emails: "andrew@flashbots.net,tina@flashbots.net",
      organizerEmail: "cube@shaperotator.xyz",
      apply: true,
      fetchImpl,
    }),
    /owner access is required/,
  );
});

test("Google calendar launch verification predicates require unchanged state", () => {
  assert.equal(backfillIsVerified({
    apply: true,
    planned: 2,
    inserted: 0,
    updated: 0,
    unchanged: 2,
  }), true);
  assert.equal(backfillIsVerified({
    apply: true,
    planned: 2,
    inserted: 1,
    updated: 0,
    unchanged: 1,
  }), false);
  assert.equal(aclIsVerified({
    apply: true,
    planned: 2,
    inserted: 0,
    updated: 0,
    unchanged: 2,
  }), true);
  assert.equal(aclIsVerified({
    apply: true,
    planned: 2,
    inserted: 0,
    updated: 1,
    unchanged: 1,
  }), false);
});
