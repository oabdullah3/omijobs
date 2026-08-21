import { api } from "../api.js";
import { el, esc, fmtRel, toast } from "../app.js";

const state = { data: null, timer: null, db: "", instructions: "" };
async function refresh() {
  try {
    state.data = await api.get("/api/analysis");
    if (!state.db) state.db = state.data.dbs[0]?.key ?? "";
    const root = document.getElementById("analysis-root");
    if (root) root.replaceChildren(renderBody());
  } catch (error) { toast(error.message, "warn"); }
}
export function onLive(event) { if (event === "analysis" || event === "db") refresh(); }
export function mount() { state.timer = setInterval(refresh, 2000); refresh(); }
export function unmount() { clearInterval(state.timer); }
async function run() { try { await api.post("/api/analysis/run", { db: state.db, instructions: state.instructions }); toast("Analysis started", "good"); refresh(); } catch (error) { toast(error.message, "warn"); } }
async function stop() { try { await api.post("/api/analysis/stop", { db: state.db }); toast("Stopping analysis", "warn"); refresh(); } catch (error) { toast(error.message, "warn"); } }
async function mark(db) { if (!confirm("Mark every analyzed job below the recommendation threshold as uninterested?")) return; try { const result = await api.post(`/api/analysis/${encodeURIComponent(db)}/mark-unrecommended`); toast(`${result.count} jobs marked uninterested`, "good"); refresh(); } catch (error) { toast(error.message, "warn"); } }
function renderBody() {
  const data = state.data ?? { settings: { providers: [] }, dbs: [], runningDb: null };
  const enabled = data.settings.providers.find((provider) => provider.id === data.settings.enabledProvider);
  const running = Boolean(data.runningDb);
  const dbOptions = data.dbs.map((db) => el("option", { value: db.key }, `${db.label} · ${db.path}`));
  const instruction = el("textarea", { class: "input", rows: 4, placeholder: "What should the evaluator prioritize?", value: state.instructions, oninput: (event) => { state.instructions = event.target.value; } });
  const dbSelect = el("select", { class: "select", value: state.db, onchange: (event) => { state.db = event.target.value; } }, dbOptions);
  const cards = data.dbs.map((db) => el("div", { class: "card" }, el("div", { class: "toolbar" }, el("h3", {}, esc(db.label)), db.running ? el("span", { class: "badge live" }, "analyzing") : null), el("p", { class: "hint" }, db.running ? (db.summary ?? "working") : (db.status ? `${db.status} · ${fmtRel(db.lastRun)}` : "never analyzed")), el("p", {}, `${db.analyzed} analyzed · ${db.pending} pending · ${db.recommended} recommended`), el("button", { class: "btn small btn-danger", disabled: !db.exists || db.running, onclick: () => mark(db.key) }, "Mark below threshold uninterested")));
  return el("div", {}, el("p", { class: "eyebrow" }, "Analysis"), el("h2", { class: "docs" }, "AI job recommendations"), !enabled ? el("div", { class: "callout warn" }, el("p", {}, "No AI provider configured — analysis is disabled.")) : null, running ? el("div", { class: "callout" }, el("p", {}, `This DB is still being analyzed: ${esc(data.runningDb)}`), el("button", { class: "btn btn-danger", onclick: stop }, "Stop")) : null, el("div", { class: "card" }, el("p", { class: "eyebrow" }, "Run analysis"), dbSelect, instruction, el("button", { class: "btn btn-primary", disabled: !enabled || !dbOptions.length || running, onclick: run }, "Run analysis")), el("div", {}, ...cards), el("div", { class: "card" }, el("p", { class: "eyebrow" }, "Providers"), ...data.settings.providers.map((provider) => el("p", {}, `${esc(provider.name)} · ${esc(provider.model)} · key ${provider.apiKeyStatus}`))));
}
export async function render() { if (!state.data) await refresh(); return el("div", { id: "analysis-root" }, renderBody()); }
