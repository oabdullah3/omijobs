import { api } from "./api.js";
import * as jobs from "./views/jobs.js";
import * as cron from "./views/cron.js";
import * as config from "./views/config.js";
import * as docs from "./views/docs.js";
import * as settings from "./views/settings.js";

const ROUTES = { jobs, cron, config, docs, settings };
const NAV = [["jobs", "Jobs"], ["cron", "Cron"], ["config", "Config"], ["docs", "Docs"]];
const $ = (id) => document.getElementById(id);

// --- DOM helpers (exported for views) ---
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "data") {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (key === "checked" || key === "disabled") {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- time helpers ---
export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
export function fmtRel(iso) {
  if (!iso) return "never";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ${ms >= 0 ? "ago" : "from now"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ${ms >= 0 ? "ago" : "from now"}`;
  return `${Math.round(h / 24)}d ${ms >= 0 ? "ago" : "from now"}`;
}
export function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// One-line live progress (running) or the persisted result summary (done) for a
// /api/run/status entry. Null when there's no progress data for that config.
export function runSummary(rs) {
  if (!rs) return null;
  const live = rs.lastLines?.length ? rs.lastLines[rs.lastLines.length - 1].trim() : null;
  return rs.running ? live : (rs.result ?? live);
}

// --- toast + modal ---
let toastTimer = null;
export function toast(message, kind = "") {
  let node = $("toast");
  if (!node) {
    node = el("div", { id: "toast", class: "toast" });
    document.body.append(node);
  }
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.display = "none"; }, 4000);
}
export function openModal(root) {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  backdrop.append(root);
  document.body.append(backdrop);
  return backdrop;
}
export function closeModal() {
  document.querySelector(".modal-backdrop")?.remove();
}

// --- theme ---
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("omijobs-theme", theme);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀" : "☾";
}

// --- router ---
let current = null;
function routeName() {
  const h = location.hash.replace(/^#\//, "");
  return ROUTES[h] ? h : "jobs";
}
function renderNav(active) {
  const nav = $("nav");
  nav.replaceChildren(...NAV.map(([name, label]) =>
    el("a", { href: `#/${name}`, class: `nav-item${active === name ? " active" : ""}` }, label)));
}
async function render() {
  const name = routeName();
  renderNav(name);
  current?.unmount?.();
  const view = ROUTES[name];
  current = view;
  const root = await view.render();
  $("view").replaceChildren(root);
  view.mount?.(root);
}
window.addEventListener("hashchange", render);

// --- live events ---
const liveDot = $("live-dot");
api.onLive((event) => {
  liveDot.classList.add("live");
  current?.onLive?.(event);
});

$("theme-toggle").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
applyTheme(localStorage.getItem("omijobs-theme") || "light");

render();
