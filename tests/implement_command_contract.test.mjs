import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skill = fs.readFileSync(path.join(repoRoot, "skills", "implement", "SKILL.md"), "utf8");
const cliEntry = path.join(repoRoot, "cli", "dist", "cli.js");

function helpText() {
  return spawnSync(process.execPath, [cliEntry, "--help"], { encoding: "utf8" }).stdout;
}

function documentedCommands() {
  const section = skill.slice(skill.indexOf("## Commands And Authority"), skill.indexOf("## Final Report"));
  return [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
}

test("the skill documents every active implementation command exposed by help", () => {
  const help = helpText();
  const fromHelp = [...help.matchAll(/^  sasu implement ([a-z-]+)/gm)].map((match) => match[1]);
  assert.deepEqual(documentedCommands().sort(), fromHelp.sort());
});

test("the active command registry and skill table agree", async () => {
  const { COMMAND_AUTHORITY, UNGATED_COMMANDS } = await import(path.join(repoRoot, "cli", "dist", "implement", "verbs.js"));
  const dispatched = new Set([...Object.keys(COMMAND_AUTHORITY), ...UNGATED_COMMANDS]);
  assert.deepEqual(documentedCommands().filter((command) => !dispatched.has(command)), []);
  for (const retired of ["finalize", "confirm", "risk", "risk-non-convergent"]) {
    assert.equal(dispatched.has(retired), false);
    assert.doesNotMatch(helpText(), new RegExp(`^  sasu implement ${retired}\\b`, "m"));
  }
});

test("mutating review lifecycle commands fail with explicit retirement guidance", () => {
  for (const command of ["finalize", "confirm", "risk"]) {
    const result = spawnSync(process.execPath, [cliEntry, "implement", command, "--json"], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /retired/);
  }
});
