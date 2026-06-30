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
const LOCK_GLYPH = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const CHECK_GLYPH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

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
  let signingIn = false;            // matrix.org device flow owns the view while true

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
          <div class="chat-gate-icon">${LOCK_GLYPH}</div>
          <h2 class="chat-gate-title">sign in to matrix</h2>
          ${status.error ? `<p class="chat-gate-reauth">${esc(status.error)}</p>` : ""}
          <button class="chat-btn chat-btn-primary chat-mxorg-browser" type="button">sign in with your browser</button>
          <details class="chat-dev"><summary>use a cohort server account instead</summary>
            <div class="chat-gate-body"><div class="chat-gate-checking">checking sign-in…</div></div>
          </details>
        </div>
      </div>`;
    const b = host.querySelector(".chat-mxorg-browser");
    if (b) b.addEventListener("click", startMatrixOrgBrowserLogin);
    refreshGateOptions();
  }

  // ── matrix.org sign-in via the computer's browser (auth-code + PKCE) ─────────
  function startMatrixOrgBrowserLogin() {
    signingIn = true;
    renderBrowserWait();
    api.loginMatrixOrgBrowser().then((res) => {
      signingIn = false;
      if (res && res.ok) { render(); return; }
      if (res && res.error === "cancelled") return;
      renderDeviceError((res && res.error) || "sign-in failed");
    });
  }

  function renderBrowserWait() {
    host.innerHTML = `
      <div class="chat-gate"><div class="chat-gate-card">
        <h2 class="chat-gate-title">sign in with matrix.org</h2>
        <div class="chat-device"><div class="chat-gate-checking">opening your browser — sign in / approve there, then come back. this finishes on its own.</div></div>
        <button class="chat-btn chat-device-cancel" type="button">cancel</button>
      </div></div>`;
    const c = host.querySelector(".chat-device-cancel");
    if (c) c.addEventListener("click", () => { signingIn = false; renderGate(); });
  }

  // ── matrix.org "approve with a code on another device" (device grant) ────────
  function startMatrixOrgLogin() {
    signingIn = true;
    renderDeviceScreen(null);   // "starting…" until the code arrives via onDeviceCode
    api.loginMatrixOrg().then((res) => {
      signingIn = false;
      if (res && res.ok) { render(); return; }         // drop into the chat shell
      if (res && res.error === "cancelled") return;    // cancel handler already re-rendered
      renderDeviceError((res && res.error) || "sign-in failed");
    });
  }

  function renderDeviceScreen(code) {
    host.innerHTML = `
      <div class="chat-gate"><div class="chat-gate-card">
        <h2 class="chat-gate-title">sign in with matrix.org</h2>
        <div class="chat-device">${code ? deviceCodeHtml(code) : `<div class="chat-gate-checking">starting sign-in…</div>`}</div>
        <button class="chat-btn chat-device-cancel" type="button">cancel</button>
      </div></div>`;
    const c = host.querySelector(".chat-device-cancel");
    if (c) c.addEventListener("click", () => { signingIn = false; api.cancelDevice(); renderGate(); });
  }

  function deviceCodeHtml({ userCode, verificationUri }) {
    return `
      <p class="chat-device-step">1 — on your phone, open</p>
      <div class="chat-device-url">${esc(verificationUri || "account.matrix.org/link")}</div>
      <p class="chat-device-step">2 — enter this code and approve</p>
      <div class="chat-device-code">${esc(userCode)}</div>
      <p class="chat-device-hint">waiting for you to approve…</p>`;
  }

  function renderDeviceError(msg) {
    host.innerHTML = `
      <div class="chat-gate"><div class="chat-gate-card">
        <h2 class="chat-gate-title">sign in with matrix.org</h2>
        <div class="chat-gate-error">${esc(msg)}</div>
        <button class="chat-btn chat-btn-primary chat-retry" type="button">try again</button>
      </div></div>`;
    const r = host.querySelector(".chat-retry");
    if (r) r.addEventListener("click", renderGate);
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
      // Paste an access token from any client you're already signed in to (the
      // token never leaves this machine). Password is the tucked-away fallback.
      body.innerHTML = `
        <form class="chat-token-form" autocomplete="off">
          <div class="chat-token-row">
            <input class="chat-input-text" name="token" type="password" placeholder="paste an access token" spellcheck="false" autocapitalize="off" />
            <button class="chat-btn chat-btn-primary chat-token-submit" type="submit" title="sign in" aria-label="sign in">${CHECK_GLYPH}</button>
          </div>
          <p class="chat-gate-hint">From Element on a computer: <code>Settings → Help &amp; About → Advanced → Access Token</code> (not shown on the phone app)</p>
          <div class="chat-login-msg" role="status" aria-live="polite"></div>
        </form>`;
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
    renderTimeline(roomId, data.encrypted, data.cryptoReady);
    setComposerEnabled(!data.encrypted || data.cryptoReady);
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

  function renderTimeline(roomId, encrypted, cryptoReady) {
    const tl = host.querySelector(".chat-timeline");
    if (!tl) return;
    if (encrypted && !cryptoReady) {
      tl.innerHTML = `<div class="chat-locked"><div class="chat-locked-glyph">🔒</div><div class="chat-locked-title">end-to-end encrypted</div><div class="chat-locked-sub">Encryption couldn't start on this device yet. Try reopening the app, or open this room in Element.</div></div>`;
      return;
    }
    const msgs = messagesByRoom.get(roomId) || [];
    if (!msgs.length) {
      tl.innerHTML = `<div class="chat-empty">no messages yet.</div>`;
      return;
    }
    tl.innerHTML = renderTimelineMsgs(msgs);
    tl.scrollTop = tl.scrollHeight;
  }

  // Render messages. Undecryptable ones (the pre-login backlog we have no key
  // for) collapse into a single explanatory line — they're still readable in
  // Element on a device that holds the keys.
  function renderTimelineMsgs(msgs) {
    const out = [];
    let hadUtd = false;
    const flush = () => {
      if (!hadUtd) return;
      out.push(`<div class="chat-utd">🔒 Messages sent before this device signed in can't be decrypted</div>`);
      hadUtd = false;
    };
    for (const m of msgs) {
      if (m.utd) { hadUtd = true; continue; }
      flush();
      out.push(renderMsg(m));
    }
    flush();
    return out.join("");
  }

  function renderMsg(m) {
    if (m.utd) return "";
    const name = senderName(m.sender);
    return `
      <div class="chat-msg${m.mine ? " is-mine" : ""}">
        <span class="chat-msg-sender" style="color:${senderColor(m.sender)}" title="${esc(m.sender)}">${esc(name)}</span>
        <span class="chat-msg-body">${esc(m.body)}</span>
        <span class="chat-msg-time">${fmtTime(m.ts)}</span>
      </div>`;
  }

  // Merge live messages into the active room. New messages append; a message
  // we already have but that just decrypted (utd → cleartext) replaces in place.
  function appendMessages(roomId, msgs) {
    const cache = messagesByRoom.get(roomId) || [];
    const byId = new Map(cache.map((m) => [m.eventId, m]));
    let changed = false;
    for (const m of msgs) {
      const existing = byId.get(m.eventId);
      if (!existing) { cache.push(m); byId.set(m.eventId, m); changed = true; }
      else if (existing.utd && !m.utd) {
        const idx = cache.findIndex((x) => x.eventId === m.eventId);
        if (idx >= 0) cache[idx] = m;
        changed = true;
      }
    }
    messagesByRoom.set(roomId, cache);
    if (!changed || roomId !== activeRoomId || loadedRoom !== roomId) return;
    cache.sort((a, b) => a.ts - b.ts);
    const tl = host.querySelector(".chat-timeline");
    if (!tl) return;
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
    tl.innerHTML = renderTimelineMsgs(cache);
    if (nearBottom) tl.scrollTop = tl.scrollHeight;
  }

  // ─── render router ─────────────────────────────────────────────────────────
  function render() {
    if (signingIn) return;   // the matrix.org device screen owns the view until it resolves
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
    // With crypto live, encrypted rooms are readable — just open the most recent.
    const pick = status.cryptoReady ? rooms[0] : (rooms.find((r) => !r.encrypted) || rooms[0]);
    if (pick) { autoSelected = true; selectRoom(pick.roomId); }
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
  api.onDeviceCode((code) => { if (signingIn && code) renderDeviceScreen(code); });

  // Initial state pull.
  (async () => {
    try {
      status = (await api.status()) || status;
      rooms = (await api.rooms()) || [];
    } catch {}
    render();
  })();
}
