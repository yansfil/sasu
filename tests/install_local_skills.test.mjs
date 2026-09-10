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
    env: {
      ...process.env,
      HOME: home,
      PNPM_HOME: path.join(home, "bin"),
      ...(options.env ?? {}),
    },
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`Installer failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "install-skills-home-"));
}

test("installer installs canonical skills with correct substitutions and no aliases", () => {
  const home = freshHome();
  const result = runInstaller(home);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.installed.codex.length, 10);
  assert.equal(report.installed.claude.length, 10);

  const codexInterview = path.join(home, ".codex", "skills", "interview-me", "SKILL.md");
  const codexInterviewText = fs.readFileSync(codexInterview, "utf8");
  assert.match(codexInterviewText, /^name: interview-me$/m);
  assert.match(codexInterviewText, /\$interview-me/);
  // The retired ho-* aliases are not installed.
  for (const alias of ["ho-interview", "ho-scope", "ho-spec", "ho-build", "ho-ship"]) {
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", alias)), false);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", alias)), false);
  }

  const claudeInterview = fs.readFileSync(path.join(home, ".claude", "skills", "interview-me", "SKILL.md"), "utf8");
  assert.match(claudeInterview, /\/interview-me/);
  assert.doesNotMatch(claudeInterview, /\$interview-me/);

  // Codex: canonical directory names, verbatim SKILL.md.
  const codexFulfill = path.join(home, ".codex", "skills", "implement", "SKILL.md");
  const codexText = fs.readFileSync(codexFulfill, "utf8");
  assert.match(codexText, /sasu implement verify/);
  assert.doesNotMatch(codexText, /prd_state_harness\.js/);
  assert.match(codexText, /"\$implement"/);

  // Claude: canonical directory names, substituted SKILL.md.
  const claudeFulfill = path.join(home, ".claude", "skills", "implement", "SKILL.md");
  const claudeText = fs.readFileSync(claudeFulfill, "utf8");
  assert.match(claudeText, /sasu implement verify/);
  assert.doesNotMatch(claudeText, /prd_state_harness\.js/);
  assert.match(claudeText, /"\/implement"/);
  assert.doesNotMatch(claudeText, /~\/\.codex\/skills\//);
  assert.doesNotMatch(
    claudeText,
    /\$(interview-me|gen-prd|implement|ship|sasu-setup|please|remember)\b/,
  );

  // remember installs on both runtimes with the public rules CLI.
  const claudeRemember = fs.readFileSync(path.join(home, ".claude", "skills", "remember", "SKILL.md"), "utf8");
  assert.match(claudeRemember, /sasu rules add/);
  assert.match(claudeRemember, /## Mandatory Confirmation Gate/);
  assert.match(claudeRemember, /not as permission to write/);
  const codexRemember = fs.readFileSync(path.join(home, ".codex", "skills", "remember", "SKILL.md"), "utf8");
  assert.match(codexRemember, /sasu rules add/);
  assert.match(codexRemember, /## Mandatory Confirmation Gate/);
  assert.match(codexRemember, /not as permission to write/);

  // please references its siblings through the Claude install paths.
  const claudePlease = fs.readFileSync(path.join(home, ".claude", "skills", "please", "SKILL.md"), "utf8");
  assert.match(claudePlease, /~\/\.claude\/skills\/gen-prd\/SKILL\.md/);

  const codexBenchmark = fs.readFileSync(path.join(home, ".codex", "skills", "benchmark-implement", "SKILL.md"), "utf8");
  assert.match(codexBenchmark, /\$benchmark-implement/);
  assert.match(codexBenchmark, /~\/\.codex\/skills\/implement\/SKILL\.md/);
  assert.match(codexBenchmark, /current coordinator session/);
  assert.match(codexBenchmark, /Do not spawn an implementation worker session/);
  assert.doesNotMatch(codexBenchmark, /delegate implementation, gathers/);
  const claudeBenchmark = fs.readFileSync(path.join(home, ".claude", "skills", "benchmark-implement", "SKILL.md"), "utf8");
  assert.match(claudeBenchmark, /\/benchmark-implement/);
  assert.match(claudeBenchmark, /~\/\.claude\/skills\/implement\/SKILL\.md/);
  assert.doesNotMatch(claudeBenchmark, /\$benchmark-implement/);

  // Auxiliary entries are symlinks into the repo; Codex-only entries are skipped for Claude.
  const claudeScripts = path.join(home, ".claude", "skills", "implement", "scripts");
  assert.ok(fs.lstatSync(claudeScripts).isSymbolicLink());
  assert.equal(fs.realpathSync(claudeScripts), fs.realpathSync(path.join(repoRoot, "skills", "implement", "scripts")));

  // References are substituted real copies for Claude: no Codex path or $token
  // may survive anywhere in the Claude tree (following symlinked scripts is
  // fine; they self-locate and carry no runtime paths in docs).
  const claudeReferences = path.join(home, ".claude", "skills", "implement", "references");
  assert.equal(fs.lstatSync(claudeReferences).isSymbolicLink(), false);
  for (const referenceName of fs.readdirSync(claudeReferences)) {
    if (!referenceName.endsWith(".md")) continue;
    const referenceText = fs.readFileSync(path.join(claudeReferences, referenceName), "utf8");
    assert.doesNotMatch(referenceText, /~\/\.codex\/skills\//, `${referenceName} keeps a Codex path`);
    assert.doesNotMatch(referenceText, /\$(interview-me|gen-prd|implement|benchmark-implement|ship|sasu-setup|please|remember)\b/, `${referenceName} keeps a Codex invocation token`);
  }
  // Codex references stay symlinked (verbatim source is correct there).
  assert.ok(fs.lstatSync(path.join(home, ".codex", "skills", "implement", "references")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(home, ".codex", "skills", "implement", "agents")));
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "implement", "agents")), false);

  // challenge installs on both runtimes with its harness-owned round cap.
  const claudeChallenge = fs.readFileSync(path.join(home, ".claude", "skills", "challenge", "SKILL.md"), "utf8");
  assert.match(claudeChallenge, /round cap \| 2/);
  assert.match(claudeChallenge, /new \*\*evidence\*\*, never new opinion/);
  assert.doesNotMatch(claudeChallenge, /\$challenge/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "skills", "challenge", "SKILL.md"), "utf8"), /\$challenge/);

  // The approved reminder and challenge routing install once on both runtimes.
  for (const file of [
    path.join(home, ".codex", "hooks.json"),
    path.join(home, ".claude", "settings.json"),
  ]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(config.hooks), ["UserPromptSubmit", "PostToolUse"]);
    assert.equal(config.hooks.UserPromptSubmit.length, 1);
    assert.match(config.hooks.UserPromptSubmit[0].hooks[0].command, /challenge_trigger\.mjs$/);
    assert.equal(config.hooks.PostToolUse.length, 1);
    assert.match(config.hooks.PostToolUse[0].hooks[0].command, /commit_reminder\.mjs$/);
  }
});

test("installer removes owned legacy directories and keeps foreign ones", () => {
  const home = freshHome();
  // A pre-rename install of ours (frontmatter carries a butler name).
  const ownedLegacy = path.join(home, ".codex", "skills", "prd-implement");
  fs.mkdirSync(ownedLegacy, { recursive: true });
  fs.writeFileSync(path.join(ownedLegacy, "SKILL.md"), "---\nname: fulfill\n---\n\n# fulfill\n");
  // A previously installed ho-* compatibility alias of ours.
  const ownedAlias = path.join(home, ".codex", "skills", "ho-build");
  fs.mkdirSync(ownedAlias, { recursive: true });
  fs.writeFileSync(path.join(ownedAlias, "SKILL.md"), "---\nname: ho-build\n---\n\n# ho-build compatibility alias\n");
  // An unrelated skill that happens to use a legacy directory name.
  const foreignLegacy = path.join(home, ".codex", "skills", "intake");
  fs.mkdirSync(foreignLegacy, { recursive: true });
  fs.writeFileSync(path.join(foreignLegacy, "SKILL.md"), "---\nname: someone-elses-intake\n---\n\n# other\n");

  const report = JSON.parse(runInstaller(home).stdout);
  assert.deepEqual(report.removedLegacy.codex, [ownedLegacy, ownedAlias]);
  assert.equal(fs.existsSync(ownedLegacy), false);
  assert.equal(fs.existsSync(ownedAlias), false);
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
  assert.equal(first.hooks.Stop.length, 1);
  assert.equal(first.hooks.Stop[0].hooks[0].command, "echo unrelated");

  // Second run changes nothing and does not duplicate hook entries.
  const second = runInstaller(home);
  const report = JSON.parse(second.stdout);
  assert.equal(report.hooks.claude.changed, false);
  assert.equal(report.hooks.codex.changed, false);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
});

test("installer retires legacy harness hooks without touching foreign hooks", () => {
  const home = freshHome();
  for (const runtime of [".codex", ".claude"]) {
    fs.mkdirSync(path.join(home, runtime), { recursive: true });
  }
  const legacy = { hooks: [{ type: "command", command: "node /tmp/prd_state_harness.js hook stop" }] };
  const foreign = { hooks: [{ type: "command", command: "echo unrelated" }] };
  fs.writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({
    hooks: { Stop: [foreign, legacy], PreToolUse: [legacy] },
  }, null, 2));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [legacy], PostToolUse: [foreign, legacy] },
  }, null, 2));

  runInstaller(home);

  const codex = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.deepEqual(codex.hooks.Stop, [foreign]);
  assert.equal(codex.hooks.PreToolUse, undefined);
  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.hooks.PostToolUse.length, 2);
  assert.deepEqual(claude.hooks.PostToolUse[0], foreign);
  assert.match(claude.hooks.PostToolUse[1].hooks[0].command, /commit_reminder\.mjs$/);
  assert.equal(claude.hooks.Stop, undefined);
});

test("installer replaces stale advisory and routing hooks while preserving foreign entries", () => {
  const home = freshHome();
  const foreign = { hooks: [{ type: "command", command: "echo unrelated" }] };
  const files = [path.join(home, ".claude", "settings.json"), path.join(home, ".codex", "hooks.json")];
  const scripts = { UserPromptSubmit: "challenge_trigger.mjs", PostToolUse: "commit_reminder.mjs" };
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const hooks = Object.fromEntries(Object.entries(scripts).map(([event, script]) => [event, [foreign,
      { hooks: [{ type: "command", command: `node /old/checkout/scripts/${script}`, timeout: 10 }] },
    ]]));
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  }

  runInstaller(home);

  for (const file of files) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [event, script] of Object.entries(scripts)) {
      assert.equal(config.hooks[event].length, 2);
      assert.deepEqual(config.hooks[event][0], foreign);
      assert.equal(config.hooks[event][1].hooks[0].command, `node ${path.join(repoRoot, "scripts", script)}`);
    }
  }
});

test("installer refuses to overwrite a foreign skill directory", () => {
  const home = freshHome();
  const foreign = path.join(home, ".claude", "skills", "interview-me");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "---\nname: someone-elses-skill\n---\n\n# other\n");
  const result = runInstaller(home, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  // The foreign skill is untouched.
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone-elses-skill/);
});

test("installer refuses a target directory whose ownership cannot be proven", () => {
  for (const skillMd of [null, "# no parseable frontmatter\n"]) {
    const home = freshHome();
    const foreign = path.join(home, ".codex", "skills", "interview-me");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "KEEP.txt"), "foreign data\n");
    if (skillMd !== null) fs.writeFileSync(path.join(foreign, "SKILL.md"), skillMd);

    const result = runInstaller(home, { allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(foreign, "KEEP.txt"), "utf8"), "foreign data\n");
  }
});

test("installer validates every skill target before replacing the CLI shim or any skill", () => {
  const home = freshHome();
  const shim = path.join(home, "bin", "sasu");
  const foreign = path.join(home, ".claude", "skills", "remember");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, "existing shim\n");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(
    path.join(foreign, "SKILL.md"),
    "---\nname: someone-elses-remember\n---\n\n# other\n",
  );

  const result = runInstaller(home, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(shim, "utf8"), "existing shim\n");
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "interview-me")), false);
  assert.match(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), /someone-elses-remember/);
});

test("installer changes no runtime contracts when CLI preparation fails", () => {
  const home = freshHome();
  const fakeBin = path.join(home, "fake-bin");
  const pnpm = path.join(fakeBin, "pnpm");
  const existing = path.join(home, ".codex", "skills", "implement", "KEEP.txt");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(pnpm, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, "unchanged\n");
  fs.writeFileSync(
    path.join(path.dirname(existing), "SKILL.md"),
    "---\nname: implement\n---\n\n# owned implement\n",
  );

  const result = runInstaller(home, {
    allowFailure: true,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.installed, { codex: [], claude: [] });
  assert.equal(report.hooks, null);
  assert.match(report.note, /No skill, legacy directory, or hook changes/);
  assert.equal(fs.readFileSync(existing, "utf8"), "unchanged\n");
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

test("candidate staging binds package siblings and preserves external skills for both runtimes", async () => {
  // Plan section 19 requires both runtime inputs to use the candidate together.
  // A project-local skill whose sibling path still points globally can execute
  // an old ship script against a new receipt even when its own text is current.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { transformContractFile } = require("../cli/lib/skill-contract.js");
  const source = "Use $implement and read ~/.codex/skills/ship/scripts/prd_ship.js";
  for (const [runtime, root, invocation] of [
    ["codex", "/validation/product/.agents/skills", "$implement"],
    ["claude", "/validation/product/.claude/skills", "/implement"],
  ]) {
    assert.equal(
      transformContractFile(runtime, "SKILL.md", source, { skillsRoot: root }),
      `Use ${invocation} and read ${root}/ship/scripts/prd_ship.js`,
    );
    assert.equal(
      transformContractFile(runtime, "references/delivery.md", source, { skillsRoot: root }),
      `Use ${invocation} and read ${root}/ship/scripts/prd_ship.js`,
    );
    assert.equal(transformContractFile(runtime, "scripts/example.js", source, { skillsRoot: root }), source);
    const external = "Read ~/.codex/skills/herdr/SKILL.md, ~/.claude/skills/herdr/SKILL.md, ~/.agents/skills/herdr/SKILL.md, and ~/.codex/skills/ship-external/SKILL.md";
    assert.equal(
      transformContractFile(runtime, "references/observer-and-herdr.md", external, { skillsRoot: root }),
      runtime === "claude" ? external.replaceAll("~/.codex/skills/", "~/.claude/skills/") : external,
    );
  }
  assert.equal(transformContractFile("codex", "SKILL.md", source), source);
  assert.equal(transformContractFile("claude", "SKILL.md", source), "Use /implement and read ~/.claude/skills/ship/scripts/prd_ship.js");
});
