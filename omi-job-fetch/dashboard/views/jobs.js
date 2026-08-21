import { api, ApiError } from "../api.js";
import { el, esc, toast, openModal, fmtTime, fmtRel } from "../app.js";

const STATUSES = ["unapplied", "applied", "uninterested"];
const state = {
  sources: [],
  key: null,
  status: "",
  q: "",
  sort: "posted_at",
  dir: "desc",
  recommended: false,
  list: null,
  info: null,
  timer: null,
  searchTimer: null,
};

async function refreshSources() {
  state.sources = await api.get("/api/dbs");
  if (!state.key && state.sources.length) state.key = state.sources[0].key;
  if (state.key && !state.sources.some((s) => s.key === state.key)) state.key = state.sources[0]?.key ?? null;
}
async function refresh() {
  try {
    await refreshSources();
    state.info = state.sources.find((s) => s.key === state.key) ?? null;
    state.list = state.key
      ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&recommended=${state.recommended ? "1" : "0"}&limit=500`)
      : null;
    const err = document.getElementById("jobs-error");
    if (err) err.replaceChildren(...(state.info?.error ? [errorCallout(state.info.error)] : []));
    const body = document.getElementById("jobs-body");
    if (body) body.replaceChildren(renderTicker(), renderTable());
  } catch (error) {
    toast(error.message, "warn");
  }
}

function errorCallout(message) {
  return el("div", { class: "callout warn" },
    el("p", {}, `Could not read this DB: ${esc(message)}. If the cron gateway is writing to it right now, wait a moment and refresh.`));
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

function chip(status) {
  return el("span", { class: `chip ${esc(status)}` }, status);
}

async function openDetail(sig) {
  const detail = await api.get(`/api/jobs/${state.key}/${encodeURIComponent(sig)}`);
  const job = detail.job ?? {};
  const rows = [];
  const push = (label, value) => { if (value != null && value !== "") rows.push(el("dt", {}, label), el("dd", {}, value)); };
  push("Title", job.title);
  push("Company", job.company);
  push("Location", job.location);
  push("Posted", fmtTime(detail.postedAt));
  push("Source", job.source);
  push("Apply URL", job.apply_url ? el("a", { href: job.apply_url, target: "_blank", rel: "noopener" }, job.apply_url) : null);
  if (detail.analysis) {
    const verdict = detail.analysis.score !== undefined && detail.analysis.reason ? `${detail.analysis.score}/10 — ${detail.analysis.reason}` : JSON.stringify(detail.analysis, null, 2);
    rows.push(el("dt", {}, "Analysis"), el("dd", {}, verdict));
  }
  if (job.description) rows.push(el("dt", {}, "Description"), el("dd", {}, job.description));
  const modal = el("div", { class: "modal" },
    el("h3", {}, esc(job.title || sig)),
    el("p", { class: "hint" }, esc(job.company || "") + (job.location ? ` · ${esc(job.location)}` : "")),
    el("dl", { class: "dl" }, ...rows),
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-primary", onclick: () => setStatus(sig, "applied", modal) }, "Apply"),
      el("button", { class: "btn btn-ghost", onclick: () => setStatus(sig, "uninterested", modal) }, "Not interested"),
      el("button", { class: "btn btn-ghost", onclick: () => close(modal) }, "Close"),
    ),
  );
  openModal(modal);
  function close(node) { node.closest(".modal-backdrop")?.remove(); }
}

async function setStatus(sig, status, modal) {
  try {
    await api.patch("/api/jobs", { dbKey: state.key, signature: sig, status });
    modal.closest(".modal-backdrop")?.remove();
    toast(`Marked ${esc(status)}`, "good");
    refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function renderTicker() {
  const info = state.info;
  const by = info?.byStatus ?? {};
  const cards = [
    ["total", info?.total ?? 0],
    ["unapplied", by.unapplied ?? 0],
    ["applied", by.applied ?? 0],
    ["uninterested", by.uninterested ?? 0],
  ];
  return el("div", { class: "ticker" }, ...cards.map(([label, n]) =>
    el("div", { class: "stat" }, el("b", {}, String(n)), el("span", {}, label))));
}

function renderTable() {
  const list = state.list;
  if (!list) return el("div", { class: "empty" }, "No source selected.");
  if (list.total === 0) return el("div", { class: "empty" }, "No jobs match the current filter.");
  const head = el("tr", {},
    ...(["posted_at", "title", "company", "location", "score", "status"].map((key) =>
      el("th", { onclick: () => { if (state.sort === key) state.dir = state.dir === "desc" ? "asc" : "desc"; else { state.sort = key; state.dir = "desc"; } refresh(); } },
        `${key}${state.sort === key ? (state.dir === "desc" ? " ↓" : " ↑") : ""}`))),
  );
  const body = list.rows.map((row) =>
    el("tr", { class: "row-click", onclick: () => openDetail(row.signature) },
      el("td", { class: "t-time" }, fmtRel(row.postedAt)),
      el("td", {}, el("span", { class: "t-title" }, esc(row.job.title || row.signature.slice(0, 8)))),
      el("td", {}, esc(row.job.company ?? "")),
      el("td", {}, esc(row.job.location ?? "")),
      el("td", {}, row.score === null ? "—" : String(row.score)),
      el("td", {}, chip(row.status))));
  return el("div", { class: "table-wrap" },
    el("table", { class: "table" },
      el("thead", {}, head),
      el("tbody", {}, ...body)));
}

function renderBody() {
  const srcOpts = state.sources.map((s) => {
    const name = s.key === "base" ? "default (jobs.db)" : s.key;
    return el("option", { value: s.key }, `${name}`);
  });
  const source = el("div", {},
    el("label", { class: "eyebrow" }, "Source"),
    el("select", {
      class: "select",
      onchange: (e) => { state.key = e.target.value; state.info = state.sources.find((s) => s.key === state.key); refresh(); },
    }, srcOpts));
  const statusFilter = el("select", {
    class: "select",
    onchange: (e) => { state.status = e.target.value; refresh(); },
  },
    el("option", { value: "" }, "any status"),
    ...STATUSES.map((s) => el("option", { value: s }, s)));
  const recommended = el("label", {}, el("input", { type: "checkbox", checked: state.recommended, onchange: (e) => { state.recommended = e.target.checked; refresh(); } }), " AI recommended");
  const search = el("input", {
    class: "input",
    placeholder: "search title / company / location…",
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value.trim();
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(refresh, 300);
    },
  });
  return el("div", { id: "jobs-root" },
    el("div", { id: "jobs-error" }),
    el("div", { class: "toolbar" }, source, statusFilter, recommended, search),
    el("div", { id: "jobs-body" }, renderTicker(), renderTable()));
}

export async function render() {
  await refreshSources();
  return el("div", {},
    el("p", { class: "eyebrow" }, "Jobs"),
    el("h2", { class: "docs" }, "Saved jobs"),
    renderBody());
}
