import { api, ApiError } from "../api.js";
import { el, esc, toast, openModal, fmtTime, fmtRel, selectMenu } from "../app.js";

const STATUSES = ["unapplied", "applied", "uninterested"];
const STATUS_LABELS = { unapplied: "Not applied", applied: "Applied", uninterested: "Not interested" };
// Extracted fields surfaced inline as chips, in visual priority order.
const CHIP_FIELDS = ["domain", "industry", "employment_type", "salary", "seniority", "mandatory_languages", "preferred_languages", "job_duration", "work_arrangement", "licenses"];
// Allowed page sizes — the UI offers exactly these.
const PAGE_SIZES = [15, 30, 45];
const state = {
  sources: [],
  key: null,
  status: "",
  q: "",
  sort: "posted_at",
  dir: "desc",
  facets: {},        // fieldKey -> string[] selected values
  exact: {},         // fieldKey -> boolean (exact-set match for list fields)
  min: {},           // fieldKey -> number|string (range/number/date min)
  max: {},           // fieldKey -> number|string (range/number/date max)
  contract: [],      // fields[] from the API
  list: null,
  info: null,
  timer: null,
  searchTimer: null,
  view: localStorage.getItem("omijobs-view") || "table", // "table" | "cards"
  page: 1,
  pageSize: (() => { const n = Number(localStorage.getItem("omijobs-page-size")); return PAGE_SIZES.includes(n) ? n : 30; })(),
};
const expandedCards = new Set(); // card-view signatures with the chip list expanded
const openDescs = new Set();      // card-view signatures with the description expanded (survives refreshes)
let refreshSeq = 0;               // monotonically increasing — superseded refreshes drop their result

async function refreshSources() {
  state.sources = await api.get("/api/dbs");
  if (!state.key && state.sources.length) state.key = state.sources[0].key;
  if (state.key && !state.sources.some((s) => s.key === state.key)) state.key = state.sources[0]?.key ?? null;
}
// The toolbar (with the Delete DB button) is built once per view mount by
// renderBody(); refresh() only re-renders the job list. Sync the button's
// enabled state here so it follows the DB file's existence without a remount.
function syncToolbar() {
  const del = document.getElementById("delete-db-btn");
  if (del) del.disabled = !state.info?.exists;
}
// Cheap fingerprint of the fetched list so the 5s poll / live events skip
// re-rendering when nothing changed — keeps open dropdowns, expanded
// descriptions, and scroll position intact.
function listFingerprint(list) {
  const rows = list?.rows ?? [];
  let fp = `${list?.total ?? 0}:${rows.length}`;
  for (const r of rows) {
    fp += `\n${r.signature}|${r.status}|${r.postedAt}|${r.job?.description?.length ?? 0}|${r.job?.title ?? ""}|${r.job?.company ?? ""}|${r.job?.location ?? ""}|${r.job?.apply_url ?? ""}|${r.analysis ? JSON.stringify(r.analysis) : ""}`;
  }
  return fp;
}

async function refresh({ force = false, resetPage = false } = {}) {
  const seq = ++refreshSeq;
  try {
    await refreshSources();
    state.info = state.sources.find((s) => s.key === state.key) ?? null;
    syncToolbar();
    const next = state.key
      ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&limit=500`)
      : null;
    if (seq !== refreshSeq) return; // superseded by a newer refresh — drop stale data
    if (next?.fields) state.contract = next.fields;
    loadFacets();
    const keyChanged = state.key !== facetKey;
    if (keyChanged) { expandedCards.clear(); openDescs.clear(); }
    if (keyChanged || resetPage) state.page = 1;
    loadCollapsed();
    loadFiltersOpen();
    const changed = force || !state.list || listFingerprint(state.list) !== listFingerprint(next);
    state.list = next;
    clampPage(filteredRows().length);
    const facetsNode = document.getElementById("jobs-facets");
    if (facetsNode && (keyChanged || facetsNode.childElementCount === 0)) {
      facetsNode.replaceChildren(renderFacets() ?? []);
      facetKey = state.key;
    }
    const err = document.getElementById("jobs-error");
    if (err) err.replaceChildren(...(state.info?.error ? [errorCallout(state.info.error)] : []));
    if (changed) {
      const body = document.getElementById("jobs-body");
      if (body) body.replaceChildren(renderTicker(), renderBodyList());
    }
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
  state.timer = setInterval(() => refresh(), 5000);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
  clearTimeout(state.searchTimer);
}

function chip(status) {
  return el("span", { class: `chip ${esc(status)}` }, status);
}

async function openDetail(sig) {
  const detail = await api.get(`/api/jobs/${state.key}/${encodeURIComponent(sig)}`);
  const job = detail.job ?? {};
  const rows = [];
  const push = (label, value) => { if (value != null && value !== "") rows.push(el("dt", {}, label), el("dd", {}, value)); };
  push("Company", job.company);
  push("Location", job.location);
  push("Posted", fmtTime(detail.postedAt));
  push("Source", job.source);
  if (job.apply_url) push("Apply URL", el("a", { href: job.apply_url, target: "_blank", rel: "noopener" }, job.apply_url));
  if (detail.analysis && detail.analysis.schemaVersion) {
    const chips = [];
    for (const [k, v] of Object.entries(detail.analysis)) {
      if (k === "schemaVersion" || k === "unmatched") continue;
      const text = Array.isArray(v) ? v.join(", ") : (v && typeof v === "object" ? JSON.stringify(v) : String(v));
      chips.push(el("span", { class: "chip" }, `${esc(k)}: ${esc(text)}`));
    }
    rows.push(el("dt", {}, "Extraction"), el("dd", {}, ...chips));
  }
  const actions = [];
  if (job.apply_url) actions.push(el("a", { class: "btn btn-primary", href: job.apply_url, target: "_blank", rel: "noopener" }, "Open application ↗"));
  actions.push(
    el("button", { class: "btn", onclick: () => setStatusAndClose(sig, "applied") }, "Mark applied"),
    el("button", { class: "btn btn-ghost", onclick: () => setStatusAndClose(sig, "uninterested") }, "Not interested"),
    el("button", { class: "btn btn-ghost", onclick: () => close(modal) }, "Close"));
  const modal = el("div", { class: "modal" },
    el("div", { class: "modal-hero" },
      el("h3", {}, esc(job.title || sig)),
      el("p", { class: "hint" }, [job.company, job.location, fmtTime(detail.postedAt)].filter(Boolean).join(" · "))),
    el("dl", { class: "dl" }, ...rows),
    job.description ? el("div", { class: "modal-section" },
      el("div", { class: "modal-label" }, "Description"),
      el("div", { class: "modal-desc" }, job.description)) : null,
    el("div", { class: "modal-actions" }, ...actions));
  openModal(modal);
  function close(node) { node.closest(".modal-backdrop")?.remove(); }
  async function setStatusAndClose(sig, status) {
    await setStatus(sig, status);
    close(modal);
  }
}

async function setStatus(sig, status) {
  try {
    await api.patch("/api/jobs", { dbKey: state.key, signature: sig, status });
    toast(`Marked ${STATUS_LABELS[status] ?? status}`, "good");
    refresh({ force: true });
  } catch (error) {
    toast(error.message, "warn");
  }
}

function renderTicker() {
  const info = state.info;
  const by = info?.byStatus ?? {};
  const cards = [
    ["total", info?.total ?? 0, "", "All jobs"],
    ["unapplied", by.unapplied ?? 0, "unapplied", "Jobs you haven't acted on yet"],
    ["applied", by.applied ?? 0, "applied", "Jobs you marked applied"],
    ["uninterested", by.uninterested ?? 0, "uninterested", "Jobs you marked not interested"],
  ];
  return el("div", { class: "ticker" }, ...cards.map(([label, n, filter, title]) =>
    el("div", { class: `stat clickable ${filter}`, "data": { filter }, title, onclick: () => setStatusFilter(filter) },
      el("b", {}, String(n)), el("span", {}, label))));
}

function setStatusFilter(filter) {
  state.status = filter;
  const sel = document.getElementById("jobs-status-filter");
  if (sel) sel.setValue?.(filter);
  refresh({ force: true, resetPage: true }); // status is applied server-side by the jobs endpoint
}

function renderTable() {
  const list = state.list;
  if (!list) return el("div", { class: "empty" }, "No source selected.");
  const rows = filteredRows();
  if (list.total === 0) return el("div", { class: "empty" }, "No jobs match the current filter.");
  if (rows.length === 0) return el("div", { class: "empty" }, "No jobs match the current facet filters.");
  const head = el("tr", {},
    ...(["posted_at", "title", "company", "location", "status"].map((key) =>
      el("th", { onclick: () => { if (state.sort === key) state.dir = state.dir === "desc" ? "asc" : "desc"; else { state.sort = key; state.dir = "desc"; } refresh({ force: true, resetPage: true }); } },
        `${key}${state.sort === key ? (state.dir === "desc" ? " ↓" : " ↑") : ""}`))),
  );
  return el("div", {},
    el("div", { class: "table-wrap" },
      el("table", { class: "table" },
        el("thead", {}, head),
        el("tbody", {}, ...pageRows(rows).map((row) => el("tr", { class: "row-click", onclick: () => openDetail(row.signature) },
          el("td", { class: "t-time" }, fmtRel(row.postedAt)),
          el("td", {}, el("span", { class: "t-title" }, esc(row.job.title || row.signature.slice(0, 8)))),
          el("td", {}, esc(row.job.company ?? "")),
          el("td", {}, esc(row.job.location ?? "")),
          el("td", {}, statusSelect(row.signature, row.status))))))),
    renderPagination(rows.length));
}

function statusSelect(sig, status) {
  const dd = selectMenu({
    class: `status-select ${esc(status)}`,
    title: "Set job status",
    value: status,
    options: STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    onSelect: async (next) => {
      dd.btn.disabled = true;
      try {
        await api.patch("/api/jobs", { dbKey: state.key, signature: sig, status: next });
        toast(`Marked ${STATUS_LABELS[next] ?? next}`, "good");
        refresh({ force: true });
      } catch (error) {
        toast(error.message, "warn");
        refresh({ force: true });
      }
    },
  });
  return dd;
}

function formatChip(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") {
    if (v.min != null || v.max != null) {
      const lo = v.min != null ? fmtNum(v.min) : "?";
      const hi = v.max != null ? fmtNum(v.max) : "?";
      return `${lo}–${hi}`;
    }
    return JSON.stringify(v);
  }
  return String(v);
}
function fmtNum(n) { return typeof n === "number" && n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }
function trunc(text, n) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
// Extracted fields present on this row, sorted by visual priority.
function cardChips(row) {
  const a = row.analysis ?? {};
  const fields = state.contract.map((f) => f.key);
  const rank = (k) => { const i = CHIP_FIELDS.indexOf(k); return i === -1 ? CHIP_FIELDS.length : i; };
  const chips = [];
  for (const key of fields) {
    const v = a[key];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    chips.push([key, formatChip(v)]);
  }
  chips.sort((x, y) => rank(x[0]) - rank(y[0]));
  return chips;
}
const CARD_CHIP_LIMIT = 4;

function renderCards() {
  const list = state.list;
  if (!list) return el("div", { class: "empty" }, "No source selected.");
  const rows = filteredRows();
  if (list.total === 0) return el("div", { class: "empty" }, "No jobs match the current filter.");
  if (rows.length === 0) return el("div", { class: "empty" }, "No jobs match the current facet filters.");
  return el("div", {},
    el("div", { class: "job-cards" }, ...pageRows(rows).map(jobCard)),
    renderPagination(rows.length));
}

function jobCard(row) {
  const job = row.job ?? {};
  const all = cardChips(row);
  const expanded = expandedCards.has(row.signature);
  const descOpen = openDescs.has(row.signature);
  const chips = (expanded ? all : all.slice(0, CARD_CHIP_LIMIT)).map(([k, v]) => el("span", { class: "mini-chip" }, `${esc(k)}: ${esc(trunc(v, 40))}`));
  if (all.length > CARD_CHIP_LIMIT) {
    chips.push(el("button", { class: "chip more", onclick: (e) => {
      e.stopPropagation();
      expanded ? expandedCards.delete(row.signature) : expandedCards.add(row.signature);
      applyFilter();
    } }, expanded ? "less" : `+${all.length - CARD_CHIP_LIMIT} more`));
  }
  const actions = [];
  if (job.apply_url) actions.push(el("a", { class: "btn btn-primary", href: job.apply_url, target: "_blank", rel: "noopener" }, "Apply ↗"));
  actions.push(el("button", { class: "btn", onclick: () => openDetail(row.signature) }, "Details"));
  if (row.status !== "uninterested") actions.push(el("button", { class: "btn btn-ghost", onclick: () => setStatus(row.signature, "uninterested") }, "Not interested"));
  return el("div", { class: "job-card" },
    el("div", { class: "job-card-head" },
      el("h3", { class: "job-card-title", title: "Open details", onclick: () => openDetail(row.signature) }, esc(job.title || row.signature.slice(0, 8))),
      statusSelect(row.signature, row.status)),
    el("div", { class: "job-card-meta" },
      el("span", { class: "job-card-company" }, esc(job.company ?? "—")),
      job.location ? el("span", {}, `· ${esc(job.location)}`) : null,
      el("span", { class: "t-time" }, `· ${fmtRel(row.postedAt)}`)),
    chips.length ? el("div", { class: "job-card-chips" }, ...chips) : null,
    job.description ? el("div", { class: "card-desc-wrap" },
      el("p", { class: `card-desc${descOpen ? " open" : ""}` }, esc(job.description)),
      el("button", { class: "desc-toggle", onclick: (e) => {
        const p = e.currentTarget.previousElementSibling;
        const open = p.classList.toggle("open");
        open ? openDescs.add(row.signature) : openDescs.delete(row.signature);
        e.currentTarget.textContent = open ? "Read less" : "Read more";
      } }, descOpen ? "Read less" : "Read more")) : null,
    el("div", { class: "job-card-actions" }, ...actions));
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
      refresh({ force: true });
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
  const srcOpts = state.sources.map((s) => ({ value: s.key, label: s.key === "base" ? "default (jobs.db)" : s.key }));
  const source = el("label", { class: "compound", title: "Which database to browse" },
    el("span", { class: "compound-label" }, "source"),
    selectMenu({
      value: state.key,
      options: srcOpts,
      onSelect: (v) => { state.key = v; state.info = state.sources.find((s) => s.key === state.key); refresh({ force: true, resetPage: true }); },
    }));
  const deleteBtn = el("button", { id: "delete-db-btn", class: "btn small btn-danger", disabled: !state.info?.exists, onclick: deleteSourceModal }, "Delete DB");
  const statusFilter = el("label", { class: "compound", title: "Filter by status" },
    el("span", { class: "compound-label" }, "status"),
    selectMenu({
      id: "jobs-status-filter",
      value: state.status,
      options: [{ value: "", label: "any status" }, ...STATUSES.map((s) => ({ value: s, label: s }))],
      onSelect: (v) => { state.status = v; refresh({ force: true, resetPage: true }); },
    }));
  const search = el("input", {
    class: "input toolbar-search",
    placeholder: "search title / company / location…",
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value.trim();
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => refresh({ force: true, resetPage: true }), 300);
    },
  });
  return el("div", { id: "jobs-root" },
    el("div", { id: "jobs-error" }),
    el("div", { class: "toolbar" }, source, statusFilter, search, el("div", { class: "spacer" }), viewToggle(), deleteBtn),
    el("div", { id: "jobs-facets" }),
    el("div", { id: "jobs-body" }, renderTicker(), renderBodyList()));
}

function facetsKey() { return `omijobs-facets:${state.key}`; }
function saveFacets() { try { localStorage.setItem(facetsKey(), JSON.stringify({ facets: state.facets, exact: state.exact, min: state.min, max: state.max })); } catch {} }
function loadFacets() {
  const valid = new Set(state.contract.map((f) => f.key));
  try {
    const saved = JSON.parse(localStorage.getItem(facetsKey()) ?? "{}");
    state.facets = {}; state.exact = {}; state.min = {}; state.max = {};
    for (const [k, v] of Object.entries(saved.facets ?? {})) if (valid.has(k) && Array.isArray(v)) state.facets[k] = v;
    for (const [k, v] of Object.entries(saved.exact ?? {})) if (valid.has(k)) state.exact[k] = Boolean(v);
    for (const [k, v] of Object.entries(saved.min ?? {})) if (valid.has(k)) state.min[k] = v;
    for (const [k, v] of Object.entries(saved.max ?? {})) if (valid.has(k)) state.max[k] = v;
  } catch { state.facets = {}; state.exact = {}; state.min = {}; state.max = {}; }
}

function applyFilter() {
  clampPage(filteredRows().length);
  renderList();
  updateFiltersBar();
}

function renderBodyList() {
  return state.view === "cards" ? renderCards() : renderTable();
}

// Rows that pass the current facet filters — pagination applies AFTER facets,
// so every page is a consistent slice of the filtered set.
function filteredRows() {
  return (state.list?.rows ?? []).filter(matchesFacets);
}
function totalPages(total) { return Math.max(1, Math.ceil(total / state.pageSize)); }
function clampPage(total) { const pages = totalPages(total); if (state.page > pages) state.page = pages; }
function pageRows(rows) {
  const start = (state.page - 1) * state.pageSize;
  return rows.slice(start, start + state.pageSize);
}

function renderPagination(total) {
  if (total <= state.pageSize) return null; // single page — no bar needed
  const pages = totalPages(total);
  const start = (state.page - 1) * state.pageSize + 1;
  const end = Math.min(total, state.page * state.pageSize);
  return el("div", { class: "pagination" },
    el("span", { class: "pagination-info" }, `Showing ${start}–${end} of ${total}`),
    el("div", { class: "pagination-nav" },
      el("button", { class: "btn small", disabled: state.page <= 1, onclick: () => gotoPage(state.page - 1) }, "‹ Prev"),
      el("span", { class: "pagination-page" }, `Page ${state.page} of ${pages}`),
      el("button", { class: "btn small", disabled: state.page >= pages, onclick: () => gotoPage(state.page + 1) }, "Next ›")),
    el("label", { class: "compound pagination-size", title: "Jobs per page" },
      el("span", { class: "compound-label" }, "per page"),
      selectMenu({
        value: String(state.pageSize),
        options: PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) })),
        onSelect: (v) => setPageSize(Number(v)),
      })));
}

function gotoPage(p) {
  const pages = totalPages(filteredRows().length);
  state.page = Math.max(1, Math.min(p, pages));
  renderList();
  const body = document.getElementById("jobs-body");
  if (body) body.scrollIntoView({ block: "start" });
}
function setPageSize(n) {
  const first = (state.page - 1) * state.pageSize; // keep the first visible row on screen
  state.pageSize = n;
  try { localStorage.setItem("omijobs-page-size", String(n)); } catch {}
  state.page = Math.floor(first / n) + 1;
  clampPage(filteredRows().length);
  renderList();
}
function renderList() {
  const body = document.getElementById("jobs-body");
  if (body) body.replaceChildren(renderTicker(), renderBodyList());
}

function viewToggle() {
  return el("div", { class: "seg", title: "Switch between compact rows and full cards" },
    el("button", { class: `seg-btn${state.view === "table" ? " on" : ""}`, "data": { view: "table" }, onclick: () => setView("table") }, "Table"),
    el("button", { class: `seg-btn${state.view === "cards" ? " on" : ""}`, "data": { view: "cards" }, onclick: () => setView("cards") }, "Cards"));
}

function setView(view) {
  state.view = view;
  localStorage.setItem("omijobs-view", view);
  applyFilter();
  // applyFilter() re-renders only the list; keep the toggle's active state in sync.
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
}

function selectedFor(field) { return state.facets[field.key] ?? []; }

function toggleFacet(field, value) {
  const cur = new Set(state.facets[field.key] ?? []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  state.facets[field.key] = [...cur];
  saveFacets();
  applyFilter();
  facetRefreshers.get(field.key)?.();
}

function renderFacets() {
  facetRefreshers.clear();
  const rows = state.list?.rows ?? [];
  const bars = state.contract.map((field) => {
    if (field.kind === "enum") return enumFacet(field, rows);
    if (field.kind === "list") return CHECKBOX_LIST_FIELDS.has(field.key) ? listCheckboxFacet(field, rows) : searchFacet(field, rows);
    if (field.kind === "range" || field.kind === "number") return numericFacet(field, rows);
    if (field.kind === "date") return dateFacet(field, rows);
    return null;
  }).filter(Boolean);
  if (!bars.length) return null;
  return el("div", {},
    filtersBar(),
    el("div", { class: `facets${filtersOpen ? "" : " closed"}`, id: "jobs-facets-grid" }, ...bars));
}

function filtersBar() {
  filtersBarNode = el("div", { class: "filters-bar" });
  updateFiltersBar();
  return filtersBarNode;
}
function updateFiltersBar() {
  if (!filtersBarNode) return;
  const active = activeFilterCount();
  const parts = [
    el("button", { class: "filters-toggle", title: "Show / hide filters", onclick: toggleFiltersPanel },
      el("span", { class: "chev" }, filtersOpen ? "▾" : "▸"),
      " Filters"),
  ];
  if (active > 0) {
    parts.push(
      el("span", { class: "filters-count" }, `${active} active filter${active === 1 ? "" : "s"}`),
      el("span", { class: "filters-spacer" }),
      el("button", { class: "btn small", onclick: clearAllFilters }, "Clear all"));
  }
  filtersBarNode.replaceChildren(...parts);
}
function toggleFiltersPanel() {
  filtersOpen = !filtersOpen;
  try { localStorage.setItem(`omijobs-filters-open:${state.key}`, filtersOpen ? "1" : "0"); } catch {}
  const grid = document.getElementById("jobs-facets-grid");
  if (grid) grid.classList.toggle("closed", !filtersOpen);
  updateFiltersBar();
}

function activeFilterCount() {
  let n = 0;
  for (const f of state.contract) {
    n += (state.facets[f.key] ?? []).length;
    if (state.min[f.key] != null) n++;
    if (state.max[f.key] != null) n++;
    if (state.exact[f.key]) n++;
  }
  return n;
}

function clearAllFilters() {
  state.facets = {}; state.exact = {}; state.min = {}; state.max = {};
  saveFacets();
  applyFilter();
  const facetsNode = document.getElementById("jobs-facets");
  if (facetsNode) facetsNode.replaceChildren(renderFacets() ?? []);
}

function collapsedKey() { return `omijobs-collapsed:${state.key}`; }
function saveCollapsed() { try { localStorage.setItem(collapsedKey(), JSON.stringify([...collapsedFacets])); } catch {} }
function loadCollapsed() {
  collapsedFacets.clear();
  try { for (const k of JSON.parse(localStorage.getItem(collapsedKey()) ?? "[]")) collapsedFacets.add(k); } catch {}
}
function facetHead(field) {
  return el("button", { class: "facet-head", title: "Collapse / expand", onclick: (e) => {
    const facet = e.currentTarget.closest(".facet");
    const closed = facet.classList.toggle("closed");
    closed ? collapsedFacets.add(field.key) : collapsedFacets.delete(field.key);
    saveCollapsed();
  } },
    el("span", { class: "facet-name" }, field.key),
    el("span", { class: "chev" }, "▾"));
}
function facetBox(field, ...children) {
  const wide = field.kind === "date" ? " facet-wide" : "";
  return el("div", { class: `facet${collapsedFacets.has(field.key) ? " closed" : ""}${wide}` }, facetHead(field), ...children);
}

function enumFacet(field, rows) {
  const options = [...(field.values ?? [])];
  const hasOther = rows.some((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes("other") : v === "other"; });
  if (hasOther) options.push("other");
  return facetBox(field,
    el("div", { class: "facet-body" },
      ...options.map((value) => {
        const checked = selectedFor(field).includes(value);
        const count = rows.filter((r) => { const v = r.analysis?.[field.key]; return Array.isArray(v) ? v.includes(value) : v === value; }).length;
        return el("label", { class: "facet-option" },
          el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
          ` ${esc(value)} (${count})`);
      }),
      el("div", { class: "facet-special" },
        unspecifiedToggle(field, rows))));
}

// List fields that stay checkbox-selectable instead of search-driven (low cardinality).
const CHECKBOX_LIST_FIELDS = new Set(["mandatory_languages", "preferred_languages"]);
// Sentinel selected in a facet when the job's JD never mentioned the field at
// all (e.g. no language requirement) — lets us surface those jobs for manual
// judgment instead of silently dropping them from every filtered view.
const UNSPECIFIED = "__unspecified__";
function fieldMissing(v) { return v == null || v === "" || (Array.isArray(v) && v.length === 0); }
function unspecifiedToggle(field, rows) {
  const count = rows.filter((r) => fieldMissing(r.analysis?.[field.key])).length;
  const checked = selectedFor(field).includes(UNSPECIFIED);
  return el("label", { class: "facet-option unspecified" },
    el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, UNSPECIFIED) }),
    ` unspecified${count ? ` (${count})` : ""}`);
}
const FACET_MATCH_LIMIT = 25;
// Curated concept -> related terms. Searching a concept keyword ("tech") also
// surfaces related values ("software engineering", "data center", "ai", …) so
// one search can select a whole family of related domains/industries.
const CONCEPTS = {
  tech: ["tech", "software", "engineering", "developer", "programming", "comput", "data", "cloud", "ai", "ml", "web", "mobile", "backend", "frontend", "devops", "security", "network", "infrastructure", "blockchain", "crypto", "digital", "internet", "saas", "platform", "application", "automation", "system", "it"],
  finance: ["finance", "financial", "fintech", "bank", "banking", "investment", "invest", "trading", "trade", "quant", "wealth", "asset", "capital", "market", "insurance", "equity", "securities", "payment", "crypto", "blockchain", "risk", "fund", "hedge"],
  ai: ["ai", "machine learning", "ml", "llm", "nlp", "deep learning", "computer vision", "genai", "generative", "intelligence", "agent", "data science", "robotics", "automation", "neural", "model"],
  data: ["data", "analytics", "analysis", "database", "sql", "bi", "insight", "mining", "warehouse", "etl", "pandas"],
  crypto: ["crypto", "blockchain", "web3", "digital asset", "stablecoin", "token", "defi", "bitcoin", "ethereum", "wallet"],
  quant: ["quant", "quantitative", "trading", "trade", "market", "derivative", "futures", "options", "portfolio", "alpha", "risk", "statistic", "mathematical", "modeling"],
  design: ["design", "ux", "ui", "creative", "visual", "graphic", "video", "media", "art", "illustration", "photo"],
  marketing: ["marketing", "seo", "brand", "social media", "content", "campaign", "growth", "market research"],
};
// Values from old runs were stored HTML-escaped ("r&amp;d") — decode for display.
function decodeEntities(value) {
  return String(value).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/g, "'");
}
function searchTerms(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const terms = new Set(tokens);
  for (const t of tokens) for (const c of CONCEPTS[t] ?? []) terms.add(c);
  return [...terms];
}
function valueMatches(value, terms) {
  const v = value.toLowerCase();
  const tokens = v.split(/[^a-z0-9]+/).filter(Boolean);
  return terms.some((t) => (/[^a-z0-9]/.test(t) || t.length >= 4) ? v.includes(t) : tokens.includes(t));
}
const facetRefreshers = new Map();
// DB key the facets were last rendered for — re-render only when it changes
// (or the container is empty, e.g. first mount) so facet search text isn't
// wiped by the 5s auto-refresh.
let facetKey = null;
// Facet headers the user collapsed — persisted per source so a source switch
// (which re-renders the facet list) doesn't blow them back open.
const collapsedFacets = new Set();
// Whole-panel Filters toggle — persisted per source. Defaults to COLLAPSED;
// only opens if the user explicitly opened it for that source.
let filtersOpen = false;
let filtersBarNode = null;
function loadFiltersOpen() {
  try { filtersOpen = localStorage.getItem(`omijobs-filters-open:${state.key}`) === "1"; } catch {}
}

function searchFacet(field, rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = r.analysis?.[field.key];
    const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
    for (const t of tags) if (typeof t === "string" && !/^\[object /i.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const input = el("input", { class: "input facet-search", type: "search", placeholder: `search ${field.key}…` });
  const chips = el("div", { class: "facet-chips" });
  const suggest = el("div", { class: "facet-suggest" });

  function chipLabel(v) { return v === UNSPECIFIED ? "unspecified" : decodeEntities(v); }
  function renderChips() {
    chips.replaceChildren(...selectedFor(field).map((v) =>
      el("span", { class: "chip facet-chip" }, chipLabel(v),
        el("button", { class: "chip-x", title: `remove ${chipLabel(v)}`, onclick: () => toggleFacet(field, v) }, "×"))));
  }
  function renderSuggestions() {
    suggest.replaceChildren();
    const q = input.value.trim();
    if (!q) return;
    const terms = searchTerms(q);
    const matchedAll = options.filter(([v]) => valueMatches(decodeEntities(v), terms));
    if (matchedAll.length === 0) { suggest.append(el("div", { class: "facet-empty" }, "no matches")); return; }
    const already = new Set(selectedFor(field));
    const missing = matchedAll.filter(([v]) => !already.has(v));
    if (missing.length > 0) {
      suggest.append(el("button", { class: "facet-select-all", onclick: () => { for (const [v] of missing) toggleFacet(field, v); input.value = ""; renderChips(); renderSuggestions(); } },
        `Select all ${missing.length} matches`));
    }
    for (const [v, count] of matchedAll.slice(0, FACET_MATCH_LIMIT)) {
      suggest.append(el("button", { class: `facet-suggest-row${already.has(v) ? " on" : ""}`, onclick: () => { toggleFacet(field, v); renderChips(); renderSuggestions(); } },
        el("span", {}, decodeEntities(v)), el("span", { class: "count" }, `(${count})`)));
    }
  }
  input.addEventListener("input", renderSuggestions);
  renderChips();
  facetRefreshers.set(field.key, () => { renderChips(); renderSuggestions(); });
  return facetBox(field,
    el("div", { class: "facet-body" },
      input, chips, suggest,
      el("div", { class: "facet-special" },
        exactToggle(field),
        unspecifiedToggle(field, rows))));
}

// Per-facet toggle: when on, the job's values must equal the selection exactly.
function exactToggle(field) {
  return el("label", { class: "facet-exact" },
    el("input", { type: "checkbox", checked: Boolean(state.exact[field.key]), onchange: (e) => { state.exact[field.key] = e.target.checked; saveFacets(); applyFilter(); } }),
    " exact only");
}

function listCheckboxFacet(field, rows) {
  const counts = new Map();
  for (const r of rows) {
    const v = r.analysis?.[field.key];
    const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
    for (const t of tags) if (typeof t === "string" && !/^\[object /i.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return facetBox(field,
    el("div", { class: "facet-body" },
      ...options.map(([value, count]) => {
        const checked = selectedFor(field).includes(value);
        return el("label", { class: "facet-option" },
          el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
          ` ${decodeEntities(value)} (${count})`);
      }),
      el("div", { class: "facet-special" },
        exactToggle(field),
        unspecifiedToggle(field, rows))));
}

function numericFacet(field, rows) {
  const min = el("input", { class: "input", type: "number", placeholder: "min", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  const max = el("input", { class: "input", type: "number", placeholder: "max", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value === "" ? undefined : Number(e.target.value); saveFacets(); applyFilter(); } });
  return facetBox(field, el("div", { class: "facet-body" }, el("div", { class: "facet-range" }, min, el("span", {}, "–"), max)));
}

function dateFacet(field, rows) {
  const before = el("input", { class: "input", type: "date", value: state.min[field.key] ?? "", oninput: (e) => { state.min[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  const after = el("input", { class: "input", type: "date", value: state.max[field.key] ?? "", oninput: (e) => { state.max[field.key] = e.target.value || undefined; saveFacets(); applyFilter(); } });
  return facetBox(field, el("div", { class: "facet-body" }, el("div", { class: "facet-range" }, el("span", {}, "after"), before, el("span", {}, "before"), after)));
}

function matchesFacets(row) {
  const a = row.analysis ?? {};
  for (const field of state.contract) {
    const selected = state.facets[field.key];
    if (selected && selected.length) {
      const v = a[field.key];
      const tags = Array.isArray(v) ? v : (v == null ? [] : [v]);
      const wantUnspecified = selected.includes(UNSPECIFIED);
      const real = selected.filter((s) => s !== UNSPECIFIED);
      if (wantUnspecified && fieldMissing(v)) continue; // matches via "unspecified"
      if (real.length === 0) return false; // only unspecified selected, but this job has a value
      if (state.exact[field.key]) {
        // Exact-set match against the real values (unspecified handled above).
        const set = [...new Set(tags)];
        if (set.length !== real.length || !real.every((s) => set.includes(s))) return false;
      } else if (!real.some((s) => tags.includes(s))) return false;
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
