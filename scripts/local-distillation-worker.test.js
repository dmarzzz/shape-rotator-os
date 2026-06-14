const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildDistillationBatch,
  fetchQueuedLocalJobs,
  resolveTranscriptPath,
  runLiveWorker,
} = require("./run-local-distillation-worker.js");
const { loadRoutingPolicy } = require("./lib/calendar-integration.cjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shape-worker-"));
  const transcriptPath = path.join(root, "demo-transcript.txt");
  fs.writeFileSync(transcriptPath, [
    "Alice decided the next action is to ship the demo next week and email alice@example.com.",
    "The private deployment link https://example.com/private should not leave the room.",
    "The presenter needs to approve the public candidate before Tuesday.",
  ].join(" "));
  const session = {
    id: "session_1",
    org_id: "org_1",
    session_type: "demo_presentation",
    public_title: "Demo review",
    title: "Internal demo review",
  };
  const sourceArtifact = {
    id: "source_1",
    org_id: "org_1",
    session_id: "session_1",
    source_kind: "manual_upload",
    storage_mode: "local_only",
    storage_ref: "demo-transcript.txt",
  };
  const processingJob = {
    id: "job_1",
    org_id: "org_1",
    source_artifact_id: "source_1",
    job_kind: "distill",
    processor_mode: "local",
    processor_status: "queued",
    prompt_version: "local-distill-v1",
  };
  return { root, transcriptPath, session, sourceArtifact, processingJob };
}

test("local distillation worker batch emits derived rows and never raw transcript text", () => {
  const { root, session, sourceArtifact, processingJob } = makeFixture();
  const output = buildDistillationBatch({
    jobs: [{ processingJob, sourceArtifact, session }],
  }, {
    policy: loadRoutingPolicy(),
    transcriptRoot: root,
  });
  const text = JSON.stringify(output);

  assert.equal(output.results.length, 1);
  assert.equal(output.failures.length, 0);
  assert.equal(output.derivedArtifacts.length, 2);
  assert.equal(output.approvalGates.length, 3);
  assert.equal(output.processingJobPatches[0].processor_status, "complete");
  assert.equal(output.sessionPatches[0].transcript_status, "distilled");
  assert.ok(output.approvalGates.every((gate) => gate.derived_artifact_id === output.derivedArtifacts[1].id));
  assert.doesNotMatch(text, /alice@example\.com/);
  assert.doesNotMatch(text, /https:\/\/example\.com\/private/);
});

test("local distillation worker completes private-only sessions without readouts", () => {
  const { root, session, sourceArtifact, processingJob } = makeFixture();
  const output = buildDistillationBatch({
    jobs: [{
      processingJob,
      sourceArtifact,
      session: { ...session, session_type: "private_1on1", public_title: "Private 1:1" },
    }],
  }, {
    policy: loadRoutingPolicy(),
    transcriptRoot: root,
  });

  assert.equal(output.results.length, 1);
  assert.equal(output.failures.length, 0);
  assert.equal(output.derivedArtifacts.length, 0);
  assert.equal(output.approvalGates.length, 0);
  assert.equal(output.processingJobPatches[0].processor_status, "complete");
  assert.equal(output.sessionPatches[0].transcript_status, "source_ready");
  assert.equal(output.sessionPatches[0].bot_status, "processed");
  assert.equal(Object.hasOwn(output.sessionPatches[0], "first_readout_at"), false);
});

test("local distillation worker refuses paths outside the transcript root", () => {
  const { root, transcriptPath, sourceArtifact } = makeFixture();
  assert.throws(
    () => resolveTranscriptPath({ ...sourceArtifact, storage_ref: transcriptPath }, { transcriptRoot: path.join(root, "nested") }),
    /escapes transcript root/,
  );
  assert.throws(
    () => resolveTranscriptPath({ ...sourceArtifact, storage_ref: "https://docs.google.com/document/d/example" }, { transcriptRoot: root }),
    /remote, not local/,
  );
});

test("local distillation worker reports unsupported sources as failures", () => {
  const { root, session, sourceArtifact, processingJob } = makeFixture();
  const output = buildDistillationBatch({
    jobs: [{
      processingJob,
      sourceArtifact: { ...sourceArtifact, source_kind: "otter_slide", storage_ref: "slide.png" },
      session,
    }],
  }, {
    policy: loadRoutingPolicy(),
    transcriptRoot: root,
  });

  assert.equal(output.results.length, 0);
  assert.equal(output.failures.length, 1);
  assert.match(output.failures[0].error, /not text-distillable/);
});

test("local distillation worker fetches queued Supabase jobs with source and session rows", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/processing_jobs")) {
      return Response.json([{ id: "job_1", org_id: "org_1", source_artifact_id: "source_1" }]);
    }
    if (pathname.endsWith("/source_artifacts")) {
      return Response.json([{ id: "source_1", session_id: "session_1", source_kind: "manual_upload" }]);
    }
    if (pathname.endsWith("/sessions")) {
      return Response.json([{ id: "session_1", session_type: "office_hours" }]);
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const rows = await fetchQueuedLocalJobs({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: "org_1",
    limit: 3,
    fetchImpl,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].processingJob.id, "job_1");
  assert.equal(rows[0].sourceArtifact.id, "source_1");
  assert.equal(rows[0].session.id, "session_1");
  assert.ok(calls.every((call) => call.options.headers.authorization === "Bearer service"));
  assert.match(calls[0].url, /processor_status=eq\.queued/);
});

test("local distillation worker live apply writes derived rows, gates, job completion, and session state", async () => {
  const { root, session, sourceArtifact, processingJob } = makeFixture();
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method, body });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/processing_jobs") && options.method === "GET") return Response.json([processingJob]);
    if (pathname.endsWith("/source_artifacts") && options.method === "GET") return Response.json([sourceArtifact]);
    if (pathname.endsWith("/sessions") && options.method === "GET") return Response.json([session]);
    if (pathname.endsWith("/derived_artifacts") && options.method === "POST") return Response.json(body);
    if (pathname.endsWith("/approval_gates") && options.method === "POST") return Response.json(body);
    if (pathname.endsWith("/processing_jobs") && options.method === "PATCH") return Response.json([{ id: "job_1", ...body }]);
    if (pathname.endsWith("/sessions") && options.method === "PATCH") return Response.json([{ id: "session_1", ...body }]);
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const output = await runLiveWorker({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: "org_1",
    policy: loadRoutingPolicy(),
    transcriptRoot: root,
    limit: 1,
    apply: true,
    fetchImpl,
  });

  assert.equal(output.fetched, 1);
  assert.equal(output.results.length, 1);
  assert.equal(output.applied.length, 1);
  assert.equal(output.failures.length, 0);
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/derived_artifacts") && call.body.length === 2));
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/approval_gates") && call.body.length === 3));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.url.includes("/processing_jobs") && call.body.processor_status === "running"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.url.includes("/processing_jobs") && call.body.processor_status === "complete"));
  assert.ok(calls.some((call) => call.method === "PATCH" && call.url.includes("/sessions") && call.body.transcript_status === "distilled"));
});

test("local distillation worker live apply keeps private-only sessions out of derived tables", async () => {
  const { root, session, sourceArtifact, processingJob } = makeFixture();
  const privateSession = { ...session, session_type: "private_1on1", public_title: "Private 1:1" };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method, body });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/processing_jobs") && options.method === "GET") return Response.json([processingJob]);
    if (pathname.endsWith("/source_artifacts") && options.method === "GET") return Response.json([sourceArtifact]);
    if (pathname.endsWith("/sessions") && options.method === "GET") return Response.json([privateSession]);
    if (pathname.endsWith("/processing_jobs") && options.method === "PATCH") return Response.json([{ id: "job_1", ...body }]);
    if (pathname.endsWith("/sessions") && options.method === "PATCH") return Response.json([{ id: "session_1", ...body }]);
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const output = await runLiveWorker({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service",
    orgId: "org_1",
    policy: loadRoutingPolicy(),
    transcriptRoot: root,
    limit: 1,
    apply: true,
    fetchImpl,
  });

  const sessionPatch = calls.find((call) => call.method === "PATCH" && call.url.includes("/sessions"))?.body;
  assert.equal(output.fetched, 1);
  assert.equal(output.results.length, 1);
  assert.equal(output.derivedArtifacts.length, 0);
  assert.equal(output.approvalGates.length, 0);
  assert.ok(!calls.some((call) => call.method === "POST" && call.url.includes("/derived_artifacts")));
  assert.ok(!calls.some((call) => call.method === "POST" && call.url.includes("/approval_gates")));
  assert.equal(sessionPatch.transcript_status, "source_ready");
  assert.equal(sessionPatch.bot_status, "processed");
  assert.equal(Object.hasOwn(sessionPatch, "first_readout_at"), false);
});
