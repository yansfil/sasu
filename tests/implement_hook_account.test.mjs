import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installer = fs.readFileSync(path.join(repoRoot, "scripts", "install-local-skills.mjs"), "utf8");

// AC26. Supervision never arrives as a lifecycle hook that decides anything:
// wake-up is owned by the supervisor tick reading the harness's own state,
// and the one Stop hook the installer registers only confirms a handover and
// always exits 0 (D-10). The marker list is also retraction history -
// anything this installer ever registered must stay listed, or a later run
// cannot withdraw it without disturbing a foreign hook.
test("hook ownership retains retirement history, the approved advisory reminder and the handover-confirming Stop hook", () => {
  const { HARNESS_HOOK_MARKERS } = require(path.join(repoRoot, "cli", "lib", "hooks.js"));
  assert.deepEqual([...HARNESS_HOOK_MARKERS].sort(), ["challenge_trigger.mjs", "commit_reminder.mjs", "prd_state_harness.js", "supervisor_stop.mjs"]);
  assert.match(installer, /require\("\.\.\/cli\/lib\/hooks\.js"\)/, "the installer reconciles hooks through the shared lib, so the CLI's uninstall sees the same markers");
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

// AC28. The polling observer is gone and herdr access is confined to the
// adapter. Asserted structurally rather than trusted to review: the next
// person who needs "just one herdr call" here should have to face this test.
test("AC28: the polling observer is gone and nothing outside the adapter calls herdr", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "skills", "implement", "scripts", "herdr_observer.js")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "tests", "herdr_observer_dispatch.test.mjs")), false);

  const adapter = path.join("cli", "src", "implement", "herdr.ts");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry.name)) walk(relative);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (relative === adapter) continue;
      const body = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      // The adapter is the only place allowed to name the binary in a spawn.
      if (/spawnSync\(\s*"herdr"|execFileSync\(\s*"herdr"/.test(body)) offenders.push(relative);
    }
  };
  walk(path.join("cli", "src"));
  assert.deepEqual(offenders, [], "herdr must be reached only through cli/src/implement/herdr.ts");
});

test("AC28: no 250ms pane poll survives in the harness", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry.name)) walk(relative);
        continue;
      }
      if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
      const body = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      if (/IMPLEMENTOR_WAIT_POLL_MS/.test(body)) offenders.push(relative);
    }
  };
  for (const dir of ["cli/src", "skills", "scripts"]) walk(dir);
  assert.deepEqual(offenders, []);
});

// A deleted file that documents still tell the agent to run is a doc that lies.
test("AC28: no skill document still points at the removed helper", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(relative); continue; }
      if (!entry.name.endsWith(".md")) continue;
      if (/herdr_observer\.js/.test(fs.readFileSync(path.join(repoRoot, relative), "utf8"))) offenders.push(relative);
    }
  };
  walk("skills");
  assert.deepEqual(offenders, []);
});
