// profile-form.js — structured cohort record editor for the web app.
//
// The public cohort page should not drop users straight into raw
// frontmatter. It collects edits in a small form, rebuilds the markdown
// record, preserves the existing prose body, and then opens GitHub's web
// PR flow with the updated file prefilled.

import { escHtml, escAttr, normalizeGithubAccount } from "./escape.js";
import { buildEditPRUrl, buildNewPRUrl, buildRecordPath } from "./pr-url.js";

const DOMAIN_OPTIONS = ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"];
const SHAPE_OPTIONS = ["torus", "hex", "prism", "meridian", "scaffold", "plate"];

const PERSON_FIELDS = [
  { key: "name",                 label: "name",               type: "text" },
  { key: "team",                 label: "team",               type: "text" },
  { key: "role",                 label: "role",               type: "text" },
  { key: "geo",                  label: "geo",                type: "text" },
  { key: "domain",               label: "domain",             type: "select", options: DOMAIN_OPTIONS },
  { key: "links.github",         label: "github",             type: "text" },
  { key: "links.x",              label: "x",                  type: "text" },
  { key: "links.website",        label: "website",            type: "url" },
  { key: "links.linkedin",       label: "linkedin",           type: "text" },
  { key: "now",                  label: "now",                type: "textarea" },
  { key: "comm_style",           label: "comm style",         type: "textarea" },
  { key: "contribute_interests", label: "contribute",         type: "textarea" },
  { key: "availability_pref",    label: "availability",       type: "textarea" },
  { key: "weekly_intention",     label: "weekly intention",   type: "textarea" },
  { key: "dietary_restrictions", label: "dietary",            type: "text" },
  { key: "skills",               label: "skills",             type: "list" },
  { key: "seeking",              label: "seeking",            type: "list" },
  { key: "offering",             label: "offering",           type: "list" },
];

const TEAM_FIELDS = [
  { key: "name",                 label: "name",               type: "text" },
  { key: "focus",                label: "focus",              type: "text" },
  { key: "now",                  label: "now",                type: "textarea" },
  { key: "members_count",        label: "members",            type: "number" },
  { key: "geo",                  label: "geo",                type: "text" },
  { key: "domain",               label: "domain",             type: "select", options: DOMAIN_OPTIONS },
  { key: "shape",                label: "shape",              type: "select", options: SHAPE_OPTIONS },
  { key: "links.github",         label: "github",             type: "text" },
  { key: "links.repo",           label: "repo",               type: "text" },
  { key: "links.x",              label: "x",                  type: "text" },
  { key: "links.website",        label: "website",            type: "url" },
  { key: "links.demo",           label: "demo",               type: "url" },
  { key: "links.deck",           label: "deck",               type: "url" },
  { key: "paper_basis",          label: "paper basis",        type: "list" },
  { key: "traction",             label: "traction",           type: "textarea" },
  { key: "hackathon_note",       label: "hackathon",          type: "text" },
  { key: "success_dimensions",   label: "success",            type: "list" },
  { key: "weekly_goals",         label: "weekly goals",       type: "textarea" },
  { key: "monthly_milestones",   label: "milestones",         type: "textarea" },
  { key: "graduation_target",    label: "graduation",         type: "textarea" },
  { key: "prior_shipping",       label: "prior shipping",     type: "list" },
  { key: "skill_areas",          label: "skill areas",        type: "list" },
  { key: "dependencies",         label: "dependencies",       type: "list" },
  { key: "seeking",              label: "seeking",            type: "list" },
  { key: "offering",             label: "offering",           type: "list" },
];

function fieldsFor(recordType) {
  if (recordType === "person") return PERSON_FIELDS;
  return TEAM_FIELDS;
}

function getNested(obj, path) {
  if (!obj) return undefined;
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setNested(obj, path, value) {
  if (!obj) return;
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function listToDisplay(value) {
  if (Array.isArray(value)) return value.join("\n");
  return value == null ? "" : String(value);
}

function splitList(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const delimiter = raw.includes("\n") ? /\r?\n/ : /,/;
  const items = raw.split(delimiter).map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

function coerceInputValue(input, fieldType) {
  const v = input.value;
  if (fieldType === "list") return splitList(v);
  if (input.type === "number") return v === "" ? null : Number(v);
  if (v === "") return null;
  return v;
}

function isEmptyValue(value) {
  return value == null
    || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function cleanObject(obj, keys) {
  const out = {};
  for (const key of keys) {
    const value = obj?.[key];
    if (!isEmptyValue(value)) out[key] = value;
  }
  return out;
}

function quoteYaml(value) {
  if (value == null || value === "") return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value);
  const lowered = s.toLowerCase();
  const reserved = new Set(["null", "true", "false", "yes", "no", "on", "off"]);
  if (/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(s) && !reserved.has(lowered)) return s;
  return JSON.stringify(s);
}

function blockScalar(value, indent) {
  const pad = " ".repeat(indent);
  const text = String(value ?? "").replace(/\s+$/, "");
  const lines = text ? text.split(/\r?\n/) : [""];
  return `|\n${lines.map((line) => `${pad}${line}`).join("\n")}`;
}

function yamlInlineValue(value, indent) {
  if (value == null || value === "") return "null";
  if (typeof value === "string" && value.includes("\n")) return blockScalar(value, indent);
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) return JSON.stringify(value);
  return quoteYaml(value);
}

function yamlListItem(value, indent) {
  const pad = " ".repeat(indent);
  if (typeof value === "string" && value.includes("\n")) {
    return `${pad}- ${blockScalar(value, indent + 2)}`;
  }
  return `${pad}- ${quoteYaml(value)}`;
}

function yamlObject(value, indent) {
  const pad = " ".repeat(indent);
  const entries = Object.entries(value || {}).filter(([, v]) => !isEmptyValue(v));
  if (!entries.length) return "{}";
  return `\n${entries.map(([key, v]) => {
    if (Array.isArray(v)) {
      return v.length
        ? `${pad}${key}:\n${v.map((item) => yamlListItem(item, indent + 2)).join("\n")}`
        : `${pad}${key}: []`;
    }
    if (v && typeof v === "object") {
      return `${pad}${key}:${yamlObject(v, indent + 2)}`;
    }
    return `${pad}${key}: ${yamlInlineValue(v, indent + 2)}`;
  }).join("\n")}`;
}

function yamlField(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (value == null || value === "") return `${pad}${key}: null`;
  if (Array.isArray(value)) {
    return value.length
      ? `${pad}${key}:\n${value.map((item) => yamlListItem(item, indent + 2)).join("\n")}`
      : `${pad}${key}: []`;
  }
  if (value && typeof value === "object") return `${pad}${key}:${yamlObject(value, indent + 2)}`;
  return `${pad}${key}: ${yamlInlineValue(value, indent + 2)}`;
}

function frontmatter(lines, body) {
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function markdownBody(body, fallbackHeading, fallbackText) {
  if (body != null && String(body).trim()) return String(body).replace(/^\s+/, "");
  return `\n## ${fallbackHeading}\n\n${fallbackText}\n`;
}

function buildTeamMarkdown(draft, slug, body = null) {
  const links = cleanObject(draft.links || {}, ["github", "repo", "x", "website", "demo", "deck"]);
  const githubAccount = normalizeGithubAccount(links.github);
  if (githubAccount) links.github = githubAccount;
  const lines = [
    yamlField("record_id", slug),
    yamlField("record_type", "team"),
    yamlField("schema_version", draft.schema_version || 1),
    yamlField("kind", draft.kind || "team"),
  ];
  if (draft.membership) lines.push(yamlField("membership", draft.membership));
  lines.push(
    "",
    yamlField("name", draft.name || ""),
    yamlField("focus", draft.focus || ""),
    yamlField("members_count", draft.members_count == null ? null : Number(draft.members_count)),
    yamlField("geo", draft.geo || ""),
    yamlField("domain", draft.domain || null),
    yamlField("shape", draft.shape || null),
    yamlField("is_mentor", Boolean(draft.is_mentor)),
    yamlField("links", links),
    yamlField("paper_basis", draft.paper_basis || null),
    yamlField("traction", draft.traction || null),
    yamlField("hackathon_note", draft.hackathon_note || null),
    yamlField("success_dimensions", draft.success_dimensions || null)
  );

  for (const key of [
    "now",
    "graduation_target",
    "monthly_milestones",
    "weekly_goals",
    "prior_shipping",
    "skill_areas",
    "dependencies",
    "seeking",
    "offering",
  ]) {
    if (!isEmptyValue(draft[key])) lines.push(yamlField(key, draft[key]));
  }
  if (!isEmptyValue(draft.journey)) lines.push(yamlField("journey", draft.journey));

  return frontmatter(
    lines,
    markdownBody(body, "about", draft.kind === "project"
      ? "(project description - what it does, who it's for, current state)"
      : "(team description - focus, members, where to find you)")
  );
}

function buildPersonMarkdown(draft, slug, body = null) {
  const links = cleanObject(draft.links || {}, ["github", "x", "website", "linkedin"]);
  const githubAccount = normalizeGithubAccount(links.github);
  if (githubAccount) links.github = githubAccount;
  const lines = [
    yamlField("record_id", slug),
    yamlField("record_type", "person"),
    yamlField("schema_version", draft.schema_version || 1),
  ];
  if (draft.role_class) lines.push(yamlField("role_class", draft.role_class));
  lines.push(
    "",
    yamlField("name", draft.name || ""),
    yamlField("team", draft.team || null),
    yamlField("role", draft.role || ""),
    yamlField("geo", draft.geo || ""),
    yamlField("domain", draft.domain || null)
  );

  for (const key of [
    "email",
    "dates_start",
    "dates_end",
    "secondary_teams",
    "absences",
    "skills",
    "skill_areas",
    "seeking",
    "offering",
    "pair_with",
    "now",
  ]) {
    if (!isEmptyValue(draft[key])) lines.push(yamlField(key, draft[key]));
  }

  lines.push(
    yamlField("links", links),
    yamlField("comm_style", draft.comm_style || null),
    yamlField("contribute_interests", draft.contribute_interests || null),
    yamlField("availability_pref", draft.availability_pref || null),
    yamlField("weekly_intention", draft.weekly_intention || null),
    yamlField("dietary_restrictions", draft.dietary_restrictions || null)
  );

  return frontmatter(
    lines,
    markdownBody(body, "bio", "(write a short bio here - what you're building, what you're into, what you'd be a good thought partner on)")
  );
}

async function fetchExistingBody({ path, repo, branch }) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}?ts=${Date.now()}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const text = await r.text();
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function prepareProfilePR({
  recordType,
  recordId,
  draft,
  repo = "dmarzzz/shape-rotator-os",
  branch = "main",
  existingBody,
}) {
  if (recordType !== "person" && recordType !== "team") {
    throw new Error(`structured PR editor does not support record type: ${recordType}`);
  }
  const path = buildRecordPath({ recordType, recordId });
  const body = existingBody === undefined
    ? await fetchExistingBody({ path, repo, branch })
    : existingBody;
  const markdown = recordType === "person"
    ? buildPersonMarkdown(draft, recordId, body)
    : buildTeamMarkdown(draft, recordId, body);
  return {
    draft,
    path,
    markdown,
    recordType,
    recordId,
    prUrl: buildNewPRUrl({ path, value: markdown, repo, branch }),
    rawEditUrl: buildEditPRUrl({ recordType, recordId, repo, branch }),
  };
}

// Render a profile-edit form into `container`. Returns a controller
// with .destroy() (removes the form) and .getDraft() (returns the live
// in-progress object).
//
// options:
//   recordType      "team" | "person"
//   recordId        slug for the record (used in the PR URL)
//   initialData     starting object - mutated in place as the user types
//   container       HTMLElement the form is appended into
//   onSubmit        optional async ({ draft, prUrl, markdown, path, ... }) => void
//   openExternal    optional (url) => void
export function renderProfileForm({
  recordType,
  recordId,
  initialData,
  container,
  onSubmit,
  openExternal,
  repo = "dmarzzz/shape-rotator-os",
  branch = "main",
}) {
  if (!container) return null;
  const draft = initialData ? JSON.parse(JSON.stringify(initialData)) : {};
  const fields = fieldsFor(recordType);
  const openLink = typeof openExternal === "function"
    ? openExternal
    : (url) => { try { window.open(url, "_blank", "noopener"); } catch {} };

  const rows = fields.map((f) => {
    const value = getNested(draft, f.key);
    const display = f.type === "list" ? listToDisplay(value) : (value == null ? "" : String(value));

    let input;
    if (f.type === "select") {
      const opts = ['<option value="">-</option>']
        .concat((f.options || []).map((option) => {
          const ov = typeof option === "object" ? option.value : option;
          const ol = typeof option === "object" ? option.label : option;
          const selected = String(ov) === String(value ?? "") ? "selected" : "";
          return `<option value="${escAttr(String(ov))}" ${selected}>${escHtml(String(ol))}</option>`;
        }))
        .join("");
      input = `<select class="shape-pf-input" name="${escAttr(f.key)}" data-ftype="${escAttr(f.type)}">${opts}</select>`;
    } else if (f.type === "textarea" || f.type === "list") {
      input = `<textarea
        class="shape-pf-input shape-pf-textarea"
        name="${escAttr(f.key)}"
        data-ftype="${escAttr(f.type)}"
        rows="${f.type === "list" ? 3 : 4}"
        placeholder="${escAttr(f.placeholder || (f.type === "list" ? "one per line" : ""))}">${escHtml(display)}</textarea>`;
    } else {
      input = `<input
        class="shape-pf-input"
        type="${escAttr(f.type)}"
        name="${escAttr(f.key)}"
        data-ftype="${escAttr(f.type)}"
        value="${escAttr(display)}"
        placeholder="${escAttr(f.placeholder || "")}" />`;
    }
    const rowClass = (f.type === "textarea" || f.type === "list")
      ? "shape-pf-row shape-pf-row-wide"
      : "shape-pf-row";
    return `<label class="${rowClass}">
      <span class="shape-pf-label">${escHtml(f.label)}</span>
      ${input}
    </label>`;
  }).join("");

  const rawEditUrl = buildEditPRUrl({ recordType, recordId, repo, branch });
  const wrap = document.createElement("div");
  wrap.className = "shape-profile-form-wrap";
  wrap.innerHTML = `
    <form class="shape-profile-form" autocomplete="off">
      ${rows}
      <div class="shape-profile-submit">
        <div class="shape-profile-submit-actions">
          <button type="submit" class="shape-profile-submit-btn">
            open prefilled PR
          </button>
          <button type="button" class="shape-profile-icon-btn shape-profile-copy-draft" aria-label="copy generated markdown" title="copy generated markdown">
            <span class="shape-copy-icon" aria-hidden="true"></span>
          </button>
        </div>
        <p class="shape-profile-hint">
          updates <code>${escHtml(buildRecordPath({ recordType, recordId }))}</code>.
          <a href="${escAttr(rawEditUrl)}" target="_blank" rel="noopener noreferrer">raw github editor</a>
        </p>
        <div class="shape-profile-result" hidden></div>
      </div>
    </form>
  `;
  container.appendChild(wrap);

  const form = wrap.querySelector("form");
  const result = wrap.querySelector(".shape-profile-result");

  const showResult = ({ kind, tag, message, markdown }) => {
    result.hidden = false;
    result.dataset.kind = kind;
    result.innerHTML = `
      <span class="shape-profile-result-tag">${escHtml(tag)}</span>
      <span>${escHtml(message)}</span>
      ${markdown ? `<span class="shape-profile-result-actions">
        <button type="button" class="shape-profile-icon-btn shape-profile-copy" aria-label="copy generated markdown" title="copy generated markdown">
          <span class="shape-copy-icon" aria-hidden="true"></span>
        </button>
      </span>` : ""}
    `;
    if (markdown) {
      result.querySelector(".shape-profile-copy")?.addEventListener("click", () => copyMarkdown(markdown));
    }
  };

  const copyMarkdown = async (markdown) => {
    try {
      await navigator.clipboard.writeText(markdown);
      showResult({ kind: "success", tag: "copied", message: "Generated markdown copied to clipboard.", markdown });
      return true;
    } catch {
      showResult({ kind: "error", tag: "copy failed", message: "Clipboard write failed; use the prefilled PR or raw editor.", markdown });
      return false;
    }
  };

  const prepareCurrentPayload = async () => {
    result.hidden = false;
    result.dataset.kind = "loading";
    result.innerHTML = `<span class="shape-profile-result-tag">preparing</span><span>building the updated markdown file...</span>`;
    return prepareProfilePR({ recordType, recordId, draft, repo, branch });
  };

  const onChange = (e) => {
    const target = e.target;
    if (!target || !target.name) return;
    const ftype = target.getAttribute("data-ftype") || target.type;
    setNested(draft, target.name, coerceInputValue(target, ftype));
  };
  form.addEventListener("input", onChange);
  form.addEventListener("change", onChange);

  const copyDraftBtn = wrap.querySelector(".shape-profile-copy-draft");
  copyDraftBtn?.addEventListener("click", async () => {
    try {
      const payload = await prepareCurrentPayload();
      await copyMarkdown(payload.markdown);
    } catch (err) {
      showResult({ kind: "error", tag: "error", message: err?.message || "could not prepare generated markdown" });
    }
  });

  const onSubmitEvent = async (e) => {
    e.preventDefault();

    let pendingWindow = null;
    if (typeof onSubmit !== "function" && typeof openExternal !== "function") {
      try {
        pendingWindow = window.open("about:blank", "_blank");
        if (pendingWindow) pendingWindow.opener = null;
      } catch {}
    }

    let payload;
    try {
      payload = await prepareCurrentPayload();
    } catch (err) {
      if (pendingWindow) pendingWindow.close();
      showResult({ kind: "error", tag: "error", message: err?.message || "could not prepare github PR" });
      return;
    }

    if (typeof onSubmit === "function") {
      await onSubmit(payload);
    } else if (pendingWindow) {
      pendingWindow.location.href = payload.prUrl;
    } else {
      openLink(payload.prUrl);
    }

    const longUrl = payload.prUrl.length > 8000;
    result.dataset.kind = longUrl ? "warn" : "success";
    result.innerHTML = `
      <span class="shape-profile-result-tag">${longUrl ? "opened" : "github opened"}</span>
      <span>${longUrl ? "If GitHub rejects the long URL, copy the markdown and use the raw editor." : "Your edited file is prefilled. Commit changes, then create the pull request."}</span>
      <span class="shape-profile-result-actions">
        <a href="${escAttr(payload.prUrl)}" target="_blank" rel="noopener noreferrer">reopen prefilled PR</a>
        <button type="button" class="shape-profile-icon-btn shape-profile-copy" aria-label="copy generated markdown" title="copy generated markdown">
          <span class="shape-copy-icon" aria-hidden="true"></span>
        </button>
      </span>
    `;
    result.querySelector(".shape-profile-copy")?.addEventListener("click", () => copyMarkdown(payload.markdown));
  };
  form.addEventListener("submit", onSubmitEvent);

  return {
    element: wrap,
    getDraft: () => draft,
    destroy: () => {
      form.removeEventListener("input", onChange);
      form.removeEventListener("change", onChange);
      form.removeEventListener("submit", onSubmitEvent);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    },
  };
}
