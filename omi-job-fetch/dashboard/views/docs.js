import { el } from "../app.js";

function code(text) { return el("code", {}, text); }
function p(...children) { return el("p", {}, ...children); }
function ul(items) { return el("ul", {}, ...items.map(li)); }
function li(text) { return el("li", {}, text); }
function h2(id, text) { return el("h2", { id }, text); }
function h3(text) { return el("h3", {}, text); }
function callout(kind, ...children) {
  return el("div", { class: `docs-callout ${kind}` },
    el("span", { class: "docs-callout-label" }, kind === "warn" ? "caution" : "tip"),
    el("div", { class: "docs-callout-body" }, ...children));
}

function quickstart() {
  return [
    h2("docs-quickstart", "Quickstart"),
    p(["omijobs finds job postings across portals, saves them into local SQLite databases, and this dashboard is the pretty face over all of it. Nothing lives in the cloud — every job, status, and extraction stays on your machine."]),
    h3("Run it"),
    ul([
      p([code("omijobs dashboard"), " starts the dashboard (the CLI is installed globally)."]),
      p(["Your browser opens to ", code("http://127.0.0.1:5211"), " automatically. Ctrl+C in the terminal stops it."]),
      p(["Port already taken? Use ", code("omijobs dashboard --port 5212"), "."]),
    ]),
    h3("Three things to know"),
    ul([
      p([code("Data is yours"), " — everything lives in SQLite files under your state directory (see Settings)."]),
      p([code("The dashboard drives the real CLI"), " — Run now, Save, and Stop all execute the same commands you would type."]),
    ]),
    callout("tip", p([code("Statuses are for you"), " — marking a job Applied or Not interested never sends anything anywhere; it is your own pipeline bookkeeping."])),
  ];
}

function jobsSection() {
  return [
    h2("docs-jobs", "Jobs"),
    p(["The Jobs page is the heart of the dashboard: every saved posting from every source, deduped by title + company + location."]),
    h3("Sources"),
    p(["The dropdown at the top-left picks which database to browse — one per config (a cron with ", code("separate"), " storage gets its own). The label shows the exact file path, and the Delete DB button permanently deletes that database."]),
    h3("The ticker"),
    p(["The four stat cards — total / not applied / applied / not interested — are clickable: tap one to filter the list to that status."]),
    h3("Two views"),
    ul([
      p([code("Table"), " — compact rows: posted time, title, company, location, and a status dropdown on every row. Click a row for the full picture."]),
      p([code("Cards"), " — full detail inline: extraction chips, a truncated description with Read more, an Apply link, and a status dropdown. No popup required."]),
      p(["Switch with the Table / Cards toggle at the top right. Your choice is remembered."]),
    ]),
    h3("Statuses"),
    p(["Every job has a status: ", code("Not applied"), " (default), ", code("Applied"), ", or ", code("Not interested"), ". Set it from the dropdown on a row/card, or inside the detail popup. The dropdown never sends an application — it only updates your tracker."]),
    h3("The detail popup"),
    p(["Click a row (or a card title) to open the full posting: the original description, extracted fields, the apply URL, and the status actions. Esc or clicking outside closes it."]),
    h3("Search & sort"),
    p(["The search box matches title, company, and location. Click any column header to sort by it (click again to flip direction)."]),
    h3("Filters (facets)"),
    p(["Extracted fields become filter columns. Checkbox lists cover low-cardinality fields like languages; searchable columns cover domains, industries, and skills; ranges cover salary and years of experience; dates cover start dates."]),
    p(["The Filters bar collapses the whole panel — active filters are counted on it, and Clear all resets everything with one click. The panel state is remembered per source."]),
    ul([
      p([code("Exact only"), " — requires a job's values to equal the checked set exactly (useful for skills)."]),
      p([code("Unspecified"), " — includes jobs whose posting never mentioned that field (e.g. no language requirement) so they stay visible for your judgment instead of silently vanishing."]),
      p(["Active filters show a Clear all bar above the columns. Filters are remembered per source in your browser."]),
    ]),
  ];
}

function analysisSection() {
  return [
    h2("docs-analysis", "Analysis"),
    p(["Analysis turns each saved description into structured fields — domain, industry, skills, salary, languages, employment type, seniority, and more. Those fields power the Jobs filters."]),
    h3("Providers"),
    p(["Add an OpenAI-compatible provider (name, base URL, model). API keys are stored as environment variables and never displayed again. Use ", code("Test"), " to verify a provider, then ", code("Enable"), " it. Extraction is disabled until a provider is enabled."]),
    h3("Running extraction"),
    p(["Pick a database, then Run extraction. Rows without an analysis get processed, and the per-DB card shows how many are analyzed vs pending. Stop aborts cleanly."]),
    h3("Re-analyze"),
    callout("warn", p([code("Re-analyze all rows"), " re-runs every row and overwrites existing extraction — it is not limited to broken entries. Use it when you change the extraction contract or fixed the logic, not for routine runs."])),
    h3("Extraction quality"),
    callout("tip", p(["Extraction is model-based: occasionally a field is missed or a posting is ambiguous. The ", code("unspecified"), " filter on the Jobs page exists precisely so those rows stay visible for your own judgment."])),
  ];
}

function cronSection() {
  return [
    h2("docs-cron", "Cron"),
    p(["The cron gateway is a background process that wakes on a schedule and runs jobs for you, even when the dashboard is closed."]),
    h3("Gateway card"),
    p(["The top card shows whether it is up, lets you Start / Stop / Restart / Pause it, and tails its live log. A pulsing dot means it is running."]),
    h3("Scheduled jobs"),
    p(["Each job is a card: its schedule, a live next-run countdown, last status, queries, and DB. Controls:"]),
    ul([
      p([code("Run now"), " — starts the job immediately; works even when the gateway is down."]),
      p([code("Stop"), " — aborts the in-flight run and saves the results it already collected."]),
      p([code("Disable / Enable"), " — keeps the job but stops or resumes its schedule."]),
      p([code("Remove"), " — deletes the job; its config file stays on disk."]),
    ]),
    h3("Schedules"),
    p(["Natural language: ", code("every 30m"), ", ", code("every 6 hours"), ", ", code("daily at 09:00"), ", ", code("weekdays at 09:00"), ", ", code("monday at 10:00"), "…"]),
    h3("Storage"),
    p([code("Shared"), " writes into the normal jobs.db; ", code("separate"), " creates a dedicated <name>.db that becomes its own source on the Jobs page."]),
    h3("Analysis crons"),
    p(["Schedule automatic extraction for a database, so newly saved postings get analyzed without any manual step."]),
  ];
}

function configSection() {
  return [
    h2("docs-config", "Config"),
    p(["Every run is driven by a config file: which queries to run, which portals (adapters) to hit, and where results go. The base config handles normal runs; each cron job has its own config."]),
    h3("The Config page"),
    p(["Each config is a card. Edit queries, adapters, storage, the aggregate DB flag, and retention (base config only). The advanced box shows the raw JSON — ", code("Save"), " applies it together with the form fields (form fields win where they overlap)."]),
    h3("Direct JSON editing"),
    p(["The same files can be edited from Settings → Config files → Edit JSON. Validation happens before anything is written, so a malformed file is rejected, never saved."]),
    h3("The aggregate DB flag"),
    p(["Disabling the aggregate DB for a config means the Jobs page will not show its results — the dashboard warns you when you do this."]),
  ];
}

function settingsSection() {
  return [
    h2("docs-settings", "Settings"),
    p(["The Settings page covers three things:"]),
    ul([
      p([code("Appearance"), " — toggle the theme from the sun/moon button in the top bar; your choice is remembered."]),
      p([code("Config files"), " — edit any config's raw JSON directly in the browser."]),
      p([code("Environment"), " — the exact paths the dashboard is wired to: package dir, state dir, config and cron files, and the CLI it drives."]),
    ]),
  ];
}

function logsSection() {
  return [
    h2("docs-logs", "Logs"),
    p(["Every run, error, and dashboard action is logged with a timestamp, level, source, and structured details. The Logs page filters by source, level, and free text, and lets you expand entries to inspect their payloads."]),
    h3("When to look"),
    p(["Extraction failures, cron runs that died, gateway hiccups — the error lines point at the file and step involved, which is usually enough to fix the problem without digging into raw files."]),
  ];
}

function troubleshootingSection() {
  return [
    h2("docs-troubleshooting", "Troubleshooting"),
    callout("warn", ul([
      p([code("Port already in use"), " — ", code("omijobs dashboard --port 5212"), " picks another port."]),
      p([code("“Could not read this DB”"), " on Jobs — the gateway is writing to that database at this moment; wait a moment and refresh."]),
      p([code("Analysis says no provider"), " — add and enable a provider on the Analysis page; extraction is disabled without one."]),
      p([code("Extraction keeps failing"), " — hit Test on the provider; check the API-key environment variable, the model name, and the timeout."]),
      p([code("A job is missing"), " — the query or enabled adapters for that source may not cover it, or that config's aggregate DB is disabled (the Config page warns when it is)."]),
      p([code("Gateway shows stale"), " — it crashed or was killed; press Stop, then Start (or just Restart)."]),
      p([code("Re-analyze overwrote rows"), " — it processes every row by design; use it only when you want a full refresh."]),
    ])),
  ];
}

const SECTIONS = [
  { id: "docs-quickstart", title: "Quickstart", render: quickstart },
  { id: "docs-jobs", title: "Jobs", render: jobsSection },
  { id: "docs-analysis", title: "Analysis", render: analysisSection },
  { id: "docs-cron", title: "Cron", render: cronSection },
  { id: "docs-config", title: "Config", render: configSection },
  { id: "docs-settings", title: "Settings", render: settingsSection },
  { id: "docs-logs", title: "Logs", render: logsSection },
  { id: "docs-troubleshooting", title: "Troubleshooting", render: troubleshootingSection },
];

let onScroll = null;

export function mount() {
  const items = [...document.querySelectorAll(".docs-nav-item")];
  const sections = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean);
  if (!sections.length) return;
  // Scrollspy: the active section is the last one whose top has crossed the
  // probe line (just under the sticky appbar / nav offset).
  const probe = 96;
  onScroll = () => {
    let current = sections[0].id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= probe) current = section.id;
    }
    // When scrolled to the very bottom the last section's top may never cross
    // the probe (its content ends first, so the previous section stays poking
    // in above it). Force the last section active once its bottom reaches the
    // viewport edge. The scrollY guard keeps a tall viewport that fits the
    // whole page from selecting the last section at the top.
    const last = sections[sections.length - 1];
    if (window.scrollY > 0 && last.getBoundingClientRect().bottom <= window.innerHeight) current = last.id;
    for (const it of items) it.classList.toggle("active", it.dataset.docs === current);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}
export function unmount() {
  if (onScroll) window.removeEventListener("scroll", onScroll);
  onScroll = null;
}

export async function render() {
  return el("div", { class: "docs-layout" },
    el("aside", { class: "docs-nav" },
      ...SECTIONS.map((s) => el("button", { class: "docs-nav-item", "data": { docs: s.id }, onclick: () => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, s.title))),
    el("article", { class: "docs docs-body" },
      el("h1", {}, "omijobs docs"),      el("p", { class: "docs-subtitle" }, "local-first job tracker — every job, status & extraction stays on your machine"),      ...SECTIONS.map((s) => el("section", { id: s.id, class: "docs-section" }, ...s.render()))));
}
