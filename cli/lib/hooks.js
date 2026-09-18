"use strict";
// Hook reconciliation shared by the installer and `sasu supervisor uninstall`.
//
// One marker list and one reconcile function, so an entry the installer
// registers can always be retracted by the CLI and vice versa. Both
// runtimes use the same hooks shape ({ hooks: { <Event>: [ { hooks: [...] } ] } }).
const fs = require("node:fs");
const path = require("node:path");

// Script basenames that mark a hook entry as ours. Every hook the installer
// has ever registered must stay listed here: the marker is the only way a
// later run can retract an entry it no longer wants without touching a hook
// somebody else installed.
const HARNESS_HOOK_MARKERS = ["prd_state_harness.js", "challenge_trigger.mjs", "commit_reminder.mjs", "supervisor_stop.mjs"];

function ownedBy(markers) {
  return (matcher) => Array.isArray(matcher?.hooks)
    && matcher.hooks.some((hook) => typeof hook?.command === "string" && markers.some((marker) => hook.command.includes(marker)));
}

const isHarnessOwnedHook = ownedBy(HARNESS_HOOK_MARKERS);

function readHooksConfig(file) {
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  return config;
}

function writeHooksConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// Idempotently reconcile harness hook entries in a Claude/Codex-style hooks
// config. An empty desired set retires every legacy harness hook while
// preserving foreign entries and unrelated settings.
function ensureHooks(file, entriesByEvent) {
  const config = readHooksConfig(file);
  let changed = false;
  // Retract harness-owned entries from events we no longer register (e.g. the
  // retired SubagentStop hook); foreign matchers on those events are preserved.
  for (const event of Object.keys(config.hooks)) {
    if (Object.prototype.hasOwnProperty.call(entriesByEvent, event)) continue;
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter((matcher) => !isHarnessOwnedHook(matcher));
    if (kept.length !== existing.length) {
      if (kept.length) config.hooks[event] = kept;
      else delete config.hooks[event];
      changed = true;
    }
  }
  for (const [event, command] of Object.entries(entriesByEvent)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter((matcher) => !isHarnessOwnedHook(matcher));
    const desired = { hooks: [{ type: "command", command, timeout: 10 }] };
    const next = [...kept, desired];
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      config.hooks[event] = next;
      changed = true;
    }
  }
  if (changed) writeHooksConfig(file, config);
  return { file, changed };
}

// Remove only the entries carrying the given markers from every event,
// leaving foreign entries and other harness hooks exactly where they are.
function removeHooks(file, markers) {
  if (!fs.existsSync(file)) return { file, changed: false };
  const config = readHooksConfig(file);
  const owned = ownedBy(markers);
  let changed = false;
  for (const event of Object.keys(config.hooks)) {
    const existing = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const kept = existing.filter((matcher) => !owned(matcher));
    if (kept.length !== existing.length) {
      if (kept.length) config.hooks[event] = kept;
      else delete config.hooks[event];
      changed = true;
    }
  }
  if (changed) writeHooksConfig(file, config);
  return { file, changed };
}

function runtimeHookFiles(home) {
  return { codex: path.join(home, ".codex", "hooks.json"), claude: path.join(home, ".claude", "settings.json") };
}

module.exports = { HARNESS_HOOK_MARKERS, isHarnessOwnedHook, ensureHooks, removeHooks, runtimeHookFiles };
