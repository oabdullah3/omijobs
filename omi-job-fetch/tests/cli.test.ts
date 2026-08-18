import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfig, parseArgs } from "../src/cli.js";

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
