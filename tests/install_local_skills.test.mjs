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

test("installer installs both runtimes under butler names with correct substitutions", () => {
  const home = freshHome();
  const result = runInstaller(home);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);

  // Codex: butler directory names, verbatim SKILL.md.
  const codexFulfill = path.join(home, ".codex", "skills", "fulfill", "SKILL.md");
  const codexText = fs.readFileSync(codexFulfill, "utf8");
  assert.match(codexText, /~\/\.codex\/skills\/fulfill\/scripts\/prd_state_harness\.js/);
  assert.match(codexText, /"\$fulfill"/);

  // Claude: butler directory names, substituted SKILL.md.
  const claudeFulfill = path.join(home, ".claude", "skills", "fulfill", "SKILL.md");
  const claudeText = fs.readFileSync(claudeFulfill, "utf8");
  assert.match(claudeText, /~\/\.claude\/skills\/fulfill\/scripts\/prd_state_harness\.js/);
  assert.match(claudeText, /"\/fulfill"/);
  assert.doesNotMatch(claudeText, /~\/\.codex\/skills\//);
  assert.doesNotMatch(claudeText, /\$(listen|promise|fulfill|deliver|pantry|please|remember)\b/);

  // remember installs on both runtimes with the substituted harness path.
  const claudeRemember = fs.readFileSync(path.join(home, ".claude", "skills", "remember", "SKILL.md"), "utf8");
  assert.match(claudeRemember, /~\/\.claude\/skills\/fulfill\/scripts\/prd_state_harness\.js rules add/);
  const codexRemember = fs.readFileSync(path.join(home, ".codex", "skills", "remember", "SKILL.md"), "utf8");
  assert.match(codexRemember, /~\/\.codex\/skills\/fulfill\/scripts\/prd_state_harness\.js rules add/);

  // please references its siblings through the Claude install paths.
  const claudePlease = fs.readFileSync(path.join(home, ".claude", "skills", "please", "SKILL.md"), "utf8");
  assert.match(claudePlease, /~\/\.claude\/skills\/promise\/SKILL\.md/);

  // Auxiliary entries are symlinks into the repo; Codex-only entries are skipped for Claude.
  const claudeScripts = path.join(home, ".claude", "skills", "fulfill", "scripts");
  assert.ok(fs.lstatSync(claudeScripts).isSymbolicLink());
  assert.equal(fs.realpathSync(claudeScripts), fs.realpathSync(path.join(repoRoot, "skills", "fulfill", "scripts")));
  assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "fulfill", "agents")));
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "fulfill", "agents")), false);

  // Hooks: Codex gets Stop + SubagentStop + PreToolUse, Claude gets Stop only.
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.ok(codexHooks.hooks.Stop.some(matcher => matcher.hooks.some(hook => hook.command.includes("prd_state_harness.js"))));
  assert.ok(codexHooks.hooks.SubagentStop.some(matcher => matcher.hooks.some(hook => hook.command.includes("hook subagent-stop"))));
  assert.ok(codexHooks.hooks.PreToolUse.some(matcher => matcher.hooks.some(hook => hook.command.includes("hook pretool-use"))));
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(claudeSettings.hooks.Stop.some(matcher => matcher.hooks.some(hook => hook.command.includes("prd_state_harness.js"))));
  assert.equal(claudeSettings.hooks.PreToolUse, undefined);
  assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /\.claude\/skills\/fulfill\/scripts\/prd_state_harness\.js/);
});

test("installer removes owned legacy directories and keeps foreign ones", () => {
  const home = freshHome();
  // A pre-rename install of ours (frontmatter carries a butler name).
  const ownedLegacy = path.join(home, ".codex", "skills", "prd-implement");
  fs.mkdirSync(ownedLegacy, { recursive: true });
  fs.writeFileSync(path.join(ownedLegacy, "SKILL.md"), "---\nname: fulfill\n---\n\n# fulfill\n");
  // An unrelated skill that happens to use a legacy directory name.
  const foreignLegacy = path.join(home, ".codex", "skills", "intake");
  fs.mkdirSync(foreignLegacy, { recursive: true });
  fs.writeFileSync(path.join(foreignLegacy, "SKILL.md"), "---\nname: someone-elses-intake\n---\n\n# other\n");

  const report = JSON.parse(runInstaller(home).stdout);
  assert.deepEqual(report.removedLegacy.codex, [ownedLegacy]);
  assert.equal(fs.existsSync(ownedLegacy), false);
  assert.equal(fs.existsSync(foreignLegacy), true);
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
