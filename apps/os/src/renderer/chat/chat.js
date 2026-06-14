// chat.js — the "chat" top-level tab: a read + write view onto the cohort
// Matrix channels.
//
// All Matrix traffic happens in the MAIN process (apps/os/matrix.js); this
// module is pure UI. It drives the client through window.api.matrix (invoke
// methods) and receives live rooms/messages over the onStatus/onRooms/
// onMessages subscriptions. v1 is unencrypted channels only — encrypted rooms
// are listed but locked (read + compose disabled) until E2EE lands.
//
// mountChat(host) is called once, lazily, the first time the tab is opened
// (see boot.js applyActiveTab). It owns its own DOM + listeners for the rest
// of the session.

const M = () => (window.api && window.api.matrix) || null;

const DEFAULT_HS = "https://mtrx.shaperotator.xyz";
const GH_MARK = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Stable hue per sender id → a readable color on the dark surface. Same FNV
// hash the rest of the OS uses for deterministic glyph/seal colors.
function senderHue(id) {
  let h = 2166136261 >>> 0;
  const s = String(id || "?");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
function senderColor(id) { return `hsl(${senderHue(id)}, 62%, 72%)`; }

// "@alice:mtrx.shaperotator.xyz" → "alice".
function senderName(id) { return String(id || "").replace(/^@/, "").split(":")[0]; }

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hr = d.getHours();
  const mn = String(d.getMinutes()).padStart(2, "0");
  const h12 = ((hr + 11) % 12) + 1;
  return `${h12}:${mn}${hr >= 12 ? "pm" : "am"}`;
}

export function mountChat(host) {
  const api = M();
  host.classList.add("chat-host");

  // Module state.
  let status = { state: "logged_out" };
  let rooms = [];
  let activeRoomId = null;
  const messagesByRoom = new Map(); // roomId → [msg]
  let loadedRoom = null;            // roomId whose timeline is currently in the DOM
  let showing = null;               // "gate" | "shell" — what's in the DOM now
  let autoSelected = false;

  // The Matrix bridge lives in the main process + preload. Those only load on
  // a FULL app start — if window.api.matrix is missing, the app was reloaded
  // (Cmd+R) but not relaunched. Say so plainly instead of showing a blank pane.
  if (!api) {
    host.innerHTML = `
      <div class="chat-gate">
        <div class="chat-gate-card">
          <h2 class="chat-gate-title">restart needed</h2>
          <p class="chat-gate-sub">The Matrix bridge isn't loaded. Fully <strong>quit and relaunch</strong> the app (a window reload isn't enough) and reopen this tab to sign in.</p>
        </div>
      </div>`;
    return;
  }

  // ─── login gate ──────────────────────────────────────────────────────────
  // Credential-free by default: the primary action opens the homeserver's SSO
  // page in the real browser (password never touches the app). We feature-
  // detect via the homeserver's /login flows — if SSO isn't enabled yet, we
  // say so plainly and tuck a clearly-temporary password path under "developer
  // sign-in" so the channels are still testable in the meantime.
  function renderGate() {
    loadedRoom = null;
    host.innerHTML = `
      <div class="chat-gate">
        <div class="chat-gate-card">
          <h2 class="chat-gate-title">sign in to matrix</h2>
          <div class="chat-gate-body"><div class="chat-gate-checking">checking sign-in…</div></div>
        </div>
      </div>`;
    refreshGateOptions();
  }

  async function refreshGateOptions() {
    const body = host.querySelector(".chat-gate-body");
    if (!body) return;
    let flows = [];
    let reachable = false;
    let why = "";
    try {
      const res = await api.flows(DEFAULT_HS);
      reachable = !!(res && res.ok);
      flows = (res && res.flows) || [];
      if (!reachable) why = (res && res.error) || "unexpected response";
    } catch (e) { why = String((e && e.message) || e); }
    if (!host.querySelector(".chat-gate-body")) return; // re-rendered while awaiting
    if (!reachable) {
      // A transient failure must NOT fall through to the password-only branch —
      // that's the phishing-shaped fallback this whole feature exists to avoid.
      // Offer a retry instead of falsely claiming the server has no other option.
      body.innerHTML = `
        <p class="chat-gate-note">Couldn't reach the homeserver to check sign-in options.${why ? ` <span class="chat-gate-why">(${esc(why)})</span>` : ""} Check your connection and try again.</p>
        <button class="chat-btn chat-btn-primary chat-retry" type="button">try again</button>`;
      const retry = body.querySelector(".chat-retry");
      if (retry) retry.addEventListener("click", refreshGateOptions);
      return;
    }
    const sso = flows.find((f) => f.type === "m.login.sso");
    const tokenFlow = flows.find((f) => f.type === "m.login.token" && f.get_login_token);
    if (sso) {
      const idps = Array.isArray(sso.identity_providers) ? sso.identity_providers : [];
      const buttons = idps.length
        ? idps.map((idp) => `<button class="chat-btn chat-btn-primary chat-sso" type="button" data-idp="${esc(idp.id)}">${ssoGlyph(idp)}<span>sign in with ${esc(idp.name || "sso")}</span></button>`).join("")
        : `<button class="chat-btn chat-btn-primary chat-sso" type="button" data-idp=""><span>sign in in your browser</span></button>`;
      body.innerHTML = `${buttons}<div class="chat-gate-status" role="status" aria-live="polite"></div>`;
      body.querySelectorAll(".chat-sso").forEach((b) => b.addEventListener("click", () => startSSO(b.dataset.idp)));
    } else if (tokenFlow) {
      // Toggle by which device you're already signed in on:
      //  • desktop → paste an access token from a desktop Element (works today)
      //  • mobile  → approve via QR from your phone (needs the homeserver's
      //    rendezvous relay, not deployed yet — see Andrew).
      body.innerHTML = `
        <div class="chat-seg" role="tablist" aria-label="how you're already signed in">
          <button class="chat-seg-btn is-active" type="button" data-pane="desktop">desktop</button>
          <button class="chat-seg-btn" type="button" data-pane="mobile">mobile</button>
        </div>
        <div class="chat-pane" data-pane="desktop">
          <form class="chat-token-form" autocomplete="off">
            <input class="chat-input-text" name="token" type="password" placeholder="paste access token" spellcheck="false" autocapitalize="off" />
            <p class="chat-gate-hint">From a signed-in <strong>desktop</strong> Element: <code>Settings → Help &amp; About → Access Token</code></p>
            <button class="chat-btn chat-btn-primary" type="submit">sign in</button>
            <div class="chat-login-msg" role="status" aria-live="polite"></div>
          </form>
        </div>
        <div class="chat-pane is-hidden" data-pane="mobile">
          <p class="chat-gate-note">Approve from a phone you're already signed in to — <strong>not enabled yet</strong>. It needs a one-time change on the homeserver (a rendezvous relay) before phones can approve a sign-in. Ping the admin to switch it on.</p>
        </div>`;
      wireSegmented();
      wireTokenForm();
    } else {
      body.innerHTML = `
        <p class="chat-gate-note">No password-free sign-in is available on this homeserver yet. Until it is, there's nothing to type here.</p>
        <details class="chat-dev">
          <summary>developer sign-in (temporary)</summary>
          ${passwordFormHtml()}
        </details>`;
      wirePasswordForm();
    }
  }

  function startDevice() {
    const body = host.querySelector(".chat-gate-body");
    if (body) {
      body.innerHTML = `
        <div class="chat-gate-checking">opening your browser… follow the steps there. this window signs you in automatically once you approve.</div>
        <button class="chat-btn chat-sso-cancel" type="button">cancel</button>`;
      const cancel = host.querySelector(".chat-sso-cancel");
      if (cancel) cancel.addEventListener("click", () => { api.cancelSSO(); refreshGateOptions(); });
    }
    api.loginDevice({ homeserver: DEFAULT_HS }).then((res) => {
      if (res && res.ok) return; // onStatus flips us into the chat shell
      if (res && res.error === "cancelled") return; // gate already re-rendered
      const b = host.querySelector(".chat-gate-body");
      if (!b) return;
      b.innerHTML = `
        <div class="chat-gate-error">${esc((res && res.error) || "sign-in failed")}</div>
        <button class="chat-btn chat-btn-primary chat-retry" type="button">try again</button>`;
      const retry = host.querySelector(".chat-retry");
      if (retry) retry.addEventListener("click", refreshGateOptions);
    });
  }

  function wireCodeForm() {
    const form = host.querySelector(".chat-code-form");
    if (!form) return;
    const msg = form.querySelector(".chat-login-msg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector("button[type=submit]");
      if (msg) { msg.textContent = "redeeming…"; msg.className = "chat-login-msg"; }
      btn.disabled = true;
      const res = await api.loginCode({ homeserver: DEFAULT_HS, token: String(fd.get("code") || "").trim() });
      btn.disabled = false;
      if (res && res.ok) { if (msg) msg.textContent = "connecting…"; }
      else if (msg) { msg.textContent = (res && res.error) || "sign-in failed"; msg.className = "chat-login-msg is-error"; }
    });
  }

  function wireTokenForm() {
    const form = host.querySelector(".chat-token-form");
    if (!form) return;
    const msg = form.querySelector(".chat-login-msg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const tok = String(new FormData(form).get("token") || "").trim();
      const btn = form.querySelector("button[type=submit]");
      if (!tok) { if (msg) { msg.textContent = "paste your access token first"; msg.className = "chat-login-msg is-error"; } return; }
      if (msg) { msg.textContent = "signing in…"; msg.className = "chat-login-msg"; }
      btn.disabled = true;
      const res = await api.loginAccessToken({ homeserver: DEFAULT_HS, accessToken: tok });
      btn.disabled = false;
      if (res && res.ok) { if (msg) msg.textContent = "connecting…"; }
      else if (msg) { msg.textContent = (res && res.error) || "sign-in failed"; msg.className = "chat-login-msg is-error"; }
    });
  }

  function wireSegmented() {
    const btns = host.querySelectorAll(".chat-seg-btn");
    const panes = host.querySelectorAll(".chat-pane");
    btns.forEach((b) => b.addEventListener("click", () => {
      const want = b.dataset.pane;
      btns.forEach((x) => x.classList.toggle("is-active", x === b));
      panes.forEach((p) => p.classList.toggle("is-hidden", p.dataset.pane !== want));
    }));
  }

  function startSSO(idpId) {
    const body = host.querySelector(".chat-gate-body");
    if (body) {
      body.innerHTML = `
        <div class="chat-gate-checking">opening your browser… approve the sign-in there, then come back.</div>
        <button class="chat-btn chat-sso-cancel" type="button">cancel</button>`;
      const cancel = host.querySelector(".chat-sso-cancel");
      if (cancel) cancel.addEventListener("click", () => { api.cancelSSO(); refreshGateOptions(); });
    }
    api.loginSSO({ homeserver: DEFAULT_HS, idpId: idpId || undefined }).then((res) => {
      if (res && res.ok) return; // onStatus flips us into the chat shell
      if (res && res.error === "cancelled") return; // gate already re-rendered
      const b = host.querySelector(".chat-gate-body");
      if (!b) return;
      b.innerHTML = `
        <div class="chat-gate-error">${esc((res && res.error) || "sign-in failed")}</div>
        <button class="chat-btn chat-btn-primary chat-retry" type="button">try again</button>`;
      const retry = host.querySelector(".chat-retry");
      if (retry) retry.addEventListener("click", refreshGateOptions);
    });
  }

  function ssoGlyph(idp) {
    const s = `${idp.id || ""} ${idp.name || ""}`.toLowerCase();
    return s.includes("github") ? `<span class="chat-sso-glyph">${GH_MARK}</span>` : "";
  }

  function passwordFormHtml() {
    return `
      <form class="chat-login" autocomplete="off">
        <label class="chat-field"><span class="chat-field-label">username</span><input class="chat-input-text" name="user" placeholder="your matrix username (e.g. fred)" spellcheck="false" autocapitalize="off" /></label>
        <label class="chat-field"><span class="chat-field-label">password</span><input class="chat-input-text" name="pass" type="password" /></label>
        <button class="chat-btn chat-btn-primary" type="submit">sign in</button>
        <div class="chat-login-msg" role="status" aria-live="polite"></div>
      </form>`;
  }

  function wirePasswordForm() {
    const form = host.querySelector(".chat-login");
    if (!form) return;
    const msg = form.querySelector(".chat-login-msg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector("button[type=submit]");
      if (msg) { msg.textContent = "signing in…"; msg.className = "chat-login-msg"; }
      btn.disabled = true;
      const res = await api.login({
        homeserver: DEFAULT_HS,
        user: String(fd.get("user") || "").trim(),
        password: String(fd.get("pass") || ""),
      });
      btn.disabled = false;
      if (res && res.ok) { if (msg) msg.textContent = "connecting…"; }
      else if (msg) { msg.textContent = (res && res.error) || "sign-in failed"; msg.className = "chat-login-msg is-error"; }
    });
  }

  // ─── chat shell ──────────────────────────────────────────────────────────
  function renderShell() {
    host.innerHTML = `
      <div class="chat-main">
        <aside class="chat-rooms">
          <header class="chat-rooms-head">
            <span class="chat-rooms-title">channels</span>
            <button class="chat-signout" type="button" title="sign out">sign out</button>
          </header>
          <ul class="chat-room-list" role="list"></ul>
        </aside>
        <section class="chat-room">
          <header class="chat-room-head">
            <span class="chat-room-name">—</span>
            <span class="chat-room-meta"></span>
          </header>
          <div class="chat-timeline" role="log" aria-live="polite">
            <div class="chat-empty">pick a channel to read it.</div>
          </div>
          <form class="chat-composer">
            <textarea class="chat-compose-input" rows="1" placeholder="message…" maxlength="4000"></textarea>
            <button class="chat-btn chat-send" type="submit" title="send (Enter)">send</button>
          </form>
        </section>
      </div>`;

    host.querySelector(".chat-signout").addEventListener("click", () => api.logout());

    const form = host.querySelector(".chat-composer");
    const input = host.querySelector(".chat-compose-input");
    form.addEventListener("submit", (e) => { e.preventDefault(); doSend(); });
    // Enter sends; Shift+Enter inserts a newline.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    // Grow the textarea up to a few lines as you type.
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    });

    renderRoomList();
  }

  async function doSend() {
    const input = host.querySelector(".chat-compose-input");
    if (!input || !activeRoomId) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    const res = await api.send(activeRoomId, text);
    if (!res || !res.ok) {
      input.value = text; // restore so the user doesn't lose it
      flashComposerError((res && res.error) || "send failed");
    }
    // On success we wait for the message to echo back through sync, so it
    // renders identically to everyone else's — no optimistic duplicate.
  }

  function flashComposerError(text) {
    const form = host.querySelector(".chat-composer");
    if (!form) return;
    let el = form.querySelector(".chat-composer-error");
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-composer-error";
      form.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.remove(); }, 4000);
  }

  // ─── room list ───────────────────────────────────────────────────────────
  function renderRoomList() {
    const ul = host.querySelector(".chat-room-list");
    if (!ul) return;
    if (!rooms.length) {
      ul.innerHTML = `<li class="chat-room-empty">${status.state === "syncing" ? "no channels yet." : "connecting…"}</li>`;
      return;
    }
    ul.innerHTML = rooms.map((r) => `
      <li>
        <button class="chat-room-btn${r.roomId === activeRoomId ? " is-active" : ""}" type="button" data-room="${esc(r.roomId)}">
          <span class="chat-room-row">
            <span class="chat-room-btn-name">${r.encrypted ? '<span class="chat-lock" title="end-to-end encrypted">🔒</span> ' : ""}${esc(r.name)}</span>
            ${r.unread ? `<span class="chat-room-unread">${r.unread}</span>` : ""}
          </span>
          ${r.lastPreview ? `<span class="chat-room-preview">${esc(r.lastPreview)}</span>` : ""}
        </button>
      </li>`).join("");
    ul.querySelectorAll("[data-room]").forEach((btn) => {
      btn.addEventListener("click", () => selectRoom(btn.dataset.room));
    });
  }

  async function selectRoom(roomId) {
    activeRoomId = roomId;
    renderRoomList(); // refresh active highlight
    const room = rooms.find((r) => r.roomId === roomId);
    const nameEl = host.querySelector(".chat-room-name");
    const metaEl = host.querySelector(".chat-room-meta");
    if (nameEl) nameEl.textContent = room ? room.name : roomId;
    if (metaEl) metaEl.textContent = room && room.encrypted ? "end-to-end encrypted" : "";

    // Pull the cached timeline from main (it keeps the last few hundred).
    const data = await api.messages(roomId);
    messagesByRoom.set(roomId, data.messages || []);
    loadedRoom = roomId;
    renderTimeline(roomId, data.encrypted);
    setComposerEnabled(!data.encrypted);
  }

  function setComposerEnabled(on) {
    const input = host.querySelector(".chat-compose-input");
    const btn = host.querySelector(".chat-send");
    if (input) {
      input.disabled = !on;
      input.placeholder = on ? "message…" : "🔒 end-to-end encrypted — can't post here yet";
    }
    if (btn) btn.disabled = !on;
  }

  function renderTimeline(roomId, encrypted) {
    const tl = host.querySelector(".chat-timeline");
    if (!tl) return;
    if (encrypted) {
      tl.innerHTML = `<div class="chat-locked"><div class="chat-locked-glyph">🔒</div><div class="chat-locked-title">end-to-end encrypted</div><div class="chat-locked-sub">This room is encrypted. Reading it needs E2EE support, which isn't in this build yet — open it in Element for now.</div></div>`;
      return;
    }
    const msgs = messagesByRoom.get(roomId) || [];
    if (!msgs.length) {
      tl.innerHTML = `<div class="chat-empty">no messages yet.</div>`;
      return;
    }
    tl.innerHTML = msgs.map(renderMsg).join("");
    tl.scrollTop = tl.scrollHeight;
  }

  function renderMsg(m) {
    const name = senderName(m.sender);
    return `
      <div class="chat-msg${m.mine ? " is-mine" : ""}">
        <span class="chat-msg-sender" style="color:${senderColor(m.sender)}" title="${esc(m.sender)}">${esc(name)}</span>
        <span class="chat-msg-body">${esc(m.body)}</span>
        <span class="chat-msg-time">${fmtTime(m.ts)}</span>
      </div>`;
  }

  // Append live messages to the active room without a full re-render.
  function appendMessages(roomId, msgs) {
    const cache = messagesByRoom.get(roomId) || [];
    const seen = new Set(cache.map((m) => m.eventId));
    for (const m of msgs) if (!seen.has(m.eventId)) cache.push(m);
    messagesByRoom.set(roomId, cache);
    if (roomId !== activeRoomId || loadedRoom !== roomId) return;
    const tl = host.querySelector(".chat-timeline");
    if (!tl) return;
    if (tl.querySelector(".chat-empty")) tl.innerHTML = "";
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    for (const m of msgs) {
      if (seen.has(m.eventId)) continue;
      tl.insertAdjacentHTML("beforeend", renderMsg(m));
    }
    if (nearBottom) tl.scrollTop = tl.scrollHeight;
  }

  // ─── render router ─────────────────────────────────────────────────────────
  function render() {
    const want = status.state === "logged_out" ? "gate" : "shell";
    if (want === showing) {
      if (want === "shell") renderRoomList();
      return;
    }
    showing = want;
    if (want === "gate") renderGate();
    else { renderShell(); maybeAutoSelect(); }
  }

  // First time the room list arrives, drop the user into the busiest-looking
  // channel so the view isn't an empty pane.
  function maybeAutoSelect() {
    if (autoSelected || !rooms.length) return;
    const firstReadable = rooms.find((r) => !r.encrypted) || rooms[0];
    if (firstReadable) { autoSelected = true; selectRoom(firstReadable.roomId); }
  }

  // Paint immediately so the tab is never an empty pane — the gate (or the
  // current chat state) shows synchronously, before the async status pull.
  render();

  // ─── live subscriptions ────────────────────────────────────────────────────
  api.onStatus((s) => { status = s || status; render(); });
  api.onRooms((list) => {
    rooms = Array.isArray(list) ? list : [];
    if (showing === "shell") { renderRoomList(); maybeAutoSelect(); }
  });
  api.onMessages(({ roomId, messages }) => {
    if (roomId && Array.isArray(messages)) {
      appendMessages(roomId, messages);
      if (showing === "shell") renderRoomList(); // refresh previews/unread
    }
  });

  // Initial state pull.
  (async () => {
    try {
      status = (await api.status()) || status;
      rooms = (await api.rooms()) || [];
    } catch {}
    render();
  })();
}
