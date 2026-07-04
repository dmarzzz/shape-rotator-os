// cohort-chat-tips.js — first-visit-per-page teaching prompt for the bot.
//
// The first time a member lands on each TOP-LEVEL page, one suggestion chip
// slides out from behind the corner chat dial ("you can ask me about this
// page"). Clicking it opens the chat with the prompt staged — not sent — so
// it teaches without spending an AI run. Each page shows its tip once, ever
// (a seen-set persists in localStorage); ✕ or a timeout dismisses it quietly.
// Deliberately dumb: top-level pages only, never queued, never repeated.

const SEEN_KEY = "srwk:chat_page_tips_seen_v1";
const SHOW_DELAY_MS = 900;    // let the page paint before the tip slides out
const AUTO_HIDE_MS = 14000;

// One teaching prompt per top-level page (keys = body[data-alch-mode]).
const TIPS = {
  membrane: "what is this page showing me?",
  collab: "who should my team talk to?",
  calendar: "what's next on the calendar?",
  context: "which transcripts are relevant to my team?",
  shapes: "where is everyone at, quickly?",
  constellation: "what does this view mean?",
  mirror: "what's stale on my profile?",
  activity: "what are people asking for right now?",
  program: "what should I be doing this week?",
};

function readSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function markSeen(key) {
  const seen = readSeen();
  seen[key] = 1;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}

let tipEl = null;
let showTimer = null;
let hideTimer = null;

function removeTip() {
  clearTimeout(hideTimer); hideTimer = null;
  if (!tipEl) return;
  const el = tipEl;
  tipEl = null;
  el.classList.remove("is-in");
  setTimeout(() => { try { el.remove(); } catch {} }, 200);
}

function showTip(pageKey, prompt) {
  removeTip();
  // Only where the dial itself is visible (it hides on apps/network/links/matrix
  // tabs and while the panel is open — no teaching over an open chat).
  const dial = document.getElementById("cohort-chat-dial");
  if (!dial || !dial.offsetParent) return;
  if (document.documentElement.classList.contains("cohort-chat-open")) return;
  markSeen(pageKey); // shown counts as seen — even a dismiss shouldn't repeat it
  const el = document.createElement("div");
  el.className = "cc-page-tip";
  el.setAttribute("role", "status");
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "cc-page-tip-ask";
  ask.innerHTML = `<span class="cc-page-tip-lede">ask me about this page</span><span class="cc-page-tip-q"></span>`;
  ask.querySelector(".cc-page-tip-q").textContent = `“${prompt}”`;
  ask.addEventListener("click", () => {
    removeTip();
    import("./cohort-chat.js").then((m) => m.askCohort && m.askCohort(prompt, { send: false })).catch(() => {});
  });
  const x = document.createElement("button");
  x.type = "button";
  x.className = "cc-page-tip-x";
  x.setAttribute("aria-label", "dismiss");
  x.textContent = "✕";
  x.addEventListener("click", removeTip);
  el.appendChild(ask);
  el.appendChild(x);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-in"));
  tipEl = el;
  hideTimer = setTimeout(removeTip, AUTO_HIDE_MS);
}

function maybeQueueTip() {
  clearTimeout(showTimer); showTimer = null;
  const tab = document.body.dataset.activeTab || "alchemy";
  const mode = document.body.dataset.alchMode || "";
  const key = tab === "alchemy" ? mode : ""; // OS pages only — the dial hides elsewhere
  const prompt = TIPS[key];
  if (!prompt || readSeen()[key]) { removeTip(); return; }
  showTimer = setTimeout(() => showTip(key, prompt), SHOW_DELAY_MS);
}

export function initChatPageTips() {
  try {
    const obs = new MutationObserver(maybeQueueTip);
    obs.observe(document.body, { attributes: true, attributeFilter: ["data-alch-mode", "data-active-tab"] });
    maybeQueueTip();
  } catch { /* teaching is best-effort */ }
}
