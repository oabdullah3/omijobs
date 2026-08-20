import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyFriendlyUpdate,
  configMeta,
  discoverConfigs,
  readConfig,
  resolveDbPath,
  slugify,
  validateConfig,
  writeConfig,
} from "../src/dashboardConfig.js";
import type { RunConfig } from "../src/types.js";

const BASE: RunConfig = {
  global: { queries: ["finance intern"] },
  portals: { enabled: ["gradconnection"], config: {} },
  ats: { enabled: [], config: {} },
  outputDir: "output",
};

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omijobs-config-"));
  await mkdir(join(dir, "dashboard.configs", "realtime"), { recursive: true });
  await writeFile(join(dir, "dashboard.configs", "realtime", "config.json"), JSON.stringify(BASE));
  return dir;
}

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slugify("Finance Intern 2026")).toBe("finance-intern-2026");
    expect(slugify(" a!!b ")).toBe("a-b");
    expect(slugify("???")).toBe("job");
  });
});

describe("resolveDbPath", () => {
  it("defaults to <outputDir>/jobs.db", () => {
    expect(resolveDbPath(BASE)).toBe(resolve("output", "jobs.db"));
  });
  it("honors db.file", () => {
    expect(resolveDbPath({ ...BASE, db: { file: "mine.db" } })).toBe(resolve("output", "mine.db"));
  });
});

describe("readConfig / writeConfig / validateConfig", () => {
  it("readConfig throws on a missing file", async () => {
    const dir = await makeDir();
    try {
      expect(() => readConfig(join(dir, "nope.json"))).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writeConfig is atomic (no temp file left behind) and readable", async () => {
    const dir = await makeDir();
    try {
      const path = join(dir, "out.json");
      writeConfig(path, { ...BASE, global: { queries: ["q2"] } });
      expect(readConfig(path).global?.queries).toEqual(["q2"]);
      // No leftover temp files.
      const leftovers = (await import("node:fs/promises")).readdir(dir);
      expect((await leftovers).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("validateConfig rejects non-config shapes and accepts a well-formed config", () => {
    expect(validateConfig({}).ok).toBe(false);
    expect(validateConfig({ portals: {}, ats: {} }).ok).toBe(true);
  });
});

describe("discoverConfigs", () => {
  it("returns the base meta plus one meta per cron job, with the db path resolved", async () => {
    const dir = await makeDir();
    try {
      // Point the base config's outputDir at the temp dir: db.exists must be
      // deterministic, and the repo's real output/jobs.db may exist from earlier runs.
      await writeFile(join(dir, "dashboard.configs", "realtime", "config.json"), JSON.stringify({ ...BASE, outputDir: dir }));
      await writeFile(join(dir, "cron.json"), JSON.stringify({
        paused: false,
        jobs: [{ id: "finance", config: "dashboard.configs/cron/finance.config.json", schedule: "every 6 hours" }],
      }));
      // writeFile does not create parents — make the subdir the cron config lives in.
      await mkdir(join(dir, "dashboard.configs", "cron"), { recursive: true });
      await writeFile(
        join(dir, "dashboard.configs", "cron", "finance.config.json"),
        JSON.stringify({ ...BASE, global: { queries: ["grad"] } }),
      );
      const metas = discoverConfigs({ packageDir: dir, cronFile: join(dir, "cron.json") });
      expect(metas.map((m) => m.id)).toEqual(["base", "finance"]);
      const base = metas[0];
      expect(base.kind).toBe("base");
      expect(base.db.enabled).toBe(true);
      expect(base.db.file).toBe("jobs.db");
      expect(base.db.exists).toBe(false);
      expect(base.queries).toEqual(["finance intern"]);
      const fin = metas[1];
      expect(fin.kind).toBe("cron");
      expect(fin.queries).toEqual(["grad"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports db.enabled false for a config that opted out", async () => {
    const dir = await makeDir();
    try {
      const meta = configMeta("base", "base", join(dir, "config.json"), "config.json", {
        ...BASE,
        db: { enabled: false },
      });
      expect(meta.db.enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applyFriendlyUpdate", () => {
  const cron: RunConfig = { ...BASE, global: { queries: ["old"] } };

  it("replaces queries", () => {
    expect(applyFriendlyUpdate(cron, { queries: ["a", "b"] }).global?.queries).toEqual(["a", "b"]);
  });

  it("routes all enabled endpoints to portals when no ats adapters are registered", () => {
    const out = applyFriendlyUpdate(cron, { enabledPortals: ["gradconnection", "linkedin"] });
    expect(out.portals.enabled).toEqual(["gradconnection", "linkedin"]);
    expect(out.ats.enabled).toEqual([]);
  });

  it("storage 'shared' points db.file at the base config's file and enables it", () => {
    const out = applyFriendlyUpdate(cron, { storage: "shared", baseConfig: BASE, id: "finance" });
    expect(out.db).toEqual({ enabled: true, file: "jobs.db" });
  });

  it("storage 'separate' names the db <slug>.db", () => {
    const out = applyFriendlyUpdate(cron, { storage: "separate", baseConfig: BASE, id: "Finance Intern" });
    expect(out.db).toEqual({ enabled: true, file: "finance-intern.db" });
  });

  it("storage 'custom' leaves db untouched", () => {
    const withDb = { ...cron, db: { enabled: false, file: "x.db" } };
    expect(applyFriendlyUpdate(withDb, { storage: "custom" })).toEqual(withDb);
  });

  it("dbEnabled false opts out and warns downstream", () => {
    expect(applyFriendlyUpdate(cron, { dbEnabled: false }).db?.enabled).toBe(false);
  });
});
