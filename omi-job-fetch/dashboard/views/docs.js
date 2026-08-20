import { el } from "../app.js";

function h1(text) { return el("h1", {}, text); }
function h2(text) { return el("h2", {}, text); }
function h3(text) { return el("h3", {}, text); }
function p(children) { return el("p", {}, children); }
function code(text) { return el("code", {}, text); }
function li(text) { return el("li", {}, text); }

export async function render() {
  return el("div", { class: "docs" },
    h1("omijobs dashboard"),
    p([`A visual layer over the `, code("omijobs"), ` CLI. Nothing here replaces the CLI — the dashboard reads the same configs, cron file, and SQLite databases, and every control it has runs the real CLI under the hood.`]),

    h2("Quickstart"),
    p([`Run `, code("omijobs dashboard"), ` from the project folder. Your browser opens to `, code("http://127.0.0.1:5211"), `. Press Ctrl+C in the terminal to stop it. Pass `, code("--port 5212"), ` if the default port is taken.`]),

    h2("Jobs"),
    p([`Everything here is read from the aggregate SQLite databases (`, code("jobs.db"), ` per config unless a cron uses separate storage). Pick a source in the dropdown — the label shows the exact file path. Click any row to see the full posting and to mark it `, code("applied"), ` or `, code("uninterested"), ` (or back to `, code("unapplied"), `). Filter by status, search title/company/location, and sort by column.`]),
    p([`Rows come from every run, deduped by title+company+location, so the same job seen across portals appears once.`]),

    h2("Cron"),
    p([`The gateway is the process that wakes up on a schedule and runs jobs. The top card shows whether it is up, lets you `, code("start"), `/`, code("stop"), `/`, code("restart"), `/`, code("pause"), ` it, and tails its log. A pulsing dot means it is running.`]),
    p([`Each scheduled job is its own card: its schedule, whether it is enabled, the countdown to the next run, and its last status. While a run is in flight the card shows `, code("running now"), ` and the Run now button is disabled — a run cannot overlap itself.`]),
    p([`Create a job with the form at the bottom. Names must be unique. Pick shared storage (results land in the normal `, code("jobs.db"), `) or separate storage (a dedicated `, code("<name>.db"), `).`]),

    h2("Config"),
    p([`The base config drives normal runs. Each cron job has its own config file. Edit queries and enabled adapters here; the advanced box shows the raw JSON. If you disable the aggregate DB for a config, the dashboard warns you because the Jobs page reads those databases.`]),

    h2("Settings"),
    p([`Theme toggle and the environment paths the dashboard is wired to.`]),
  );
}
