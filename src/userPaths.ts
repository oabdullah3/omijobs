import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface UserPaths {
  stateDir: string;
  baseConfig: string;
  cronFile: string;
  outputDir: string;
}

export function userPaths(stateDir = join(homedir(), ".omijobs")): UserPaths {
  return {
    stateDir,
    baseConfig: join(stateDir, "dashboard.configs", "realtime", "config.json"),
    cronFile: join(stateDir, "cron.json"),
    outputDir: join(stateDir, "output"),
  };
}

export function ensureUserFiles(packageDir: string, stateDir = join(homedir(), ".omijobs")): UserPaths {
  const paths = userPaths(stateDir);
  mkdirSync(resolve(paths.baseConfig, ".."), { recursive: true });
  if (!existsSync(paths.baseConfig)) copyFileSync(join(packageDir, "config.base.json"), paths.baseConfig);
  if (!existsSync(paths.cronFile)) writeFileSync(paths.cronFile, '{\n  "paused": false,\n  "jobs": []\n}\n', "utf8");
  return paths;
}
