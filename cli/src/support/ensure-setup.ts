import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Lazy auto-provision for the one setup precondition a machine may fix
// unattended: run state under agents/runs/ must never enter commits or PRs.
// Config needs no provisioning (defaults apply while agents/config.json is
// absent) and every other setup item is a human decision that stays in the
// sasu-setup interview, so this remains a single idempotent ignore guard.
// It must stay cheap enough to run on every CLI entry: fs plus two git
// spawns. Full doctor is not an entry check - binaryVersion() probes judge
// binaries with 15s timeouts each.
export function ensureSetup(projectRoot: string): string[] {
  // check-ignore instead of reading ignore files: any matching rule counts
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
  // .git/info/exclude, never .gitignore: the old append mutated the judged
  // working tree at CLI entry, so until a human committed that line every
  // run's diff carried a .gitignore change the run did not make, and
  // fidelity judges failed it as out-of-scope work (2026-08-17
  // dual-implement live run: both concurrent runs FAILed F2/F3 partly on
  // the harness's own append). info/exclude satisfies the same check-ignore
  // contract while staying invisible to source snapshots and judged diffs;
  // a team-shared committed .gitignore remains a human decision for the
  // sasu-setup interview.
  const gitPath = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (gitPath.error !== undefined || gitPath.status !== 0) return [];
  const excludePath = path.resolve(projectRoot, gitPath.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludePath, `${separator}# PRD pipeline runtime state\nagents/runs/\n`);
  return ["setup: ignored agents/runs/ via .git/info/exclude - run state must never enter commits"];
}
