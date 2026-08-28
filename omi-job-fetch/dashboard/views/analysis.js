import { api } from "../api.js";
import { el, esc, fmtRel, toast, openModal, selectMenu } from "../app.js";

const state = { data: null, timer: null, db: "", reanalyze: false, testResults: {}, dbDropdown: null };

const PROVIDER_DEFAULTS = { temperature: 0.2, maxTokens: 400, timeoutMs: 60000, retries: 3, retryBackoffMs: 2000 };
const EMPTY = { settings: { providers: [], enabledProvider: null }, dbs: [], runningDb: null };
const data = () => state.data ?? EMPTY;

async function refresh() {
  try {
    state.data = await api.get("/api/analysis");
    if (!state.db) state.db = state.data.dbs[0]?.key ?? "";
    renderDynamic();
  } catch (error) {
    toast(error.message, "warn");
  }
}

// Re-render only the regions whose content changes on poll (per-db cards,
// providers, run/stop callout) and re-sync the DB <select> options in place.
// The instruction textarea, DB select, and settings form are built once in
// render() and never touched again, so they keep focus while the user types.
function renderDynamic() {
  syncDbSelect();
  const cards = document.getElementById("analysis-cards");
  if (cards) cards.replaceChildren(...renderDbCards());
  refreshProviders();
  refreshActions();
}

function refreshProviders() {
  const providers = document.getElementById("analysis-providers");
  if (providers) providers.replaceChildren(providersCard(data().settings));
}

function refreshActions() {
  const actions = document.getElementById("analysis-actions");
  // replaceChildren(null, …) coerces null to the literal "null" text node, so
  // filter out the callout placeholders that renderActions returns when there's
  // nothing to show (no missing-provider warning, no running callout).
  if (actions) actions.replaceChildren(...renderActions().filter(Boolean));
}

function syncDbSelect() {
  const dd = state.dbDropdown;
  if (!dd) return;
  const dbs = data().dbs ?? [];
  const options = dbs.map((db) => ({ value: db.key, label: db.label }));
  const keys = options.map((o) => o.value);
  const same = dd.options.length === options.length && options.every((o, i) => dd.options[i].value === o.value && dd.options[i].label === o.label);
  if (same) return;
  dd.setOptions(options);
  if (!keys.includes(state.db)) state.db = keys[0] ?? "";
  dd.setValue(state.db);
}

export function onLive(event) {
  if (event === "analysis" || event === "db") refresh();
}
export function mount() {
  state.timer = setInterval(refresh, 2000);
  refresh();
}
export function unmount() {
  clearInterval(state.timer);
}

async function run() {
  try { await api.post("/api/analysis/run", { db: state.db, reanalyze: state.reanalyze }); toast(state.reanalyze ? "Re-analyze started" : "Extraction started", "good"); refresh(); }
  catch (error) { toast(error.message, "warn"); }
}
async function stop() {
  try { await api.post("/api/analysis/stop", { db: state.db }); toast("Stopping analysis", "warn"); refresh(); }
  catch (error) { toast(error.message, "warn"); }
}

// --- provider + settings mutations ---
async function saveProvider(id, provider, key) {
  const body = { provider };
  if (key && key.trim() !== "") body.key = key;
  await api.post(id ? `/api/analysis/providers/${encodeURIComponent(id)}` : "/api/analysis/providers", body);
}
async function enable(id) {
  try { await api.post(`/api/analysis/providers/${encodeURIComponent(id)}/enable`); toast("Provider enabled", "good"); refresh(); }
  catch (error) { toast(error.message, "warn"); }
}
async function removeProvider(id) {
  if (!confirm(`Remove provider "${id}"? This does not delete its stored API key.`)) return;
  try { await api.del(`/api/analysis/providers/${encodeURIComponent(id)}`); toast("Provider removed", "good"); refresh(); }
  catch (error) { toast(error.message, "warn"); }
}
async function testProvider(id) {
  state.testResults[id] = { status: "testing" };
  refreshProviders();
  try {
    const result = await api.post(`/api/analysis/providers/${encodeURIComponent(id)}/test`);
    state.testResults[id] = result.ok ? { ok: true, reply: result.reply } : { ok: false, error: result.error };
  } catch (error) {
    state.testResults[id] = { ok: false, error: error.message };
  }
  refreshProviders();
}

function testResultLine(providerId) {
  const result = state.testResults[providerId];
  if (!result) return null;
  if (result.status === "testing") return el("div", { class: "hint" }, "testing…");
  const ok = result.ok === true;
  return el("div", { class: ok ? "hint good" : "hint warn" }, ok ? `ok · ${result.reply}` : `error · ${result.error}`);
}

// --- form builders ---
function field(label, input, hint) {
  return el("div", { class: "field" }, el("label", {}, label), input, hint ? el("div", { class: "hint" }, hint) : null);
}

function providerFormModal(existing) {
  const isEdit = Boolean(existing);
  const id = el("input", { class: "input", placeholder: "openrouter", value: existing?.id ?? "", disabled: isEdit });
  const name = el("input", { class: "input", placeholder: "OpenRouter", value: existing?.name ?? "" });
  const baseUrl = el("input", { class: "input", placeholder: "https://api.example.com/v1", value: existing?.baseUrl ?? "" });
  const model = el("input", { class: "input", placeholder: "gpt-4o-mini", value: existing?.model ?? "" });
  const apiKeyEnv = el("input", { class: "input", placeholder: "OPENROUTER_API_KEY", value: existing?.apiKeyEnv ?? "" });
  const key = el("input", { class: "input", type: "password", placeholder: isEdit ? "leave blank to keep existing key" : "sk-…" });
  const temperature = el("input", { class: "input", type: "number", step: "0.1", min: "0", max: "2", value: existing?.temperature ?? PROVIDER_DEFAULTS.temperature });
  const maxTokens = el("input", { class: "input", type: "number", min: "1", value: existing?.maxTokens ?? PROVIDER_DEFAULTS.maxTokens });
  const timeoutMs = el("input", { class: "input", type: "number", min: "1000", value: existing?.timeoutMs ?? PROVIDER_DEFAULTS.timeoutMs });
  const retries = el("input", { class: "input", type: "number", min: "0", max: "10", value: existing?.retries ?? PROVIDER_DEFAULTS.retries });
  const retryBackoffMs = el("input", { class: "input", type: "number", min: "0", value: existing?.retryBackoffMs ?? PROVIDER_DEFAULTS.retryBackoffMs });

  const form = el("div", { class: "form-grid" },
    el("div", { class: "form-row" },
      field("ID", id, isEdit ? "Provider id is fixed after creation." : "Unique slug, e.g. openrouter"),
      field("Name", name)),
    field("Base URL", baseUrl, "OpenAI-compatible root, e.g. https://api.openai.com/v1"),
    field("Model", model),
    el("div", { class: "form-row" },
      field("API key env var", apiKeyEnv, "Env-var name the key is stored under"),
      field(isEdit ? "API key (optional)" : "API key", key, isEdit ? "Leave blank to keep the existing key." : "Stored write-only; never shown again.")),
    el("div", { class: "form-row" },
      field("Temperature", temperature),
      field("Max tokens", maxTokens)),
    el("div", { class: "form-row" },
      field("Timeout (ms)", timeoutMs),
      field("Retries", retries)),
    field("Retry backoff (ms)", retryBackoffMs));

  const modal = el("div", { class: "modal" },
    el("h3", {}, isEdit ? `Edit ${esc(existing.id)}` : "Add AI provider"),
    form,
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-primary", onclick: save }, "Save provider"),
      el("button", { class: "btn btn-ghost", onclick: () => backdrop.remove() }, "Cancel")));
  const backdrop = openModal(modal);

  function collect() {
    return {
      id: id.value.trim(),
      name: name.value.trim(),
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      apiKeyEnv: apiKeyEnv.value.trim(),
      temperature: Number(temperature.value),
      maxTokens: Number(maxTokens.value),
      timeoutMs: Number(timeoutMs.value),
      retries: Number(retries.value),
      retryBackoffMs: Number(retryBackoffMs.value),
    };
  }

  async function save() {
    try {
      await saveProvider(isEdit ? existing.id : null, collect(), key.value);
      toast(isEdit ? "Provider updated" : "Provider added", "good");
      backdrop.remove();
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  }

  return backdrop;
}

function providerCard(provider, enabledProviderId) {
  const enabled = provider.id === enabledProviderId;
  const controls = [
    el("button", { class: "btn small", onclick: () => testProvider(provider.id) }, "Test"),
    el("button", { class: "btn small", disabled: enabled, onclick: () => enable(provider.id) }, enabled ? "Enabled" : "Enable"),
    el("button", { class: "btn small", onclick: () => providerFormModal(provider) }, "Edit"),
    el("button", { class: "btn small btn-danger", onclick: () => removeProvider(provider.id) }, "Remove"),
  ];
  return el("div", { class: "card", "data": { provider: provider.id } },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(provider.name)),
      enabled ? el("span", { class: "badge live" }, "enabled") : null,
      el("span", { class: `badge ${provider.apiKeyStatus === "set" ? "live" : "off"}` }, `key ${provider.apiKeyStatus}`)),
    el("dl", { class: "provider-meta" },
      el("dt", {}, "Model"), el("dd", {}, esc(provider.model)),
      el("dt", {}, "Base URL"), el("dd", {}, esc(provider.baseUrl)),
      el("dt", {}, "Env var"), el("dd", {}, esc(provider.apiKeyEnv)),
      el("dt", {}, "Temperature"), el("dd", {}, String(provider.temperature)),
      el("dt", {}, "Max tokens"), el("dd", {}, String(provider.maxTokens)),
      el("dt", {}, "Timeout"), el("dd", {}, `${provider.timeoutMs}ms`),
      el("dt", {}, "Retries"), el("dd", {}, String(provider.retries))),
    el("div", { class: "toolbar" }, ...controls),
    testResultLine(provider.id));
}

function providersCard(s) {
  return el("div", {},
    el("div", { class: "toolbar" },
      el("h3", { class: "docs" }, "Providers"),
      el("button", { class: "btn small btn-primary", onclick: () => providerFormModal(null) }, "Add provider")),
    s.providers.length
      ? el("div", {}, ...s.providers.map((provider) => providerCard(provider, s.enabledProvider)))
      : el("p", { class: "hint" }, "No providers yet — add one to enable AI analysis."));
}

function settingsCard(s) {
  const systemPrompt = el("textarea", { class: "input", rows: 5, value: s.systemPrompt ?? "" });
  const descriptionMaxChars = el("input", { class: "input", type: "number", min: "1", value: s.descriptionMaxChars ?? 2000 });
  const form = el("form", { class: "form-grid" },
    el("div", { class: "field" }, el("label", {}, "System prompt"), systemPrompt, el("div", { class: "hint" }, "Persona sent to the model; the extraction instructions are generated from the contract fields.")),
    el("div", { class: "form-row" },
      el("div", { class: "field" }, el("label", {}, "Description max chars"), descriptionMaxChars)),
    el("button", { class: "btn btn-primary", type: "submit" }, "Save settings"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api.put("/api/analysis/settings", {
        systemPrompt: systemPrompt.value,
        descriptionMaxChars: Number(descriptionMaxChars.value),
      });
      toast("Settings saved", "good");
      refresh();
    } catch (error) {
      toast(error.message, "warn");
    }
  });
  return el("div", { class: "card" },
    el("div", { class: "toolbar" }, el("h3", {}, "Extraction settings")),
    form);
}

function renderDbCards() {
  const dbs = data().dbs ?? [];
  return dbs.map((db) => el("div", { class: "card" },
    el("div", { class: "toolbar" },
      el("h3", {}, esc(db.label)),
      db.running ? el("span", { class: "badge live" }, "analyzing") : null),
    el("p", { class: "hint" }, db.running ? (db.summary ?? "working") : (db.status ? `${db.status} · ${fmtRel(db.lastRun)}` : "never analyzed")),
    el("p", { class: "hint" }, `${db.analyzed} analyzed · ${db.pending} pending`)));
}

function renderActions() {
  const enabled = Boolean(data().settings.providers.find((provider) => provider.id === data().settings.enabledProvider));
  const running = Boolean(data().runningDb);
  const dbOptions = data().dbs ?? [];
  return [
    !enabled ? el("div", { class: "callout warn" }, el("p", {}, "No AI provider configured — extraction is disabled.")) : null,
    running ? el("div", { class: "callout" },
      el("p", {}, `This DB is still being extracted: ${esc(data().runningDb)}`),
      el("button", { class: "btn btn-danger", onclick: stop }, "Stop")) : null,
    el("div", { class: "toolbar" },
      el("button", { class: "btn btn-primary", disabled: !enabled || !dbOptions.length || running, onclick: run }, "Run extraction"),
      el("label", { class: "inline-check" },
        el("input", { type: "checkbox", checked: state.reanalyze, onchange: (e) => { state.reanalyze = e.target.checked; } }),
        " Re-analyze all rows (overwrites existing extraction)")),
  ];
}

export async function render() {
  if (!state.data) await refresh();
  const s = data();
  const dbOptions = s.dbs.map((db) => ({ value: db.key, label: db.label }));
  const dbDropdown = selectMenu({
    id: "analysis-db-select",
    value: state.db,
    options: dbOptions,
    onSelect: (v) => { state.db = v; },
    class: "compound",
    title: "Select database",
  });
  state.dbDropdown = dbDropdown;
  return el("div", { id: "analysis-root" },
    el("p", { class: "eyebrow" }, "Analysis"),
    el("h2", { class: "docs" }, "AI job extraction"),
    el("p", { class: "hint" }, "Run extraction, manage providers, and configure prompts."),
    el("div", { class: "card" },
      el("div", { class: "toolbar" },
        el("h3", {}, "Run extraction"),
        dbDropdown),
      el("div", { id: "analysis-actions" }, ...renderActions())),
    el("h3", { class: "docs" }, "Databases"),
    el("div", { id: "analysis-cards" }, ...renderDbCards()),
    el("h3", { class: "docs" }, "Providers"),
    el("div", { id: "analysis-providers" }, providersCard(s.settings)),
    el("h3", { class: "docs" }, "Settings"),
    settingsCard(s.settings));
}

