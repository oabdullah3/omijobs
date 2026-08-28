import { api } from "./api.js";
import * as jobs from "./views/jobs.js";
import * as cron from "./views/cron.js";
import * as config from "./views/config.js";
import * as docs from "./views/docs.js";
import * as settings from "./views/settings.js";
import * as analysis from "./views/analysis.js";
import * as logs from "./views/logs.js";

const ROUTES = { jobs, cron, config, docs, settings, analysis, logs };
const NAV = [["jobs", "Jobs"], ["analysis", "Analysis"], ["cron", "Cron"], ["config", "Config"], ["docs", "Docs"], ["logs", "Logs"]];
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
    } else if (key === "checked" || key === "disabled" || key === "selected") {
      node[key] = Boolean(value);
    } else if (key === "value") {
      // textarea/select/option/input values are DOM properties, not attributes —
      // setAttribute("value", …) leaves <textarea> and <select> visually empty.
      node.value = value;
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

// --- custom dropdown (replaces native <select>) ---
// Native <select> popups are OS-rendered (white bg, blue highlight) and ignore CSS,
// so they can't be themed for dark mode. selectMenu renders the option list in-page:
//   selectMenu({ value, options: [{ value, label }], onSelect(v), title, id, class, disabled })
// Returns the container (div.dd) with .setValue(v), .open(), .close(), .btn.
export function selectMenu({ value, options = [], onSelect, title, id, class: cls = "", disabled = false } = {}) {
  const container = el("div", { id, class: `dd${cls ? ` ${cls}` : ""}` });
  const label = el("span", { class: "dd-label" });
  const caret = el("span", { class: "dd-caret", "aria-hidden": "true" }, "▾");
  const btn = el("button", {
    type: "button", class: "dd-btn", title,
    "aria-haspopup": "listbox", "aria-expanded": "false",
    disabled: Boolean(disabled),
    onclick: (e) => { e.stopPropagation(); toggle(); },
  }, label, caret);
  const menu = el("div", { class: "dd-menu", role: "listbox" });
  menu.hidden = true;
  container.append(btn, menu);

  let current = value ?? "";
  let hoverIdx = -1;
  const optNodes = []; // { value, node }

  function buildOptions() {
    menu.replaceChildren();
    optNodes.length = 0;
    options.forEach((o, i) => {
      const node = el("button", {
        type: "button", class: "dd-option", role: "option",
        "aria-selected": String(o.value === current),
        onclick: (e) => { e.stopPropagation(); pick(o.value); },
      }, esc(o.label));
      if (o.value === current) node.classList.add("selected");
      node.addEventListener("pointerenter", () => setHover(i, false));
      optNodes.push({ value: o.value, node });
      menu.append(node);
    });
  }
  const currentLabel = () => (options.find((o) => o.value === current) ?? { label: current }).label;
  function setValue(v) {
    current = v;
    label.textContent = currentLabel();
    for (const o of optNodes) {
      const on = o.value === current;
      o.node.classList.toggle("selected", on);
      o.node.setAttribute("aria-selected", String(on));
    }
  }
  setValue(current); // paint the initial label
  function setHover(i, scroll = true) {
    hoverIdx = i;
    optNodes.forEach((o, idx) => o.node.classList.toggle("hover", idx === i));
    if (scroll && i >= 0) {
      const n = optNodes[i].node;
      menu.scrollTop = n.offsetTop - menu.clientHeight / 2 + n.clientHeight / 2;
    }
  }
  function open() {
    if (!menu.hidden) return;
    buildOptions();
    setValue(current);
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    container.dataset.open = "1";
    setHover(optNodes.findIndex((o) => o.value === current));
    document.addEventListener("pointerdown", onDocDown, true);
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    delete container.dataset.open;
    document.removeEventListener("pointerdown", onDocDown, true);
    setHover(-1);
  }
  function toggle() { if (menu.hidden) open(); else close(); }
  function pick(v) {
    close();
    if (v !== current) {
      current = v;
      setValue(v);
      onSelect?.(v);
    }
  }
  function move(dir) {
    if (!optNodes.length) return;
    const n = optNodes.length;
    let i = hoverIdx === -1 ? (dir > 0 ? -1 : 0) : hoverIdx;
    i = (i + dir + n) % n;
    setHover(i);
  }
  function activate() {
    if (hoverIdx >= 0) pick(optNodes[hoverIdx].value);
  }
  function onDocDown(e) {
    if (!container.contains(e.target)) close();
  }
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (menu.hidden) open(); else move(e.key === "ArrowDown" ? 1 : -1);
    } else if ((e.key === "Enter" || e.key === " ") && !menu.hidden) {
      e.preventDefault();
      activate();
    } else if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    } else if (e.key === "Tab" && !menu.hidden) {
      close();
    }
  });

  container.setValue = setValue;
  container.open = open;
  container.close = close;
  container.btn = btn;
  return container;
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
  const onKey = (e) => { if (e.key === "Escape") { backdrop.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
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
applyTheme(localStorage.getItem("omijobs-theme") || "dark");

render();
