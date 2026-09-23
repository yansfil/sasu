#!/usr/bin/env node

// Installs the PRD workflow skills for both runtimes from this repository.
//
// Both runtimes install the canonical pipeline names. The former ho-*
// compatibility aliases are retired; existing installs of them are removed.
//
// - Codex   (~/.codex/skills/<name>/):  SKILL.md copied verbatim.
// - Claude  (~/.claude/skills/<name>/): SKILL.md copied with substitutions
//   (`~/.codex/skills/` becomes `~/.claude/skills/`, `$name` invocations
//   become `/name`), because Claude Code derives the `/command` from the
//   directory and renders the Codex invocation syntax meaningless.
//
// SKILL.md is always a real file (Codex skill loading can omit symlinked
// SKILL.md files; Claude copies are substituted). Auxiliary entries such as
// `scripts` and `references` are symlinked back to this repository so both
// installs share one implementation.
//
// The installer also retires legacy harness hooks idempotently while
// preserving foreign hooks, and removes pre-rename install directories it
// owns (intake, prd, prd-implement, ...). Hook reconciliation lives in
// cli/lib/hooks.js, shared with `sasu supervisor uninstall`.
//
// It also installs the supervisor LaunchAgent (`sasu supervisor install`)
// and the Observer Stop hook on both runtimes, so a Herdr-dispatched run is
// watched from its first tick (D-03, D-12).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SKILL_NAMES,
  contractFiles,
  runtimeIncludesEntry,
  transformContractFile,
} = require("../cli/lib/skill-contract.js");
const { ensureHooks, runtimeHookFiles } = require("../cli/lib/hooks.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const home = process.env.HOME || "";

// Pre-rename install directories that this pipeline used to own, including
// the retired ho-* compatibility aliases.
const LEGACY_DIRS = ["intake", "prd", "prd-implement", "prd-setup", "prd-ship", "listen", "promise", "fulfill", "pantry", "deliver", "ho-interview", "ho-scope", "ho-spec", "ho-build", "ho-ship", "benchmark-implement"];
// Frontmatter names that mark a legacy install as ours: any current name plus
// every earlier generation (butler set, pre-rename prd-* set).
const OWNED_LEGACY_NAMES = [...SKILL_NAMES, ...LEGACY_DIRS];

const TARGETS = {
  codex: {
    root: path.join(home, ".codex", "skills"),
  },
  claude: {
    root: path.join(home, ".claude", "skills"),
  },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function frontmatterName(skillMdPath) {
  try {
    const text = fs.readFileSync(skillMdPath, "utf8");
    const match = text.match(/^---\n[\s\S]*?^name:\s*(\S+)\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function assertNotForeign(targetDir, expectedName) {
  if (!fs.existsSync(targetDir)) return;
  const targetStat = fs.lstatSync(targetDir);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite ${targetDir}: the existing target is not an owned skill directory.`);
  }
  const existing = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(existing) || !fs.lstatSync(existing).isFile() || fs.lstatSync(existing).isSymbolicLink()) {
    throw new Error(
      `Refusing to overwrite ${targetDir}: the existing directory has no regular SKILL.md proving ownership. ` +
      "Remove or rename the foreign directory first.",
    );
  }
  const name = frontmatterName(existing);
  if (name !== expectedName) {
    throw new Error(
      `Refusing to overwrite ${targetDir}: existing SKILL.md is named '${name ?? "unparseable"}', expected '${expectedName}'. ` +
      "Remove or rename the foreign skill first.",
    );
  }
}

function preflightSkills() {
  for (const targetKey of Object.keys(TARGETS)) {
    for (const name of SKILL_NAMES) {
      // This shared manifest validates every effective contract file, including
      // executable scripts, before any installed runtime surface is changed.
      contractFiles(skillsRoot, name, targetKey);
      assertNotForeign(path.join(TARGETS[targetKey].root, name), name);
    }
  }
}

function installSkill(targetKey, name) {
  const target = TARGETS[targetKey];
  const sourceDir = path.join(skillsRoot, name);
  if (!fs.existsSync(sourceDir)) throw new Error(`Missing skill source: ${sourceDir}`);
  const targetDir = path.join(target.root, name);
  assertNotForeign(targetDir, name);

  ensureDir(targetDir);
  for (const entry of fs.readdirSync(targetDir)) {
    removePath(path.join(targetDir, entry));
  }

  const skillMdSource = path.join(sourceDir, "SKILL.md");
  if (!fs.existsSync(skillMdSource)) throw new Error(`Missing ${skillMdSource}`);
  fs.writeFileSync(
    path.join(targetDir, "SKILL.md"),
    transformContractFile(targetKey, "SKILL.md", fs.readFileSync(skillMdSource, "utf8")),
  );

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "SKILL.md") continue;
    if (!runtimeIncludesEntry(targetKey, entry.name)) continue;
    const source = path.join(sourceDir, entry.name);
    const linkTarget = path.join(targetDir, entry.name);
    removePath(linkTarget);
    // References carry the same runtime-specific paths and invocation tokens
    // as SKILL.md, so the Claude install must substitute them; a symlink would
    // leave ~/.codex paths in every reference command. Scripts stay symlinked
    // for both runtimes (they self-locate from the invoked path).
    if (targetKey === "claude" && entry.isDirectory() && entry.name === "references") {
      ensureDir(linkTarget);
      for (const referenceEntry of fs.readdirSync(source)) {
        const referenceSource = path.join(source, referenceEntry);
        if (referenceEntry.endsWith(".md")) {
          fs.writeFileSync(
            path.join(linkTarget, referenceEntry),
            transformContractFile(
              targetKey,
              `references/${referenceEntry}`,
              fs.readFileSync(referenceSource, "utf8"),
            ),
          );
        } else {
          fs.symlinkSync(referenceSource, path.join(linkTarget, referenceEntry), fs.statSync(referenceSource).isDirectory() ? "dir" : "file");
        }
      }
      continue;
    }
    const linkType = fs.statSync(source).isDirectory() ? "dir" : "file";
    fs.symlinkSync(source, linkTarget, linkType);
  }
  return { skill: name, sourceDir, targetDir };
}

// Remove pre-rename install directories, but only when they are ours: their
// SKILL.md frontmatter must carry one of our current or earlier skill names.
// Anything else is left alone.
function cleanupLegacyDirs(targetKey) {
  const removed = [];
  for (const dir of LEGACY_DIRS) {
    const targetDir = path.join(TARGETS[targetKey].root, dir);
    if (!fs.existsSync(targetDir)) continue;
    const name = frontmatterName(path.join(targetDir, "SKILL.md"));
    if (!OWNED_LEGACY_NAMES.includes(name)) continue;
    removePath(targetDir);
    removed.push(targetDir);
  }
  return removed;
}

// Build the sasu CLI and expose its binary. The shim execs the built
// entry in this repository, so `sasu` always matches the installed
// skills (same-repo versioning is the skew defense from PRD D-06).
function installCliBinary() {
  const cliDir = path.join(repoRoot, "cli");
  if (!fs.existsSync(path.join(cliDir, "package.json"))) {
    return { ok: false, error: "cli/package.json missing" };
  }
  const steps = [];
  if (!fs.existsSync(path.join(cliDir, "node_modules"))) {
    steps.push(["npm", ["ci", "--silent"]]);
  }
  steps.push(["npm", ["run", "build"]]);
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { cwd: cliDir, encoding: "utf8" });
    if (result.status !== 0) {
      return { ok: false, error: `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}` };
    }
  }
  const binDir = process.env.PNPM_HOME
    || (process.platform === "darwin" ? path.join(home, "Library", "pnpm") : path.join(home, ".local", "bin"));
  ensureDir(binDir);
  const shimPath = path.join(binDir, "sasu");
  const entry = path.join(cliDir, "dist", "cli.js");
  const hcoordEntry = path.join(cliDir, "dist", "hcoord", "cli.js");
  const version = spawnSync("node", [entry, "--contract-version"], { encoding: "utf8" });
  if (version.status !== 0) {
    return { ok: false, error: `built CLI version probe failed: ${(version.stderr || version.stdout || "").trim().slice(0, 500)}` };
  }
  if (!fs.existsSync(hcoordEntry)) return { ok: false, error: "built hcoord entrypoint missing" };
  const hcoordShimPath = path.join(binDir, "hcoord");
  fs.writeFileSync(shimPath, `#!/bin/sh\nexec node "${entry}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(hcoordShimPath, `#!/bin/sh\nexec node "${hcoordEntry}" "$@"\n`, { mode: 0o755 });
  return { ok: true, shimPath, hcoordShimPath, contractVersion: (version.stdout || "").trim() };
}

// The LaunchAgent that runs `sasu supervisor tick` every interval. The CLI
// owns the plist and the launchctl calls so they converge on repeat; the
// installer only invokes it with the binary it just built, under this HOME.
// Tests pass a fake launchctl on PATH and an isolated HOME; nothing here
// knows the difference (B14, B20).
function installSupervisor() {
  const entry = path.join(repoRoot, "cli", "dist", "cli.js");
  const result = spawnSync(process.execPath, [entry, "supervisor", "install", "--json"], { encoding: "utf8", env: process.env });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  if (result.status !== 0 || report === null) {
    return { ok: false, error: `sasu supervisor install failed (${result.status ?? "no status"}): ${(report?.message ?? result.stderr ?? result.stdout ?? "").trim().slice(0, 500)}` };
  }
  return { ok: true, ...report.detail, message: report.message };
}

function runInstaller() {
  // Ownership and the complete source manifest are read-only checks. Running
  // them first prevents a later safety refusal from stranding a new CLI shim
  // beside only a subset of the matching skill contracts.
  preflightSkills();

  // The CLI is the authority that executes the installed contracts. Prepare
  // and probe it before touching either runtime tree so a failed build cannot
  // leave new skills paired with an old binary while still exiting zero.
  const cliBinary = installCliBinary();
  if (!cliBinary.ok) {
    return {
      ok: false,
      repoRoot,
      cliBinary,
      installed: { codex: [], claude: [] },
      removedLegacy: { codex: [], claude: [] },
      hooks: null,
      note: "No skill, legacy directory, or hook changes were attempted because CLI preparation failed.",
    };
  }

  for (const key of Object.keys(TARGETS)) ensureDir(TARGETS[key].root);
  const installed = {
    codex: SKILL_NAMES.map(name => installSkill("codex", name)),
    claude: SKILL_NAMES.map(name => installSkill("claude", name)),
  };
  const removedLegacy = {
    codex: cleanupLegacyDirs("codex"),
    claude: cleanupLegacyDirs("claude"),
  };

  // Lifecycle authority stays CLI-owned. These callbacks supply routing and
  // advisory context only; the reminder cannot commit or change run state.
  const challengeTriggerCommand = `node ${path.join(repoRoot, "scripts", "challenge_trigger.mjs")}`;
  const commitReminderCommand = `node ${path.join(repoRoot, "scripts", "commit_reminder.mjs")}`;
  // The Stop hook confirms an Observer handover to the supervisor tick and
  // never blocks a stop; it is the same entry on both runtimes.
  const supervisorStopCommand = `node ${path.join(repoRoot, "scripts", "supervisor_stop.mjs")}`;
  const legacyRetired = fs.existsSync(path.join(home, ".hcoord", "legacy-supervisor-retired"));
  const lifecycleHooks = { UserPromptSubmit: challengeTriggerCommand, PostToolUse: commitReminderCommand, ...(legacyRetired ? {} : { Stop: supervisorStopCommand }) };
  const files = runtimeHookFiles(home);
  const hooks = {
    codex: ensureHooks(files.codex, lifecycleHooks),
    claude: ensureHooks(files.claude, lifecycleHooks),
  };
  const supervisor = legacyRetired ? { ok: true, retired: true, message: "legacy supervisor remains retired" } : installSupervisor();
  return {
    ok: supervisor.ok,
    repoRoot,
    cliBinary,
    installed,
    removedLegacy,
    hooks,
    supervisor,
    note: "SKILL.md files are real copies (Claude copies are path/invocation substituted); auxiliary entries are symlinks.",
  };
}

const report = runInstaller();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
