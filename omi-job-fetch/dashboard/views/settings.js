import { api } from "../api.js";
import { el, esc } from "../app.js";

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
  return el("div", {},
    el("p", { class: "eyebrow" }, "Settings"),
    el("h2", { class: "docs" }, "Dashboard"),
    el("div", { class: "card" },
      el("h3", {}, "Appearance"),
      el("p", {}, "Toggle the theme from the sun/moon button in the top bar. Your choice is remembered.")),
    el("div", { class: "card" },
      el("h3", {}, "Environment"),
      el("dl", { class: "dl" }, ...rows.map(([k, v]) => [el("dt", {}, esc(k)), el("dd", { class: "mono" }, esc(v))]).flat())),
  );
}
