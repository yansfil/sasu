import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The harness lanes whose output is run state, not reviewable project work.
// agents/runs/ holds gate verdicts and implement state; agents/quick/ holds a
// quick lane's generated contract, receipt, verify verdict, evidence blobs and
// its .quick-active.json pointer. Neither is human-approved before it is
// written, so neither belongs in a commit or a PR diff. The committed half of
// the namespace (agents/prd/, agents/rules/, agents/config.json) is approved
// by a person and stays tracked.
export const RUNTIME_IGNORE_ROOTS = ["agents/runs/", "agents/quick/"] as const;

// check-ignore instead of reading ignore files: any matching rule counts
// (glob forms, nested files, info/exclude), exactly like the doctor check.
// Returns true when ignored, false when a git checkout lacks the rule, and
// null when there is no git checkout to enforce anything in.
export function ignoreState(projectRoot: string, root: string): boolean | null {
  const check = spawnSync("git", ["check-ignore", "-q", `${root}probe`], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (check.error !== undefined || check.status === null || check.status >= 2) return null;
  return check.status === 0;
}

// Lazy auto-provision for the one setup precondition a machine may fix
// unattended: run state under the runtime lanes must never enter commits or
// PRs. Config needs no provisioning (defaults apply while agents/config.json
// is absent) and every other setup item is a human decision that stays in the
// sasu-setup interview, so this remains a single idempotent ignore guard.
// It must stay cheap enough to run on every CLI entry: fs plus a couple of git
// spawns. Full doctor is not an entry check - binaryVersion() probes judge
// binaries with 15s timeouts each.
export function ensureSetup(projectRoot: string): string[] {
  const missing = RUNTIME_IGNORE_ROOTS.filter((root) => ignoreState(projectRoot, root) === false);
  if (missing.length === 0) return [];
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
  fs.appendFileSync(excludePath, `${separator}# PRD pipeline runtime state\n${missing.join("\n")}\n`);
  return [`setup: ignored ${missing.join(" and ")} via .git/info/exclude - run state must never enter commits`];
}
