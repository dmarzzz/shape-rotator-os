import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clamp01,
  axisFraction,
  programWeekToMs,
  buildActivityLane,
  buildStandingLane,
  teamStageSeries,
  isPresent,
  buildPresenceLane,
  buildSessionsLane,
  buildReleasesLane,
  buildCommitsLane,
  buildMeetingsLane,
  buildTeamLane,
  buildDefaultTimeline,
  buildFollowedTimeline,
  filterTimelineByPrefs,
} from "./cohort-timeline-tracks.mjs";

const DAY = 86400000;
const START = Date.UTC(2026, 4, 18); // mon may 18 2026
const END = Date.UTC(2026, 6, 26); // sun jul 26 2026
const NOW = Date.UTC(2026, 5, 17); // wed jun 17 2026
const WINDOW = { startMs: START, endMs: END, nowMs: NOW };

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("clamp01 bounds and guards NaN", () => {
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(1.4), 1);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(NaN), 0);
});

test("axisFraction maps the program window to 0..1 and clamps", () => {
  assert.equal(axisFraction(START, START, END), 0);
  assert.equal(axisFraction(END, START, END), 1);
  assert.ok(close(axisFraction(START + (END - START) / 2, START, END), 0.5));
  assert.equal(axisFraction(START - DAY, START, END), 0); // before clamps
  assert.equal(axisFraction(END + DAY, START, END), 1); // after clamps
  assert.equal(axisFraction(START, START, START), 0); // zero span guarded
});

test("programWeekToMs returns week midpoints", () => {
  assert.equal(programWeekToMs(0, START), START + 3.5 * DAY);
  assert.equal(programWeekToMs(2, START), START + 17.5 * DAY);
});

test("buildActivityLane normalizes, filters, sorts, and flags future", () => {
  const whatsNew = [
    { date: "2026-07-23", kind: "event", label: "final demo day", meta: "ceremony", nav: { mode: "calendar" } },
    { date: "2026-06-13", kind: "release", label: "0.3.5", meta: "Shape Rotator OS", nav: { mode: "shapes", recordId: "shape-rotator-os" } },
    { date: "not-a-date", kind: "event", label: "junk" }, // dropped
    { date: "2026-05-25", kind: "ask", label: "need design help", meta: "asks" },
  ];
  const lane = buildActivityLane(whatsNew, WINDOW);
  assert.equal(lane.trackKey, "activity");
  assert.equal(lane.items.length, 3); // junk dropped
  // sorted ascending by time
  assert.deepEqual(
    lane.items.map((i) => i.title),
    ["need design help", "0.3.5", "final demo day"],
  );
  const demo = lane.items.find((i) => i.title === "final demo day");
  const release = lane.items.find((i) => i.title === "0.3.5");
  assert.equal(demo.category, "event");
  assert.equal(demo.isFuture, true); // 2026-07-23 > now
  assert.equal(demo.team, null); // calendar nav → no team
  assert.equal(release.isFuture, false); // 2026-06-13 < now
  assert.equal(release.team, "shape-rotator-os"); // shapes nav → team
  assert.deepEqual(release.detailRef, { nav: { mode: "shapes", recordId: "shape-rotator-os" } });
  assert.equal(release.tier, "public");
  assert.equal(release.shape, "point");
  assert.equal(release.id, "activity:2026-06-13:release:0-3-5");
  assert.ok(release.fraction > 0 && release.fraction < 1);
});

test("buildActivityLane tolerates non-array input", () => {
  assert.deepEqual(buildActivityLane(null, WINDOW).items, []);
  assert.deepEqual(buildActivityLane(undefined, WINDOW).items, []);
});

const STANDING = {
  weeks: [
    { program_week: 0, label: "Program start" },
    { program_week: 1, label: "Week 1" },
    { program_week: 2, label: "Week 2" },
  ],
  byTeam: {
    abra: { weeks: { 0: { stage: 0, confidence: "Low" }, 1: { stage: 2 }, 2: { stage: 4, confidence: "Medium" } } },
    beta: { weeks: { 0: { stage: 2 }, 1: { stage: 2 } } }, // no week 2
  },
};

test("buildStandingLane averages PMF stage per week across teams with data", () => {
  const lane = buildStandingLane(STANDING, WINDOW);
  assert.equal(lane.trackKey, "standing");
  assert.equal(lane.teamCount, 2);
  assert.equal(lane.stageMax, 8);
  const [w0, w1, w2] = lane.points;
  assert.equal(w0.stage, 1); // (0 + 2) / 2
  assert.equal(w0.teamsWithData, 2);
  assert.equal(w1.stage, 2); // (2 + 2) / 2
  assert.equal(w2.stage, 4); // only abra reported week 2
  assert.equal(w2.teamsWithData, 1);
  assert.ok(lane.points.every((p) => p.fraction >= 0 && p.fraction <= 1));
});

test("teamStageSeries maps a single team's weeks", () => {
  const series = teamStageSeries(STANDING.byTeam.beta, STANDING.weeks, START);
  assert.equal(series.length, 3);
  assert.equal(series[0].stage, 2);
  assert.equal(series[2].stage, null); // beta has no week 2
  assert.equal(series[1].ms, programWeekToMs(1, START));
});

test("isPresent honors window bounds and absences (inclusive end days)", () => {
  const person = {
    dates_start: "2026-05-18T00:00:00.000Z",
    dates_end: "2026-07-25T00:00:00.000Z",
    absences: [{ start: "2026-06-11T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z" }],
  };
  assert.equal(isPresent(person, Date.UTC(2026, 5, 1)), true); // jun 1, in window, no absence
  assert.equal(isPresent(person, Date.UTC(2026, 5, 15)), false); // jun 15, mid-absence
  assert.equal(isPresent(person, Date.UTC(2026, 5, 18)), true); // jun 18, day after absence ends
  assert.equal(isPresent(person, Date.UTC(2026, 4, 1)), false); // may 1, before arrival
  assert.equal(isPresent(person, Date.UTC(2026, 7, 1)), false); // aug 1, after departure
});

test("buildPresenceLane samples occupancy across the window", () => {
  const people = [
    { name: "A", dates_start: "2026-05-18T00:00:00.000Z", dates_end: "2026-07-25T00:00:00.000Z" },
    {
      name: "B",
      dates_start: "2026-05-18T00:00:00.000Z",
      dates_end: "2026-07-25T00:00:00.000Z",
      absences: [{ start: "2026-06-11T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z" }],
    },
    { name: "C", dates_start: "2026-06-15T00:00:00.000Z", dates_end: "2026-07-25T00:00:00.000Z" },
    { name: "NoDates" }, // excluded from roster
  ];
  const lane = buildPresenceLane(people, WINDOW);
  assert.equal(lane.trackKey, "presence");
  assert.equal(lane.total, 3); // NoDates excluded
  assert.equal(lane.samples[0].ms, START); // first sample at program start
  assert.equal(lane.samples[0].present, 2); // A + B present, C not yet arrived
  assert.ok(close(lane.samples[0].occupancy, 2 / 3));
  assert.ok(lane.samples.every((s) => s.fraction >= 0 && s.fraction <= 1));
  assert.ok(lane.samples.at(-1).ms <= END);
});

test("buildDefaultTimeline assembles the v1 lane set with a shared axis", () => {
  const out = buildDefaultTimeline(
    { whatsNew: [{ date: "2026-06-13", kind: "release", label: "x" }], standingWeekly: STANDING, people: [] },
    WINDOW,
  );
  assert.equal(out.axis.startMs, START);
  assert.equal(out.axis.endMs, END);
  assert.ok(out.axis.nowFraction > 0 && out.axis.nowFraction < 1);
  assert.deepEqual(
    out.lanes.map((l) => l.trackKey),
    ["activity", "standing", "presence"],
  );
});

test("buildSessionsLane places local sessions as tier:'local' points, sorted", () => {
  const sessions = [
    { id: "u2", source: "claude", title: "agent loop", project: "Shape OS", ms: Date.UTC(2026, 5, 20) },
    { id: "u1", source: "codex", project: "Engine", ms: Date.UTC(2026, 5, 10) },
    { id: "bad", source: "claude", ms: NaN }, // dropped
  ];
  const lane = buildSessionsLane(sessions, WINDOW);
  assert.equal(lane.trackKey, "sessions");
  assert.equal(lane.label, "my sessions");
  assert.equal(lane.items.length, 2); // bad ms dropped
  assert.deepEqual(lane.items.map((i) => i.title), ["Engine", "agent loop"]); // sorted by ms; project as title fallback
  assert.ok(lane.items.every((i) => i.tier === "local")); // never public
  assert.equal(lane.items[1].isFuture, true); // jun 20 > now (jun 17)
  assert.ok(lane.items.every((i) => i.fraction >= 0 && i.fraction <= 1));
});

test("buildSessionsLane tolerates non-array input", () => {
  assert.deepEqual(buildSessionsLane(null, WINDOW).items, []);
});

test("buildDefaultTimeline appends the sessions lane only when local sessions are passed", () => {
  const base = { whatsNew: [], standingWeekly: STANDING, people: [] };
  assert.equal(buildDefaultTimeline(base, WINDOW).lanes.some((l) => l.trackKey === "sessions"), false);
  const withSessions = buildDefaultTimeline(
    { ...base, localSessions: [{ id: "s", ms: NOW, title: "t" }] },
    WINDOW,
  );
  assert.equal(withSessions.lanes.at(-1).trackKey, "sessions");
});

test("filterTimelineByPrefs hides lanes and marker categories without mutating the source", () => {
  const timeline = buildDefaultTimeline(
    {
      whatsNew: [
        { date: "2026-06-13", kind: "release", label: "release", nav: { mode: "shapes", recordId: "abra" } },
        { date: "2026-06-14", kind: "commit", label: "commit", nav: { mode: "shapes", recordId: "abra" } },
      ],
      standingWeekly: STANDING,
      people: [],
    },
    WINDOW,
  );
  const filtered = filterTimelineByPrefs(timeline, {
    hiddenLanes: ["presence"],
    hiddenCategories: ["commit"],
  });
  assert.deepEqual(filtered.lanes.map((l) => l.trackKey), ["activity", "standing"]);
  assert.deepEqual(filtered.lanes[0].items.map((i) => i.category), ["release"]);
  assert.deepEqual(timeline.lanes[0].items.map((i) => i.category), ["release", "commit"]);
});

// ── follow-board fixtures + new lane builders ────────────────────────────────

const FOLLOW_WHATS_NEW = [
  { date: "2026-06-13", kind: "release", label: "0.3.5", meta: "Abra", nav: { mode: "shapes", recordId: "abra" } },
  { date: "2026-06-14", kind: "commit", label: "7 commits", meta: "Abra", nav: { mode: "shapes", recordId: "abra" } },
  { date: "2026-06-15", kind: "commit", label: "3 commits", meta: "TeeSQL", nav: { mode: "shapes", recordId: "teesql" } },
  { date: "2026-07-23", kind: "event", label: "demo day", nav: { mode: "calendar" } },
];

const FOLLOW_MATCHES = [
  {
    date: "2026-06-08",
    title_contains: ["WDYDLW with Shaw"],
    section: "wdydlw standup #1",
    confidence: "high",
    sources: [{ role: "transcript", mentions_direct: ["abra", "will-cory"], mentions_any: ["abra", "teesql"] }],
  },
  {
    date: "2026-06-10",
    title_contains: [],
    section: "icp interviews",
    confidence: "high",
    sources: [{ role: "transcript", mentions_direct: ["teesql"], mentions_any: ["teesql"] }],
  },
  { date: "bad-date", section: "dropped", sources: [{ mentions_any: ["abra"] }] }, // dropped
];

const TEAM_NAMES = new Map([["abra", "Abra"], ["teesql", "TeeSQL"]]);

test("buildReleasesLane / buildCommitsLane filter activity to one category, item color stays activity", () => {
  const rel = buildReleasesLane(FOLLOW_WHATS_NEW, WINDOW);
  assert.equal(rel.label, "releases");
  assert.deepEqual(rel.items.map((i) => i.category), ["release"]);
  assert.equal(rel.items[0].trackKey, "activity"); // color/shape unchanged
  assert.equal(rel.items[0].team, "abra");

  const com = buildCommitsLane(FOLLOW_WHATS_NEW, WINDOW);
  assert.equal(com.label, "github commits");
  assert.deepEqual(com.items.map((i) => i.category), ["commit", "commit"]); // sorted by date
  assert.deepEqual(com.items.map((i) => i.title), ["7 commits", "3 commits"]);
});

test("buildMeetingsLane places one transcript anchor per match, joins title_contains, drops bad dates", () => {
  const lane = buildMeetingsLane(FOLLOW_MATCHES, WINDOW);
  assert.equal(lane.trackKey, "transcript");
  assert.equal(lane.label, "meetings");
  assert.equal(lane.items.length, 2); // bad-date dropped
  const [a, b] = lane.items; // sorted ascending
  assert.equal(a.category, "transcript");
  assert.equal(a.title, "WDYDLW with Shaw");
  assert.equal(a.detail, "wdydlw standup #1");
  assert.equal(a.team, null);
  assert.equal(a.tier, "public");
  assert.equal(b.title, "icp interviews"); // empty title_contains falls back to section
  assert.ok(lane.items.every((i) => i.fraction >= 0 && i.fraction <= 1));
});

test("buildMeetingsLane tolerates non-array input", () => {
  assert.deepEqual(buildMeetingsLane(null, WINDOW).items, []);
});

test("buildTeamLane merges a team's releases+commits+insights+meetings, sorted, excludes other teams", () => {
  const evidence = [
    { claim_text: "Abra shipped registry", content_json: { week_start: "2026-06-01", teams: ["abra"], teams_basis: "inferred" } },
    { claim_text: "TeeSQL onboarded", content_json: { week_start: "2026-06-01", teams: ["teesql"] } },
  ];
  const lane = buildTeamLane(
    "abra",
    { whatsNew: FOLLOW_WHATS_NEW, evidenceCards: evidence, transcriptMatches: FOLLOW_MATCHES, teamNameById: TEAM_NAMES },
    WINDOW,
  );
  assert.equal(lane.trackKey, "team");
  assert.equal(lane.value, "abra");
  assert.equal(lane.label, "abra"); // lowercased team name
  // abra: 1 release + 1 commit + 1 insight + 1 meeting (the jun-08 match mentions abra)
  assert.equal(lane.items.length, 4);
  assert.ok(lane.items.every((i) => i.team === "abra"));
  assert.deepEqual(lane.items.map((i) => i.category), ["insight", "transcript", "release", "commit"]); // sorted by date
  // teesql's commit, insight + jun-10 meeting must NOT appear on abra's lane
  assert.ok(!lane.items.some((i) => i.title === "3 commits"));
  assert.ok(!lane.items.some((i) => i.title === "icp interviews"));
});

test("buildTeamLane matches transcript mentions by record_id OR slugged team name", () => {
  const matches = [
    { date: "2026-06-09", section: "by name", sources: [{ mentions_any: ["abra"], mentions_direct: [] }] },
    { date: "2026-06-11", section: "by slug", sources: [{ mentions_any: ["abra"], mentions_direct: [] }] },
  ];
  // Use a team whose record_id differs from slug(name) to prove name-slug matching.
  const names = new Map([["abra-team-rec", "Abra"]]);
  const lane = buildTeamLane(
    "abra-team-rec",
    { whatsNew: [], evidenceCards: [], transcriptMatches: matches, teamNameById: names },
    WINDOW,
  );
  // slug("Abra") === "abra" hits both matches even though record_id is "abra-team-rec"
  assert.equal(lane.items.length, 2);
});

test("buildTeamLane returns an empty lane for a blank team id", () => {
  const lane = buildTeamLane("", {}, WINDOW);
  assert.deepEqual(lane.items, []);
});

test("buildFollowedTimeline preserves follow order and normalizes each lane's render + payload", () => {
  const followed = [
    { id: "lane-1", kind: "releases", subjectId: null, label: "" },
    { id: "lane-2", kind: "standing", subjectId: null, label: "" },
    { id: "lane-3", kind: "presence", subjectId: null, label: "" },
    { id: "lane-4", kind: "meetings", subjectId: null, label: "" },
  ];
  const out = buildFollowedTimeline(
    followed,
    {
      whatsNew: FOLLOW_WHATS_NEW,
      standingWeekly: STANDING,
      people: [{ name: "A", dates_start: "2026-05-18T00:00:00.000Z", dates_end: "2026-07-25T00:00:00.000Z" }],
      transcriptMatches: FOLLOW_MATCHES,
    },
    WINDOW,
  );
  assert.equal(out.axis.startMs, START);
  assert.ok(out.axis.nowFraction > 0 && out.axis.nowFraction < 1);
  // order preserved 1:1 with the follow list
  assert.deepEqual(out.lanes.map((l) => l.id), ["lane-1", "lane-2", "lane-3", "lane-4"]);
  assert.deepEqual(out.lanes.map((l) => l.render), ["points", "standing", "presence", "points"]);
  assert.deepEqual(out.lanes.map((l) => l.trackKey), ["points", "standing", "presence", "points"]);
  assert.ok(out.lanes.every((l) => l.removable === true));
  // payload key matches render bucket
  assert.ok(Array.isArray(out.lanes[0].items)); // releases -> items
  assert.ok(Array.isArray(out.lanes[1].points)); // standing -> points
  assert.equal(out.lanes[1].stageMax, 8);
  assert.ok(Array.isArray(out.lanes[2].samples)); // presence -> samples
  assert.ok(Array.isArray(out.lanes[3].items)); // meetings -> items
  // count reflects placed markers
  assert.equal(out.lanes[0].count, 1); // one release
  assert.equal(out.lanes[3].count, 2); // two meetings
  // default labels filled per kind
  assert.equal(out.lanes[0].label, "releases");
  assert.equal(out.lanes[2].label, "in town");
});

test("buildFollowedTimeline maps legacy kinds shipped→releases, transcripts→meetings", () => {
  const out = buildFollowedTimeline(
    [
      { id: "a", kind: "shipped", subjectId: null, label: "" },
      { id: "b", kind: "transcripts", subjectId: null, label: "" },
    ],
    { whatsNew: FOLLOW_WHATS_NEW, transcriptMatches: FOLLOW_MATCHES },
    WINDOW,
  );
  assert.deepEqual(out.lanes.map((l) => l.kind), ["releases", "meetings"]);
  assert.equal(out.lanes[0].label, "releases");
  assert.equal(out.lanes[1].label, "meetings");
});

test("buildFollowedTimeline builds a team lane and uses the team name as the default label", () => {
  const out = buildFollowedTimeline(
    [{ id: "t", kind: "team", subjectId: "teesql", label: "" }],
    { whatsNew: FOLLOW_WHATS_NEW, transcriptMatches: FOLLOW_MATCHES, teamNameById: TEAM_NAMES },
    WINDOW,
  );
  assert.equal(out.lanes.length, 1);
  assert.equal(out.lanes[0].kind, "team");
  assert.equal(out.lanes[0].subjectId, "teesql");
  assert.equal(out.lanes[0].label, "teesql"); // lowercased team name
  assert.equal(out.lanes[0].render, "points");
});

test("buildFollowedTimeline honors an explicit subscription label (lowercased)", () => {
  const out = buildFollowedTimeline(
    [{ id: "x", kind: "activity", subjectId: null, label: "Everything" }],
    { whatsNew: FOLLOW_WHATS_NEW },
    WINDOW,
  );
  assert.equal(out.lanes[0].label, "everything");
});

test("buildFollowedTimeline skips a team lane with no subjectId and sessions without localSessions", () => {
  const out = buildFollowedTimeline(
    [
      { id: "noteam", kind: "team", subjectId: null, label: "" },
      { id: "sess", kind: "sessions", subjectId: null, label: "" },
      { id: "ok", kind: "activity", subjectId: null, label: "" },
    ],
    { whatsNew: FOLLOW_WHATS_NEW },
    WINDOW,
  );
  assert.deepEqual(out.lanes.map((l) => l.id), ["ok"]); // both unbuildable lanes dropped
});

test("buildFollowedTimeline includes a sessions lane only when localSessions are passed (private opt-in)", () => {
  const out = buildFollowedTimeline(
    [{ id: "sess", kind: "sessions", subjectId: null, label: "" }],
    { localSessions: [{ id: "s1", title: "agent loop", ms: NOW }] },
    WINDOW,
  );
  assert.equal(out.lanes.length, 1);
  assert.equal(out.lanes[0].kind, "sessions");
  assert.equal(out.lanes[0].render, "points");
  assert.ok(out.lanes[0].items.every((i) => i.tier === "local")); // still private
});

test("buildFollowedTimeline skips unknown kinds and tolerates a non-array follow list", () => {
  const out = buildFollowedTimeline(
    [{ id: "weird", kind: "made-up", subjectId: null, label: "" }, null, "junk"],
    { whatsNew: FOLLOW_WHATS_NEW },
    WINDOW,
  );
  assert.deepEqual(out.lanes, []);
  assert.deepEqual(buildFollowedTimeline(null, {}, WINDOW).lanes, []);
});
