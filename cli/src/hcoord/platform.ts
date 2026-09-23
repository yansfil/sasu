import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HcoordError } from "./model";
import { runHerdrCommand } from "../implement/herdr";
import { dataDir, stopMarkerPath } from "./store";

const LABEL = "com.hcoord.daemon";
const plistPath = (home: string): string => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const escapeXml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export const platformSupport = () => ({
  macos: { localSocket: "verified_isolated", loginStart: "unverified", manualStop: "verified_isolated", herdrNotification: "unverified", systemNotification: "unsupported", remoteHerdr: "unsupported" },
  windows: { sharedCore: "implemented_unverified", namedPipe: "unsupported", loginStart: "unsupported", manualStop: "unsupported", desktopNotification: "unsupported", remoteHerdrHost: "unsupported" },
});

/** The title carries only an opaque request ID; the question stays in the private ledger. */
export function notifyHuman(requestId: string): { ok: boolean; code: string } {
  const result = runHerdrCommand(["notification", "show", `hcoord request ${requestId}: open the CLI inbox`, "--sound", "request"], 2000);
  return { ok: result.status === 0, code: result.status === 0 ? "herdr_accepted" : result.status === null ? "runtime_unavailable" : "notification_refused" };
}

export function startDaemon(home = os.homedir()): { label: string; path: string } {
  if (process.platform !== "darwin") throw new HcoordError("unsupported_platform", "automatic daemon start is implemented only for macOS; see hcoord daemon run on a supported host");
  const domain = `gui/${process.getuid!()}`;
  const file = plistPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir(home), { recursive: true, mode: 0o700 });
  fs.rmSync(stopMarkerPath(home), { force: true });
  const executable = path.resolve(__dirname, "cli.js");
  const args = [process.execPath, executable, "daemon", "run"];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${escapeXml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escapeXml(home)}</string><key>PATH</key><string>${escapeXml(process.env["PATH"] ?? "")}</string></dict><key>StandardOutPath</key><string>${escapeXml(path.join(dataDir(home), "daemon.log"))}</string><key>StandardErrorPath</key><string>${escapeXml(path.join(dataDir(home), "daemon.err.log"))}</string></dict></plist>\n`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  const boot = spawnSync("launchctl", ["bootstrap", domain, file], { encoding: "utf8", timeout: 5000 });
  if (boot.status !== 0 && !/already bootstrapped|service already loaded/i.test(`${boot.stderr}${boot.stdout}`)) throw new HcoordError("start_failed", "launchd could not bootstrap coordinator; inspect its stderr log");
  const kick = spawnSync("launchctl", ["kickstart", `${domain}/${LABEL}`], { encoding: "utf8", timeout: 5000 });
  if (kick.status !== 0) throw new HcoordError("start_failed", "launchd could not start coordinator; inspect its stderr log");
  return { label: LABEL, path: file };
}
