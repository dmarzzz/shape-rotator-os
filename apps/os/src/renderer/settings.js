// settings.js — Settings overlay for Shape Rotator OS.
//
// Opened from the apps grid (a card with data-app-key="settings", wired in
// boot.js). Currently exposes one control: toggle native OS notifications
// fired 5 minutes before a calendar event starts. It is a self-contained,
// inline-styled overlay (matching the charcoal/oxide theme) so it needs no
// new CSS and no hook into the tab/apps-view visibility system.
import * as notifier from "./event-notifier.js";

let overlay = null;
let statusEl = null;
let toggleInput = null;

function api() {
  return window.api || {};
}

async function readEnabled() {
  try {
    const p = await api().loadPrefs?.();
    return !!(p && p.notifications && p.notifications.enabled === true);
  } catch (_) {
    return false;
  }
}

// Merge into the single prefs blob so we don't clobber other settings.
async function writeEnabled(on) {
  const a = api();
  let p = {};
  try {
    p = (await a.loadPrefs?.()) || {};
  } catch (_) {}
  if (!p || typeof p !== "object") p = {};
  p.notifications = { ...(p.notifications || {}), enabled: !!on };
  await a.savePrefs?.(p);
}

function setStatus(msg, tone) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color =
    tone === "ok" ? "#6EE7B7" : tone === "warn" ? "#FF6B7A" : "rgba(241,236,231,0.52)";
}

function build() {
  overlay = document.createElement("div");
  overlay.id = "settings-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "settings");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(20,17,18,0.62)",
    backdropFilter: "blur(6px)",
    fontFamily: '"Space Grotesk", -apple-system, system-ui, sans-serif',
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    width: "min(560px, 92vw)",
    background: "#2C2728",
    border: "1px solid rgba(241,236,231,0.14)",
    borderRadius: "12px",
    padding: "28px",
    color: "rgba(241,236,231,0.94)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
  });
  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div>
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(241,236,231,0.52);">Shape Rotator</div>
        <div style="font-size:22px;font-weight:600;">Settings</div>
      </div>
      <button data-settings-close type="button" aria-label="close"
        style="background:none;border:none;color:rgba(241,236,231,0.74);font-size:20px;line-height:1;cursor:pointer;">✕</button>
    </div>
    <section style="border-top:1px solid rgba(241,236,231,0.14);padding-top:18px;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(241,236,231,0.52);margin-bottom:14px;">Notifications</div>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;">
        <div style="flex:1;">
          <div style="font-size:16px;margin-bottom:4px;">Event reminders</div>
          <div style="font-size:13px;color:rgba(241,236,231,0.52);line-height:1.45;">Get a native notification 5 minutes before a calendar event starts.</div>
        </div>
        <label style="position:relative;display:inline-block;width:46px;height:26px;flex:none;cursor:pointer;">
          <input data-settings-toggle type="checkbox" style="position:absolute;opacity:0;width:0;height:0;" />
          <span data-settings-track style="position:absolute;inset:0;background:rgba(241,236,231,0.18);border-radius:13px;transition:background .2s;"></span>
          <span data-settings-knob style="position:absolute;top:3px;left:3px;width:20px;height:20px;background:#F1ECE7;border-radius:50%;transition:transform .2s;"></span>
        </label>
      </div>
      <div data-settings-status style="font-size:12px;margin-top:12px;color:rgba(241,236,231,0.52);"></div>
      <button data-settings-test type="button"
        style="margin-top:16px;background:#8F220E;color:#F7F1EC;border:none;border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer;font-family:inherit;">Send test notification</button>
    </section>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  statusEl = card.querySelector("[data-settings-status]");
  toggleInput = card.querySelector("[data-settings-toggle]");
  const track = card.querySelector("[data-settings-track]");
  const knob = card.querySelector("[data-settings-knob]");

  function paintToggle(on) {
    track.style.background = on ? "#8F220E" : "rgba(241,236,231,0.18)";
    knob.style.transform = on ? "translateX(20px)" : "translateX(0)";
  }
  overlay._paintToggle = paintToggle;

  toggleInput.addEventListener("change", async () => {
    const on = toggleInput.checked;
    paintToggle(on);
    try {
      await writeEnabled(on);
      if (on) {
        const granted = await api().notifyRequestPermission?.();
        if (granted) {
          setStatus("On — you'll be notified 5 minutes before each event.", "ok");
        } else {
          setStatus(
            "Saved, but the OS denied notifications. Enable them in System Settings → Notifications → Shape Rotator OS.",
            "warn",
          );
        }
      } else {
        setStatus("Off — no event reminders.", "dim");
      }
      try {
        await notifier.refresh();
      } catch (_) {}
    } catch (err) {
      setStatus("Failed to save: " + err, "warn");
    }
  });

  card.querySelector("[data-settings-test]").addEventListener("click", async () => {
    try {
      await api().notifyRequestPermission?.();
      await api().notify?.({
        title: "Shape Rotator OS",
        body: "Test notification — reminders are working.",
      });
      setStatus("Test notification sent.", "ok");
    } catch (err) {
      setStatus("Test failed: " + err, "warn");
    }
  });

  card.querySelector("[data-settings-close]").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && overlay.style.display !== "none") close();
  });
}

export async function open() {
  if (!overlay) build();
  const on = await readEnabled();
  toggleInput.checked = on;
  overlay._paintToggle(on);
  setStatus(
    on ? "On — you'll be notified 5 minutes before each event." : "Off — no event reminders.",
    on ? "ok" : "dim",
  );
  overlay.style.display = "flex";
}

export function close() {
  if (overlay) overlay.style.display = "none";
}
