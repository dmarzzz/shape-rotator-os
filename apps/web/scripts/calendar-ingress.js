import {
  DEFAULT_CALENDAR_TIMEZONE,
  DEFAULT_ROUTING_POLICY,
  MANUAL_SOURCE_KINDS,
  MANUAL_STORAGE_MODES,
  attendeeEmailList,
  buildCalendarIngressPayload,
  buildCreateCalendarEventBody,
  buildEventRequestRow,
  buildGoogleEventPreview,
  buildManualSourceManifest,
  calendarIngressConfigWithDefaults,
  calendarIngressReadiness,
  callIngestArtifacts,
  callCreateCalendarEvent,
  cohortInviteDirectoryFromSurface,
  defaultCalendarDateTimeValue,
  approveEventRequest,
  decideApprovalGate,
  fetchCalendarOpsQueue,
  fetchPrivateInviteDirectory,
  loadCalendarIngressConfig,
  mergeAttendeeEmails,
  policyDecision,
  postEventRequest,
  rejectEventRequest,
  reviewDerivedArtifact,
  reviewEvidenceCard,
  saveCalendarIngressConfig,
} from "./calendar-ingress-client.mjs?v=supabase-source";

const root = document.getElementById("calendar-ingress");
const state = {
  config: loadCalendarIngressConfig(),
  payload: null,
  error: null,
  result: null,
  queue: null,
  inviteDirectory: null,
  inviteError: null,
  busy: false,
  queueBusy: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function optionRows() {
  return Object.entries(DEFAULT_ROUTING_POLICY.session_types)
    .map(([key, item]) => `<option value="${esc(key)}">${esc(item.label)} · ${esc(item.max_tier)}</option>`)
    .join("");
}

function sourceKindLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sourceKindRows() {
  return MANUAL_SOURCE_KINDS
    .map((kind) => `<option value="${esc(kind)}">${esc(sourceKindLabel(kind))}</option>`)
    .join("");
}

function storageModeRows() {
  return MANUAL_STORAGE_MODES
    .map((mode) => `<option value="${esc(mode)}">${esc(mode.replace(/_/g, " "))}</option>`)
    .join("");
}

function inviteGroupById(id) {
  return (state.inviteDirectory?.groups || []).find((group) => group.id === id) || null;
}

function invitePersonById(id) {
  return (state.inviteDirectory?.people || []).find((person) => person.id === id) || null;
}

function attendeeTextarea() {
  return formEl()?.elements?.attendee_emails || null;
}

function selectedGuestCount() {
  return attendeeEmailList(attendeeTextarea()?.value || "").length;
}

function defaultStartValue() {
  return defaultCalendarDateTimeValue(24);
}

function defaultEndValue() {
  return defaultCalendarDateTimeValue(25);
}

function readForm(form) {
  const data = new FormData(form);
  return {
    title: data.get("title"),
    public_title: data.get("public_title"),
    session_type: data.get("session_type"),
    starts_at: data.get("starts_at"),
    ends_at: data.get("ends_at"),
    timezone: data.get("timezone"),
    location: data.get("location"),
    attendee_emails: data.get("attendee_emails"),
    public_description: data.get("public_description"),
    bot_requested: data.get("bot_requested") === "on",
    request_meet: data.get("request_meet") === "on",
  };
}

function readSourceForm(form) {
  const data = new FormData(form);
  return {
    session_id: data.get("session_id"),
    source_kind: data.get("source_kind"),
    storage_mode: data.get("storage_mode"),
    storage_ref: data.get("storage_ref"),
    mime_type: data.get("mime_type"),
    source_hash: data.get("source_hash"),
    size_bytes: data.get("size_bytes"),
  };
}

function currentDecision(form) {
  try {
    const data = new FormData(form);
    return policyDecision(data.get("session_type"));
  } catch {
    return policyDecision("office_hours");
  }
}

function renderStatus() {
  if (state.busy) return `<p class="cal-ingress-status">working</p>`;
  if (state.queueBusy) return `<p class="cal-ingress-status">loading queue</p>`;
  if (state.error) return `<p class="cal-ingress-status is-error">${esc(state.error)}</p>`;
  if (state.result) return `<p class="cal-ingress-status is-ok">${esc(state.result)}</p>`;
  return `<p class="cal-ingress-status">local preview</p>`;
}

function shortDate(value) {
  if (!value) return "no date";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function requestTitle(row) {
  return row?.request_json?.session?.public_title
    || row?.request_json?.session?.title
    || "untitled request";
}

function requestMeta(row) {
  const session = row?.request_json?.session || {};
  return [
    session.session_type,
    session.starts_at ? shortDate(session.starts_at) : null,
    (row?.request_json?.attendees || []).length ? `${row.request_json.attendees.length} guests` : null,
  ].filter(Boolean).join(" · ");
}

function compactText(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function artifactSummary(row) {
  const distillation = row?.content_json?.distillation || {};
  const summary = Array.isArray(distillation.summary) ? distillation.summary.filter(Boolean) : [];
  if (summary.length) return summary.map((item) => `• ${compactText(item, 180)}`).join("\n");
  const themes = Array.isArray(distillation.themes) ? distillation.themes.filter(Boolean) : [];
  if (themes.length) return `themes: ${themes.map((item) => compactText(item, 40)).join(", ")}`;
  return compactText(row?.content_md || "", 260) || "no preview exported";
}

function cardSummary(row) {
  return compactText(row?.claim_text || row?.summary || row?.content_json?.source_note || "", 260) || "no claim exported";
}

function renderEmptyQueue() {
  return `<p class="cal-ingress-empty">no queue rows loaded</p>`;
}

function renderQueueList(rows, renderItem) {
  if (!rows?.length) return `<p class="cal-ingress-empty">clear</p>`;
  return `<ul class="cal-ingress-queue-list">${rows.map(renderItem).join("")}</ul>`;
}

function renderQueue() {
  const queue = state.queue;
  return `
    <section class="cal-ingress-queue" aria-label="operator queue">
      <div class="cal-ingress-queue-head">
        <div>
          <p class="cal-ingress-kicker">operator queue</p>
          <h3>requests, jobs, review gates</h3>
        </div>
        <button type="button" data-cal-queue-refresh>${state.queueBusy ? "loading" : "refresh queue"}</button>
      </div>
      ${queue ? `
        <div class="cal-ingress-queue-grid">
          <section>
            <h4>event requests</h4>
            ${renderQueueList(queue.eventRequests, (row) => `
              <li>
                <strong>${esc(requestTitle(row))}</strong>
                <span>${esc(requestMeta(row) || row.status || "pending")}</span>
                <div class="cal-ingress-queue-actions">
                  <button type="button" data-cal-queue-action="approve-request" data-id="${esc(row.id)}">approve</button>
                  <button type="button" data-cal-queue-action="reject-request" data-id="${esc(row.id)}">reject</button>
                </div>
              </li>`)}
          </section>
          <section>
            <h4>processing jobs</h4>
            ${renderQueueList(queue.processingJobs, (row) => `
              <li>
                <strong>${esc(row.job_kind || "job")} · ${esc(row.processor_status || "queued")}</strong>
                <span>${esc(row.processor_mode || "local")} · due ${esc(shortDate(row.due_at))}</span>
                ${row.error ? `<span class="is-error">${esc(row.error)}</span>` : ""}
              </li>`)}
          </section>
          <section>
            <h4>derived review</h4>
            ${renderQueueList(queue.derivedArtifacts, (row) => `
              <li>
                <strong>${esc(row.artifact_kind || "artifact")} · ${esc(row.tier || "")}</strong>
                <span>${esc(row.review_status || "needs_review")} · ${esc(row.approval_state || "not_required")}</span>
                <pre class="cal-ingress-artifact-preview">${esc(artifactSummary(row))}</pre>
                <div class="cal-ingress-queue-actions">
                  ${row.approval_state === "pending" ? "" : `<button type="button" data-cal-queue-action="review-derived" data-id="${esc(row.id)}">reviewed</button>`}
                  ${row.tier === "T3" && row.approval_state === "approved" ? `<button type="button" data-cal-queue-action="publish-derived" data-id="${esc(row.id)}">publish</button>` : ""}
                  <button type="button" data-cal-queue-action="block-derived" data-id="${esc(row.id)}">block</button>
                </div>
              </li>`)}
          </section>
          <section>
            <h4>evidence cards</h4>
            ${renderQueueList(queue.evidenceCards, (row) => `
              <li>
                <strong>${esc(row.claim_type || "claim")} · ${esc(row.surface_tier || "")}</strong>
                <span>${esc(row.review_status || "needs_review")} · ${esc(row.approval_state || "not_required")} · ${esc(row.attribution_scope || "room")}</span>
                <pre class="cal-ingress-artifact-preview">${esc(cardSummary(row))}</pre>
                <div class="cal-ingress-queue-actions">
                  ${row.approval_state === "pending" ? "" : `<button type="button" data-cal-queue-action="review-card" data-id="${esc(row.id)}">reviewed</button>`}
                  ${row.surface_tier === "T3" && row.approval_state === "approved" ? `<button type="button" data-cal-queue-action="publish-card" data-id="${esc(row.id)}">publish</button>` : ""}
                  <button type="button" data-cal-queue-action="block-card" data-id="${esc(row.id)}">block</button>
                </div>
              </li>`)}
          </section>
          <section>
            <h4>public gates</h4>
            ${renderQueueList(queue.approvalGates, (row) => `
              <li>
                <strong>${esc(row.gate_key || "gate")}</strong>
                <span>${esc(row.gate_status || "pending")}</span>
                <div class="cal-ingress-queue-actions">
                  <button type="button" data-cal-queue-action="approve-gate" data-id="${esc(row.id)}">approve</button>
                  <button type="button" data-cal-queue-action="block-gate" data-id="${esc(row.id)}">block</button>
                </div>
              </li>`)}
          </section>
        </div>` : renderEmptyQueue()}
    </section>
  `;
}

function renderInvitePicker() {
  const directory = state.inviteDirectory;
  if (state.inviteError) {
    return `
      <div class="cal-ingress-invite" data-cal-invite-picker>
        <div class="cal-ingress-invite-head">
          <span>cohort guests</span>
          <strong>directory unavailable</strong>
        </div>
        <p>${esc(state.inviteError)}</p>
      </div>
    `;
  }
  if (!directory) {
    return `
      <div class="cal-ingress-invite" data-cal-invite-picker>
        <div class="cal-ingress-invite-head">
          <span>cohort guests</span>
          <strong>loading directory</strong>
        </div>
      </div>
    `;
  }
  const roleGroups = directory.groups.filter((group) => group.kind === "role");
  const teamGroups = directory.groups.filter((group) => group.kind === "team");
  const groupButton = (group) => `
    <button type="button" data-cal-invite-group="${esc(group.id)}">
      ${esc(group.label)} <span>${esc(group.count)}</span>
    </button>
  `;
  return `
    <div class="cal-ingress-invite" data-cal-invite-picker>
      <div class="cal-ingress-invite-head">
        <span>cohort guests</span>
        <strong>${esc(directory.people.length)} available · ${esc(directory.source || "public surface")} · ${esc(directory.missingEmailCount)} without private contact</strong>
      </div>
      <div class="cal-ingress-invite-groups" aria-label="invite role groups">
        ${roleGroups.map(groupButton).join("") || `<p>no email-backed role groups</p>`}
      </div>
      <div class="cal-ingress-invite-groups compact" aria-label="invite team groups">
        ${teamGroups.map(groupButton).join("") || `<p>no email-backed team groups</p>`}
      </div>
      <div class="cal-ingress-row two">
        <label>
          <span>add person</span>
          <select name="attendee_person" data-cal-invite-person>
            <option value="">select person</option>
            ${directory.people.map((person) => `
              <option value="${esc(person.id)}">${esc(person.name)}</option>
            `).join("")}
          </select>
        </label>
        <div class="cal-ingress-invite-meter" aria-live="polite">
          <span>selected guests</span>
          <strong data-cal-guest-count>${esc(selectedGuestCount())}</strong>
        </div>
      </div>
      <div class="cal-ingress-actions">
        <button type="button" data-cal-invite-clear>clear guests</button>
      </div>
    </div>
  `;
}

function renderConfig() {
  const c = state.config || {};
  const readiness = calendarIngressReadiness(c);
  const browserMissing = readiness.missingBrowserSafe.length
    ? readiness.missingBrowserSafe.join(", ")
    : "ready";
  const operatorMissing = readiness.missingOperator.length
    ? readiness.missingOperator.join(", ")
    : "ready";
  const driveCommand = c.driveArtifactFolderId && c.orgId
    ? `npm run artifacts:drive -- --org-id ${c.orgId} --drive-folder-id ${c.driveArtifactFolderId} --apply`
    : "npm run artifacts:drive -- --org-id ORG_ID --drive-folder-id GOOGLE_DRIVE_ARTIFACT_FOLDER_ID --apply";
  return `
    <details class="cal-ingress-config" open>
      <summary>operator setup</summary>
      <div class="cal-ingress-setup-status" aria-live="polite">
        <div>
          <span>browser state</span>
          <strong>${esc(browserMissing)}</strong>
        </div>
        <div>
          <span>operator workers</span>
          <strong>${esc(operatorMissing)}</strong>
        </div>
      </div>
      <div class="cal-ingress-config-grid">
        <label><span>supabase url</span><input name="supabaseUrl" value="${esc(c.supabaseUrl || "")}" autocomplete="off" /></label>
        <label><span>anon key</span><input name="supabaseAnonKey" value="${esc(c.supabaseAnonKey || "")}" autocomplete="off" /></label>
        <label><span>access token (not saved)</span><input name="accessToken" value="${esc(c.accessToken || "")}" autocomplete="off" /></label>
        <label><span>org id</span><input name="orgId" value="${esc(c.orgId || "")}" autocomplete="off" /></label>
        <label><span>calendar connection</span><input name="calendarConnectionId" value="${esc(c.calendarConnectionId || "")}" autocomplete="off" /></label>
        <label><span>capture bot email</span><input name="botEmail" value="${esc(c.botEmail || "")}" autocomplete="off" /></label>
        <label><span>drive artifact folder</span><input name="driveArtifactFolderId" value="${esc(c.driveArtifactFolderId || "")}" autocomplete="off" /></label>
        <div class="cal-ingress-managed-calendar">
          <span>admin edit path</span>
          <p>The editable Google Calendar link is shared privately with calendar owners. Public Google, webcal, and .ics links are read-only subscriptions.</p>
        </div>
        <label class="span-2"><span>create function url</span><input name="createEventUrl" value="${esc(c.createEventUrl || "")}" autocomplete="off" /></label>
      </div>
      <div class="cal-ingress-runbook" aria-label="operator worker commands">
        <div>
          <span>admin ACL check</span>
          <code>npm run calendar:acl:google -- --env-file .env.calendar.local --verify</code>
        </div>
        <div>
          <span>calendar sync</span>
          <code>npm run calendar:sync:google -- --org-id ${esc(c.orgId || "ORG_ID")} --calendar-connection-id ${esc(c.calendarConnectionId || "CALENDAR_CONNECTION_ID")} --apply</code>
        </div>
        <div>
          <span>drive artifacts</span>
          <code>${esc(driveCommand)}</code>
        </div>
        <div>
          <span>cloud distill</span>
          <code>Supabase cron invokes Drive discovery and transcript processing with Vault worker credentials; server admin credentials never enter browser state.</code>
        </div>
      </div>
      <div class="cal-ingress-actions">
        <button type="button" data-cal-config-save>save connection</button>
        <button type="button" data-cal-config-clear>clear</button>
      </div>
    </details>
  `;
}

function renderPreview(form) {
  let payload;
  let preview;
  let decision;
  try {
    payload = buildCalendarIngressPayload(readForm(form), {
      idFactory: () => "preview-session-id",
    });
    preview = buildGoogleEventPreview(payload, { botEmail: state.config.botEmail });
    decision = payload.decision;
  } catch {
    decision = currentDecision(form);
    preview = null;
  }

  return `
    <div class="cal-ingress-policy" aria-live="polite">
      <div>
        <span>ceiling</span>
        <strong>${esc(decision.max_tier)}</strong>
      </div>
      <div>
        <span>cohort</span>
        <strong>${esc(decision.cohort_mode)}</strong>
      </div>
      <div>
        <span>public</span>
        <strong>${decision.public_allowed ? "gated" : "no"}</strong>
      </div>
    </div>
    <pre class="cal-ingress-preview" aria-label="calendar payload preview">${esc(JSON.stringify(preview || {
      summary: "fill the form",
      guestsCanModify: false,
      guestsCanInviteOthers: false,
    }, null, 2))}</pre>
  `;
}

function renderSourcePreview(form) {
  let body;
  try {
    body = buildManualSourceManifest(readSourceForm(form));
  } catch {
    body = {
      provider: "manual",
      manifest: {
        source_tier: "T0",
        raw_available_to_server: false,
        artifacts: [{ source_kind: "manual_upload", storage_mode: "external_ref" }],
      },
    };
  }
  return `<pre class="cal-ingress-preview" aria-label="source payload preview">${esc(JSON.stringify(body, null, 2))}</pre>`;
}

function renderSourceIngress() {
  return `
    <section class="cal-ingress-source" aria-label="source ingress">
      <div class="cal-ingress-source-head">
        <div>
          <p class="cal-ingress-kicker">source ingress</p>
          <h3>submit transcript/source</h3>
        </div>
      </div>
      <div class="cal-ingress-source-grid">
        <form class="cal-ingress-form" data-cal-source-form>
          <div class="cal-ingress-row three">
            <label><span>session id</span><input name="session_id" required autocomplete="off" /></label>
            <label><span>source type</span><select name="source_kind">${sourceKindRows()}</select></label>
            <label><span>storage</span><select name="storage_mode">${storageModeRows()}</select></label>
          </div>
          <label><span>source ref/path</span><input name="storage_ref" required autocomplete="off" placeholder="private-transcripts/session.txt or drive/otter url" /></label>
          <div class="cal-ingress-row three">
            <label><span>mime type</span><input name="mime_type" placeholder="text/plain" autocomplete="off" /></label>
            <label><span>hash</span><input name="source_hash" autocomplete="off" /></label>
            <label><span>size bytes</span><input name="size_bytes" inputmode="numeric" autocomplete="off" /></label>
          </div>
          <div class="cal-ingress-actions">
            <button type="submit" data-cal-source-action="submit">submit source</button>
            <button type="button" data-cal-source-action="dry-run">dry run source</button>
          </div>
        </form>
        <aside class="cal-ingress-side" data-cal-source-preview>
          ${renderSourcePreview(document.createElement("form"))}
        </aside>
      </div>
    </section>
  `;
}

function render() {
  if (!root) return;
  const timezone = DEFAULT_CALENDAR_TIMEZONE;
  const readiness = calendarIngressReadiness(state.config);
  if (!readiness.browserReady) {
    root.innerHTML = `
    <div class="cal-ingress-inner">
      <div class="cal-ingress-head">
        <div>
          <p class="cal-ingress-kicker">calendar ingress</p>
          <h2>operator controls</h2>
        </div>
        ${renderStatus()}
      </div>
      <p class="cal-ingress-empty">Signed-in Supabase config is required before event creation, guest selection, or review queues are loaded.</p>
      ${renderConfig()}
    </div>
  `;
    wire();
    return;
  }
  root.innerHTML = `
    <div class="cal-ingress-inner">
      <div class="cal-ingress-head">
        <div>
          <p class="cal-ingress-kicker">calendar ingress</p>
          <h2>create or request a session</h2>
        </div>
        ${renderStatus()}
      </div>
      <div class="cal-ingress-grid">
        <form class="cal-ingress-form" data-cal-ingress-form>
          <div class="cal-ingress-row two">
            <label><span>calendar title</span><input name="public_title" required placeholder="office hours" /></label>
            <label><span>private title</span><input name="title" placeholder="internal title if different" /></label>
          </div>
          <div class="cal-ingress-row three">
            <label><span>type</span><select name="session_type">${optionRows()}</select></label>
            <label><span>start</span><input name="starts_at" type="datetime-local" required value="${defaultStartValue()}" /></label>
            <label><span>end</span><input name="ends_at" type="datetime-local" required value="${defaultEndValue()}" /></label>
          </div>
          <div class="cal-ingress-row two">
            <label><span>timezone</span><input name="timezone" value="${esc(timezone)}" /></label>
            <label><span>location</span><input name="location" placeholder="Google Meet" /></label>
          </div>
          ${renderInvitePicker()}
          <label><span>attendees</span><textarea name="attendee_emails" rows="4" placeholder="guest@example.com"></textarea></label>
          <label><span>public note</span><textarea name="public_description" rows="3" placeholder="short safe note for the invite"></textarea></label>
          <div class="cal-ingress-toggles">
            <label><input name="request_meet" type="checkbox" checked /><span>Google Meet</span></label>
            <label><input name="bot_requested" type="checkbox" checked /><span>capture bot</span></label>
          </div>
          <div class="cal-ingress-actions">
            <button type="submit" data-cal-action="request">submit request</button>
            <button type="button" data-cal-action="create">create invite</button>
            <button type="button" data-cal-action="dry-run">dry run</button>
          </div>
          ${renderConfig()}
        </form>
        <aside class="cal-ingress-side" data-cal-ingress-preview>
          ${renderPreview(document.createElement("form"))}
        </aside>
      </div>
      ${renderSourceIngress()}
      ${renderQueue()}
    </div>
  `;
  wire();
  updatePreview();
}

function formEl() {
  return root?.querySelector("[data-cal-ingress-form]");
}

function sourceFormEl() {
  return root?.querySelector("[data-cal-source-form]");
}

function updatePreview() {
  const form = formEl();
  const slot = root?.querySelector("[data-cal-ingress-preview]");
  if (!form || !slot) return;
  slot.innerHTML = renderPreview(form);
  updateInviteMeter();
}

function updateSourcePreview() {
  const form = sourceFormEl();
  const slot = root?.querySelector("[data-cal-source-preview]");
  if (!form || !slot) return;
  slot.innerHTML = renderSourcePreview(form);
}

function updateInviteMeter() {
  const count = root?.querySelector("[data-cal-guest-count]");
  if (count) count.textContent = String(selectedGuestCount());
}

function addInviteEmails(emails = []) {
  const input = attendeeTextarea();
  if (!input) return;
  input.value = mergeAttendeeEmails(input.value, emails);
  updatePreview();
}

async function loadInviteDirectory() {
  if (!root) return;
  if (!calendarIngressReadiness(state.config).browserReady) return;
  try {
    state.inviteDirectory = await fetchPrivateInviteDirectory({ config: state.config });
    if (!state.inviteDirectory.people.length) {
      const response = await fetch("/cohort-surface.json");
      if (!response.ok) throw new Error(`cohort directory fetch failed: ${response.status}`);
      state.inviteDirectory = {
        ...cohortInviteDirectoryFromSurface(await response.json()),
        source: "public_surface_fallback",
      };
    }
    state.inviteError = null;
  } catch (error) {
    try {
      const response = await fetch("/cohort-surface.json");
      if (!response.ok) throw error;
      state.inviteDirectory = {
        ...cohortInviteDirectoryFromSurface(await response.json()),
        source: "public_surface_fallback",
      };
      state.inviteError = null;
    } catch {
      state.inviteDirectory = null;
      state.inviteError = error?.message || String(error);
    }
  }
  const picker = root.querySelector("[data-cal-invite-picker]");
  if (picker) {
    picker.outerHTML = renderInvitePicker();
    wireInvitePicker();
    updatePreview();
  }
}

function readConfigFromDom() {
  const out = {};
  root.querySelectorAll(".cal-ingress-config input").forEach((input) => {
    out[input.name] = input.value.trim();
  });
  return out;
}

async function handleSubmit(kind) {
  const form = formEl();
  if (!form) return;
  state.error = null;
  state.result = null;
  let payload;
  try {
    payload = buildCalendarIngressPayload(readForm(form));
  } catch (error) {
    state.error = error.message || String(error);
    render();
    return;
  }
  const config = { ...state.config };
  const orgId = config.orgId;
  if (!orgId) {
    state.error = "org id is required";
    render();
    return;
  }
  state.busy = true;
  render();
  try {
    if (kind === "request") {
      const row = buildEventRequestRow({ orgId, payload });
      await postEventRequest({ config, row });
      state.result = "request submitted";
    } else {
      const body = buildCreateCalendarEventBody({
        orgId,
        calendarConnectionId: config.calendarConnectionId,
        payload,
        dryRun: kind === "dry-run",
        persist: kind !== "dry-run",
      });
      await callCreateCalendarEvent({ config, body });
      state.result = kind === "dry-run" ? "dry run returned" : "invite created";
    }
  } catch (error) {
    state.error = error?.body?.error || error?.message || String(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function handleSourceSubmit(kind) {
  const form = sourceFormEl();
  if (!form) return;
  state.error = null;
  state.result = null;
  let body;
  try {
    body = buildManualSourceManifest(readSourceForm(form));
  } catch (error) {
    state.error = error.message || String(error);
    render();
    return;
  }
  const config = { ...state.config };
  if (!config.orgId) {
    state.error = "org id is required";
    render();
    return;
  }
  state.busy = true;
  render();
  try {
    await callIngestArtifacts({
      config,
      body: {
        ...body,
        org_id: config.orgId,
        dry_run: kind === "dry-run",
        persist: kind !== "dry-run",
      },
    });
    state.result = kind === "dry-run" ? "source dry run returned" : "source submitted";
  } catch (error) {
    state.error = error?.body?.error || error?.message || String(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshQueue() {
  state.error = null;
  state.result = null;
  state.queueBusy = true;
  render();
  try {
    state.queue = await fetchCalendarOpsQueue({ config: state.config });
    const total = Object.values(state.queue).reduce((sum, rows) => sum + (rows?.length || 0), 0);
    state.result = `queue loaded: ${total}`;
  } catch (error) {
    state.error = error?.body?.error || error?.message || String(error);
  } finally {
    state.queueBusy = false;
    render();
  }
}

function findQueueRow(group, id) {
  return (state.queue?.[group] || []).find((row) => String(row.id) === String(id));
}

async function handleQueueAction(action, id) {
  state.error = null;
  state.result = null;
  state.queueBusy = true;
  render();
  try {
    if (action === "approve-request") {
      const row = findQueueRow("eventRequests", id);
      await approveEventRequest({ config: state.config, request: row });
      state.result = "request approved and invite created";
    } else if (action === "reject-request") {
      await rejectEventRequest({ config: state.config, requestId: id, reviewNotes: "Rejected in calendar ingress queue." });
      state.result = "request rejected";
    } else if (action === "review-derived") {
      await reviewDerivedArtifact({ config: state.config, artifactId: id, reviewStatus: "reviewed", notes: "Reviewed in calendar ingress queue." });
      state.result = "artifact marked reviewed";
    } else if (action === "block-derived") {
      await reviewDerivedArtifact({ config: state.config, artifactId: id, reviewStatus: "blocked", approvalState: "blocked", notes: "Blocked in calendar ingress queue." });
      state.result = "artifact blocked";
    } else if (action === "publish-derived") {
      await reviewDerivedArtifact({ config: state.config, artifactId: id, reviewStatus: "published", approvalState: "approved", notes: "Published in calendar ingress queue after approval gates cleared." });
      state.result = "artifact published";
    } else if (action === "review-card") {
      await reviewEvidenceCard({ config: state.config, cardId: id, reviewStatus: "reviewed", notes: "Evidence card reviewed in calendar ingress queue." });
      state.result = "evidence card marked reviewed";
    } else if (action === "block-card") {
      await reviewEvidenceCard({ config: state.config, cardId: id, reviewStatus: "blocked", approvalState: "blocked", notes: "Evidence card blocked in calendar ingress queue." });
      state.result = "evidence card blocked";
    } else if (action === "publish-card") {
      await reviewEvidenceCard({ config: state.config, cardId: id, reviewStatus: "published", approvalState: "approved", notes: "Published no-name evidence card after public approval gates cleared." });
      state.result = "evidence card published";
    } else if (action === "approve-gate") {
      const gate = findQueueRow("approvalGates", id);
      await decideApprovalGate({ config: state.config, gate, gateStatus: "approved", notes: "Approved in calendar ingress queue." });
      state.result = "gate approved";
    } else if (action === "block-gate") {
      const gate = findQueueRow("approvalGates", id);
      await decideApprovalGate({ config: state.config, gate, gateStatus: "blocked", notes: "Blocked in calendar ingress queue." });
      state.result = "gate blocked";
    }
    state.queue = await fetchCalendarOpsQueue({ config: state.config });
  } catch (error) {
    state.error = error?.body?.error || error?.message || String(error);
  } finally {
    state.queueBusy = false;
    render();
  }
}

function wire() {
  const form = formEl();
  if (!form) return;
  const sourceForm = sourceFormEl();
  form.addEventListener("input", updatePreview);
  form.addEventListener("change", updatePreview);
  wireInvitePicker();
  sourceForm?.addEventListener("input", updateSourcePreview);
  sourceForm?.addEventListener("change", updateSourcePreview);
  sourceForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSourceSubmit("submit");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handleSubmit("request");
  });
  root.querySelector("[data-cal-action='create']")?.addEventListener("click", () => handleSubmit("create"));
  root.querySelector("[data-cal-action='dry-run']")?.addEventListener("click", () => handleSubmit("dry-run"));
  root.querySelector("[data-cal-source-action='dry-run']")?.addEventListener("click", () => handleSourceSubmit("dry-run"));
  root.querySelector("[data-cal-queue-refresh]")?.addEventListener("click", refreshQueue);
  root.querySelectorAll("[data-cal-queue-action]").forEach((button) => {
    button.addEventListener("click", () => handleQueueAction(button.dataset.calQueueAction, button.dataset.id));
  });
  root.querySelector("[data-cal-config-save]")?.addEventListener("click", () => {
    state.config = calendarIngressConfigWithDefaults(readConfigFromDom());
    saveCalendarIngressConfig(state.config);
    state.error = null;
    state.result = "connection saved";
    render();
  });
  root.querySelector("[data-cal-config-clear]")?.addEventListener("click", () => {
    state.config = calendarIngressConfigWithDefaults({});
    saveCalendarIngressConfig({});
    state.error = null;
    state.result = "connection cleared";
    render();
  });
}

function wireInvitePicker() {
  root.querySelectorAll("[data-cal-invite-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = inviteGroupById(button.dataset.calInviteGroup);
      if (group) addInviteEmails(group.emails);
    });
  });
  root.querySelector("[data-cal-invite-person]")?.addEventListener("change", (event) => {
    const person = invitePersonById(event.currentTarget.value);
    if (person) addInviteEmails([person.email]);
    event.currentTarget.value = "";
  });
  root.querySelector("[data-cal-invite-clear]")?.addEventListener("click", () => {
    const input = attendeeTextarea();
    if (!input) return;
    input.value = "";
    updatePreview();
  });
  updateInviteMeter();
}

render();
loadInviteDirectory();
