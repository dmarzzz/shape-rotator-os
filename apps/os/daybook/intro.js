'use strict';

// ─────────────────────────────────────────────────────────────────────────
// First-run onboarding: a self-introduction to the cohort, modeled on the
// Router self-introduction prompt. Discovers the projects you actually work
// in, takes a few clarifying answers, and drafts a concrete, honest,
// privacy-first intro you approve before posting. Runs once; after that the
// app does daily digests.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const FLAG = path.join(HOME, '.router-daybook', 'introduced');

function isIntroduced() {
  try { return fs.existsSync(FLAG); } catch { return false; }
}
function markIntroduced() {
  try {
    fs.mkdirSync(path.dirname(FLAG), { recursive: true });
    fs.writeFileSync(FLAG, String(Date.now()));
  } catch { /* ignore */ }
}

// Save the interview transcript + the intro it produced, as a readable markdown
// file in the repo's interviews/ folder. `stamp` keys one file per session, so
// re-generating overwrites rather than piling up.
const INTERVIEWS_DIR = path.join(__dirname, '..', 'interviews');
function saveInterview({ transcript = [], post = '', name = '', handle = '', stamp = '' } = {}) {
  try { fs.mkdirSync(INTERVIEWS_DIR, { recursive: true }); } catch { /* ignore */ }
  const id = stamp || String(Date.now());
  const lines = [
    `# Interview — ${name}${handle ? ` (@${handle})` : ''}`,
    `Saved ${new Date().toISOString()}`,
    '',
  ];
  transcript.forEach((t, i) => {
    lines.push(`## Q${i + 1}. ${t.q}`, '', (t.a || '').trim() || '_(skipped)_', '');
  });
  lines.push('---', '', '## Generated introduction', '', post || '', '');
  const file = path.join(INTERVIEWS_DIR, `${id}.md`);
  try { fs.writeFileSync(file, lines.join('\n')); } catch { /* ignore */ }
  return file;
}

function newestJsonl(dir) {
  try {
    const f = fs.readdirSync(dir)
      .filter((x) => x.endsWith('.jsonl'))
      .map((x) => ({ x, m: fs.statSync(path.join(dir, x)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    return f ? path.join(dir, f.x) : null;
  } catch { return null; }
}

// The session files carry the real working directory — more reliable than
// decoding the dash-mangled project dir name.
function readCwd(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 8000);
    const m = head.match(/"cwd"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// A short, safe one-liner about a project — only ever reads package.json,
// CLAUDE.md, or README; never .env, credentials, or source.
function describe(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.description) return String(pkg.description).slice(0, 200);
  } catch { /* no package.json */ }
  for (const name of ['CLAUDE.md', 'README.md', 'readme.md', 'Readme.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const line = text.split('\n').map((s) => s.trim())
        .find((s) => s && !s.startsWith('#') && !s.startsWith('![') && !s.startsWith('<'));
      if (line) return line.slice(0, 200);
    } catch { /* try next */ }
  }
  return '';
}

// Discover the projects the user actually works in, newest first.
async function discoverProjects({ limit = 12 } = {}) {
  const byPath = new Map(); // path -> mtime
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* none */ }

  for (const d of dirs) {
    const dir = path.join(CLAUDE_PROJECTS, d);
    const j = newestJsonl(dir);
    if (!j) continue;
    const cwd = readCwd(j);
    if (!cwd) continue;
    let mt = 0;
    try { mt = fs.statSync(j).mtimeMs; } catch { /* ignore */ }
    if (!byPath.has(cwd) || mt > byPath.get(cwd)) byPath.set(cwd, mt);
  }

  return [...byPath.entries()]
    .filter(([p]) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => ({ name: path.basename(p), path: p, description: describe(p) }));
}

function buildIntroSystem(name) {
  return `You write the SELF-INTRODUCTION for the person whose machine and Claude subscription are running this — refer to them by their REAL FIRST NAME (you know who they are; "${name}" is only a fallback if you genuinely don't). For the cohort's shared Router feed, read by peer builders. THIRD PERSON — the subject is named in the first sentence. NEVER first person: no "I", "I'm", "my", "we", "me", "myself" anywhere. Write as someone introducing them to the cohort.

OUTPUT: a single JSON object and NOTHING else — no fences, no commentary:
{ "post": "the full introduction, ready to publish (PLAIN TEXT)" }

STRUCTURE — PLAIN TEXT, NO markdown (no "#", no "*", no "_", no "\`"), ~400-700 words. Separate sections with a blank line; each labeled section starts with a short plain label and an em-dash, like the daily digest ("Working on — …"):
- OPEN with a vivid, exciting opening paragraph (NO label) — a "call to adventure." In 3-5 sentences, capture the through-line and ambition of the subject's work and make the reader feel SEEN: name the real thing they're chasing, why it's hard, and why it matters / is part of something bigger. This paragraph should have ENERGY and momentum — a pleasure to read. It is the one place to be evocative. Stay grounded in the actual work; the excitement comes from real substance, never buzzwords or inflated claims.
- "Working on — " the projects listed below, described plainly.
- "Focus — " STRICTLY from what the author said in the INTERVIEW. If they didn't say, keep it to one plain sentence drawn from the most active work.
- "Background — " only expertise actually evident from the work; do not invent.
- "Looking to connect on — " STRICTLY from the author's INTERVIEW answers. List only people/topics they named. You may @-mention a named person only if that exact handle appears in the COHORT FEED. If they named nothing, write one short, general sentence (an open invitation) or omit the section. NEVER invent or infer who they want to connect with.

CONNECTIONS RULE (critical): do NOT assert that any specific cohort member is an overlap, or that ${name} is "interested in" connecting on something, unless the author stated it in the INTERVIEW. The app must not guess his interests or relationships. When in doubt, leave it out.

DIRECT QUOTES: weave in 1-3 SHORT verbatim quotes from ${name}'s own INTERVIEW answers — his actual words about what he's building, what drives him, what he can offer, or what he's looking for — in "quotation marks". They make the intro authentically his. Quote ONLY things he actually said in the INTERVIEW (verbatim, lightly trimmed at most); never invent or paraphrase into quotes. The narration stays third person around the quotes.

GROUNDING: base the intro on the RECENT WORK and PROJECTS provided — be specific to what ${name} has actually been building, the real problems and decisions. Avoid generic filler that could describe anyone; if it isn't grounded in the provided material, don't say it.

TONE: the OPENING paragraph is energizing, vivid, and exciting — a real hook. The body sections (What he's working on, Focus, Background, Looking to connect on) are plainer and concrete. Throughout: third person, no emoji, no first person, and every claim TRUE to the work — excitement comes from the real ambition and substance, never from buzzwords, inflated adjectives, or empty marketing-speak.

SOURCES: separate what is INFERRED from the work (hedge: "has been working on…", "appears to be") from what the author explicitly STATED. Never overstate.

PRIVACY (hard rules, never violate):
- NEVER include secrets, API keys, tokens, passwords, .env contents, or file contents.
- NEVER name a client, employer, or anything the author marked PRIVATE — describe such work generically ("a client project"). The exact private names must not appear anywhere in the post.
- Invent nothing. Every concrete claim traces to the projects, the author's answers, or the feed.`;
}

function extractJson(out) {
  let body = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const i = body.indexOf('{'), j = body.lastIndexOf('}');
  if (i !== -1 && j > i) body = body.slice(i, j + 1);
  try { return JSON.parse(body); } catch { return null; }
}

// Env with ANTHROPIC_API_KEY stripped, so `claude -p` always uses the user's
// subscription auth and can never accidentally bill the API.
function subscriptionEnv() {
  const e = { ...process.env };
  delete e.ANTHROPIC_API_KEY;
  return e;
}

// Shared runner: spawn `claude -p`, feed the user message, resolve final text.
// When `onChunk` is given, runs in streaming mode (stream-json) and calls
// onChunk(accumulatedText) as the model writes — for the live "thinking" view.
function runClaude(system, user, { timeoutMs = 150000, model, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const streaming = !!onChunk;
    const args = ['-p'];
    if (streaming) args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
    args.push('--append-system-prompt', system);
    if (model) args.push('--model', model);
    let child;
    try { child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: subscriptionEnv() }); }
    catch (err) { return reject(new Error('Could not launch the claude CLI: ' + err.message)); }
    let out = '', err = '', acc = '', buf = '', usageTokens = 0;
    // live output-token count (includes the model's hidden thinking tokens via
    // output_tokens_details); blend with a char estimate so it climbs smoothly.
    const emit = () => { try { onChunk(acc, Math.max(Math.round(acc.length / 4), usageTokens)); } catch { /* display only */ } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI timed out.')); }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (!streaming) { out += d.toString(); return; }
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'stream_event' && o.event) {
          const ev = o.event;
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            acc += ev.delta.text; emit();
          } else if (ev.type === 'message_delta' && ev.usage && typeof ev.usage.output_tokens === 'number') {
            usageTokens = ev.usage.output_tokens; emit();
          }
        } else if (o.type === 'result') {
          if (typeof o.result === 'string') out = o.result;
          if (o.usage && typeof o.usage.output_tokens === 'number') { usageTokens = o.usage.output_tokens; emit(); }
        }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('claude CLI error: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const final = streaming ? (out || acc) : out;
      if (code !== 0 && !final.trim()) return reject(new Error('claude CLI exited ' + code + ': ' + err.trim()));
      resolve(final);
    });
    child.stdin.write(user);
    child.stdin.end();
  });
}

function recentBlock(history, projects) {
  return [
    'RECENT WORK (from local Claude Code + Codex sessions — be specific to this):',
    history || '(no recent activity found)',
    '',
    'PROJECTS (names + short descriptions):',
    projects.length
      ? projects.map((p) => `- ${p.name}${p.description ? ': ' + p.description : ''}`).join('\n')
      : '(none detected)',
  ].join('\n');
}

// Recent posts from OTHER cohort members — used to ask sharper give/receive
// questions (e.g. "X is wrestling with Y — could you help, or want help there?").
function feedBlock(feedEntries) {
  if (!feedEntries || !feedEntries.length) return '';
  const lines = feedEntries.slice(0, 18).map((e) => {
    const who = e.handle ? '@' + e.handle : (e.pseudonym || 'someone');
    return `- ${who} (${e.date}): ${e.content.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  });
  return '\n\nCOHORT NOTEBOOK (recent posts from OTHERS — use these to find real overlaps between what they\'re doing/needing and what he could give or wants):\n' + lines.join('\n');
}

// Optional grounding for the "refine a draft" reuse: the current draft the
// interview is helping sharpen. Empty for the onboarding flow (no focus passed).
function focusBlock(focus) {
  if (!focus || !String(focus).trim()) return '';
  return '\n\nCURRENT DRAFT (what this conversation is helping ' + 'refine — ground questions in it, aim at what he most wants to say or get back):\n' + String(focus).trim();
}

// STEP 1 — a DYNAMIC interview (one question at a time, real follow-ups),
// modeled on the archive AI-interview craft. We never show a draft; the
// conversation produces the intro.

const interviewPurpose = (name) => `The purpose of this interview is to understand WHO ${name} is and how he fits this cohort — a community of builders who help each other. By the end you want to understand three things: who he is and what he's really chasing (the throughline and motivation, not a feature list); what he can GIVE the cohort (what he's unusually good at, could help others with, has hard-won lessons in, or has access/resources for); and what he wants to RECEIVE from it (the people, collaborators, skills, feedback, or resources he's actually looking for). The written intro is just the means to connect him with the right people — so dig for substance and reciprocity, not surface.`;

const INTERVIEW_CRAFT = `INTERVIEW CRAFT:
- Ask ONE question. Concise — less is more. NEVER a compound question (no second ask tacked on after a comma).
- Ground it in his real work so it's clearly about him — but stay natural and plain, NOT theatrical, cinematic, or over-written. No scene-setting.
- Aim at substance: who he is, what he wants, what he can offer or needs — not just a nice story.
- Warm, curious, direct. Address him as "you". No emoji. Output the question and nothing else (in the JSON).`;

const INTERVIEW_GOALS = `Over the conversation, come to understand:
(1) WHO he is / what he's chasing — the throughline and motivation behind the work.
(2) What he can GIVE the cohort — strengths, what he could help others with, lessons learned, resources or access.
(3) What he wants to RECEIVE — the people, collaborators, skills, feedback, or resources he's actually after (do NOT guess this; get him to say it).
Move toward these naturally; don't interrogate or ask them all at once. Also quietly note anything clearly private to keep off the feed.`;

// The whole welcome message as ONE natural, warm note — opens by noticing what
// you actually did most recently, then flows into what the Router is and what
// Router is about to do. Not a personalized line bolted onto boilerplate.
function welcomeMessage({ name = 'you', recent = '', dayLabel = '', timeoutMs = 60000, model } = {}) {
  const system = `Write the welcome message shown when ${name} opens the Router app for the first time. It must read as ONE natural, warm message in a single voice — NEVER a personalized sentence stitched onto a generic blurb.

SIGNAL vs NOISE (critical): the RECENT WORK is a raw session transcript and may contain quoted text, pasted prompts, long pasted histories, and assistant/tool chatter that are NOT what ${name} actually did. IGNORE all of that. Describe ONLY what he genuinely built, changed, or decided today — the real edits, files, decisions, problems. Never describe quoted or pasted material (or anything from a different time period embedded in the text) as his work. If you can't tell what he actually did, stay general rather than guess.

Flow naturally through these, in order:
1. Notice what ${name} has been working on most recently — name 1-2 concrete things he ACTUALLY did from the RECENT WORK below, in plain human language (no jargon, no bare list of project names). If RECENT WORK is empty or unclear, skip this and just open with a warm welcome.
2. Introduce the Router: the cohort's shared notebook — a live feed where the builders around you post what they're making, struggling with, and looking for; it's how people here find each other.
3. What happens next: you'll answer a few questions about your work, and they become an introduction you approve before anything posts.

Voice: warm, plain, direct, second person ("you"). About 3-5 sentences, ~55-90 words. It should sound like one person wrote it in one breath. No hype, no marketing-speak, no exclamation marks, no emoji, no headings, no lists. Output only the message.`;
  const user = `RECENT WORK${dayLabel ? ` (${dayLabel})` : ''}:\n${(recent || '(nothing notable found)').slice(0, 6000)}\n\nWrite the welcome message.`;
  return runClaude(system, user, { timeoutMs, model })
    .then((out) => out.trim())
    .catch(() => '');
}

// `purpose`, `goals`, `opening`, and `focus` are OPTIONAL overrides. They all
// default to the onboarding values, so existing callers (and the whole intro
// flow) behave byte-for-byte as before. The "refine a draft" reuse passes its
// own purpose/opening plus `focus` (the current draft) to ground the questions.
function firstQuestion({ name = 'They', projects = [], history = '', feedEntries = [], timeoutMs = 120000, model,
  purpose, opening, focus } = {}) {
  const purposeBlock = purpose || interviewPurpose(name);
  const openingBlock = opening || `Ask the FIRST question. Open on who he is and what he's building toward — the throughline of his work and what's driving it — in a way that invites him to talk about what he cares about and what he's reaching for. Ground it in his real work, but aim at motivation and substance, not a cinematic moment.`;
  const system = `You are interviewing ${name} for the shape-rotator accelerator cohort — a community of builders who help each other. You've read his recent work (CORPUS below) and the cohort's recent notebook posts.

${purposeBlock}

${openingBlock}

${INTERVIEW_CRAFT}

Output JSON only: { "question": "...", "hint": "optional 3-6 word hint" }`;
  const user = recentBlock(history, projects) + feedBlock(feedEntries) + focusBlock(focus) + '\n\nAsk the first question (JSON).';
  return runClaude(system, user, { timeoutMs, model }).then((out) => {
    const obj = extractJson(out) || {};
    return { question: String(obj.question || '').trim(), hint: String(obj.hint || '').trim(), done: false };
  });
}

function nextQuestion({ name = 'They', projects = [], history = '', feedEntries = [], transcript = [], maxTurns = 5, timeoutMs = 120000, model, onChunk,
  purpose, goals, focus } = {}) {
  if (transcript.length >= maxTurns) return Promise.resolve({ done: true });
  const purposeBlock = purpose || interviewPurpose(name);
  const goalsBlock = goals || INTERVIEW_GOALS;
  const system = `You are interviewing ${name} (CORPUS below) for the cohort. The conversation so far is given. Ask the NEXT question, or end if you understand enough.

${purposeBlock}

${goalsBlock}

${INTERVIEW_CRAFT}
- The next question must feel like a NATURAL follow-up and must NOT reuse the previous question's syntax or pattern.
- Where it fits, draw on the COHORT NOTEBOOK: probe a real overlap between what others are doing/needing and what he could give or wants (e.g. "@x has been deep in Y — is that something you could help with, or want help on?"). Don't force it.
- Build on what he just said. End when you understand enough.

Output JSON only: { "done": false, "question": "...", "hint": "..." }  OR  { "done": true }`;
  const convo = transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${(t.a || '').trim() || '(skipped)'}`).join('\n\n');
  const user = recentBlock(history, projects) + feedBlock(feedEntries) + focusBlock(focus) + '\n\nCONVERSATION SO FAR:\n' + convo + '\n\nAsk the next question or end (JSON).';
  return runClaude(system, user, { timeoutMs, model, onChunk }).then((out) => {
    const obj = extractJson(out) || {};
    if (obj.done) return { done: true };
    return { question: String(obj.question || '').trim(), hint: String(obj.hint || '').trim(), done: false };
  });
}

// STEP 2 — write the full intro from the recent work + the author's interview
// answers (Focus / connections come ONLY from answers, never inference).
function generateIntro({ name = 'They', handle = null, projects = [], history = '', interview = [], feedEntries = [], timeoutMs = 150000, model, onChunk } = {}) {
  const system = buildIntroSystem(name);
  const qa = (interview || []).filter((x) => x && (x.a || '').trim());
  const user = [
    `IDENTITY: ${name}${handle ? ` (@${handle})` : ''}`,
    '',
    recentBlock(history, projects),
    '',
    'INTERVIEW — the author\'s OWN words. Focus and "Looking to connect on" must come from these, and nothing else:',
    qa.length ? qa.map((x) => `- Q: ${x.q}\n  A: ${x.a.trim()}`).join('\n') : '(the author skipped the interview — keep Focus minimal and omit specific connections)',
    '',
    'COHORT FEED (only to resolve @handles the author NAMED — never to invent connections):',
    (feedEntries || []).slice(0, 20)
      .map((e) => `- @${e.handle || e.pseudonym} (${e.date}): ${e.content.replace(/\s+/g, ' ').slice(0, 160)}`)
      .join('\n') || '(none)',
    '',
    'Write the full introduction JSON now.',
  ].filter((l) => l !== '').join('\n');

  return runClaude(system, user, { timeoutMs, model, onChunk }).then((out) => {
    const obj = extractJson(out);
    if (obj && obj.post) return { post: String(obj.post).trim(), footnotes: [], quietDay: false, headline: '' };
    return { post: out.trim(), footnotes: [], quietDay: false, headline: '' };
  });
}

module.exports = { isIntroduced, markIntroduced, saveInterview, discoverProjects, welcomeMessage, firstQuestion, nextQuestion, generateIntro, FLAG };
