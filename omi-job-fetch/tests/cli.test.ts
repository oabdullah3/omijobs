import { afterEach, describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactLink, createProgressFile, createRenderer, createRunMarker, createStopWatch, findConfig, parseArgs, parseDashboardFlags, renderTrail } from "../src/cli.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

describe("parseArgs", () => {
  it("captures --config <path>", () => {
    const { configPath, help } = parseArgs(["--config", "my/config.json"]);
    expect(configPath).toBe("my/config.json");
    expect(help).toBe(false);
  });

  it("captures --config=<path>", () => {
    const { configPath } = parseArgs(["--config=my/config.json"]);
    expect(configPath).toBe("my/config.json");
  });

  it("returns help true for --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["--config", "my/config.json", "--help"]).help).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--query", "grad"])).toThrow(/Unknown flag: --query/);
    expect(() => parseArgs(["--location=Hong Kong"])).toThrow(/Unknown flag: --location/);
  });

  it("rejects positional arguments", () => {
    expect(() => parseArgs(["grad"])).toThrow(/Unexpected positional/);
  });

  it("rejects --config without a path", () => {
    expect(() => parseArgs(["--config"])).toThrow(/--config requires a file path/);
    expect(() => parseArgs(["--config", "--help"])).toThrow(/--config requires a file path/);
  });
});

describe("findConfig", () => {
  it("loads the config at the explicit path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-cfg-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          global: { queries: ["q"] },
          portals: { enabled: ["gradconnection"], config: {} },
          ats: { enabled: [], config: {} },
          dedup: { fields: ["title"] },
        }),
      );
      const { config } = findConfig(path);
      expect(config.portals.enabled).toEqual(["gradconnection"]);
      expect(config.global?.queries).toEqual(["q"]);
      expect(config.dedup.fields).toEqual(["title"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the user-owned realtime config under ~/.omijobs", () => {
    const { path } = findConfig();
    expect(resolve(path)).toBe(resolve(homedir(), ".omijobs", "dashboard.configs", "realtime", "config.json"));
  });

  it("throws when the explicit path does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-cfg-"));
    try {
      expect(() => findConfig(join(dir, "nope.json"))).toThrow(/No config.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createRenderer", () => {
  const LIVE = "  gc · page 1/2 · 3 found";

  function capture() {
    const out: string[] = [];
    const origWrite = process.stdout.write;
    const origLog = console.log;
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.log = ((line?: unknown) => {
      out.push(`${String(line)}\n`);
    }) as typeof console.log;
    return {
      out,
      restore: () => {
        process.stdout.write = origWrite;
        console.log = origLog;
      },
    };
  }

  afterEach(() => {
    // Remove the shadow property so Node's real isTTY getter wins again.
    Reflect.deleteProperty(process.stdout, "isTTY");
  });

  it("boundaries always print; a live line shows in place on a TTY and is cleared before the next boundary", () => {
    const { out, restore } = capture();
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const renderer = createRenderer();
      renderer.boundary("[1/2] running gc …");
      renderer.live(LIVE);
      renderer.boundary("[1/2] ✓ gc — 3 raw, 0 dropped, 8s");
      expect(out).toEqual([
        "[1/2] running gc …\n",
        LIVE,
        `\r${" ".repeat(LIVE.length)}\r`,
        "[1/2] ✓ gc — 3 raw, 0 dropped, 8s\n",
      ]);
    } finally {
      restore();
    }
  });

  it("suppresses live lines when stdout is not a TTY", () => {
    const { out, restore } = capture();
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      const renderer = createRenderer();
      renderer.boundary("a");
      renderer.live("hidden");
      renderer.boundary("b");
      expect(out).toEqual(["a\n", "b\n"]);
    } finally {
      restore();
    }
  });
});

describe("createProgressFile", () => {
  it("mirrors lines and a result line into the env-gated progress file, truncated per run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-progress-"));
    try {
      const file = join(dir, "runs", "x.log");
      process.env.OMI_JOB_FETCH_PROGRESS_FILE = file;
      try {
        const first = createProgressFile();
        first.line("  gc · page 1/2 · 3 found");
        first.line("  jd · 5/10");
        first.result("3 jobs, 1 dropped, 0 deduped");
        // A fresh run truncates — the previous run's tail must not leak through.
        const second = createProgressFile();
        second.line("fresh line");
        expect(readFileSync(file, "utf8")).toBe("fresh line\n");
        second.result("4 jobs, 0 dropped, 0 deduped");
        expect(readFileSync(file, "utf8")).toBe("fresh line\nresult: 4 jobs, 0 dropped, 0 deduped\n");
      } finally {
        delete process.env.OMI_JOB_FETCH_PROGRESS_FILE;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no-ops when OMI_JOB_FETCH_PROGRESS_FILE is unset", async () => {
    delete process.env.OMI_JOB_FETCH_PROGRESS_FILE;
    const p = createProgressFile();
    expect(() => {
      p.line("x");
      p.result("y");
    }).not.toThrow();
  });
});

describe("createRunMarker", () => {
  it("writes a {pid, startedAt} marker when the env is set and clears it on clear()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-marker-"));
    try {
      const file = join(dir, "runs", "x.running");
      process.env.OMI_JOB_FETCH_RUN_MARKER = file;
      try {
        const marker = createRunMarker();
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; startedAt?: unknown };
        expect(parsed.pid).toBe(process.pid);
        expect(typeof parsed.startedAt).toBe("string");
        marker.clear();
        expect(existsSync(file)).toBe(false);
      } finally {
        delete process.env.OMI_JOB_FETCH_RUN_MARKER;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no-ops when OMI_JOB_FETCH_RUN_MARKER is unset", () => {
    delete process.env.OMI_JOB_FETCH_RUN_MARKER;
    const marker = createRunMarker();
    expect(marker.pid).toBeNull();
    expect(() => marker.clear()).not.toThrow();
  });
});

describe("createStopWatch", () => {
  it("flips aborted() once the stop marker file appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfetch-stop-"));
    try {
      const stopFile = join(dir, "stop");
      const watch = createStopWatch(stopFile);
      try {
        expect(watch.aborted()).toBe(false);
        writeFileSync(stopFile, new Date().toISOString(), "utf8");
        const deadline = Date.now() + 2000;
        while (!watch.aborted() && Date.now() < deadline) await sleep(20);
        expect(watch.aborted()).toBe(true);
      } finally {
        watch.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays false when no stop file is set (no polling, no signal handlers)", () => {
    const watch = createStopWatch();
    watch.dispose();
    expect(watch.aborted()).toBe(false);
  });
});

describe("compactLink", () => {
  it("strips scheme/host and generic action segments down to the job-ID tail", () => {
    expect(compactLink("https://hk.jobsdb.com/job/94012335/apply")).toBe("#94012335");
    expect(compactLink("https://www.linkedin.com/jobs/view/4397220687/")).toBe("#4397220687");
    expect(compactLink("https://www.janestreet.com/join-jane-street/apply/8641377002?gh_jid=8641377002")).toBe("#8641377002");
    expect(compactLink("https://aia.wd3.myworkdayjobs.com/en-US/External/job/Hong-Kong/Agency--Intern_JR-64572")).toBe(
      "Agency--Intern_JR-64572",
    );
    expect(compactLink("https://k2integrity.careers.hibob.com/jobs/3db3dd50-9543-4d6f-8a4a-1a1a1a1a1a1a")).toBe(
      "3db3dd50-9543-4d6f-8a4a-1a1a1a1a1a1a",
    );
  });

  it("falls back to the host or the raw input when there is no path tail", () => {
    expect(compactLink(null)).toBe("—");
    expect(compactLink(undefined)).toBe("—");
    expect(compactLink("https://example.com/")).toBe("example.com");
    expect(compactLink("not a url")).toBe("not a url");
  });
});

describe("renderTrail", () => {
  it("renders dropped + deduped cases as compact sorted lines with section headers", () => {
    const lines = renderTrail({
      droppedCases: [
        { adapter: "jobsdb", missing: ["apply_url"], title: "Zeta role", link: "https://hk.jobsdb.com/job/111/apply" },
      ],
      dedupedCases: [
        { title: "Zeta role", company: "Zeta Co", link: "https://hk.jobsdb.com/job/111/apply", keptLink: "https://hk.jobsdb.com/job/112/apply" },
        { title: "Alpha role", company: "Alpha Co", link: "https://hk.jobsdb.com/job/201/apply", keptLink: "https://hk.jobsdb.com/job/202/apply" },
        { title: "Alpha role", company: "Alpha Co", link: "https://hk.jobsdb.com/job/203/apply", keptLink: "https://hk.jobsdb.com/job/202/apply" },
      ],
    });
    expect(lines).toEqual([
      "Dropped 1 listing",
      "  drop   Zeta role — missing apply_url — #111",
      "Deduplicated 3 duplicate listings · 2 unique titles",
      "  dedup  Alpha role @ Alpha Co — #201 → #202",
      "  dedup  Alpha role @ Alpha Co — #203 → #202",
      "  dedup  Zeta role @ Zeta Co — #111 → #112",
    ]);
  });

  it("truncates long titles and companies with an ellipsis", () => {
    const longTitle = `Financial Planning Associate (Internship Program: Fresh Grad/ IANG /TTPS / QMAS) ${"x".repeat(80)}`;
    const [header, line] = renderTrail({
      droppedCases: [],
      dedupedCases: [
        { title: longTitle, company: "Eternity Wealth Consultancy Company Limited", link: "https://hk.jobsdb.com/job/94012335/apply", keptLink: "https://hk.jobsdb.com/job/94039444/apply" },
      ],
    });
    expect(header).toBe("Deduplicated 1 duplicate listing · 1 unique title");
    expect(line).toMatch(/^  dedup  Financial Planning Associate \(Internship Prog… @ Eternity Wealth Consultan… — #94012335 → #94039444$/);
  });

  it("returns [] when there are no dropped or deduped cases", () => {
    expect(renderTrail({ droppedCases: [], dedupedCases: [] })).toEqual([]);
  });
});

describe("parseDashboardFlags", () => {
  it("parses --port and --port= forms", () => {
    expect(parseDashboardFlags(["--port", "5212"])).toEqual({ port: 5212 });
    expect(parseDashboardFlags(["--port=5213"])).toEqual({ port: 5213 });
    expect(parseDashboardFlags([])).toEqual({});
  });

  it("rejects bad ports and unknown flags", () => {
    expect(parseDashboardFlags(["--port", "abc"]).error).toBeDefined();
    expect(parseDashboardFlags(["--port", "0"]).error).toBeDefined();
    expect(parseDashboardFlags(["--port", "70000"]).error).toBeDefined();
    expect(parseDashboardFlags(["--bogus"]).error).toBeDefined();
  });
});
