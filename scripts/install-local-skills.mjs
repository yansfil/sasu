#!/usr/bin/env node

// Installs the PRD workflow skills for both runtimes from this repository.
//
// - Codex   (~/.codex/skills):  legacy directory names (intake, prd, ...),
//   SKILL.md copied verbatim. Codex resolves the skill name from frontmatter,
//   so `$listen` etc. work with legacy directories.
// - Claude  (~/.claude/skills): butler directory names (listen, promise, ...),
//   because Claude Code derives the `/command` name from the directory.
//   SKILL.md is copied with path and invocation substitutions so the text
//   references the Claude install locations and `/name` invocations.
//
// SKILL.md is always a real file (Codex skill loading can omit symlinked
// SKILL.md files; Claude copies are substituted). Auxiliary entries such as
// `scripts` and `references` are symlinked back to this repository so both
// installs share one implementation.
//
// The installer also registers the harness Stop hook for Claude Code in
// ~/.claude/settings.json and the Stop/PreToolUse hooks for Codex in
// ~/.codex/hooks.json, idempotently.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const home = process.env.HOME || "";

// dir: repo + Codex install directory (legacy name). name: butler skill name,
// used as the Claude install directory and the invocation token.
const SKILLS = [
  { dir: "intake", name: "listen" },
  { dir: "prd", name: "promise" },
  { dir: "prd-implement", name: "fulfill" },
  { dir: "prd-setup", name: "pantry" },
  { dir: "prd-ship", name: "deliver" },
  { dir: "please", name: "please" },
];

// Codex-only auxiliary entries that make no sense in the Claude install.
const CODEX_ONLY_ENTRIES = new Set(["agents"]);

const TARGETS = {
  codex: {
    root: path.join(home, ".codex", "skills"),
    installDir: skill => skill.dir,
    transformSkillMd: text => text,
  },
  claude: {
    root: path.join(home, ".claude", "skills"),
    installDir: skill => skill.name,
    transformSkillMd: text => substituteForClaude(text),
  },
};

function substituteForClaude(text) {
  let out = text;
  // Path references: ~/.codex/skills/<legacy-dir>/ -> ~/.claude/skills/<butler>/
  // Trailing slash keeps `prd/` distinct from `prd-implement/`.
  for (const skill of SKILLS) {
    out = out.split(`~/.codex/skills/${skill.dir}/`).join(`~/.claude/skills/${skill.name}/`);
  }
  // Invocation tokens: $listen -> /listen (legacy aliases map to butler names).
  const invocation = {
    "prd-implement": "fulfill",
    "prd-setup": "pantry",
    "prd-ship": "deliver",
    intake: "listen",
    prd: "promise",
    listen: "listen",
    promise: "promise",
    fulfill: "fulfill",
    deliver: "deliver",
    pantry: "pantry",
    please: "please",
  };
  out = out.replace(
    /\$(prd-implement|prd-setup|prd-ship|intake|prd|listen|promise|fulfill|deliver|pantry|please)\b/g,
    (match, token) => `/${invocation[token]}`,
  );
  return out;
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

function installSkill(targetKey, skill) {
  const target = TARGETS[targetKey];
  const sourceDir = path.join(skillsRoot, skill.dir);
  if (!fs.existsSync(sourceDir)) throw new Error(`Missing skill source: ${sourceDir}`);
  const targetDir = path.join(target.root, target.installDir(skill));
  assertNotForeign(targetDir, skill.name);

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
    fs.symlinkSync(source, linkTarget, entry.isDirectory() ? "dir" : "file");
  }
  return { skill: skill.name, sourceDir, targetDir };
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
  const fulfillDir = targetKey === "claude" ? "fulfill" : "prd-implement";
  const script = path.join(TARGETS[targetKey].root, fulfillDir, "scripts", "prd_state_harness.js");
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
  codex: SKILLS.map(skill => installSkill("codex", skill)),
  claude: SKILLS.map(skill => installSkill("claude", skill)),
};

const codexHookCommand = harnessHookCommand("codex");
const claudeHookCommand = harnessHookCommand("claude");
const hooks = {
  // Codex uses the PreToolUse guard for premature `update_goal complete`.
  codex: ensureHooks(path.join(home, ".codex", "hooks.json"), {
    Stop: codexHookCommand("stop"),
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
  hooks,
  note: "SKILL.md files are real copies (Claude copies are path/invocation substituted); auxiliary entries are symlinks.",
}, null, 2) + "\n");
