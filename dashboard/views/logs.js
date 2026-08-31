import { api } from "../api.js";
import { el, esc, fmtTime } from "../app.js";

const state = { filter: { source: "", level: "", range: "1h", q: "", runId: "" }, timer: null, listNode: null, hovering: false, selecting: false };

const RANGES = { "5m": 5 * 60_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

function queryString() {
  const f = state.filter;
  const p = new URLSearchParams();
  if (f.source) p.set("source", f.source);
  if (f.level) p.set("level", f.level);
  if (f.q) p.set("q", f.q);
  if (f.runId) p.set("runId", f.runId);
  const rangeMs = RANGES[f.range];
  if (rangeMs) p.set("from", new Date(Date.now() - rangeMs).toISOString());
  p.set("limit", "300");
  return p.toString();
}

async function refresh() {
  if (!state.listNode) return;
  // Don't clobber the DOM while the user is reading or copying: rebuilding
  // rows mid-selection kills the selection and jumps the scroll position.
  if (state.hovering || state.selecting) return;
  const atBottom = state.listNode.scrollHeight - state.listNode.scrollTop - state.listNode.clientHeight < 40;
  try {
    const { events, total } = await api.get(`/api/logs?${queryString()}`);
    state.listNode.replaceChildren(...events.map(row));
    const count = document.getElementById("logs-count");
    if (count) count.textContent = `${events.length} of ${total} events`;
    if (atBottom) state.listNode.scrollTop = state.listNode.scrollHeight;
  } catch { /* keep last view */ }
}

function row(e) {
  const line = el("div", { class: `log-row ${e.level}` },
    el("span", { class: "log-ts" }, fmtTime(e.ts)),
    el("span", { class: "log-level" }, e.level.toUpperCase()),
    el("span", { class: "log-source" }, e.source),
    el("span", { class: "log-event" }, e.event),
    el("span", { class: "log-msg" }, esc(e.message)));
  if (e.data && Object.keys(e.data).length) {
    const details = el("pre", { class: "log-data" }, esc(JSON.stringify(e.data, null, 2)));
    details.style.display = "none";
    line.addEventListener("click", () => { details.style.display = details.style.display === "none" ? "block" : "none"; });
    line.append(details);
  }
  return line;
}

function filterBar() {
  const source = el("select", { class: "input", onchange: (e) => { state.filter.source = e.target.value; refresh(); } },
    el("option", { value: "" }, "all sources"),
    ...["gateway", "run", "analysis", "dashboard"].map((s) => el("option", { value: s }, s)));
  const level = el("select", { class: "input", onchange: (e) => { state.filter.level = e.target.value; refresh(); } },
    el("option", { value: "" }, "all levels"),
    ...["debug", "info", "warn", "error"].map((l) => el("option", { value: l }, l)));
  const range = el("select", { class: "input", onchange: (e) => { state.filter.range = e.target.value; refresh(); } },
    ...Object.keys(RANGES).map((r) => el("option", { value: r }, r)));
  const q = el("input", { class: "input", placeholder: "search message…", oninput: (e) => { state.filter.q = e.target.value.trim(); refresh(); } });
  return el("div", { class: "toolbar" }, source, level, range, q);
}

export function onLive() { /* logs page tail-refreshes on its own 3s timer */ }
export function mount() {
  state.timer = setInterval(refresh, 3000);
  state.onSelection = () => {
    const sel = document.getSelection();
    state.selecting = Boolean(sel && !sel.isCollapsed && state.listNode && state.listNode.contains(sel.anchorNode));
  };
  document.addEventListener("selectionchange", state.onSelection);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
  document.removeEventListener("selectionchange", state.onSelection);
  state.hovering = false;
  state.selecting = false;
}

export async function render() {
  state.listNode = el("div", { class: "log-list" }, el("div", { class: "empty" }, "loading…"));
  state.listNode.addEventListener("mouseenter", () => { state.hovering = true; });
  state.listNode.addEventListener("mouseleave", () => { state.hovering = false; });
  const root = document.createElement("div");
  root.append(
    el("div", { class: "toolbar" }, el("p", { class: "eyebrow" }, "Logs"), el("span", { class: "hint", id: "logs-count" }, "")),
    filterBar(),
    state.listNode,
  );
  await refresh();
  return root;
}
