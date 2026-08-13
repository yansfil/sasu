import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Lazy auto-provision for the one setup precondition a machine may fix
// unattended: run state under agents/runs/ must never enter commits or PRs.
// Config needs no provisioning (defaults apply while agents/config.json is
// absent) and every other setup item is a human decision that stays in the
// ho-setup interview, so this remains a single idempotent gitignore guard.
// It must stay cheap enough to run on every CLI entry: fs plus one git spawn.
// Full doctor is not an entry check - binaryVersion() probes judge binaries
// with 15s timeouts each.
export function ensureSetup(projectRoot: string): string[] {
  // check-ignore instead of reading .gitignore text: any matching rule counts
  // (glob forms, nested files, info/exclude), exactly like the doctor check.
  const check = spawnSync("git", ["check-ignore", "-q", "agents/runs/probe"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  // 0: already ignored. >=2 or spawn error: no git checkout, so there is
  // nothing to enforce and the doctor reports that honestly. Only 1 (a git
  // checkout without the rule) needs provisioning.
  if (check.error !== undefined || check.status !== 1) return [];
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(gitignorePath, `${separator}# PRD pipeline runtime state\nagents/runs/\n`);
  return ["setup: added agents/runs/ to .gitignore - run state must never enter commits (commit this line like normal project work)"];
}
