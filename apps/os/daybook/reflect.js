'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Reflection generator — the content strategy lives here.
//
// Shells out to the LOCAL `claude` CLI (`claude -p`). No API key, no extra
// network hop. Produces a structured digest for the shape-rotator cohort
// feed: third person, labeled sections, weighted across projects, one sharp
// insight, and bidirectional collaboration — concrete HELP ${name} can offer
// specific peers + concrete ASKS — all HIGH-CONFIDENCE and cited from the feed.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const { redact } = require('./redact');
const { loadRules } = require('./scope');
const postspec = require('./postspec');

// Strip ANTHROPIC_API_KEY so `claude -p` always uses the subscription, never the API.
function subscriptionEnv() { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; return e; }

function buildSystemPrompt(name) {
  // Length aim sits a little inside the locked gate window so a good post isn't
  // failed at the edges; both numbers trace to postspec (the locked contract).
  const aimMin = postspec.LENGTH.min + 40;
  const aimMax = postspec.LENGTH.max - 40;
  // The generator avoids the EXACT phrasings the G3 gate enforces.
  const bannedExamples = postspec.BANNED.map((b) => `"${b.example}"`).join(', ');
  return `You write ${name}'s DAILY UPDATE for the shape-rotator accelerator cohort's shared Router feed, read by peer builders. THIRD PERSON, ${name} is the subject. The goal is something ${name} will feel comfortable posting under his own name: plain, accurate, matter-of-fact. NOT an article, NOT a story.

OUTPUT: a single JSON object and NOTHING else — no markdown fences, no commentary. Schema:
{
  "quietDay": boolean,
  "headline": "a plain, factual one-line summary of the day (neutral — NOT a clever or punchy headline; max ~10 words, no period)",
  "post": "the full post text, ready to publish (see FORMAT)",
  "footnotes": [
    { "n": 1,
      "handle": "cohort handle WITHOUT @ (must appear in the COHORT FEED)",
      "quote": "the EXACT short phrase quoted in the body (3-10 words, verbatim from their entry)",
      "date": "human date of their entry, e.g. May 29",
      "excerpt": "~200-char surrounding excerpt from their entry, for context on hover" }
  ],
  "firstQuestion": "ONE warm, specific question (≤20 words, addressed to ${name} as 'you') that invites him to sharpen THIS post in a short interview — the single most useful thing to nail down: what he most wants the cohort to weigh in on or get back from them, or a spot the draft gets wrong or thin. Plain and grounded in the actual draft, NOT generic. Empty string only if the post is genuinely complete with nothing worth asking."
}

POST FORMAT (the "post" field), exactly in this order:
1. Line 1: "Router digest · ${'${DATE}'}"  (the date is given below)
2. Line 2: the plain summary line.
3. A blank line.
4. BODY — ~${aimMin}-${aimMax} words (hard limits ${postspec.LENGTH.min}-${postspec.LENGTH.max}), third-person, ${name} named in the first sentence. Lead-ins appear in THIS order; "Wins" and "Insight" are REQUIRED, the rest ONLY when genuine — omit any of them rather than manufacture content (a thinner honest post beats a padded one):
   - "Wins — " (required) what actually shipped or moved forward today.
   - "Struggles — " (ONLY if there was REAL friction) a genuine blocker or hard problem: something that actually fought back, broke, took many failed attempts, or is still unresolved. A normal product-design decision or a routine implementation choice that ${name} simply made and resolved is NOT a struggle — do not dramatize ordinary building as hardship. If the day was just steady work, OMIT this lead-in. Name real projects (teleport-router, router-daybook); NEVER a client.
   - "Insight — " (required) the one notable thing ${name} figured out or concluded, stated plainly. If a DAILY QUESTION is given AND clearly relevant, answer it in one line here; else ignore it.
   - "Offering — " (OMIT BY DEFAULT) include ONLY when ${name}'s actual work TODAY directly solves a SPECIFIC person's STATED problem in the feed — a genuinely useful handoff that person would actually want. A topical, same-domain, same-pattern, or same-tooling overlap is NOT enough; if the match isn't tight and truly useful, leave Offering out. When included: name the @handle, quote their EXACT problem phrase (3-10 words, verbatim, in "quotation marks") immediately followed by a superscript footnote marker, and state the SPECIFIC thing ${name} hands over. One forced offer is worse than none.
   - "Asking — " (OPTIONAL — a genuine, HIGH-VALUE ask, weighted by IMPORTANCE AND URGENCY to ${name}'s real goals). When ${name} has shipped something the cohort could actually TRY, USE, or have a view on — a user-facing feature, a product direction, anything where real usage or feedback would help — a testing/usage/direction ask is HIGH-VALUE: PREFER making it (e.g. "would a few people run this and say whether an in-app feed is worth opening daily, or whether they'd use it at all"). ${name} is usually not stuck, so a hard-blocker ask is the exception. OMIT Asking only when the work was genuinely INTERNAL/no-stakes (a refactor, hardening, plumbing) with nothing worth others' input. NEVER surface low-stakes implementation trivia (which variable, which nav pattern) as an ask — that is worse than omitting; never re-ask a solved problem; never invent a struggle; never end on a question just to end on one. Name a cohort member only on a tight, genuinely useful match (verbatim quote + marker); otherwise ask plainly with no name.
5. A blank line, then a sources block, exactly:
   "—"
   "Sources"
   then one line per footnote: "¹ @handle · date" (matching superscripts, in order).

TONE (important): plain, factual, direct — like ${name} reporting his own day to peers, not a journalist writing about him. State what happened. NO editorializing, NO clever or writerly turns of phrase ("the candor today was…", "rhymes with", "the sharpest move"), NO dramatization, NO hype, NO emoji. If a sentence sounds like a magazine, rewrite it flatter. Short, woven quotes only — never block quotes.

SIGNAL vs NOISE (critical): the WORK LOG is a raw transcript of ${name}'s AI-assistant sessions, full of incidental setup and process chatter that is NOT the work. IGNORE it. Specifically:
- How a session got bootstrapped — transcribing a voice note, dictating a prompt, the assistant searching the filesystem or reading its own transcript — is plumbing, not an accomplishment. NEVER report it.
- The assistant narrating its own tool use ("let me check…", "now I'll read…") is not ${name}'s work.
Report ONLY the substance: what ${name} is building, the real decisions, what shipped, what blocked him, what he concluded. If a detail wouldn't matter to a peer a week from now, leave it out.

COLLABORATION (the "Offering" and "Asking" lead-ins):
- RESTRAINT FIRST — a forced or merely-plausible connection is WORSE than none. The DEFAULT is to make NO @-mention at all. Only name a peer when ${name}'s actual work directly bears on that specific person's STATED problem AND the offer/ask is genuinely useful to them. Do NOT manufacture a connection to seem collaborative.
- THE SAME RESTRAINT GOVERNS STRUGGLES AND ASKS — report a struggle only when it was REAL friction, not a routine decision dressed as hardship. Never re-ask something he already solved as if it were open, never invent a struggle to justify a question, never end on a question just to end on one. Some honest days have no Struggles, no Offering, and no Asking — that is fine.
- WEIGHT BY IMPORTANCE AND URGENCY — when choosing what to surface, especially the ask, pick what actually MATTERS to ${name}'s goals and what the cohort can genuinely move, not whatever is merely true or technically honest. ${name} is usually not stuck, so a high-value ask is help testing or trying what he built, feedback on whether and how people would use it, or a real high-stakes decision — NOT low-stakes implementation trivia (which variable, which pattern). A trivial honest question is worse than no question. If nothing important enough exists, omit the ask.
- SUBSTANCE ONLY: a match must connect on the SUBSTANCE of the work — the actual problem, the architecture, the product question — NOT incidental tooling, keywords, the same domain, or the same UI pattern. (Both used Whisper, both built some kind of timeline, both have a settings toggle = SPURIOUS; drop it.) HIGH CONFIDENCE ONLY.
- CONCRETE + ACTIONABLE: every offer names a specific thing ${name} can give (a method he just got working, a pointer, code, a pairing session on the exact problem). Every ask names a specific thing ${name} needs. Present tense, real, doable this week.
- BANNED PHRASINGS — this hedge/vague-verb/blanket-openness register reads as lame and empty; NEVER write any of these (or close variants): ${bannedExamples}. If you cannot make an offer or ask specific and concrete, OMIT that line rather than pad it with one of these.

CITATIONS: every superscript marker (¹ ² ³) in the body MUST have a matching footnotes[] item AND a Sources line, numbered sequentially from 1. A quote without a verbatim feed source is not allowed — drop it. Never cite or @-mention ${name} himself.

HARD SAFETY RULES (never violate):
- NEVER include secrets, API keys, tokens, passwords, .env contents, or raw file contents.
- NEVER name a client. Describe client/sensitive work generically (e.g. "a client integration").
- Invent nothing. Every claim traces to the WORK LOG or the COHORT FEED; every quote is verbatim.

THIN DAY: if the day was trivial, set "quietDay": true and keep it short and honest; the app will offer to skip it.`;
}

function formatFeed(entries) {
  if (!entries || !entries.length) return '(no recent cohort entries available)';
  const lines = [];
  let budget = 14000;
  for (const e of entries) {
    const who = e.handle ? '@' + e.handle : (e.pseudonym || 'someone');
    const snippet = e.content.replace(/\s+/g, ' ').trim().slice(0, 420);
    const line = `- ${who} (${e.date}): ${snippet}`;
    budget -= line.length;
    if (budget < 0) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function parseResult(out) {
  const text = out.trim();
  // Strip accidental ```json fences.
  let body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // If there's prose around it, grab the outermost {...}.
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) body = body.slice(first, last + 1);
  try {
    const obj = JSON.parse(body);
    return {
      quietDay: !!obj.quietDay,
      headline: String(obj.headline || '').trim(),
      post: String(obj.post || '').trim(),
      footnotes: Array.isArray(obj.footnotes) ? obj.footnotes.map((f) => ({
        n: Number(f.n) || 0,
        handle: String(f.handle || '').replace(/^@/, ''),
        quote: String(f.quote || ''),
        date: String(f.date || ''),
        excerpt: String(f.excerpt || ''),
      })).filter((f) => f.n > 0 && f.handle) : [],
      // Bundled refine opener — shown under the draft as the "Refine in
      // interview" prompt and used as Q1 so the interview opens instantly.
      firstQuestion: String(obj.firstQuestion || '').trim(),
    };
  } catch {
    // Fallback: treat the whole output as the post text.
    return { quietDay: false, headline: '', post: text, footnotes: [], parseFallback: true };
  }
}

// generate(digest, { name, dateLabel, feedEntries, dailyQuestion })
function generate(digest, opts = {}) {
  const {
    name = 'They',
    dateLabel = 'today',
    feedEntries = [],
    dailyQuestion = null,
    myHandle = null,
    standingPreferences = '',
    currentDraft = '',     // when revising: the draft to change in place
    instruction = '',      // when revising: what the author wants different
    timeoutMs = 150000,
    model,
    onChunk,               // when set: stream real token deltas for the live counter
  } = opts;

  // Always-hide terms + client abstractions, shared by both scrub sites (I2).
  // Never throws; missing/corrupt file => empty rules.
  let rules;
  try { rules = loadRules(); } catch { rules = { hide: [], abstractions: [] }; }

  // ── SCRUB #1 (I2): deterministic CODE scrub of the digest BEFORE it can
  // enter the prompt that reaches Anthropic. Defense in depth — transcripts.js
  // may already have scrubbed the digest, but we re-run here on the bytes.
  // redact() is idempotent: re-masking already-masked text produces no new
  // confident findings and does not garble the existing mask tokens, so a
  // double scrub is safe to coordinate with an upstream scrub.
  const scrubbedDigest = redact(digest, rules).masked;

  let system = buildSystemPrompt(name).replace(/\$\{DATE\}/g, dateLabel);
  if (standingPreferences && standingPreferences.trim()) {
    system += `\n\nSTANDING PREFERENCES — ${name} has set these as standing rules for every digest. Apply ALL of them, unless one would conflict with a HARD SAFETY RULE:\n${standingPreferences}`;
  }

  const revising = !!(currentDraft && instruction && instruction.trim());

  const user = [
    `DATE: ${dateLabel}`,
    myHandle
      ? `IDENTITY: ${name}'s own cohort handle is @${myHandle}. ${name}'s own posts are already filtered out of the feed below — never @-mention @${myHandle}, and never treat ${name} as a collaboration match.`
      : '',
    dailyQuestion ? `DAILY QUESTION (use only if clearly relevant): ${dailyQuestion}` : '',
    '',
    '=== WORK LOG (today, from Claude Code + Codex) ===',
    scrubbedDigest,
    '',
    '=== COHORT FEED (last 14 days, for collaboration matching) ===',
    formatFeed(feedEntries),
    '',
    revising ? '=== CURRENT DRAFT (revise THIS) ===' : '',
    revising ? redact(currentDraft, rules).masked : '',
    revising ? '' : '',
    revising
      ? `${name} is reviewing the draft above and wants this changed:\n"${instruction.trim()}"\n\nRevise the draft to address that, while keeping everything that already works and obeying all the rules and the format. Output the full revised digest JSON.`
      : 'Write the digest JSON now.',
  ].filter((l) => l !== '').join('\n');

  return new Promise((resolve, reject) => {
    // Streaming mode (stream-json) when a live token callback is given — the
    // counter then reflects REAL model progress instead of a time estimate.
    // The final result is still the complete JSON object, parsed exactly as the
    // buffered path, so both redact scrubs below are unchanged.
    const streaming = !!onChunk;
    const args = ['-p'];
    if (streaming) args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
    args.push('--append-system-prompt', system);
    if (model) args.push('--model', model);

    let child;
    try {
      child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: subscriptionEnv() });
    } catch (err) {
      return reject(new Error('Could not launch the claude CLI: ' + err.message));
    }

    let out = '';
    let err = '';
    let acc = '';
    let buf = '';
    let usageTokens = 0;
    const emit = () => { try { onChunk(acc, Math.max(Math.round(acc.length / 4), usageTokens)); } catch { /* display only */ } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude CLI timed out while writing the reflection.'));
    }, timeoutMs);

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
      if (code !== 0 && !final.trim()) {
        return reject(new Error('claude CLI exited ' + code + ': ' + err.trim()));
      }
      const parsed = parseResult(final);

      // ── SCRUB #2 (I2): re-run the SAME deterministic scrubber + the user's
      // always-hide terms over the MODEL-GENERATED post/headline AFTER the
      // child closes and BEFORE we resolve to the caller. Nothing the model
      // emitted reaches the renderer/staging/Router until it has passed
      // through redact() on bytes. The UI binds its chips/counts to
      // postFindings (the findings over the FINAL outgoing post string).
      const postScrub = redact(parsed.post, rules);
      const headlineScrub = redact(parsed.headline, rules);
      parsed.post = postScrub.masked;
      parsed.headline = headlineScrub.masked;
      // Findings over the final outgoing text (post first, then headline).
      parsed.postFindings = postScrub.findings.concat(headlineScrub.findings);

      resolve(parsed);
    });

    child.stdin.write(user);
    child.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pattern extraction: given the log of revision notes, return ONLY the
// preferences that recur as a clear pattern (the same intent in 2+ notes).
// One-offs and jokes are deliberately ignored. Returns string[] (possibly []).
// ─────────────────────────────────────────────────────────────────────────
function extractPatterns(notes, opts = {}) {
  const { name = 'the author', timeoutMs = 60000, model } = opts;
  if (!notes || notes.length < 2) return Promise.resolve([]);

  const system = `You are given short revision notes ${name} gave on daily-update drafts, across several days. Identify ONLY the preferences that recur as a clear PATTERN — the same underlying intent expressed in 2 OR MORE separate notes. IGNORE anything that appears once: one-offs, jokes, and fixes specific to a single draft (e.g. a single "make it iambic pentameter" or "drop today's insight line" is NOT a pattern). Output ONLY a JSON array of short, general, imperative preference statements (e.g. ["Keep it under ~250 words", "Avoid @-mentions unless the overlap is strong"]). If nothing clearly recurs, output []. No prose, no fences.`;

  const user = 'REVISION NOTES (oldest first):\n'
    + notes.map((n) => `- ${n.date ? '(' + n.date + ') ' : ''}${n.text}`).join('\n')
    + '\n\nReturn the JSON array of recurring preferences (or []).';

  return new Promise((resolve) => {
    const args = ['-p', '--append-system-prompt', system];
    if (model) args.push('--model', model);
    let child;
    try { child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: subscriptionEnv() }); }
    catch { return resolve([]); }

    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve([]); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      let b = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const i = b.indexOf('['), j = b.lastIndexOf(']');
      if (i >= 0 && j > i) b = b.slice(i, j + 1);
      try {
        const arr = JSON.parse(b);
        resolve(Array.isArray(arr) ? arr.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8) : []);
      } catch { resolve([]); }
    });
    child.stdin.write(user);
    child.stdin.end();
  });
}

module.exports = { generate, extractPatterns, buildSystemPrompt, parseResult };
