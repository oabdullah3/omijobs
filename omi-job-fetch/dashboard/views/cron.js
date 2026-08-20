import { api } from "../api.js";
import { el, esc, toast, openModal, fmtCountdown, fmtRel, runSummary } from "../app.js";

const SCHEDULE_EXAMPLES = ["every 30m", "every 6 hours", "every 2 days", "daily at 09:00", "weekdays at 09:00", "weekends at 10:00", "monday at 09:00", "hourly", "daily", "weekly"];
const state = { data: null, bootstrap: null, configMeta: {}, runStatus: {}, refreshTimer: null, tickTimer: null, logNode: null };

async function refresh() {
  try {
    state.data = await api.get("/api/cron");
    state.runStatus = await api.get("/api/run/status");
    if (!state.bootstrap) state.bootstrap = await api.get("/api/bootstrap");
    // Map each config id → its meta (queries, db name, state) so job cards can
    // show the user-facing details instead of a config file path.
    const configs = await api.get("/api/configs");
    state.configMeta = Object.fromEntries(configs.map((m) => [m.id, m]));
    const gw = document.getElementById("cron-gateway");
    if (gw && state.data) {
      // Swap only the header card. The log is a persistent sibling — reparenting
      // it every 3s would reset its scrollTop to 0 (Chrome zeroes scroll on move).
      const card = gw.querySelector(":scope > .card");
      if (card) card.replaceWith(gatewayHeader());
      else gw.append(gatewayHeader());
    }
    const jobs = document.getElementById("cron-jobs");
    if (jobs && state.data) {
      const d = state.data;
      const children = [];
      if (d.error) children.push(el("div", { class: "callout warn" }, el("p", {}, esc(d.error))));
      children.push(...d.jobs.map((j) => jobCard(j, d.gateway.running)));
      jobs.replaceChildren(...children);
    }
    loadLog();
  } catch (error) {
    toast(error.message, "warn");
  }
}

// Tick every second so every countdown span re-reads its data-next timestamp.
// Must match jobCard's "next: " prefix — otherwise the 3s refresh (prefix) and
// this 1s tick (no prefix) alternate overwriting the span and the label flickers.
function tickCountdowns() {
  for (const node of document.querySelectorAll(".countdown[data-next]")) {
    node.textContent = `next: ${fmtCountdown(node.dataset.next)}`;
  }
}

export function onLive(event) {
  if (event === "cron" || event === "state") refresh();
}
export function mount() {
  state.refreshTimer = setInterval(refresh, 3000);
  state.tickTimer = setInterval(tickCountdowns, 1000);
  refresh();
}
export function unmount() {
  clearInterval(state.refreshTimer);
  clearInterval(state.tickTimer);
}

async function mutate(action, id) {
  try {
    const body = await api.post(`/api/cron/${action}`, id ? { id } : {});
    if (body.output) toast(body.output.trim().split("\n").pop(), body.ok ? "good" : "warn");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function gatewayHeader() {
  const d = state.data;
  const gw = d.gateway;
  const rec = el("span", { class: `rec${gw.running ? " live" : ""}` });
  const statusText = gw.running ? `running (pid ${gw.pid})` : gw.stale ? "stale (gateway down)" : "not running";
  const badge = gw.running ? el("span", { class: "badge live" }, statusText)
    : gw.stale ? el("span", { class: "badge stale" }, statusText)
    : el("span", { class: "badge off" }, statusText);
  const btns = [
    el("button", { class: "btn btn-primary", disabled: gw.running, onclick: () => mutate("start") }, "Start"),
    el("button", { class: "btn", disabled: !gw.running, onclick: () => mutate("stop") }, "Stop"),
    el("button", { class: "btn", disabled: !gw.running, onclick: () => mutate("restart") }, "Restart"),
    el("button", { class: "btn", onclick: () => mutate(d.paused ? "resume" : "pause") }, d.paused ? "Resume" : "Pause"),
  ];
  return el("div", { class: "card" },
    el("p", { class: "eyebrow" }, "Cron gateway"),
    el("div", { class: "toolbar" }, rec, badge, ...btns),
    el("p", { class: "hint" }, `Auto-start at login: ${esc(gw.autostart)} · state: ${esc(d.file)}`));
}

// One persistent log node, created once and never reparented: refresh() swaps
// the header card above it, but this element stays put so its scroll position
// survives every 3s poll.
function gatewayLog() {
  if (!state.logNode) state.logNode = el("div", { class: "log", id: "cron-log" }, "loading log…");
  return state.logNode;
}

async function loadLog() {
  const log = state.logNode ?? document.getElementById("cron-log");
  if (!log) return;
  // Were we watching the tail? If so pin to the new bottom after the update; if
  // the user scrolled up to read history, leave their scroll position alone.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  try {
    const { lines } = await api.get("/api/cron/log");
    log.textContent = lines.length ? lines.join("\n") : "(no log lines yet)";
    if (atBottom) log.scrollTop = log.scrollHeight;
  } catch { /* ignore */ }
}

function jobCard(job, gwRunning) {
  const running = job.running;
  const statusText = running
    ? (gwRunning ? "running now" : "running (stale — gateway down)")
    : (job.lastStatus ?? "never run");
  const badge = running
    ? el("span", { class: `badge ${gwRunning ? "live" : "stale"}` }, statusText)
    : el("span", { class: "badge off" }, statusText);
  // Always a countdown span (data-next drives the 1s ticker), even when not
  // running — the card just stops updating the text to a static "next: …".
  const countdown = el("span", { class: "countdown", "data": { next: job.nextRunAt } }, `next: ${fmtCountdown(job.nextRunAt)}`);
  // Live progress while running; the persisted result summary after (both come
  // from the run's progress file via /api/run/status). statusText is the fallback
  // when the config has never run or no progress data exists.
  const progress = runSummary(state.runStatus?.[job.id]);
  const controls = [
    el("button", { class: "btn small", disabled: running, onclick: () => runNow(job) }, "Run now"),
    el("button", { class: "btn small btn-danger", disabled: !running, onclick: () => stopRun(job) }, "Stop"),
    el("button", { class: "btn small", onclick: () => mutate(job.enabled ? "disable" : "enable", job.id) }, job.enabled ? "Disable" : "Enable"),
    el("button", { class: "btn small btn-danger", onclick: () => removeJob(job) }, "Remove"),
  ];
  // The config details stand out in a callout instead of a "config: <path>"
  // line — paths live in fixed folders now, so only names matter.
  const cfg = state.configMeta[job.id];
  return el("div", { class: "card", "data": { cron: job.id } },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(job.id)),
      badge,
      countdown),
    el("p", { class: "hint" }, `schedule: ${esc(job.schedule)}`),
    cfg ? el("div", { class: "callout" },
      el("p", {}, `queries: ${esc(cfg.queries.join(", ") || "(none)")}`),
      cfg.db.enabled
        ? el("p", {}, `db: ${esc(cfg.db.file)} · ${cfg.db.exists ? `${cfg.db.jobCount} jobs` : "not created yet"}`)
        : el("p", {}, "db: disabled")) : null,
    el("p", { class: "hint" }, `last run: ${fmtRel(job.lastRun)}` + (progress ? ` · ${esc(progress)}` : ` (${esc(statusText)})`)),
    el("div", { class: "toolbar" }, ...controls));
}

// Stop aborts the running process and writes the partial results it fetched so
// far to the DB and the output (the CLI polls a stop marker and exits 130).
async function stopRun(job) {
  try {
    const body = await api.post(`/api/configs/${job.id}/stop`);
    toast(`Stopping "${job.id}" — saving results so far…`, "warn");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

// Run now spawns the real CLI (POST /api/configs/:id/run), so it works even
// when the gateway is down; the dashboard's in-flight guard returns 409 for a
// config that is already running, which disables the button via the next refresh.
async function runNow(job) {
  try {
    const body = await api.post(`/api/configs/${job.id}/run`);
    toast(`Started a run for "${job.id}" (${body.runId})`, "good");
    refresh();
  } catch (error) {
    toast(error.message, error.status === 409 ? "warn" : "warn");
  }
}

async function removeJob(job) {
  if (!confirm(`Remove cron job "${job.id}"? This does not delete its config file.`)) return;
  await mutate("remove", job.id);
}

function addCronCard() {
  const name = el("input", { class: "input", placeholder: "e.g. Finance Intern" });
  const schedule = el("input", { class: "input", list: "sched-examples", placeholder: "e.g. every 6 hours" });
  const queries = el("input", { class: "input", placeholder: "comma-separated queries (blank = base queries)" });
  const portalChecks = (state.bootstrap?.adapters ?? []).map((a) =>
    el("label", {}, el("input", { type: "checkbox", value: a.id }), ` ${esc(a.name)}`));
  const shared = el("input", { type: "radio", name: "storage", value: "shared", checked: true });
  const separate = el("input", { type: "radio", name: "storage", value: "separate" });
  const form = el("form", { class: "form-grid" },
    el("div", { class: "form-row" },
      el("div", { class: "field" }, el("label", {}, "Name (unique)"), name, el("div", { class: "hint" }, "Becomes the cron id and, for separate storage, the DB filename.")),
      el("div", { class: "field" }, el("label", {}, "Schedule"), schedule,
        el("datalist", { id: "sched-examples" }, ...SCHEDULE_EXAMPLES.map((s) => el("option", { value: s })))),
    ),
    el("div", { class: "field" }, el("label", {}, "Queries"), queries),
    el("div", { class: "field" }, el("label", {}, "Adapters"),
      el("div", { class: "toolbar" }, ...portalChecks)),
    el("div", { class: "field" },
      el("label", {}, "Where do results go?"),
      el("div", {},
        el("label", {}, shared, " shared jobs.db (same as normal runs) "),
        el("label", {}, separate, " separate <name>.db"),
      )),
    el("button", { class: "btn btn-primary", type: "submit" }, "Add cron job"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const portals = [...form.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
    try {
      const body = await api.post("/api/cron/add", {
        name: name.value.trim(),
        schedule: schedule.value.trim(),
        queries: queries.value.split(",").map((s) => s.trim()).filter(Boolean),
        enabledPortals: portals,
        storage: form.querySelector("input[name=storage]:checked").value,
      });
      toast(body.output?.trim().split("\n")[0] ?? "Added", "good");
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  });
  return el("div", { class: "card" },
    el("p", { class: "eyebrow" }, "Add cron"),
    el("h3", {}, "New scheduled run"),
    form);
}

export async function render() {
  if (!state.data) await refresh();
  loadLog();
  const root = document.createElement("div");
  root.id = "cron-root";
  if (state.data) {
    const d = state.data;
    const jobChildren = [];
    if (d.error) jobChildren.push(el("div", { class: "callout warn" }, el("p", {}, esc(d.error))));
    jobChildren.push(...d.jobs.map((j) => jobCard(j, d.gateway.running)));
    root.append(
      el("div", { id: "cron-gateway" }, gatewayHeader(), gatewayLog()),
      el("div", { id: "cron-jobs" }, ...jobChildren),
      el("div", { id: "cron-add" }, addCronCard()));
  } else {
    root.append(el("div", { class: "empty" }, "Loading…"));
  }
  return root;
}
