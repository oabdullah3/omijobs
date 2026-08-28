import { api } from "../api.js";
import { el, esc, toast, openModal } from "../app.js";

const state = { info: null };

async function refresh() {
  try {
    state.info = await api.get("/api/bootstrap");
  } catch { /* keep last */ }
}

export function mount() { refresh(); }
export async function render() {
  await refresh();
  const info = state.info;
  if (!info) return el("div", { class: "empty" }, "Loading…");
  const rows = [
    ["Port", String(info.port)],
    ["Package dir", info.packageDir],
    ["State dir", info.stateDir],
    ["Base config", info.configPath],
    ["Cron file", info.cronPath],
    ["CLI", info.cliPath],
    ["Adapters", info.adapters.map((a) => `${a.id} (${a.family})`).join(", ")],
  ];
  let configs = [];
  try { configs = await api.get("/api/configs"); } catch { /* keep empty */ }
  return el("div", {},
    el("p", { class: "eyebrow" }, "Settings"),
    el("h2", { class: "docs" }, "Dashboard"),
    el("div", { class: "card" },
      el("h3", {}, "Appearance"),
      el("p", {}, "Toggle the theme from the sun/moon button in the top bar. Your choice is remembered.")),
    el("div", { class: "card" },
      el("h3", {}, "Config files"),
      el("p", { class: "hint" }, "Edit any config's raw JSON directly — it is validated before it is written. The cron schedule file itself is managed on the Cron page."),
      configs.length ? el("div", {}, ...configs.map(configFileRow)) : el("p", { class: "hint" }, "No configs found.")),
    el("div", { class: "card" },
      el("h3", {}, "Environment"),
      el("dl", { class: "dl" }, ...rows.map(([k, v]) => [el("dt", {}, esc(k)), el("dd", { class: "mono" }, esc(v))]).flat())),
  );
}

function configFileRow(meta) {
  return el("div", { class: "config-file-row" },
    el("div", { class: "config-file-info" },
      el("div", { class: "config-file-name" },
        el("span", { class: `badge ${meta.kind === "base" ? "live" : "off"}` }, meta.kind === "base" ? "base" : "cron"),
        el("b", {}, esc(meta.id))),
      el("span", { class: "mono hint" }, esc(meta.rel ?? meta.path ?? "")),
      meta.db ? el("span", { class: "hint" }, meta.db.enabled ? `db: ${esc(meta.db.file)}${meta.db.exists ? ` · ${meta.db.jobCount} jobs` : ""}` : "db disabled") : null),
    el("button", { class: "btn small", onclick: () => editConfigJson(meta) }, "Edit JSON"));
}

async function editConfigJson(meta) {
  let raw;
  try {
    const { config } = await api.get(`/api/configs/${encodeURIComponent(meta.id)}`);
    raw = JSON.stringify(config, null, 2);
  } catch (error) {
    toast(error.message, "warn");
    return;
  }
  const textarea = el("textarea", { class: "input codeblock", rows: 18, spellcheck: "false" });
  textarea.value = raw;
  const modal = el("div", { class: "modal modal-wide" },
    el("h3", {}, `Edit ${esc(meta.id)}`),
    el("p", { class: "hint" }, `Saved to ${esc(meta.rel ?? meta.path ?? "config file")}. Invalid JSON is rejected without writing.`),
    textarea,
    el("div", { class: "modal-actions" },
      el("button", { class: "btn btn-primary", onclick: save }, "Save config"),
      el("button", { class: "btn btn-ghost", onclick: () => backdrop.remove() }, "Cancel")));
  const backdrop = openModal(modal);
  async function save() {
    let parsed;
    try {
      parsed = JSON.parse(textarea.value);
    } catch {
      toast("Invalid JSON — nothing was saved", "warn");
      return;
    }
    try {
      await api.put(`/api/configs/${encodeURIComponent(meta.id)}`, { raw: parsed });
      toast(`Saved ${esc(meta.id)}`, "good");
      backdrop.remove();
    } catch (error) {
      toast(error.message, "warn");
    }
  }
}
