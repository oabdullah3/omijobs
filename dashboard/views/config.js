import { api } from "../api.js";
import { el, esc, toast, openModal, fmtRel, runSummary } from "../app.js";

const state = { configs: [], bootstrap: null, runStatus: {}, timer: null };

async function refresh() {
  try {
    state.configs = await api.get("/api/configs");
    state.runStatus = await api.get("/api/run/status");
    if (!state.bootstrap) state.bootstrap = await api.get("/api/bootstrap");
    const root = document.getElementById("config-root");
    if (root) root.replaceChildren(renderBody());
  } catch (error) {
    toast(error.message, "warn");
  }
}

export function onLive(event) {
  if (event === "db" || event === "runs") refresh();
}
export function mount() {
  state.timer = setInterval(refresh, 5000);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
}

async function runNow(meta) {
  try {
    const body = await api.post(`/api/configs/${meta.id}/run`);
    toast(`Started a run for "${meta.id}" (${body.runId})`, "good");
  } catch (error) {
    toast(error.message, error.status === 409 ? "warn" : "warn");
  }
}

function configCard(meta) {
  // Config paths live in fixed folders now, so cards show names: the config id
  // (title), the DB *filename*, and user-facing details. Full paths are gone.
  const dbBadge = meta.db.enabled
    ? el("span", { class: `badge ${meta.db.exists ? "live" : "off"}` }, `${esc(meta.db.file)} · ${meta.db.exists ? `${meta.db.jobCount} jobs` : "not created yet"}`)
    : el("span", { class: "badge stale" }, "db disabled");
  // Live progress while running; the persisted result summary after (both come
  // from the run's progress file via /api/run/status, keyed by config id).
  const rs = state.runStatus?.[meta.id];
  const progress = runSummary(rs);
  const running = rs?.running ?? false;
  return el("div", { class: "card" },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(meta.id)),
      el("span", { class: "hint" }, meta.kind === "base" ? "realtime config" : "cron config"),
      dbBadge),
    el("p", { class: "hint" }, `queries: ${esc(meta.queries.join(", ") || "(none)")}`),
    el("p", { class: "hint" }, `adapters: ${esc(meta.enabledPortals.join(", ") || "(none)")}`),
    progress ? el("p", { class: "hint" }, `run: ${esc(progress)}${running ? ` · ${fmtRel(rs.updatedAt)}` : ""}`) : null,
    el("div", { class: "toolbar" },
      el("button", { class: "btn", onclick: () => editModal(meta) }, "Edit"),
      el("button", { class: "btn btn-primary", disabled: running, onclick: () => runNow(meta) }, "Run now"),
      el("button", { class: "btn btn-danger", disabled: !running, onclick: () => stopRun(meta) }, "Stop")));
}

// Stop aborts the running process and writes the partial results it fetched so
// far to the DB and the output (the CLI polls a stop marker and exits 130).
async function stopRun(meta) {
  try {
    const body = await api.post(`/api/configs/${meta.id}/stop`);
    toast(`Stopping "${meta.id}" — saving results so far…`, "warn");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function editModal(meta) {
  const queries = el("input", { class: "input", value: meta.queries.join(", ") });
  const adapterChecks = (state.bootstrap?.adapters ?? []).map((a) => {
    const on = meta.enabledPortals.includes(a.id);
    return el("label", {}, el("input", { type: "checkbox", value: a.id, checked: on }), ` ${esc(a.name)}`);
  });
  const shared = el("input", { type: "radio", name: "storage", value: "shared", checked: meta.db.file === "jobs.db" && meta.db.enabled });
  const separate = el("input", { type: "radio", name: "storage", value: "separate", checked: meta.db.file.endsWith(".db") && meta.db.file !== "jobs.db" && meta.db.enabled });
  const custom = el("input", { type: "radio", name: "storage", value: "custom", checked: !shared.checked && !separate.checked });
  const dbEnabled = el("input", { type: "checkbox", checked: meta.db.enabled });
  const retention = el("input", { class: "input", type: "number", min: 0, value: meta.retentionDays ?? 30 });
  const raw = el("textarea", { class: "input codeblock", rows: 10, spellcheck: "false" });
  raw.value = "loading…";
  // One Save button persists the friendly form fields AND the raw JSON. It stays
  // disabled until the full config finishes loading so a save can never hit a
  // half-loaded editor.
  const saveBtn = el("button", { class: "btn btn-primary", disabled: true, onclick: () => save() }, "Save");
  const modal = el("div", { class: "modal" },
    el("h3", {}, `Edit ${esc(meta.id)}`),
    el("div", { class: "callout warn", id: "db-warning", style: "display:none" },
      el("p", {}, "This config has DB writes disabled — the dashboard Jobs page will not show its results.")),
    el("div", { class: "form-grid" },
      el("div", { class: "field" }, el("label", {}, "Queries"), queries),
      el("div", { class: "field" }, el("label", {}, "Adapters"), el("div", { class: "toolbar" }, ...adapterChecks)),
      meta.kind === "cron" ? el("div", { class: "field" },
        el("label", {}, "Storage"),
        el("div", {},
          el("label", {}, shared, " shared jobs.db "),
          el("label", {}, separate, " separate <name>.db "),
          el("label", {}, custom, " custom (advanced)"))) : null,
      el("div", { class: "field" }, el("label", {}, "Aggregate DB"), el("label", {}, dbEnabled, " enabled (dashboard depends on it)")),
      meta.kind === "base" ? el("div", { class: "field" }, el("label", {}, "Retention (days)"), retention, el("div", { class: "hint" }, "0 keeps everything; cron configs inherit this value.")) : null,
      el("div", { class: "field" }, el("label", {}, "Advanced (raw JSON)"), raw,
        el("div", { class: "hint" }, "The full config file — Save applies it along with the form fields above (form fields win where they overlap).")),
    ),
    el("div", { class: "modal-actions" },
      saveBtn,
      el("button", { class: "btn btn-ghost", onclick: () => backdrop.remove() }, "Cancel")));
  const backdrop = openModal(modal);

  // Load the FULL raw RunConfig into the advanced editor on open.
  api.get(`/api/configs/${meta.id}`).then(({ config }) => {
    raw.value = JSON.stringify(config, null, 2);
    saveBtn.disabled = false;
  }).catch((error) => {
    raw.value = "";
    toast(`Could not load the config: ${error.message}`, "warn");
  });

  function showWarning() {
    document.getElementById("db-warning").style.display = "block";
  }

  // Initial form values, for dirty-tracking: Save sends the raw JSON plus only
  // the form fields the user actually changed, so a raw-JSON edit (e.g. a
  // portal block) is never overwritten by a stale form value.
  const initialQueries = [...meta.queries];
  const initialEnabled = [...meta.enabledPortals];
  const initialStorage = meta.db.file === "jobs.db" && meta.db.enabled ? "shared"
    : (meta.db.file.endsWith(".db") && meta.db.file !== "jobs.db" && meta.db.enabled ? "separate" : "custom");
  const initialDbEnabled = meta.db.enabled;
  const initialRetention = meta.retentionDays ?? 30;
  const sameSet = (a, b) => {
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  };

  async function save() {
    const warning = document.getElementById("db-warning");
    warning.style.display = "none";
    const willDisable = !dbEnabled.checked && initialDbEnabled;
    if (willDisable && !confirm("Disabling the aggregate DB means the dashboard Jobs page will not show results from this config. Continue?")) return;
    // The raw JSON in the advanced editor is the source of truth for anything
    // the form doesn't override — parse it first so a typo can't silently drop
    // edits the way the old Save / Apply JSON split did.
    let parsed;
    try {
      parsed = JSON.parse(raw.value);
    } catch {
      toast("Invalid JSON in the advanced editor — nothing was saved", "warn");
      return;
    }
    const payload = { raw: parsed };
    const queriesVal = queries.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!sameSet(queriesVal, initialQueries)) payload.queries = queriesVal;
    const enabledVal = [...adapterChecks].filter((c) => c.firstChild.checked).map((c) => c.firstChild.value);
    if (!sameSet(enabledVal, initialEnabled)) payload.enabledPortals = enabledVal;
    if (dbEnabled.checked !== initialDbEnabled) payload.dbEnabled = dbEnabled.checked;
    if (meta.kind === "base") {
      const retentionVal = Number(retention.value);
      if (retentionVal !== initialRetention) payload.retentionDays = retentionVal;
    } else {
      const storageVal = document.querySelector(`input[name=storage]:checked`)?.value;
      if (storageVal !== initialStorage) payload.storage = storageVal;
    }
    try {
      const body = await api.put(`/api/configs/${meta.id}`, payload);
      if (body.dbWarning) showWarning();
      toast(`Saved ${esc(meta.id)}`, "good");
      // When the DB is disabled, keep the modal open so the #db-warning callout
      // stays visible — the user dismisses it via the modal's close button.
      if (!body.dbWarning) backdrop.remove();
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  }
}

function renderBody() {
  // Base and cron configs are shown in separate sections so the two never share
  // a name or read as the same kind of thing (realtime/ vs cron/ folders).
  const realtime = state.configs.filter((m) => m.kind === "base");
  const cron = state.configs.filter((m) => m.kind === "cron");
  return el("div", {},
    el("p", { class: "eyebrow" }, "Config"),
    el("h2", { class: "docs" }, "Configuration"),
    el("p", { class: "hint" }, "The realtime config drives normal runs; each cron job has its own config."),
    ...(realtime.length ? [el("h3", { class: "docs" }, "Realtime"), ...realtime.map(configCard)] : []),
    ...(cron.length ? [el("h3", { class: "docs" }, "Cron"), ...cron.map(configCard)] : []));
}

export async function render() {
  if (!state.configs.length) await refresh();
  return el("div", { id: "config-root" }, renderBody());
}
