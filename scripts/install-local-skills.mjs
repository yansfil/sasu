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
// owns (intake, prd, prd-implement, ...).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const home = process.env.HOME || "";

const SKILL_NAMES = ["interview-me", "gen-prd", "implement", "benchmark-implement", "ship", "sasu-setup", "please", "remember", "quick", "challenge"];

// Pre-rename install directories that this pipeline used to own, including
// the retired ho-* compatibility aliases.
const LEGACY_DIRS = ["intake", "prd", "prd-implement", "prd-setup", "prd-ship", "listen", "promise", "fulfill", "pantry", "deliver", "ho-interview", "ho-scope", "ho-spec", "ho-build", "ho-ship"];
// Frontmatter names that mark a legacy install as ours: any current name plus
// every earlier generation (butler set, pre-rename prd-* set).
const OWNED_LEGACY_NAMES = [...SKILL_NAMES, ...LEGACY_DIRS];

// Codex-only auxiliary entries that make no sense in the Claude install.
const CODEX_ONLY_ENTRIES = new Set(["agents"]);

const TARGETS = {
  codex: {
    root: path.join(home, ".codex", "skills"),
    transformSkillMd: text => text,
  },
  claude: {
    root: path.join(home, ".claude", "skills"),
    transformSkillMd: text => substituteForClaude(text),
  },
};

function substituteForClaude(text) {
  const roots = text.split("~/.codex/skills/").join("~/.claude/skills/");
  // Invocation tokens: $interview-me -> /interview-me.
  return roots.replace(/\$(interview-me|gen-prd|implement|benchmark-implement|ship|sasu-setup|please|remember|quick|challenge)\b/g, "/$1");
}

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
  const existing = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(existing)) return;
  const name = frontmatterName(existing);
  if (name && name !== expectedName) {
    throw new Error(
      `Refusing to overwrite ${targetDir}: existing SKILL.md is named '${name}', expected '${expectedName}'. ` +
      "Remove or rename the foreign skill first.",
    );
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
    target.transformSkillMd(fs.readFileSync(skillMdSource, "utf8")),
  );

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "SKILL.md") continue;
    if (targetKey === "claude" && CODEX_ONLY_ENTRIES.has(entry.name)) continue;
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
            target.transformSkillMd(fs.readFileSync(referenceSource, "utf8")),
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

// Script basenames that mark a hook entry as ours. Every hook this installer
// has ever registered must stay listed here: the marker is the only way a
// later run can retract an entry it no longer wants without touching a hook
// somebody else installed.
const HARNESS_HOOK_MARKERS = ["prd_state_harness.js", "challenge_trigger.mjs"];

function isHarnessOwnedHook(matcher) {
  if (!Array.isArray(matcher?.hooks)) return false;
  return matcher.hooks.some(hook =>
    typeof hook?.command === "string" && HARNESS_HOOK_MARKERS.some(marker => hook.command.includes(marker)));
}

// Idempotently reconcile harness hook entries in a Claude/Codex-style hooks
// config. An empty desired set retires every legacy harness hook while
// preserving foreign entries and unrelated settings.
function ensureHooks(file, entriesByEvent) {
  let config = {};
  if (fs.existsSync(file)) {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  let changed = false;
  // Retract harness-owned entries from events we no longer register (e.g. the
  // retired SubagentStop hook); foreign matchers on those events are preserved.
  for (const event of Object.keys(config.hooks)) {
    if (Object.prototype.hasOwnProperty.call(entriesByEvent, event)) continue;
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter(matcher => !isHarnessOwnedHook(matcher));
    if (kept.length !== existing.length) {
      if (kept.length) config.hooks[event] = kept;
      else delete config.hooks[event];
      changed = true;
    }
  }
  for (const [event, command] of Object.entries(entriesByEvent)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter(matcher => !isHarnessOwnedHook(matcher));
    const desired = { hooks: [{ type: "command", command, timeout: 10 }] };
    const next = [...kept, desired];
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      config.hooks[event] = next;
      changed = true;
    }
  }
  if (changed) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { file, changed };
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
    steps.push(["pnpm", ["install", "--silent"]]);
  }
  steps.push(["pnpm", ["run", "build"]]);
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
  fs.writeFileSync(shimPath, `#!/bin/sh\nexec node "${entry}" "$@"\n`, { mode: 0o755 });
  const version = spawnSync("node", [entry, "--contract-version"], { encoding: "utf8" });
  return { ok: version.status === 0, shimPath, contractVersion: (version.stdout || "").trim() };
}

for (const key of Object.keys(TARGETS)) ensureDir(TARGETS[key].root);

const cliBinary = installCliBinary();

const installed = {
  codex: SKILL_NAMES.map(name => installSkill("codex", name)),
  claude: SKILL_NAMES.map(name => installSkill("claude", name)),
};

const removedLegacy = {
  codex: cleanupLegacyDirs("codex"),
  claude: cleanupLegacyDirs("claude"),
};

// The implement pipeline stays CLI-owned and registers no lifecycle hooks. The
// one exception is the challenge trigger: it is a UserPromptSubmit reader that
// writes nothing and blocks nothing, and it exists in the harness rather than
// in a skill document because the adversarial round cap must be a guard, not a
// request for discipline (PRINCIPLES items 7 and 13).
const challengeTriggerCommand = `node ${path.join(repoRoot, "scripts", "challenge_trigger.mjs")}`;
const lifecycleHooks = { UserPromptSubmit: challengeTriggerCommand };

const hooks = {
  codex: ensureHooks(path.join(home, ".codex", "hooks.json"), lifecycleHooks),
  claude: ensureHooks(path.join(home, ".claude", "settings.json"), lifecycleHooks),
};

process.stdout.write(JSON.stringify({
  ok: cliBinary.ok,
  repoRoot,
  cliBinary,
  installed,
  removedLegacy,
  hooks,
  note: "SKILL.md files are real copies (Claude copies are path/invocation substituted); auxiliary entries are symlinks.",
}, null, 2) + "\n");
