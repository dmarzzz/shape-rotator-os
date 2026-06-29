import test from "node:test";
import assert from "node:assert/strict";
import { qTokens, teamBlock, buildCohortContext, buildChatPrompt, classifyChatIntent, needsProjectConfirmation } from "./cohort-chat-context.mjs";
import { splitCommand, resolveCommand } from "../../cohort-chat-node.js";

const surface = {
  teams: [
    {
      record_id: "abra", name: "Abra", focus: "formal verification · TEE Postgres",
      now: "writing the verification registry spec",
      description: "A registry for proving TEE database claims against formal evidence.",
      domain: "tee",
      geo: "NYC",
      links: { repo: "abra-org/abra", website: "https://abra.dev" },
      traction: "verification registry spec is in active buildout",
      prior_shipping: ["TEE registry prototype"],
      success_dimensions: ["technical-risk"],
      seeking: ["TEE Postgres beta access"], offering: ["formal-verification office hours"],
      skill_areas: ["tee", "formal-verification"],
      journey: { stage: 3, primary_bottleneck: "Solution Quality", next_milestone: "validate registry against TeeSQL", problem: "TEE database claims need verifiable registry evidence" },
      connections: [{ to: "teesql", toName: "TeeSQL", score: 0.9, kind: "dependency", reason: "Abra needs TEE Postgres; TeeSQL offers it." }],
    },
    { record_id: "elocute", name: "Elocute", focus: "AI speech practice", offering: ["consumer GTM"], skill_areas: ["design"] },
  ],
  people: [
    { record_id: "albiona-hoti", name: "Albiona Hoti", team: "elocute", now: "compressing user conversations into a product plan", go_to_them_for: ["speech-practice tools"], skill_areas: ["agentic", "design"], bio: "Builds speech-practice product loops from user interviews.", working_style: "prototype with users" },
  ],
  transcript_evidence_cards: [
    { claim_type: "product_signal", claim_text: "Abra validated the registry spec against a TeeSQL dependency.", summary: "Project-specific validation signal.", evidence_level: "observed", confidence: 0.82, surface_tier: "T2", attribution_scope: "team", content_json: { week_start: "2026-06-14", teams: ["abra"], themes: ["TEE registry"], claims: [{ text: "TeeSQL beta access is the next validation dependency." }] } },
  ],
  whats_new: [{ date: "2026-06-20", label: "teesql v0.2.0", meta: "TeeSQL", kind: "release" }],
  cohort_intel: {
    project_week_snapshots: [{
      project_id: "abra",
      project_name: "Abra",
      week_start: "2026-06-14",
      declared_state: { bottleneck: "Solution Quality", bottleneck_category: "Solution Quality" },
      observed_state: {
        inferred_bottleneck: "Solution Quality",
        evidence_quality: "medium",
        evidence_summary: "2 transcript signals across 1 source card; 2 scored as project-specific.",
        top_observed_claims: [{ text: "The registry spec needs TeeSQL beta validation.", claim_type: "product_signal" }],
      },
      drift: { status: "aligned", reason: "Declared and observed bottlenecks agree." },
      evidence: { project_specific_signal_count: 2, signal_count: 2 },
    }],
    project_week_snapshot_quality: { snapshot_count: 1, project_count: 1, drift_status_counts: { aligned: 1 }, weak_snapshot_count: 0, insufficient_snapshot_count: 0 },
    project_progress_rollups: [{
      project_id: "abra",
      project_name: "Abra",
      latest_week_start: "2026-06-14",
      current_drift_status: "aligned",
      current_evidence_quality: "medium",
      declared_bottleneck: "Solution Quality",
      observed_bottleneck: "Solution Quality",
      trajectory: "on_track",
      intervention_priority: "low",
      operator_question: "Verify the next milestone moved rather than only the label improving.",
      recommended_next_check: "Validate the registry against TeeSQL.",
      coverage: { dated_week_count: 1, project_specific_signal_count: 2, signal_count: 2 },
    }],
    project_progress_rollup_quality: { rollup_count: 1, priority_counts: { low: 1 }, trajectory_counts: { on_track: 1 }, no_evidence_count: 0, undated_evidence_project_count: 0, coverage_gap_count: 0 },
    data_contract: {
      quality: {
        source_transcript_count: 1,
        total_signal_count: 2,
        claim_signal_count: 1,
        qa_signal_count: 1,
        team_signal_count: 1,
        person_signal_count: 0,
        missing_team_signal_count: 1,
        missing_person_signal_count: 1,
      },
    },
  },
};

test("qTokens keeps meaningful question terms, drops stopwords", () => {
  const t = qTokens("who should I talk to about TEE Postgres?");
  assert.ok(t.has("tee"));
  assert.ok(t.has("postgres"));
  assert.ok(qTokens("Shape OS").has("os"));
  assert.ok(!t.has("who"));
  assert.ok(!t.has("talk"));
});

test("teamBlock surfaces focus, seeking/offering, journey, and suggested connections", () => {
  const b = teamBlock(surface.teams[0]);
  assert.match(b, /focus: formal verification/);
  assert.match(b, /profile: domain tee; geo NYC/);
  assert.match(b, /description: A registry for proving TEE database claims/);
  assert.match(b, /links: repo: abra-org\/abra/);
  assert.match(b, /traction: verification registry spec/);
  assert.match(b, /prior shipping: TEE registry prototype/);
  assert.match(b, /seeking: TEE Postgres beta access/);
  assert.match(b, /progress: stage 3/);
  assert.match(b, /bottleneck: Solution Quality/);
  assert.match(b, /journey problem: TEE database claims/);
  assert.match(b, /suggested connections:/);
  assert.match(b, /TeeSQL: Abra needs TEE Postgres/);
});

test("buildCohortContext ranks the question-relevant team into full detail", () => {
  const ctx = buildCohortContext(surface, { question: "who works on TEE Postgres?" });
  assert.match(ctx, /COHORT: 2 teams, 1 people/);
  assert.match(ctx, /Data quality and coverage/);
  assert.match(ctx, /signal inventory: 2 total/);
  assert.match(ctx, /coverage gaps: 1 team\(s\) without transcript-derived signals/);
  // The TEE team should appear as a full block (has 'suggested connections').
  assert.match(ctx, /### Abra \(team, id:abra\)/);
  assert.match(ctx, /suggested connections/);
  // Distilled insight + activity sections present.
  assert.match(ctx, /Recent distilled session insights/);
  assert.match(ctx, /teams: abra/);
  assert.match(ctx, /meta: tier T2; type product_signal; level observed; confidence 0.82; scope team/);
  assert.match(ctx, /Recent activity/);
});

test("buildCohortContext includes focused project trajectory and evidence snapshots", () => {
  const ctx = buildCohortContext(surface, {
    question: "how is Abra doing this week?",
    focus: { teamId: "abra", teamName: "Abra", repos: ["abra-org/abra"] },
  });
  assert.match(ctx, /Project trajectory rows/);
  assert.match(ctx, /Abra: priority low; trajectory on_track; latest 2026-06-14; quality medium/);
  assert.match(ctx, /operator question: Verify the next milestone moved/);
  assert.match(ctx, /Project-week evidence snapshots/);
  assert.match(ctx, /top claim: The registry spec needs TeeSQL beta validation/);
});

test("buildCohortContext keeps the focused project in full detail even when query terms point elsewhere", () => {
  const ctx = buildCohortContext(surface, {
    question: "consumer GTM",
    fullTeams: 1,
    focus: { teamId: "abra", teamName: "Abra", repos: ["abra-org/abra"] },
  });
  assert.match(ctx, /### Abra \(team, id:abra\)/);
  assert.doesNotMatch(ctx, /### Elocute \(team, id:elocute\)/);
});

test("buildCohortContext respects the char budget", () => {
  const ctx = buildCohortContext(surface, { question: "x", maxChars: 200 });
  assert.ok(ctx.length <= 200 + 32);
});

test("buildChatPrompt frames the system role, embeds context + question, ends on Assistant:", () => {
  const p = buildChatPrompt({ surface, history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], question: "who should I talk to about TEE Postgres?" });
  assert.match(p, /cohort assistant/i);
  assert.match(p, /COHORT CONTEXT/);
  assert.match(p, /Member: who should I talk to about TEE Postgres\?/);
  assert.match(p, /Assistant:$/);
  // prior turns carried
  assert.match(p, /Conversation so far/);
  // default (non-agent) mode does NOT carry the action contract
  assert.doesNotMatch(p, /Proposing changes/);
});

test("buildChatPrompt agent mode injects the action contract + tool results", () => {
  const p = buildChatPrompt({ surface, question: "update my profile from my work", agent: true, toolResults: "SESSIONS: shipped the agent loop" });
  assert.match(p, /Proposing changes/);
  assert.match(p, /propose_profile_update/);
  assert.match(p, /submit_private_contact/);
  assert.match(p, /NEVER put email or Telegram in propose_profile_update/);
  assert.match(p, /Do NOT use `request_scan`, local sessions, Telegram chats, DMs, or message history/);
  assert.match(p, /TOOL RESULTS/);
  assert.match(p, /shipped the agent loop/);
  // still ends ready for the model to answer
  assert.match(p, /Assistant:$/);
});

test("award refresh prompt asks for relevant evidence, not pitching", () => {
  const p = buildChatPrompt({
    surface,
    question: "scan my work for awards evidence",
    agent: true,
    route: "refresh_update",
    focus: { teamId: "abra", teamName: "Abra", repos: ["abra-org/abra"] },
    focusResolution: { reason: "selected", candidates: [surface.teams[0]] },
  });
  assert.match(p, /evidence dossier, not a pitch deck/);
  assert.match(p, /supported evidence, missing evidence, and unrelated\/out-of-scope signal/);
  assert.match(p, /Keep only signal relevant to the active project/);
  assert.match(p, /Never write promotional award copy/);
});

test("chat routing classifies update scans and asks for a project when default focus is ambiguous", () => {
  const route = classifyChatIntent("refresh my github for this week");
  const focusResolution = {
    reason: "default-primary",
    focus: { teamId: "abra", teamName: "Abra", repos: ["abra-org/abra"] },
    candidates: surface.teams,
  };
  assert.equal(route, "refresh_update");
  assert.equal(needsProjectConfirmation(route, focusResolution), true);
  const p = buildChatPrompt({
    surface,
    question: "refresh my github for this week",
    agent: true,
    route,
    focus: focusResolution.focus,
    focusResolution,
  });
  assert.match(p, /===== ROUTING =====/);
  assert.match(p, /focus_reason: default-primary/);
  assert.match(p, /Before proposing a scan or profile\/project update, ask which project/);
});

test("chat routing keeps status questions read-only even when they mention this week", () => {
  assert.equal(classifyChatIntent("what did dmarz ship this week for Shape OS?"), "status_lookup");
});

// ── local AI CLI resolver ──────────────────────────────────────────────────
test("splitCommand handles quotes and bare args", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand(`ollama run "qwen2.5:7b"`), ["ollama", "run", "qwen2.5:7b"]);
});

test("resolveCommand honours an explicit COHORT_CHAT_CMD override", () => {
  const argv = resolveCommand("my-llm --print");
  assert.deepEqual(argv, ["my-llm", "--print"]);
});
