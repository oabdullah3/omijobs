import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OS-level autostart for the cron gateway (no admin rights — all user-level):
 *
 *   Windows: HKCU Run key        — wscript.exe "<state>\start-gateway.vbs" (hidden window)
 *   macOS:   LaunchAgent plist   — ~/Library/LaunchAgents/com.omijobs.cron.plist, KeepAlive
 *   Linux:   systemd user unit   — ~/.config/systemd/user/omijobs-cron.service, Restart=always
 *
 * The Windows path is exercised on this machine. macOS/Linux writers follow the
 * documented mechanics (plist / systemd unit + launchctl / systemctl) and are
 * unit-tested on command construction, but not against a real box.
 */

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "omijobs-cron";
const STATE_DIR = join(homedir(), ".omijobs");
const GATEWAY_VBS = join(STATE_DIR, "start-gateway.vbs");
const PLIST = join(homedir(), "Library", "LaunchAgents", "com.omijobs.cron.plist");
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "omijobs-cron.service");

export interface AutostartTarget {
  node: string;
  cliPath: string;
}

export interface AutostartResult {
  registered: boolean;
  mechanism: string;
  error?: string;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { ok: r.status === 0, stdout: r.stdout ?? "" };
  } catch (error) {
    return { ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Write the hidden-launcher VBS that starts the gateway without a console
 * window: `WScript.Shell.Run(cmd, 0, False)` — window style 0 = hidden, don't
 * wait. Returns the VBS path. Shared by `registerAutostart` (login) and
 * `cronCli`'s `launchGateway` (manual start) so both paths stay in sync.
 */
export function writeGatewayVbs(target: AutostartTarget): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const cmd = `"${target.node}" "${target.cliPath}" cron gateway`;
  const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`;
  writeFileSync(GATEWAY_VBS, vbs);
  return GATEWAY_VBS;
}

/** Idempotent: registering twice just overwrites. Best-effort, never throws. */
export function registerAutostart(target: AutostartTarget): AutostartResult {
  if (process.platform === "win32") {
    // Launch via wscript (a GUI app) instead of a bare `node` command: node is
    // a console app, so a bare Run-key entry allocates a visible console window
    // at login, and closing it kills the gateway process tree.
    const vbsPath = writeGatewayVbs(target);
    const command = `wscript.exe "${vbsPath}"`;
    const r = run("reg", ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"]);
    return r.ok
      ? { registered: true, mechanism: "Windows HKCU Run key (wscript, hidden)" }
      : { registered: false, mechanism: "Windows HKCU Run key", error: r.error ?? r.stdout };
  }
  if (process.platform === "darwin") {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.omijobs.cron</string>
  <key>ProgramArguments</key>
  <array>
    <string>${target.node}</string>
    <string>${target.cliPath}</string>
    <string>cron</string>
    <string>gateway</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    writeFileSync(PLIST, xml);
    const r = run("launchctl", ["load", PLIST]);
    return r.ok
      ? { registered: true, mechanism: "macOS LaunchAgent (com.omijobs.cron)" }
      : { registered: false, mechanism: "macOS LaunchAgent", error: r.error ?? r.stdout };
  }
  if (process.platform === "linux") {
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    const ini = `[Unit]
Description=omijobs cron gateway

[Service]
Type=simple
ExecStart=${target.node} ${target.cliPath} cron gateway
Restart=always

[Install]
WantedBy=default.target
`;
    writeFileSync(SYSTEMD_UNIT, ini);
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", "omijobs-cron.service"]);
    return r.ok
      ? { registered: true, mechanism: "Linux systemd user unit (omijobs-cron.service)" }
      : { registered: false, mechanism: "Linux systemd user unit", error: r.error ?? r.stdout };
  }
  return { registered: false, mechanism: "unsupported platform" };
}

/** Best-effort removal of the autostart entry. Never throws. */
export function unregisterAutostart(): void {
  if (process.platform === "win32") {
    run("reg", ["delete", RUN_KEY, "/v", VALUE, "/f"]);
  } else if (process.platform === "darwin") {
    run("launchctl", ["unload", PLIST]);
  } else if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", "omijobs-cron.service"]);
  }
}

export function autostartStatus(): string {
  if (process.platform === "win32") {
    const r = run("reg", ["query", RUN_KEY, "/v", VALUE]);
    return r.ok ? "registered (HKCU Run key)" : "not registered";
  }
  if (process.platform === "darwin") {
    return existsSync(PLIST) ? "registered (LaunchAgent)" : "not registered";
  }
  if (process.platform === "linux") {
    const r = run("systemctl", ["--user", "is-enabled", "omijobs-cron.service"]);
    return r.ok && r.stdout.trim() === "enabled" ? "registered (systemd user unit)" : "not registered";
  }
  return "n/a (unsupported platform)";
}
