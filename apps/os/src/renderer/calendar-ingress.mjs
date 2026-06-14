import {
  DEFAULT_CALENDAR_ID,
  DEFAULT_CALENDAR_TIMEZONE,
  DEFAULT_CAPTURE_BOT_EMAIL,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_SUPABASE_URL,
  MANUAL_SOURCE_KINDS,
  MANUAL_STORAGE_MODES,
  approveEventRequest,
  buildCalendarIngressPayload,
  buildCreateCalendarEventBody,
  buildEventRequestRow as buildWebEventRequestRow,
  buildGoogleEventPreview,
  buildManualSourceManifest,
  calendarIngressConfigWithDefaults,
  callCreateCalendarEvent,
  callIngestArtifacts,
  calendarIngressReadiness,
  defaultCalendarDateTimeValue,
  fetchCalendarOpsQueue,
  loadCalendarIngressConfig as loadWebCalendarIngressConfig,
  parseAttendees,
  persistableCalendarIngressConfig,
  postEventRequest,
  saveCalendarIngressConfig as saveWebCalendarIngressConfig,
} from "../../../web/scripts/calendar-ingress-client.mjs";

export {
  DEFAULT_CALENDAR_TIMEZONE,
  DEFAULT_CAPTURE_BOT_EMAIL,
  DEFAULT_ROUTING_POLICY,
  DEFAULT_SUPABASE_URL,
  MANUAL_SOURCE_KINDS,
  MANUAL_STORAGE_MODES,
  approveEventRequest,
  buildCalendarIngressPayload,
  buildCreateCalendarEventBody,
  buildGoogleEventPreview,
  buildManualSourceManifest,
  calendarIngressConfigWithDefaults,
  calendarIngressReadiness,
  callCreateCalendarEvent,
  callIngestArtifacts,
  defaultCalendarDateTimeValue,
  fetchCalendarOpsQueue,
  parseAttendees,
  persistableCalendarIngressConfig,
  postEventRequest,
};

export const DEFAULT_GOOGLE_CALENDAR_ID = DEFAULT_CALENDAR_ID;
export const DEFAULT_CALENDAR_CONFIG_KEY = "srwk:calendar_ingress_config";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function sourceKindRows() {
  return MANUAL_SOURCE_KINDS
    .map((kind) => `<option value="${esc(kind)}">${esc(kind.replace(/_/g, " "))}</option>`)
    .join("");
}

function storageModeRows() {
  return MANUAL_STORAGE_MODES
    .map((mode) => `<option value="${esc(mode)}">${esc(mode.replace(/_/g, " "))}</option>`)
    .join("");
}

function sessionTypeRows() {
  return Object.entries(DEFAULT_ROUTING_POLICY.session_types)
    .map(([key, item]) => `<option value="${esc(key)}">${esc(item.label)} · ${esc(item.max_tier)}</option>`)
    .join("");
}

export function buildEventRequestRow({ orgId, payload, surface = "electron" }) {
  return buildWebEventRequestRow({ orgId, payload, surface });
}

export async function submitEventRequest({ config, row, fetchImpl = fetch }) {
  return postEventRequest({ config, row, fetchImpl });
}

export async function createCalendarEvent({ config, body, fetchImpl = fetch }) {
  return callCreateCalendarEvent({ config, body, fetchImpl });
}

export function loadCalendarIngressConfig(storage = globalThis.localStorage, key = DEFAULT_CALENDAR_CONFIG_KEY) {
  return loadWebCalendarIngressConfig(storage, key);
}

export function saveCalendarIngressConfig(config, storage = globalThis.localStorage, key = DEFAULT_CALENDAR_CONFIG_KEY) {
  return saveWebCalendarIngressConfig(config, storage, key);
}

export function renderCalendarIngressPanel({ config = {} } = {}) {
  const c = calendarIngressConfigWithDefaults(config);
  return `
    <section class="cal-ingress" aria-label="calendar ingress">
      <header class="cal-ingress-head">
        <p class="cal-ingress-kicker">calendar ingress</p>
        <h2>create or request a session</h2>
      </header>
      <form class="cal-ingress-form" data-cal-ingress-form>
        <label><span>calendar title</span><input name="public_title" required /></label>
        <label><span>private title</span><input name="title" /></label>
        <label><span>type</span><select name="session_type">${sessionTypeRows()}</select></label>
        <label><span>start</span><input name="starts_at" type="datetime-local" value="${esc(defaultCalendarDateTimeValue(24))}" /></label>
        <label><span>end</span><input name="ends_at" type="datetime-local" value="${esc(defaultCalendarDateTimeValue(25))}" /></label>
        <label><span>timezone</span><input name="timezone" value="${esc(DEFAULT_CALENDAR_TIMEZONE)}" /></label>
        <label><span>attendees</span><textarea name="attendee_emails"></textarea></label>
        <div class="cal-ingress-toggles">
          <span>Google Meet</span>
          <span>transcript on</span>
          <span>Cube invited</span>
        </div>
        <div class="cal-ingress-actions">
          <button type="submit" data-cal-action="request">submit request</button>
          <button type="button" data-cal-action="create">create invite</button>
          <button type="button" data-cal-action="dry-run">dry run</button>
        </div>
      </form>
      <aside class="cal-ingress-config">
        <h3>supabase setup</h3>
        <label><span>supabase url</span><input name="supabaseUrl" value="${esc(c.supabaseUrl || "")}" /></label>
        <label><span>anon key</span><input name="supabaseAnonKey" /></label>
        <label><span>access token (not saved)</span><input name="accessToken" /></label>
        <label><span>org id</span><input name="orgId" value="${esc(c.orgId || "")}" /></label>
        <label><span>calendar connection</span><input name="calendarConnectionId" value="${esc(c.calendarConnectionId || "")}" /></label>
        <label><span>capture bot email</span><input name="botEmail" value="${esc(c.botEmail || DEFAULT_CAPTURE_BOT_EMAIL)}" /></label>
        <div class="cal-ingress-managed-calendar"><span>managed event target</span><code>${esc(c.calendarId || DEFAULT_CALENDAR_ID)}</code></div>
        <button type="button" data-cal-config-save>save connection</button>
      </aside>
      <section class="cal-ingress-source" aria-label="source ingress">
        <h3>submit transcript/source</h3>
        <form data-cal-source-form>
          <label><span>session id</span><input name="session_id" /></label>
          <label><span>source type</span><select name="source_kind">${sourceKindRows()}</select></label>
          <label><span>storage</span><select name="storage_mode">${storageModeRows()}</select></label>
          <label><span>source ref/path</span><input name="storage_ref" /></label>
          <button type="submit" data-cal-source-action="submit">submit source</button>
        </form>
      </section>
      <section class="cal-ingress-queue" aria-label="operator queue">
        <h3>operator queue</h3>
        <button type="button" data-cal-queue-refresh>refresh queue</button>
      </section>
    </section>
  `;
}
