import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Public contract: the skill document's Command Contract, `sasu --help`, and the
// CLI's own command registry are three declarations of one surface. A doc
// that promises a flag the CLI does not have, or hides one it does, is worse
// than no doc: the agent reading it is the one that acts on it.
//
// Compared in BOTH directions on purpose. A one-way check ("everything
// documented exists") passes a document that documents nothing.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skillPath = path.join(repoRoot, "skills", "implement", "SKILL.md");
const cliEntry = path.join(repoRoot, "cli", "dist", "cli.js");

/** Flags every command takes; the table says so once instead of each time. */
const GLOBAL_FLAGS = new Set(["json", "slug", "state", "adopt", "issuer"]);

const flagsIn = (text) => new Set(
  [...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]).filter((flag) => !GLOBAL_FLAGS.has(flag)),
);

/**
 * `sasu --help`, read as {command -> flags}. A command with two usage lines
 * (`risk` and `risk --non-convergent`) is keyed by the mode-selecting flag, which
 * is how the authority table keys it too.
 */
function helpSurface() {
  const executed = spawnSync(process.execPath, [cliEntry, "--help"], { encoding: "utf8" });
  // `--help` exits non-zero by design (it is usage, not a successful run).
  assert.ok(executed.stdout.includes("sasu implement"), executed.stderr);
  const surface = new Map();
  for (const line of executed.stdout.split("\n")) {
    const match = line.match(/^\s{2}sasu implement ([a-z-]+)\s+(.*)$/);
    if (!match) continue;
    const [, command, rest] = match;
    const flags = flagsIn(rest);
    // The mode flag names the row rather than counting as one of its flags.
    const mode = ["non-convergent"].find((candidate) => flags.has(candidate));
    const key = mode === undefined ? command : `${command} --${mode}`;
    if (mode !== undefined) flags.delete(mode);
    const existing = surface.get(key);
    if (existing === undefined) surface.set(key, flags);
    else for (const flag of flags) existing.add(flag);
  }
  return surface;
}

/** The Command Contract table, read the same way. */
function documentedSurface() {
  const lines = fs.readFileSync(skillPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Command Contract");
  assert.ok(start !== -1, "SKILL.md must carry a `## Command Contract` section");
  const surface = new Map();
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ") && i > start) break;
    const match = lines[i].match(/^\| `([a-z-]+(?: --[a-z-]+)?)` \| (.*?) \| (.*?) \| (.*?) \|$/);
    if (!match) continue;
    const [, command, required, optional] = match;
    surface.set(command, new Set([...flagsIn(required), ...flagsIn(optional)]));
  }
  assert.ok(surface.size > 10, `the contract table parsed ${surface.size} rows - the table shape drifted`);
  return surface;
}

test("the documented command set and the --help command set match in both directions", () => {
  const help = helpSurface();
  const documented = documentedSurface();
  const undocumented = [...help.keys()].filter((command) => !documented.has(command));
  const invented = [...documented.keys()].filter((command) => !help.has(command));
  assert.deepEqual(undocumented, [], "these commands are in --help and not in the Command Contract table");
  assert.deepEqual(invented, [], "these commands are in the table and not in --help");
});

test("each command's documented flags and its --help flags match in both directions", () => {
  const help = helpSurface();
  const documented = documentedSurface();
  const mismatches = [];
  for (const [command, helpFlags] of help) {
    const documentedFlags = documented.get(command) ?? new Set();
    const missing = [...helpFlags].filter((flag) => !documentedFlags.has(flag)).sort();
    const extra = [...documentedFlags].filter((flag) => !helpFlags.has(flag)).sort();
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push(`${command}: undocumented ${missing.join(",") || "none"} / not in --help ${extra.join(",") || "none"}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test("every documented command is one the CLI actually dispatches", async () => {
  // The two set comparisons above are documents agreeing with each other.
  // This one ties the table to code, so a pair of documents cannot agree on a
  // command that does not exist (approved workflow plan section 16).
  const { COMMAND_AUTHORITY, UNGATED_COMMANDS } = await import(path.join(repoRoot, "cli", "dist", "implement", "verbs.js"));
  const dispatched = new Set([...Object.keys(COMMAND_AUTHORITY), ...UNGATED_COMMANDS]);
  const orphans = [...documentedSurface().keys()]
    .map((command) => command.replace("risk --non-convergent", "risk-non-convergent"))
    .filter((command) => !dispatched.has(command));
  assert.deepEqual(orphans, [], "the table documents a command the CLI does not dispatch");
});

test("the documented issuer column is the authority table, not a retelling of it", async () => {
  const { COMMAND_AUTHORITY } = await import(path.join(repoRoot, "cli", "dist", "implement", "verbs.js"));
  const lines = fs.readFileSync(skillPath, "utf8").split("\n");
  const mismatches = [];
  for (const line of lines) {
    const match = line.match(/^\| `([a-z-]+(?: --[a-z-]+)?)` \| .*? \| .*? \| (.*?) \|$/);
    if (!match) continue;
    const key = match[1].replace("risk --non-convergent", "risk-non-convergent");
    const allowed = COMMAND_AUTHORITY[key];
    const documented = match[2].trim();
    if (allowed === undefined) {
      // Ungated surfaces are documented as "anyone"; claiming otherwise would
      // promise a restriction the gate does not enforce.
      if (documented !== "anyone") mismatches.push(`${key}: documented "${documented}" but the gate restricts nothing`);
      continue;
    }
    const expected = [...allowed].join(", ");
    if (documented !== expected) mismatches.push(`${key}: documented "${documented}", gate allows "${expected}"`);
  }
  assert.deepEqual(mismatches, []);
});
