import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const installer = path.join(repoRoot, "scripts", "install-local-skills.mjs");

function runInstaller(home, options = {}) {
  const result = spawnSync(process.execPath, [installer], {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`Installer failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "install-skills-home-"));
}

test("installer installs both runtimes with correct layouts and substitutions", () => {
  const home = freshHome();
  const result = runInstaller(home);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);

  // Codex: legacy directory names, verbatim SKILL.md.
  const codexFulfill = path.join(home, ".codex", "skills", "prd-implement", "SKILL.md");
  const codexText = fs.readFileSync(codexFulfill, "utf8");
  assert.match(codexText, /~\/\.codex\/skills\/prd-implement\/scripts\/prd_state_harness\.js/);
  assert.match(codexText, /"\$fulfill"/);

  // Claude: butler directory names, substituted SKILL.md.
  const claudeFulfill = path.join(home, ".claude", "skills", "fulfill", "SKILL.md");
  const claudeText = fs.readFileSync(claudeFulfill, "utf8");
  assert.match(claudeText, /~\/\.claude\/skills\/fulfill\/scripts\/prd_state_harness\.js/);
  assert.match(claudeText, /"\/fulfill"/);
  assert.doesNotMatch(claudeText, /~\/\.codex\/skills\//);
  assert.doesNotMatch(claudeText, /\$(listen|promise|fulfill|deliver|pantry|please|intake|prd)\b/);

  // please references its siblings through the Claude install paths.
  const claudePlease = fs.readFileSync(path.join(home, ".claude", "skills", "please", "SKILL.md"), "utf8");
  assert.match(claudePlease, /~\/\.claude\/skills\/promise\/SKILL\.md/);
  assert.doesNotMatch(claudePlease, /~\/\.claude\/skills\/prd\//);

  // Auxiliary entries are symlinks into the repo; Codex-only entries are skipped for Claude.
  const claudeScripts = path.join(home, ".claude", "skills", "fulfill", "scripts");
  assert.ok(fs.lstatSync(claudeScripts).isSymbolicLink());
  assert.equal(fs.realpathSync(claudeScripts), fs.realpathSync(path.join(repoRoot, "skills", "prd-implement", "scripts")));
  assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "prd-implement", "agents")));
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "fulfill", "agents")), false);

  // Hooks: Codex gets Stop + PreToolUse, Claude gets Stop only.
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.ok(codexHooks.hooks.Stop.some(matcher => matcher.hooks.some(hook => hook.command.includes("prd_state_harness.js"))));
  assert.ok(codexHooks.hooks.PreToolUse.some(matcher => matcher.hooks.some(hook => hook.command.includes("hook pretool-use"))));
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(claudeSettings.hooks.Stop.some(matcher => matcher.hooks.some(hook => hook.command.includes("prd_state_harness.js"))));
  assert.equal(claudeSettings.hooks.PreToolUse, undefined);
  assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /\.claude\/skills\/fulfill\/scripts\/prd_state_harness\.js/);
});

test("installer is idempotent and preserves foreign hooks and settings", () => {
  const home = freshHome();
  // Pre-existing user settings and an unrelated hook must survive.
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] },
  }, null, 2));

  runInstaller(home);
  const first = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(first.model, "opus");
  assert.equal(first.hooks.Stop.length, 2);
  assert.equal(first.hooks.Stop[0].hooks[0].command, "echo unrelated");

  // Second run changes nothing and does not duplicate hook entries.
  const second = runInstaller(home);
  const report = JSON.parse(second.stdout);
  assert.equal(report.hooks.claude.changed, false);
  assert.equal(report.hooks.codex.changed, false);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 2);
});

test("installer refuses to overwrite a foreign skill directory", () => {
  const home = freshHome();
  const foreign = path.join(home, ".claude", "skills", "listen");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: someone-elses-skill\n---\n\n# other\n");
  const result = runInstaller(home, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  // The foreign skill is untouched.
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone-elses-skill/);
});
