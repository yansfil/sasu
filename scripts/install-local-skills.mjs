#!/usr/bin/env node

// Installs the PRD workflow skills for both runtimes from this repository.
//
// Both runtimes install the canonical pipeline names plus thin compatibility
// aliases for the former ho-* invocations.
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
// The installer also registers the harness hooks idempotently
// (~/.codex/hooks.json: Stop/PreToolUse/SubagentStop; ~/.claude/settings.json:
// Stop only, since Claude Code has no update_goal tool) and removes legacy
// pre-rename install directories it owns (intake, prd, prd-implement, ...).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const home = process.env.HOME || "";

const CANONICAL_SKILL_NAMES = ["interview-me", "gen-prd", "implement", "ship", "ho-setup", "please", "remember"];
const COMPATIBILITY_SKILL_NAMES = ["ho-interview", "ho-scope", "ho-spec", "ho-build", "ho-ship"];
const SKILL_NAMES = [...CANONICAL_SKILL_NAMES, ...COMPATIBILITY_SKILL_NAMES];

// Pre-rename install directories that this pipeline used to own.
const LEGACY_DIRS = ["intake", "prd", "prd-implement", "prd-setup", "prd-ship", "listen", "promise", "fulfill", "pantry", "deliver"];
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
  return roots.replace(/\$(interview-me|gen-prd|implement|ship|ho-setup|please|remember|ho-interview|ho-scope|ho-spec|ho-build|ho-ship)\b/g, "/$1");
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

// Version-manager node paths (nvm, fnm) die on version switches, which would
// silently kill the hooks. Prefer a stable system node for hook commands.
function hookNodeBinary() {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function harnessHookCommand(targetKey) {
  const script = path.join(TARGETS[targetKey].root, "implement", "scripts", "prd_state_harness.js");
  return kind => `"${hookNodeBinary()}" "${script}" hook ${kind}`;
}

// Idempotently ensure the harness hook entries exist in a Claude/Codex-style
// hooks config. Entries whose command mentions prd_state_harness.js are
// replaced (paths may have changed); everything else is preserved.
function ensureHooks(file, entriesByEvent) {
  let config = {};
  if (fs.existsSync(file)) {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  let changed = false;
  for (const [event, command] of Object.entries(entriesByEvent)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter(matcher =>
      !(Array.isArray(matcher.hooks) && matcher.hooks.some(hook =>
        typeof hook.command === "string" && hook.command.includes("prd_state_harness.js"))));
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

for (const key of Object.keys(TARGETS)) ensureDir(TARGETS[key].root);

const installed = {
  codex: SKILL_NAMES.map(name => installSkill("codex", name)),
  claude: SKILL_NAMES.map(name => installSkill("claude", name)),
};

const removedLegacy = {
  codex: cleanupLegacyDirs("codex"),
  claude: cleanupLegacyDirs("claude"),
};

const codexHookCommand = harnessHookCommand("codex");
const claudeHookCommand = harnessHookCommand("claude");
const hooks = {
  // Codex uses the PreToolUse guard for premature `update_goal complete`.
  codex: ensureHooks(path.join(home, ".codex", "hooks.json"), {
    Stop: codexHookCommand("stop"),
    SubagentStop: codexHookCommand("subagent-stop"),
    PreToolUse: codexHookCommand("pretool-use"),
  }),
  // Claude Code has no update_goal tool; the Stop hook is the only guard.
  claude: ensureHooks(path.join(home, ".claude", "settings.json"), {
    Stop: claudeHookCommand("stop"),
  }),
};

process.stdout.write(JSON.stringify({
  ok: true,
  repoRoot,
  installed,
  removedLegacy,
  hooks,
  note: "SKILL.md files are real copies (Claude copies are path/invocation substituted); auxiliary entries are symlinks.",
}, null, 2) + "\n");
