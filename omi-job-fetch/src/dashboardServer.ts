import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "./registry.js";
import { loadCron, parseSchedule } from "./cron.js";
import { applyFriendlyUpdate, BASE_CONFIG_REL, configMeta, CRON_CONFIG_DIR, discoverConfigs, readConfig, slugify, validateConfig, writeConfig } from "./dashboardConfig.js";
import { discoverDbs, getJob, isBusyError, listJobs, setJobStatus, deleteDbFile, JOB_STATUSES } from "./dashboardDb.js";
import { getCronState, runCronMutation, tailLog } from "./dashboardCron.js";
import { listRuns, readRunStatus, readRunningMarkers, startRun } from "./dashboardRuns.js";
import { getAnalysisDashboardState } from "./dashboardAnalysis.js";
import { addProvider, enableProvider, loadAnalysisSettings, providerApiKeyStatus, removeProvider, resolveProviderApiKey, saveAnalysisSettings, toPublicSettings, updateProvider, validateSettings, writeProviderApiKey } from "./analysisConfig.js";
import { callProvider } from "./analysisProvider.js";
import { resolveAnalysisState, readActiveMarker } from "./analysisCli.js";
import { createLogger, errorData, logMeta, queryLogs } from "./logger.js";
import type { RunConfig } from "./types.js";
import { ensureUserFiles, userPaths } from "./userPaths.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 5211;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

export interface DashboardOptions {
  port?: number;
  packageDir?: string;
  stateDir?: string;
  cliPath?: string;
  openBrowser?: boolean;
  now?: () => Date;
}
export interface DashboardServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        rejectBody(new Error("invalid JSON body"));
      }
    });
    req.on("error", rejectBody);
  });
}

export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardServer> {
  const packageDir = resolve(options.packageDir ?? PKG);
  const stateDir = options.stateDir ?? join(homedir(), ".omijobs");
  const configDir = options.packageDir === undefined ? ensureUserFiles(packageDir, stateDir).stateDir : packageDir;
  const cliPath = options.cliPath ?? resolve(packageDir, "dist", "cli.js");
  const cronFile = options.packageDir === undefined ? userPaths(stateDir).cronFile : resolve(packageDir, "cron.json");
  const staticRoot = resolve(packageDir, "dashboard");
  const clock = options.now ?? (() => new Date());
  const analysisState = resolveAnalysisState(stateDir);
  const dlog = createLogger({ source: "dashboard" });

  const clients = new Set<ServerResponse>();
  const inflight = new Set<string>();
  let boundPort = options.port ?? DEFAULT_PORT;
  const broadcast = (type: string, payload: unknown) => {
    // Unnamed message events only: `es.onmessage` does NOT fire for named
    // `event: <type>` SSE events, so the type rides inside the data payload.
    const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
    for (const client of clients) {
      try {
        client.write(msg);
      } catch {
        clients.delete(client);
      }
    }
  };

  /** Config ids with a run currently in progress: dashboard-triggered (inflight) + PID-verified running markers. */
  const runningIds = (): Set<string> => {
    const ids = new Set(inflight);
    for (const id of readRunningMarkers(stateDir).keys()) ids.add(id);
    return ids;
  };

  // --- 2s stat-poll: broadcast on changes to cron.json, DB files, cron.log ---
  let lastSeen = new Map<string, number>();
  const watch = setInterval(() => {
    const targets = [cronFile, join(stateDir, "cron.log"), analysisState.active];
    let metas: ReturnType<typeof discoverConfigs> = [];
    try {
      metas = discoverConfigs({ packageDir: configDir, cronFile });
    } catch {
      // unreadable cron.json — still watch the file itself for recovery
    }
    for (const m of metas) targets.push(m.db.path);
    const seen = new Map<string, number>();
    for (const t of targets) {
      try {
        seen.set(t, statSync(t).mtimeMs);
      } catch {
        // missing file
      }
    }
    for (const [path, ms] of seen) {
      if (lastSeen.has(path) && lastSeen.get(path) !== ms) {
        const kind = path === cronFile ? "cron" : path === join(stateDir, "cron.log") ? "state" : path.startsWith(analysisState.dir) ? "analysis" : "db";
        broadcast(kind, {});
      }
    }
    lastSeen = seen;
  }, 2000);

  // --- route handlers ---
  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = path.split("/").filter(Boolean); // ["api", ...]

    if (path === "/api/bootstrap" && method === "GET") {
      sendJson(res, 200, {
        packageDir,
        stateDir,
        configPath: join(configDir, ...BASE_CONFIG_REL.split("/")),
        cronPath: cronFile,
        cliPath,
        port: boundPort,
        adapters: adapters.map((a) => ({ id: a.manifest.id, name: a.manifest.name, family: a.manifest.family })),
      });
      return;
    }

    if (path === "/api/analysis" && method === "GET") {
      sendJson(res, 200, getAnalysisDashboardState({ packageDir, configDir, cronFile, stateDir, now: clock }));
      return;
    }

    if (path === "/api/analysis/run" && method === "POST") {
      let body: Record<string, unknown>;
      try { body = await readBody(req) as Record<string, unknown>; } catch (error) { sendJson(res, 400, { error: errMsg(error) }); return; }
      const dbKey = String(body.db ?? "");
      const settings = loadAnalysisSettings(packageDir, stateDir);
      const provider = settings.providers.find((item) => item.id === settings.enabledProvider);
      if (!provider) { sendJson(res, 400, { error: "No enabled AI provider" }); return; }
      if (providerApiKeyStatus(provider, stateDir) !== "set") { sendJson(res, 400, { error: "Provider API key is not set" }); return; }
      const active = readActiveMarker(analysisState.active);
      if (active) { sendJson(res, 409, { error: "An analysis is already in progress" }); return; }
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((item) => item.id === dbKey);
      if (!meta || !meta.db.exists) { sendJson(res, 400, { error: `No existing DB for "${dbKey}"` }); return; }
      mkdirSync(analysisState.dir, { recursive: true });
      const args = [cliPath, "analyze", "run", dbKey];
      if (body.reanalyze === true) args.push("--reanalyze");
      const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, OMI_JOB_FETCH_TRIGGER: "dashboard", OMI_JOB_FETCH_PROGRESS_FILE: analysisState.log(dbKey), OMI_JOB_FETCH_STOP_FILE: analysisState.stop(dbKey), OMI_JOB_FETCH_RUN_MARKER: analysisState.active } });
      child.unref(); dlog.info("dashboard.run", "analysis run triggered", { kind: "analysis", db: dbKey }); broadcast("analysis", { runningDb: dbKey }); sendJson(res, 200, { ok: true, pid: child.pid ?? null }); return;
    }

    if (path === "/api/analysis/stop" && method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = await readBody(req) as Record<string, unknown>; } catch { /* empty */ }
      const dbKey = String(body.db ?? ""); const active = readActiveMarker(analysisState.active);
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((item) => item.id === dbKey);
      if (!active || !meta || meta.db.path !== active.dbPath) { sendJson(res, 409, { error: "No active analysis for this DB" }); return; }
      mkdirSync(analysisState.dir, { recursive: true }); writeFileSync(analysisState.stop(dbKey), new Date().toISOString()); dlog.info("dashboard.stop", "analysis stop triggered", { kind: "analysis", db: dbKey }); broadcast("analysis", { stopping: dbKey }); sendJson(res, 200, { ok: true }); return;
    }

    const providerRoute = /^\/api\/analysis\/providers(?:\/([^/]+))?$/i.exec(path);
    if (providerRoute && method === "GET") { const settings = loadAnalysisSettings(packageDir, stateDir); sendJson(res, 200, toPublicSettings(settings, stateDir)); return; }
    if (providerRoute && method === "POST") {
      let body: any; try { body = await readBody(req); } catch (error) { sendJson(res, 400, { error: errMsg(error) }); return; }
      try {
        const settings = loadAnalysisSettings(packageDir, stateDir);
        const isUpdate = Boolean(providerRoute[1]);
        const provider = body.provider;
        // Onboarding requires a key; edits keep the existing key when the field is left blank.
        if (!isUpdate && (!body.key || String(body.key).trim() === "")) throw new Error("provider API key is required");
        const next = isUpdate ? updateProvider(settings, providerRoute[1], provider) : addProvider(settings, provider);
        if (body.key && provider?.apiKeyEnv) writeProviderApiKey(provider, String(body.key), stateDir);
        saveAnalysisSettings(stateDir, next);
        sendJson(res, 200, { settings: toPublicSettings(next, stateDir) });
      } catch (error) { sendJson(res, 400, { error: errMsg(error) }); } return;
    }
    if (providerRoute && method === "DELETE") { try { const next = removeProvider(loadAnalysisSettings(packageDir, stateDir), providerRoute[1]); saveAnalysisSettings(stateDir, next); sendJson(res, 200, { settings: toPublicSettings(next, stateDir) }); } catch (error) { sendJson(res, 400, { error: errMsg(error) }); } return; }
    const enableRoute = /^\/api\/analysis\/providers\/([^/]+)\/enable$/i.exec(path);
    if (enableRoute && method === "POST") { try { const next = enableProvider(loadAnalysisSettings(packageDir, stateDir), enableRoute[1]); saveAnalysisSettings(stateDir, next); sendJson(res, 200, { settings: toPublicSettings(next, stateDir) }); } catch (error) { sendJson(res, 400, { error: errMsg(error) }); } return; }
    const testRoute = /^\/api\/analysis\/providers\/([^/]+)\/test$/i.exec(path);
    if (testRoute && method === "POST") {
      const id = decodeURIComponent(testRoute[1]);
      const settings = loadAnalysisSettings(packageDir, stateDir);
      const provider = settings.providers.find((item) => item.id === id);
      if (!provider) { sendJson(res, 404, { error: `provider "${id}" does not exist` }); return; }
      const key = resolveProviderApiKey(provider, stateDir);
      if (!key) { sendJson(res, 200, { ok: false, error: "provider API key is not set" }); return; }
      try {
        const reply = await callProvider(provider, key, [{ role: "system", content: "Reply with the single word OK" }, { role: "user", content: "ping" }]);
        sendJson(res, 200, { ok: true, reply });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: errMsg(error) });
      }
      return;
    }
    if (path === "/api/analysis/settings" && method === "PUT") { try { const body = await readBody(req) as Record<string, unknown>; const current = loadAnalysisSettings(packageDir, stateDir); const next = validateSettings({ ...current, ...body }); saveAnalysisSettings(stateDir, next); sendJson(res, 200, { settings: toPublicSettings(next, stateDir) }); } catch (error) { sendJson(res, 400, { error: errMsg(error) }); } return; }

    if (path === "/api/configs" && method === "GET") {
      const metas = discoverConfigs({ packageDir: configDir, cronFile });
      const counts = new Map(discoverDbs(metas).map((d) => [d.key, d.total]));
      sendJson(res, 200, metas.map((m) => ({ ...m, db: { ...m.db, jobCount: counts.get(m.id) ?? 0 } })));
      return;
    }

    const configsId = /^\/api\/configs\/([^/]+)$/.exec(path);
    if (configsId && method === "GET") {
      const id = decodeURIComponent(configsId[1]);
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      sendJson(res, 200, { config: readConfig(meta.path) });
      return;
    }

    const configsRun = /^\/api\/configs\/([^/]+)\/run$/.exec(path);
    if (configsRun && method === "POST") {
      const id = decodeURIComponent(configsRun[1]);
      if (runningIds().has(id)) {
        sendJson(res, 409, { error: `A run for "${id}" is already in progress — wait for it to finish.` });
        return;
      }
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      inflight.add(id);
      broadcast("runs", { running: id });
      const { id: runId } = startRun({
        cliPath,
        configPath: meta.path,
        trigger: "dashboard",
        jobId: id,
        progressFile: resolve(stateDir, "runs", `${id}.log`),
        stopFile: resolve(stateDir, "runs", `${id}.stop`),
        runMarkerFile: resolve(stateDir, "runs", `${id}.running`),
        onExit: (code) => {
          inflight.delete(id);
          // Belt-and-suspenders: the CLI's finally clears its marker, but if it
          // died without running it, drop the stale marker now.
          rmSync(resolve(stateDir, "runs", `${id}.running`), { force: true });
          broadcast("runs", { done: id, code });
          broadcast("db", {});
        },
      });
      dlog.info("dashboard.run", "run triggered", { kind: "run", id, runId });
      sendJson(res, 200, { ok: true, runId });
      return;
    }

    const configsStop = /^\/api\/configs\/([^/]+)\/stop$/.exec(path);
    if (configsStop && method === "POST") {
      const id = decodeURIComponent(configsStop[1]);
      if (!runningIds().has(id)) {
        sendJson(res, 409, { error: `No run for "${id}" is currently in progress.` });
        return;
      }
      // The CLI (spawned by this dashboard or the gateway) polls this marker and
      // finalizes with the partial results it already collected.
      const stopFile = resolve(stateDir, "runs", `${id}.stop`);
      try {
        mkdirSync(dirname(stopFile), { recursive: true });
        writeFileSync(stopFile, new Date().toISOString(), "utf8");
      } catch (error) {
        dlog.error("dashboard.error", "stop failed", { kind: "run", id, ...errorData(error) });
        sendJson(res, 500, { error: errMsg(error) });
        return;
      }
      dlog.info("dashboard.stop", "run stop triggered", { kind: "run", id });
      broadcast("runs", { stopping: id });
      sendJson(res, 200, { ok: true });
      return;
    }

    const configs = /^\/api\/configs\/([^/]+)$/.exec(path);
    if (configs && method === "PUT") {
      const id = decodeURIComponent(configs[1]);
      const metas = discoverConfigs({ packageDir: configDir, cronFile });
      const meta = metas.find((m) => m.id === id);
      if (!meta) {
        sendJson(res, 404, { error: `No config "${id}"` });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      let config: RunConfig;
      if (body.raw !== undefined) {
        const v = validateConfig(body.raw);
        if (!v.ok) {
          sendJson(res, 400, { error: v.error });
          return;
        }
        config = v.config;
      } else {
        const current = readConfig(meta.path);
        const baseMeta = metas.find((m) => m.kind === "base");
        const baseConfig = baseMeta ? readConfig(baseMeta.path) : undefined;
        config = applyFriendlyUpdate(current, {
          queries: Array.isArray(body.queries) ? body.queries.map(String) : undefined,
          enabledPortals: Array.isArray(body.enabledPortals) ? body.enabledPortals.map(String) : undefined,
          storage: body.storage as "shared" | "separate" | "custom" | undefined,
          dbEnabled: typeof body.dbEnabled === "boolean" ? body.dbEnabled : undefined,
          retentionDays: meta.kind === "base" && typeof body.retentionDays === "number" ? body.retentionDays : undefined,
          baseConfig,
          id,
          stripRetention: meta.kind === "cron",
        });
      }
      writeConfig(meta.path, config);
      const fresh = configMeta(meta.id, meta.kind, meta.path, meta.rel, config);
      broadcast("db", {});
      sendJson(res, 200, { config: fresh, dbWarning: config.db?.enabled === false });
      return;
    }

    if (path === "/api/cron" && method === "GET") {
      // A manual Config-page run blocks the same config id the gateway uses, so
      // pass the live running set (inflight + PID-verified markers) — the same
      // source /api/run/status uses.
      const state = getCronState({ cronFile, stateDir, now: clock(), runningIds: runningIds() });
      sendJson(res, 200, state);
      return;
    }

    if (path === "/api/cron/log" && method === "GET") {
      sendJson(res, 200, { lines: tailLog(stateDir, 30) });
      return;
    }

    if (path === "/api/run/status" && method === "GET") {
      sendJson(res, 200, readRunStatus(stateDir, runningIds()));
      return;
    }

    if (path === "/api/logs" && method === "GET") {
      const q = url.searchParams;
      const limit = Math.max(1, Math.min(Number(q.get("limit") ?? 200), 1000));
      const offset = Math.max(0, Number(q.get("offset") ?? 0));
      sendJson(res, 200, queryLogs({
        source: q.get("source") ?? undefined,
        level: q.get("level") ?? undefined,
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        q: q.get("q") ?? undefined,
        runId: q.get("runId") ?? undefined,
        limit,
        offset,
      }, join(stateDir, "logs")));
      return;
    }

    if (path === "/api/logs/meta" && method === "GET") {
      sendJson(res, 200, logMeta(join(stateDir, "logs")));
      return;
    }

    const cronAction = /^\/api\/cron\/(?!add$)([a-z]+)$/.exec(path);
    if (cronAction && method === "POST") {
      const action = cronAction[1];
      const known = new Set(["start", "stop", "restart", "pause", "resume", "run", "enable", "disable", "remove"]);
      if (!known.has(action)) {
        sendJson(res, 400, { error: `Unknown cron action "${action}"` });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch {
        // no body is fine for start/stop/etc.
      }
      const args = action === "enable" || action === "disable" || action === "remove"
        ? [action, String(body.id ?? "")]
        : [action];
      const result = await runCronMutation({ cliPath, args });
      if (action === "remove") dlog.info("dashboard.remove", "cron job removed", { id: String(body.id ?? "") });
      broadcast("cron", {});
      sendJson(res, result.ok ? 200 : 502, { ...result });
      return;
    }

    if (path === "/api/cron/add" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const name = String(body.name ?? "").trim();
      const schedule = String(body.schedule ?? "").trim();
      if (!name) {
        sendJson(res, 400, { error: "A cron name is required" });
        return;
      }
      let parsed;
      try {
        parsed = parseSchedule(schedule);
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const id = slugify(name);
      if (id === "base") {
        sendJson(res, 400, { error: `A cron job cannot be named "base" — that name belongs to the realtime config.` });
        return;
      }
      const cron = loadCron(cronFile);
      if (cron.jobs.some((j) => j.id === id)) {
        sendJson(res, 409, { error: `A cron job named "${id}" already exists — names must be unique.` });
        return;
      }
      const metas = discoverConfigs({ packageDir: configDir, cronFile });
      const baseMeta = metas.find((m) => m.kind === "base");
      if (!baseMeta) {
        sendJson(res, 500, { error: "No base config.json — cannot create a cron config." });
        return;
      }
      const configRel = typeof body.existing === "string" && body.existing
        ? body.existing
        : `${CRON_CONFIG_DIR}/${id}.config.json`;
      const configPath = resolve(dirname(cronFile), configRel);
      if (!existsSync(configPath)) {
        const baseConfig = readConfig(baseMeta.path);
        writeConfig(
          configPath,
          applyFriendlyUpdate(baseConfig, {
            queries: Array.isArray(body.queries) ? body.queries.map(String) : undefined,
            enabledPortals: Array.isArray(body.enabledPortals) ? body.enabledPortals.map(String) : undefined,
            storage: body.storage === "shared" || body.storage === "separate" || body.storage === "custom" ? body.storage : "shared",
            baseConfig,
            id,
            stripRetention: true,
          }),
        );
      }
      const result = await runCronMutation({
        cliPath,
        args: ["add", "--config", configRel, "--schedule", schedule, "--name", id],
      });
      dlog.info("dashboard.add", "cron job added", { id });
      broadcast("cron", {});
      sendJson(res, result.ok ? 200 : 502, { ...result });
      return;
    }

    if (path === "/api/cron/add-analysis" && method === "POST") {
      let body: Record<string, unknown>;
      try { body = await readBody(req) as Record<string, unknown>; } catch (error) { sendJson(res, 400, { error: errMsg(error) }); return; }
      const result = await runCronMutation({ cliPath, args: ["add-analysis", "--name", String(body.name ?? ""), "--schedule", String(body.schedule ?? ""), "--db", String(body.db ?? "")] });
      dlog.info("dashboard.add", "analysis cron added", { id: String(body.name ?? "") });
      broadcast("cron", {}); sendJson(res, result.ok ? 200 : 502, { ...result }); return;
    }

    if (path === "/api/dbs" && method === "GET") {
      const metas = discoverConfigs({ packageDir: configDir, cronFile });
      sendJson(res, 200, discoverDbs(metas));
      return;
    }

    const dbsId = /^\/api\/dbs\/([^/]+)$/.exec(path);
    if (dbsId && method === "DELETE") {
      const key = decodeURIComponent(dbsId[1]);
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === key);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${key}"` });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch {
        // empty body → empty confirmation
      }
      const confirm = String(body.confirm ?? "").trim();
      if (confirm !== key) {
        sendJson(res, 400, { error: `Type "${key}" to confirm deletion` });
        return;
      }
      if (runningIds().has(key)) {
        sendJson(res, 409, { error: `A run for "${key}" is in progress — stop it first.` });
        return;
      }
      const active = readActiveMarker(analysisState.active);
      if (active && active.dbPath === meta.db.path) {
        sendJson(res, 409, { error: "This DB is being analyzed — stop the analysis first." });
        return;
      }
      const result = deleteDbFile(meta.db.path);
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return;
      }
      broadcast("db", {});
      sendJson(res, 200, { ok: true });
      return;
    }

    const dbJobs = /^\/api\/dbs\/([^/]+)\/jobs$/.exec(path);
    if (dbJobs && method === "GET") {
      const key = decodeURIComponent(dbJobs[1]);
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === key);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${key}"` });
        return;
      }
      // A never-created DB (config db disabled or zero runs so far) isn't an
      // error — the jobs table is just empty.
      if (!meta.db.enabled || !existsSync(meta.db.path)) {
        sendJson(res, 200, { total: 0, rows: [], fields: loadAnalysisSettings(packageDir, stateDir).fields });
        return;
      }
      const q = url.searchParams;
      const dirParam = q.get("dir");
      const result = listJobs(meta.db.path, {
        status: q.get("status") ?? undefined,
        q: q.get("q") ?? undefined,
        sort: q.get("sort") ?? undefined,
        dir: dirParam === "asc" || dirParam === "desc" ? dirParam : undefined,
        limit: Number(q.get("limit") ?? 200),
        offset: Number(q.get("offset") ?? 0),
      });
      sendJson(res, 200, { ...result, fields: loadAnalysisSettings(packageDir, stateDir).fields });
      return;
    }

    const jobDetail = /^\/api\/jobs\/([^/]+)\/(.+)$/.exec(path);
    if (jobDetail && method === "GET") {
      const key = decodeURIComponent(jobDetail[1]);
      const signature = decodeURIComponent(jobDetail[2]);
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === key);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${key}"` });
        return;
      }
      // A never-created DB (config db disabled or zero runs so far) must not
      // create the file or 500 on a missing table — mirror the list route.
      if (!meta.db.enabled || !existsSync(meta.db.path)) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      const detail = getJob(meta.db.path, signature);
      if (!detail) {
        sendJson(res, 404, { error: "job not found" });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (path === "/api/jobs" && method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(req)) as Record<string, unknown>;
      } catch (error) {
        sendJson(res, 400, { error: errMsg(error) });
        return;
      }
      const { dbKey, signature, status } = body;
      if (typeof status !== "string" || !(JOB_STATUSES as readonly string[]).includes(status)) {
        sendJson(res, 400, { error: `status must be one of ${JOB_STATUSES.join(", ")}` });
        return;
      }
      const meta = discoverConfigs({ packageDir: configDir, cronFile }).find((m) => m.id === dbKey);
      if (!meta) {
        sendJson(res, 404, { error: `No source "${String(dbKey)}"` });
        return;
      }
      // A never-created DB must not create the file on a status update.
      if (!meta.db.enabled || !existsSync(meta.db.path)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const r = setJobStatus(meta.db.path, String(signature), status);
      if (!r.ok) {
        if (r.error === "not found") {
          sendJson(res, 404, { error: "job not found" });
        } else if (isBusyError(r.error)) {
          sendJson(res, 409, { error: "The DB is busy — another process is writing it. Try again in a moment.", busy: true });
        } else {
          sendJson(res, 500, { error: r.error ?? "unknown error" });
        }
        return;
      }
      broadcast("db", {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/api/runs" && method === "GET") {
      const metas = discoverConfigs({ packageDir: configDir, cronFile });
      const baseMeta = metas.find((m) => m.kind === "base");
      sendJson(res, 200, listRuns(baseMeta ? resolve(dirname(baseMeta.path), baseMeta.outputDir) : resolve(stateDir, "output")));
      return;
    }

    if (path === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch {
          /* client gone */
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: `No such endpoint: ${method} ${path}` });
  }

  function handleStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const rel = (path === "/" ? "index.html" : path.replace(/^\/+/, "").split("?")[0]);
    const file = resolve(staticRoot, rel);
    if (!file.startsWith(staticRoot + sep) && file !== staticRoot) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, res, url.pathname, url).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: errMsg(error) });
        else res.end();
      });
      return;
    }
    handleStatic(req, res, url.pathname);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(`Port ${options.port ?? DEFAULT_PORT} is already in use. Pass a free port: omijobs dashboard --port 5212`);
    }
    throw error;
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? DEFAULT_PORT;
  boundPort = port;
  const url = `http://127.0.0.1:${port}`;

  if (options.openBrowser !== false) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", windowsHide: true }).unref();
  }

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        clearInterval(watch);
        for (const client of clients) {
          try {
            client.end();
          } catch {
            /* ignore */
          }
        }
        clients.clear();
        server.close(() => resolveClose());
      }),
  };
}
