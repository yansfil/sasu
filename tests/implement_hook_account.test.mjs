import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installer = fs.readFileSync(path.join(repoRoot, "scripts", "install-local-skills.mjs"), "utf8");

// AC26. The supervision channel added six ledgers, a waiter and four verbs,
// and none of it may arrive as a lifecycle hook: event wake-up is owned by the
// harness's own state, not by a runtime callback (D-41). The marker list is
// also retraction history - anything this installer ever registered must stay
// listed, or a later run cannot withdraw it without disturbing a foreign hook.
test("AC26: the harness still registers exactly the two hooks it always did", () => {
  const markers = installer.match(/const HARNESS_HOOK_MARKERS = \[([^\]]*)\]/);
  assert.ok(markers, "HARNESS_HOOK_MARKERS must remain declared in the installer");
  const listed = [...markers[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
  assert.deepEqual(listed, ["challenge_trigger.mjs", "prd_state_harness.js"]);
});

test("AC26: no implement source registers a lifecycle hook", () => {
  const implementDir = path.join(repoRoot, "cli", "src", "implement");
  const offenders = [];
  for (const name of fs.readdirSync(implementDir)) {
    if (!name.endsWith(".ts")) continue;
    const body = fs.readFileSync(path.join(implementDir, name), "utf8");
    if (/UserPromptSubmit|PreToolUse|PostToolUse|SessionStart|"hooks"/.test(body)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "implement behaviour must reach the agent through commands, not hooks");
});
