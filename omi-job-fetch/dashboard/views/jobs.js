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
  facets: {},        // fieldKey -> string[] selected values
  min: {},           // fieldKey -> number|string (range/number/date min)
  max: {},           // fieldKey -> number|string (range/number/date max)
  contract: [],      // fields[] from the API
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
      ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&limit=500`)
      : null;
    if (state.list?.fields) state.contract = state.list.fields;
    loadFacets();
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
  if (detail.analysis && detail.analysis.schemaVersion) {
    const chips = [];
    for (const [k, v] of Object.entries(detail.analysis)) {
      if (k === "schemaVersion" || k === "unmatched") continue;
      const text = Array.isArray(v) ? v.join(", ") : (v && typeof v === "object" ? JSON.stringify(v) : String(v));
      chips.push(el("span", { class: "chip" }, `${esc(k)}: ${esc(text)}`));
    }
    rows.push(el("dt", {}, "Extraction"), el("dd", {}, ...chips));
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
  const rows = (list.rows ?? []).filter(matchesFacets);
  if (list.total === 0) return el("div", { class: "empty" }, "No jobs match the current filter.");
  if (rows.length === 0) return el("div", { class: "empty" }, "No jobs match the current facet filters.");
  const head = el("tr", {},
    ...(["posted_at", "title", "company", "location", "status"].map((key) =>
      el("th", { onclick: () => { if (state.sort === key) state.dir = state.dir === "desc" ? "asc" : "desc"; else { state.sort = key; state.dir = "desc"; } refresh(); } },
        `${key}${state.sort === key ? (state.dir === "desc" ? " ↓" : " ↑") : ""}`))),
  );
  const body = rows.map((row) =>
    el("tr", { class: "row-click", onclick: () => openDetail(row.signature) },
      el("td", { class: "t-time" }, fmtRel(row.postedAt)),
      el("td", {}, el("span", { class: "t-title" }, esc(row.job.title || row.signature.slice(0, 8)))),
      el("td", {}, esc(row.job.company ?? "")),
      el("td", {}, esc(row.job.location ?? "")),
      el("td", {}, chip(row.status))));
  return el("div", { class: "table-wrap" },
    el("table", { class: "table" },
      el("thead", {}, head),
      el("tbody", {}, ...body)));
}

function deleteSourceModal() {
  const info = state.info;
  if (!info) return;
  const key = info.key;
  const confirmInput = el("input", { class: "input", placeholder: `Type "${key}"` });
  const deleteBtn = el("button", { class: "btn btn-danger", disabled: true }, "Delete database");
  confirmInput.addEventListener("input", () => { deleteBtn.disabled = confirmInput.value.trim() !== key; });
  deleteBtn.addEventListener("click", async () => {
    try {
      await api.del(`/api/dbs/${encodeURIComponent(key)}`, { confirm: confirmInput.value.trim() });
      backdrop.remove();
      toast(`Deleted ${esc(key)}`, "good");
      if (state.key === key) state.key = null;
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  });
  const modal = el("div", { class: "modal" },
    el("h3", {}, `Delete ${esc(key)}?`),
    el("p", { class: "hint" }, `This permanently deletes ${esc(info.path)} and cannot be undone.`),
    el("div", { class: "field" }, el("label", {}, `Type "${key}" to confirm`), confirmInput),
    el("div", { class: "modal-actions" },
      deleteBtn,
      el("button", { class: "btn btn-ghost", onclick: () => backdrop.remove() }, "Cancel")));
  const backdrop = openModal(modal);
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
  const deleteBtn = el("button", { class: "btn small btn-danger", disabled: !state.info?.exists, onclick: deleteSourceModal }, "Delete DB");
  const statusFilter = el("select", {
    class: "select",
    onchange: (e) => { state.status = e.target.value; refresh(); },
  },
    el("option", { value: "" }, "any status"),
    ...STATUSES.map((s) => el("option", { value: s }, s)));
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
    el("div", { class: "toolbar" }, source, statusFilter, search, deleteBtn),
    el("div", { id: "jobs-facets" }, renderFacets()),
    el("div", { id: "jobs-body" }, renderTicker(), renderTable()));
}

function facetsKey() { return `omijobs-facets:${state.key}`; }
function saveFacets() { try { localStorage.setItem(facetsKey(), JSON.stringify({ facets: state.facets, min: state.min, max: state.max })); } catch {} }
function loadFacets() {
  const valid = new Set(state.contract.map((f) => f.key));
  try {
    const saved = JSON.parse(localStorage.getItem(facetsKey()) ?? "{}");
    state.facets = {}; state.min = {}; state.max = {};
    for (const [k, v] of Object.entries(saved.facets ?? {})) if (valid.has(k) && Array.isArray(v)) state.facets[k] = v;
    for (const [k, v] of Object.entries(saved.min ?? {})) if (valid.has(k)) state.min[k] = v;
    for (const [k, v] of Object.entries(saved.max ?? {})) if (valid.has(k)) state.max[k] = v;
  } catch { state.facets = {}; state.min = {}; state.max = {}; }
}

function applyFilter() {
  const body = document.getElementById("jobs-body");
  if (body) body.replaceChildren(renderTicker(), renderTable());
}

function selectedFor(field) { return state.facets[field.key] ?? []; }

function toggleFacet(field, value) {
  const cur = new Set(state.facets[field.key] ?? []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  state.facets[field.key] = [...cur];
  saveFacets();
  applyFilter();
}

function renderFacets() {
  const rows = state.list?.rows ?? [];
  const bars = state.contract.map((field) => {
    if (field.kind === "enum") return enumFacet(field, rows);
    if (field.kind === "list") return listFacet(field, rows);
    if (field.kind === "range" || field.kind === "number") return numericFacet(field, rows);
    if (field.kind === "date") return dateFacet(field, rows);
    return null;
  }).filter(Boolean);
  return bars.length ? el("div", { class: "facets" }, ...bars) : null;
}

function enumFacet(field, rows) {
  const options = [...(field.values ?? [])];
  const hasOther = rows.some((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes("other") : v === "other"; });
  if (hasOther) options.push("other");
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    ...options.map((value) => {
      const checked = selectedFor(field).includes(value);
      const count = rows.filter((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes(value) : v === value; }).length;
      return el("label", { class: "facet-option" },
        el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
        ` ${esc(value)} (${count})`);
    }));
}

function listFacet(field, rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = r.analysis?.[field.key];
    const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
    for (const t of tags) if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    ...options.map(([value, count]) => {
      const checked = selectedFor(field).includes(value);
      return el("label", { class: "facet-option" },
        el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
        ` ${esc(value)} (${count})`);
    }));
}

function numericFacet(field, rows) {
  const min = el("input", { class: "input", type: "number", placeholder: "min", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  const max = el("input", { class: "input", type: "number", placeholder: "max", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  return el("div", { class: "facet" }, el("div", { class: "eyebrow" }, field.key), el("div", { class: "facet-range" }, min, el("span", {}, "–"), max));
}

function dateFacet(field, rows) {
  const before = el("input", { class: "input", type: "date", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  const after = el("input", { class: "input", type: "date", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  return el("div", { class: "facet" }, el("div", { class: "eyebrow" }, field.key), el("div", { class: "facet-range" }, el("span", {}, "after"), before, el("span", {}, "before"), after));
}

function matchesFacets(row) {
  const a = row.analysis ?? {};
  for (const field of state.contract) {
    const selected = state.facets[field.key];
    if (selected && selected.length) {
      const v = a[field.key];
      const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
      if (!selected.some((s) => tags.includes(s))) return false;
    }
    if (field.kind === "number") {
      const n = a[field.key];
      const lo = state.min[field.key]; const hi = state.max[field.key];
      if (n != null && typeof n === "number") { if (lo != null && n < lo) return false; if (hi != null && n > hi) return false; }
    } else if (field.kind === "range") {
      const range = a[field.key];
      const lo = state.min[field.key]; const hi = state.max[field.key];
      if (range && typeof range === "object" && !Array.isArray(range)) { if (lo != null && range.max != null && range.max < lo) return false; if (hi != null && range.min != null && range.min > hi) return false; }
    }
    if (field.kind === "date") {
      const d = a[field.key];
      if (typeof d === "string") {
        const lo = state.min[field.key]; const hi = state.max[field.key];
        if (lo && d < lo) return false;
        if (hi && d > hi) return false;
      }
    }
  }
  return true;
}

export async function render() {
  await refreshSources();
  return el("div", {},
    el("p", { class: "eyebrow" }, "Jobs"),
    el("h2", { class: "docs" }, "Saved jobs"),
    renderBody());
}
