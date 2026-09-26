import { convergeLaunchAgent, kickstartLabel, labelStatus, removeLaunchAgent, type InstallResult, type LaunchAgentStatus, type LaunchdEnvironment, type UninstallResult } from "../support/launchd";
import { LAUNCHD_LABEL, launchAgentPlistPath, launchdLogPath, TICK_INTERVAL_SECONDS } from "./paths";

export type { InstallResult, LaunchAgentStatus, LaunchctlRun, LaunchdEnvironment, UninstallResult } from "../support/launchd";

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
    "    <string>--quiet</string>",
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

const supervisorAgent = (environment: LaunchdEnvironment) => ({ label: LAUNCHD_LABEL, plistPath: launchAgentPlistPath(environment.env ?? process.env) });

export function launchAgentStatus(environment: LaunchdEnvironment = {}): LaunchAgentStatus {
  return labelStatus(supervisorAgent(environment), environment);
}

/**
 * Converge the LaunchAgent on the given spec (engineering 11): unchanged
 * bytes and a loaded label ask launchd nothing; changed bytes reload the
 * label (bootout, bootstrap) so the running definition matches the file;
 * an unloaded label is bootstrapped.
 */
export function installLaunchAgent(spec: LaunchAgentSpec, environment: LaunchdEnvironment = {}): InstallResult {
  return convergeLaunchAgent(supervisorAgent(environment), renderPlist(spec), environment);
}

/** Remove only what install created: the label and its plist (D-12). */
export function uninstallLaunchAgent(environment: LaunchdEnvironment = {}): UninstallResult {
  return removeLaunchAgent(supervisorAgent(environment), environment);
}

/** Ask launchd to run the tick now rather than at the next interval; a missing label is reported, never bootstrapped here. */
export function kickstart(environment: LaunchdEnvironment = {}): { ok: boolean; detail: string | null } {
  return kickstartLabel(LAUNCHD_LABEL, environment);
}
