// matrix-unread.js — numbered unread badge on the "matrix" nav entry.
//
// Mirrors the OS rail's what's-new badges: a small numbered circle in the
// gutter left of the matrix icon showing how many unread cohort-chat messages
// are waiting. When a saved Matrix session exists, the Matrix bridge
// (apps/os/matrix.js) resumes sync in the MAIN process at app start and
// broadcasts room summaries (each with a per-room `unread` count) over
// api.matrix.onRooms. Signed-out boots stay cheap: the initial status/rooms
// probes return logged-out/empty without loading the Matrix module.
//
// The counts are authoritative: chat.js sends a read receipt when the user
// opens a channel (api.markRead), so the homeserver zeroes that room's
// notification_count and the badge drops on the next sync. No client-side
// "seen" bookkeeping is needed.

let latestRooms = [];
let loggedIn = false;
let started = false;

function matrixBtn() {
  return document.querySelector('.primary-nav .nav-cat--dest[data-tab="matrix"]');
}

function unreadTotal() {
  if (!loggedIn) return 0;
  let n = 0;
  for (const r of latestRooms) n += Number(r && r.unread) || 0;
  return n;
}

function renderBadge() {
  const btn = matrixBtn();
  if (!btn) return;
  const n = unreadTotal();
  btn.classList.toggle("ar-unread", n > 0);
  let badge = btn.querySelector(".ar-unread-badge");
  if (n > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ar-unread-badge";
      badge.setAttribute("aria-hidden", "true");
      btn.appendChild(badge);
    }
    badge.textContent = n > 9 ? "9+" : String(n);
  } else if (badge) {
    badge.remove();
  }
}

function clearBadge() {
  const btn = matrixBtn();
  btn?.classList.remove("ar-unread");
  btn?.querySelector(".ar-unread-badge")?.remove();
}

export function initMatrixUnread() {
  if (started) return;
  const api = window.api && window.api.matrix;
  if (!api) return;   // no bridge (renderer reloaded without a full app start) — nothing to badge
  started = true;

  api.onStatus((s) => {
    loggedIn = !!(s && s.state && s.state !== "logged_out");
    if (!loggedIn) { clearBadge(); return; }
    renderBadge();
  });
  api.onRooms((list) => {
    latestRooms = Array.isArray(list) ? list : [];
    renderBadge();
  });

  // Broadcasts may have fired before we subscribed (matrix syncs from app
  // start) — pull the current status + rooms once to seed the badge.
  Promise.resolve(api.status?.()).then((s) => {
    loggedIn = !!(s && s.state && s.state !== "logged_out");
    if (!loggedIn) clearBadge(); else renderBadge();
  }).catch(() => {});
  Promise.resolve(api.rooms?.()).then((list) => {
    latestRooms = Array.isArray(list) ? list : [];
    renderBadge();
  }).catch(() => {});
}
