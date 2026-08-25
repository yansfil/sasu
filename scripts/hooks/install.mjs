#!/usr/bin/env node
// Registers (or removes) the two optional git-safety hooks in both runtimes.
//
//   node scripts/hooks/install.mjs              register
//   node scripts/hooks/install.mjs --uninstall  remove
//
// Deliberately separate from install-local-skills.mjs: these hooks are an
// opt-in machine-wide policy, not part of the skill contract. Keeping them in
// their own script means the skill installer never has to special-case
// "registered but not by me" entries - it simply sees foreign hooks and
// preserves them.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOOK_DIR = path.resolve(import.meta.dirname);
const CHECKPOINT = path.join(HOOK_DIR, "git-checkpoint.sh");
const WORKTREE = path.join(HOOK_DIR, "worktree-create.sh");

// Claude Code has a worktree lifecycle event; Codex does not.
const TARGETS = [
  {
    runtime: "claude",
    file: path.join(os.homedir(), ".claude", "settings.json"),
    events: {
      Stop: { command: CHECKPOINT, timeout: 20, statusMessage: "Checkpointing…" },
      WorktreeCreate: { command: WORKTREE, timeout: 300, statusMessage: "Preparing worktree…" },
    },
  },
  {
    runtime: "codex",
    file: path.join(os.homedir(), ".codex", "hooks.json"),
    events: {
      Stop: { command: CHECKPOINT, timeout: 20 },
    },
  },
];

const isOurs = matcher =>
  Array.isArray(matcher?.hooks) &&
  matcher.hooks.some(h => typeof h?.command === "string" && h.command.startsWith(HOOK_DIR));

function apply(target, uninstall) {
  const config = fs.existsSync(target.file) ? JSON.parse(fs.readFileSync(target.file, "utf8")) : {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  const before = JSON.stringify(config.hooks);

  for (const [event, entry] of Object.entries(target.events)) {
    const kept = (Array.isArray(config.hooks[event]) ? config.hooks[event] : []).filter(m => !isOurs(m));
    const next = uninstall ? kept : [...kept, { hooks: [{ type: "command", ...entry }] }];
    if (next.length) config.hooks[event] = next;
    else delete config.hooks[event];
  }

  const changed = JSON.stringify(config.hooks) !== before;
  if (changed) {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { runtime: target.runtime, file: target.file, changed };
}

const uninstall = process.argv.includes("--uninstall");
for (const script of [CHECKPOINT, WORKTREE]) {
  if (!uninstall && !fs.existsSync(script)) throw new Error(`missing hook script: ${script}`);
}
const results = TARGETS.map(t => apply(t, uninstall));
console.log(JSON.stringify({ action: uninstall ? "uninstall" : "install", results }, null, 2));
