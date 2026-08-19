import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactLink, createRenderer, findConfig, parseArgs, renderTrail, splitQueries } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses --key value flags", () => {
    const { flags, configPath, help } = parseArgs(["--query", "grad program", "--location", "Hong Kong"]);
    expect(flags).toEqual({ query: "grad program", location: "Hong Kong" });
    expect(configPath).toBeUndefined();
    expect(help).toBe(false);
  });

  it("parses --key=value and coerces numbers", () => {
    const { flags } = parseArgs(["--query=grad", "--page", "3"]);
    expect(flags).toEqual({ query: "grad", page: 3 });
  });

  it("captures --config", () => {
    const { configPath } = parseArgs(["--config", "my/config.json", "--query", "x"]);
    expect(configPath).toBe("my/config.json");
  });

  it("treats a flag with no value as boolean true", () => {
    const { flags } = parseArgs(["--sort"]);
    expect(flags.sort).toBe(true);
  });

  it("rejects positional arguments", () => {
    expect(() => parseArgs(["grad"])).toThrow(/Unexpected positional/);
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
          portals: { enabled: ["gradconnection"], config: {} },
          ats: { enabled: [], config: {} },
          dedup: { fields: ["title"] },
        }),
      );
      const { config } = findConfig(path);
      expect(config.portals.enabled).toEqual(["gradconnection"]);
      expect(config.dedup.fields).toEqual(["title"]);
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

describe("splitQueries", () => {
  it("splits a comma-separated query into trimmed distinct queries", () => {
    expect(splitQueries("finance, grad program, finance ")).toEqual(["finance", "grad program"]);
    expect(splitQueries("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("drops empty and blank entries and handles missing or non-string input", () => {
    expect(splitQueries("")).toEqual([]);
    expect(splitQueries(" , , ")).toEqual([]);
    expect(splitQueries("a,,b,")).toEqual(["a", "b"]);
    expect(splitQueries(undefined)).toEqual([]);
    expect(splitQueries(42)).toEqual(["42"]);
  });
});
