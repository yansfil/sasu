import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL, launchAgentPlistPath, launchdLogPath, TICK_INTERVAL_SECONDS } from "./paths";

/**
 * The user LaunchAgent that runs `sasu supervisor tick` (D-03).
 *
 * `StartInterval` rather than `KeepAlive`: the tick is a one-shot process
 * and launchd starts it again every interval, keeps one instance per label,
 * and starts it at login. There is no long-lived daemon, no lease and no
 * PID file to go stale. The program is the absolute node and cli.js of the
 * installing checkout, and PATH is copied from the installer's shell because
 * launchd's own PATH has neither herdr nor a Homebrew git.
 */
export interface LaunchAgentSpec {
  node: string;
  cli: string;
  home: string;
  path: string;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(spec: LaunchAgentSpec): string {
  const log = launchdLogPath({ HOME: spec.home });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(spec.node)}</string>`,
    `    <string>${xml(spec.cli)}</string>`,
    "    <string>supervisor</string>",
    "    <string>tick</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${TICK_INTERVAL_SECONDS}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    <string>${xml(spec.home)}</string>`,
    "    <key>PATH</key>",
    `    <string>${xml(spec.path)}</string>`,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(spec.home)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export type LaunchctlRun = (args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultLaunchctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const executed = spawnSync("launchctl", args, { encoding: "utf8", shell: false, timeout: 15_000 });
  if (executed.error !== undefined) return { status: null, stdout: "", stderr: String(executed.error) };
  return { status: executed.status, stdout: executed.stdout ?? "", stderr: executed.stderr ?? "" };
}

export interface LaunchdEnvironment {
  env?: NodeJS.ProcessEnv;
  launchctl?: LaunchctlRun;
  uid?: number;
}

const domain = (environment: LaunchdEnvironment): string => `gui/${environment.uid ?? os.userInfo().uid}`;

export interface LaunchAgentStatus {
  plistPath: string;
  installed: boolean;
  /** launchd's answer for the label: loaded, not loaded, or a launchctl failure. */
  loaded: boolean | null;
  detail: string | null;
}

export function launchAgentStatus(environment: LaunchdEnvironment = {}): LaunchAgentStatus {
  const env = environment.env ?? process.env;
  const plistPath = launchAgentPlistPath(env);
  const launchctl = environment.launchctl ?? defaultLaunchctl;
  const printed = launchctl(["print", `${domain(environment)}/${LAUNCHD_LABEL}`]);
  if (printed.status === 0) return { plistPath, installed: fs.existsSync(plistPath), loaded: true, detail: null };
  if (printed.status === null) return { plistPath, installed: fs.existsSync(plistPath), loaded: null, detail: `launchctl unavailable: ${printed.stderr.trim()}` };
  return { plistPath, installed: fs.existsSync(plistPath), loaded: false, detail: (printed.stderr || printed.stdout).trim() || `launchctl print exited ${printed.status}` };
}

export interface InstallResult {
  plistPath: string;
  /** written when the plist bytes changed, unchanged otherwise. */
  plist: "written" | "unchanged";
  /** What launchctl was asked to do, in order; a converged install asks nothing. */
  launchctl: string[];
  loaded: boolean;
  problem: string | null;
}

/**
 * Converge the LaunchAgent on the given spec (engineering 11): unchanged
 * bytes and a loaded label ask launchd nothing; changed bytes reload the
 * label (bootout, bootstrap) so the running definition matches the file;
 * an unloaded label is bootstrapped.
 */
export function installLaunchAgent(spec: LaunchAgentSpec, environment: LaunchdEnvironment = {}): InstallResult {
  const env = environment.env ?? process.env;
  const plistPath = launchAgentPlistPath(env);
  const launchctl = environment.launchctl ?? defaultLaunchctl;
  const asked: string[] = [];
  const call = (args: string[]): { ok: boolean; detail: string } => {
    asked.push(args.join(" "));
    const executed = launchctl(args);
    return { ok: executed.status === 0, detail: (executed.stderr || executed.stdout).trim() || `launchctl ${args[0]} exited ${executed.status ?? "without status"}` };
  };
  const rendered = renderPlist(spec);
  const current = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, "utf8") : null;
  const changed = current !== rendered;
  const before = launchAgentStatus(environment);
  if (changed) {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, rendered);
  }
  const target = `${domain(environment)}/${LAUNCHD_LABEL}`;
  if (before.loaded === true && changed) {
    const out = call(["bootout", target]);
    if (!out.ok) return { plistPath, plist: "written", launchctl: asked, loaded: true, problem: `bootout failed, the old definition is still loaded: ${out.detail}` };
  }
  if (before.loaded !== true || changed) {
    const boot = call(["bootstrap", domain(environment), plistPath]);
    if (!boot.ok) return { plistPath, plist: changed ? "written" : "unchanged", launchctl: asked, loaded: false, problem: `bootstrap failed: ${boot.detail}` };
  }
  return { plistPath, plist: changed ? "written" : "unchanged", launchctl: asked, loaded: true, problem: null };
}

export interface UninstallResult {
  plistPath: string;
  plist: "removed" | "absent";
  launchctl: string[];
  problem: string | null;
}

/** Remove only what install created: the label and its plist (D-12). */
export function uninstallLaunchAgent(environment: LaunchdEnvironment = {}): UninstallResult {
  const env = environment.env ?? process.env;
  const plistPath = launchAgentPlistPath(env);
  const launchctl = environment.launchctl ?? defaultLaunchctl;
  const asked: string[] = [];
  const before = launchAgentStatus(environment);
  let problem: string | null = null;
  if (before.loaded === true) {
    const args = ["bootout", `${domain(environment)}/${LAUNCHD_LABEL}`];
    asked.push(args.join(" "));
    const out = launchctl(args);
    if (out.status !== 0) problem = `bootout failed: ${(out.stderr || out.stdout).trim()}`;
  }
  const existed = fs.existsSync(plistPath);
  if (existed && problem === null) fs.rmSync(plistPath);
  return { plistPath, plist: existed && problem === null ? "removed" : "absent", launchctl: asked, problem };
}

/** Ask launchd to run the tick now rather than at the next interval; a missing label is reported, never bootstrapped here. */
export function kickstart(environment: LaunchdEnvironment = {}): { ok: boolean; detail: string | null } {
  const launchctl = environment.launchctl ?? defaultLaunchctl;
  const out = launchctl(["kickstart", `${domain(environment)}/${LAUNCHD_LABEL}`]);
  return { ok: out.status === 0, detail: out.status === 0 ? null : (out.stderr || out.stdout).trim() || `launchctl kickstart exited ${out.status ?? "without status"}` };
}
