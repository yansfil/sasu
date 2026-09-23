#!/usr/bin/env node
// Registers (or removes) the optional recovery hook in both runtimes.
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
const CHECKPOINT = path.join(HOOK_DIR, "git-checkpoint.mjs");
const OWNED_MARKERS = ["git-checkpoint.sh", "git-checkpoint.mjs", "worktree-create.sh"];

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const TARGETS = [
  {
    runtime: "claude",
    file: path.join(os.homedir(), ".claude", "settings.json"),
    events: {
      Stop: { command: `node ${shellQuote(CHECKPOINT)}`, timeout: 20, statusMessage: "Saving recovery snapshot…" },
    },
  },
  {
    runtime: "codex",
    file: path.join(os.homedir(), ".codex", "hooks.json"),
    events: {
      Stop: { command: `node ${shellQuote(CHECKPOINT)}`, timeout: 20 },
    },
  },
];

function withoutOwnedCommands(matcher) {
  if (!matcher || !Array.isArray(matcher.hooks)) return matcher;
  const hooks = matcher.hooks.filter(h => !(typeof h?.command === "string" && OWNED_MARKERS.some(marker => h.command.includes(marker))));
  return hooks.length > 0 ? { ...matcher, hooks } : null;
}

function stripOwned(matchers) {
  return matchers.map(withoutOwnedCommands).filter(Boolean);
}

function apply(target, uninstall) {
  const config = fs.existsSync(target.file) ? JSON.parse(fs.readFileSync(target.file, "utf8")) : {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  const before = JSON.stringify(config.hooks);

  for (const event of Object.keys(config.hooks)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = stripOwned(existing);
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  for (const [event, entry] of Object.entries(target.events)) {
    const kept = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
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
if (!uninstall && !fs.existsSync(CHECKPOINT)) throw new Error(`missing hook script: ${CHECKPOINT}`);
const results = TARGETS.map(t => apply(t, uninstall));
console.log(JSON.stringify({ action: uninstall ? "uninstall" : "install", results }, null, 2));
