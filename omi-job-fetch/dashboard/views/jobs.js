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
  exact: {},         // fieldKey -> boolean (exact-set match for list fields)
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
// The toolbar (with the Delete DB button) is built once per view mount by
// renderBody(); refresh() only re-renders the job list. Sync the button's
// enabled state here so it follows the DB file's existence without a remount.
function syncToolbar() {
  const del = document.getElementById("delete-db-btn");
  if (del) del.disabled = !state.info?.exists;
}
async function refresh() {
  try {
    await refreshSources();
    state.info = state.sources.find((s) => s.key === state.key) ?? null;
    syncToolbar();
    state.list = state.key
      ? await api.get(`/api/dbs/${state.key}/jobs?status=${state.status}&q=${encodeURIComponent(state.q)}&sort=${state.sort}&dir=${state.dir}&limit=500`)
      : null;
    if (state.list?.fields) state.contract = state.list.fields;
    loadFacets();
    const facetsNode = document.getElementById("jobs-facets");
    if (facetsNode && (state.key !== facetKey || facetsNode.childElementCount === 0)) {
      facetsNode.replaceChildren(renderFacets() ?? []);
      facetKey = state.key;
    }
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
  const deleteBtn = el("button", { id: "delete-db-btn", class: "btn small btn-danger", disabled: !state.info?.exists, onclick: deleteSourceModal }, "Delete DB");
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
    el("div", { id: "jobs-facets" }),
    el("div", { id: "jobs-body" }, renderTicker(), renderTable()));
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
    }),
    unspecifiedToggle(field, rows));
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
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    unspecifiedToggle(field, rows),
    input, exactToggle(field), chips, suggest);
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
  return el("div", { class: "facet" },
    el("div", { class: "eyebrow" }, field.key),
    exactToggle(field),
    ...options.map(([value, count]) => {
      const checked = selectedFor(field).includes(value);
      return el("label", { class: "facet-option" },
        el("input", { type: "checkbox", checked, onchange: () => toggleFacet(field, value) }),
        ` ${decodeEntities(value)} (${count})`);
    }),
    unspecifiedToggle(field, rows));
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
