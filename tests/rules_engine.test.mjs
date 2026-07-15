import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const harness = path.join(repoRoot, "skills", "ho-build", "scripts", "prd_state_harness.js");

function run(args, cwd, options = {}) {
  const result = spawnSync(process.execPath, [harness, ...args], {
    cwd,
    shell: false,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error([
      `Command failed: rules ${args.join(" ")}`,
      `exitCode: ${result.status}`,
      result.stdout,
      result.stderr,
    ].join("\n"));
  }
  return result;
}

function runJson(args, cwd, options = {}) {
  const result = run(args, cwd, options);
  const text = result.stdout.trim();
  return { exitCode: result.status, stderr: result.stderr, json: text ? JSON.parse(text) : null };
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-engine-"));
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Rules Test"]);
  git(["config", "commit.gpgsign", "false"]);
  write(path.join(dir, "README.md"), "# Test\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Initial"]);
  return dir;
}

function invariantDraft(overrides = {}) {
  const base = {
    id: "INV-scripts-tested",
    evidence: "agents/implement/some-run/state.json#D1",
    triggerPaths: ["src/**"],
    checkType: "command",
    checkRun: "node -e 'process.exit(0)'",
    body: "Changes under src/ must keep the suite green.",
  };
  const merged = { ...base, ...overrides };
  const lines = ["---", `id: ${merged.id}`, "kind: invariant", "status: active"];
  if (merged.evidence) {
    lines.push("evidence:", `  - ${merged.evidence}`);
  }
  if (merged.triggerPaths && merged.triggerPaths.length) {
    lines.push("trigger:", "  paths:");
    for (const glob of merged.triggerPaths) lines.push(`    - "${glob}"`);
  }
  lines.push("check:", `  type: ${merged.checkType}`);
  if (merged.checkRun) lines.push(`  run: ${merged.checkRun}`);
  if (merged.checkPattern) lines.push(`  pattern: ${merged.checkPattern}`);
  if (merged.checkFiles) lines.push(`  files: "${merged.checkFiles}"`);
  if (merged.checkExpect) lines.push(`  expect: ${merged.checkExpect}`);
  if (merged.checkConfirm) lines.push(`  confirm: ${merged.checkConfirm}`);
  lines.push("---", "", merged.body, "");
  return lines.join("\n");
}

test("rules add rejects evidence-free and unverifiable rules", () => {
  const root = initGitRepo();

  write(path.join(root, "draft-no-evidence.md"), invariantDraft({ evidence: null }));
  const noEvidence = run(["rules", "add", "--file", "draft-no-evidence.md"], root, { allowFailure: true });
  assert.notEqual(noEvidence.status, 0);
  assert.match(noEvidence.stderr, /evidence is required/);

  write(path.join(root, "draft-no-trigger.md"), invariantDraft({ triggerPaths: [] }));
  const noTrigger = run(["rules", "add", "--file", "draft-no-trigger.md"], root, { allowFailure: true });
  assert.notEqual(noTrigger.status, 0);
  assert.match(noTrigger.stderr, /trigger\.paths is required/);

  write(path.join(root, "draft-vague.md"), invariantDraft({ checkType: "manual", checkRun: null }));
  const vague = run(["rules", "add", "--file", "draft-vague.md"], root, { allowFailure: true });
  assert.notEqual(vague.status, 0);
  assert.match(vague.stderr, /check\.confirm is required/);

  assert.equal(fs.existsSync(path.join(root, "agents", "rules", "INDEX.md")), false,
    "rejected rules must not touch the ledger");
});

test("rules add registers a valid invariant atomically and blocks duplicates", () => {
  const root = initGitRepo();
  write(path.join(root, "draft.md"), invariantDraft());
  const added = runJson(["rules", "add", "--file", "draft.md"], root).json;
  assert.equal(added.ok, true);
  assert.equal(added.id, "INV-scripts-tested");
  assert.equal(fs.existsSync(path.join(root, "agents", "rules", "invariants", "INV-scripts-tested.md")), true);
  const index = fs.readFileSync(path.join(root, "agents", "rules", "INDEX.md"), "utf8");
  assert.match(index, /INV-scripts-tested/);
  assert.match(index, /agents\/rules\/invariants\/INV-scripts-tested\.md/);

  const duplicateId = run(["rules", "add", "--file", "draft.md"], root, { allowFailure: true });
  assert.notEqual(duplicateId.status, 0);
  assert.match(duplicateId.stderr, /Duplicate rule \(id match\)/);

  write(path.join(root, "draft-twin.md"), invariantDraft({ id: "INV-twin" }));
  const duplicateSummary = run(["rules", "add", "--file", "draft-twin.md"], root, { allowFailure: true });
  assert.notEqual(duplicateSummary.status, 0);
  assert.match(duplicateSummary.stderr, /Duplicate rule \(summary match\)/);
});

test("rules check matches trigger globs against changed files and fails closed", () => {
  const root = initGitRepo();
  write(path.join(root, "draft.md"), invariantDraft({
    checkRun: "test -f src/must-exist.txt",
  }));
  runJson(["rules", "add", "--file", "draft.md"], root);

  // No matching change: rule does not arm.
  write(path.join(root, "docs/note.md"), "unrelated");
  const quiet = runJson(["rules", "check"], root).json;
  assert.equal(quiet.ok, true);
  assert.equal(quiet.results.length, 0);

  // Matching change with a failing check: non-zero exit.
  write(path.join(root, "src/app.js"), "// change");
  const failing = runJson(["rules", "check"], root, { allowFailure: true });
  assert.equal(failing.exitCode, 1);
  assert.equal(failing.json.ok, false);
  assert.equal(failing.json.failures[0].id, "INV-scripts-tested");

  // Satisfy the check: passes.
  write(path.join(root, "src/must-exist.txt"), "present");
  const passing = runJson(["rules", "check"], root).json;
  assert.equal(passing.ok, true);
  assert.equal(passing.results[0].status, "pass");
});

test("grep checks support present and absent expectations", () => {
  const root = initGitRepo();
  write(path.join(root, "draft.md"), invariantDraft({
    id: "INV-no-todo",
    checkType: "grep",
    checkRun: null,
    checkPattern: "TODO-FORBIDDEN",
    checkFiles: "src/**",
    checkExpect: "absent",
    body: "src/ must not contain forbidden TODO markers.",
  }));
  runJson(["rules", "add", "--file", "draft.md"], root);
  write(path.join(root, "src/app.js"), "const x = 1; // TODO-FORBIDDEN fix");
  const failing = runJson(["rules", "check"], root, { allowFailure: true });
  assert.equal(failing.exitCode, 1);
  assert.match(failing.json.failures[0].detail, /must be absent/);

  write(path.join(root, "src/app.js"), "const x = 1;");
  const passing = runJson(["rules", "check"], root).json;
  assert.equal(passing.ok, true);
});

test("fact and regression rules land in the ledger; pending lessons surface in checks", () => {
  const root = initGitRepo();

  const missingLanding = run(["rules", "add", "--kind", "fact", "--id", "FACT-build", "--summary", "Build needs node 22", "--evidence", "run#D2", "--landing", "docs/build.md"], root, { allowFailure: true });
  assert.notEqual(missingLanding.status, 0);
  assert.match(missingLanding.stderr, /Landing path does not exist/);

  write(path.join(root, "docs/build.md"), "# Build\nNeeds node 22.");
  runJson(["rules", "add", "--kind", "fact", "--id", "FACT-build", "--summary", "Build needs node 22", "--evidence", "run#D2", "--landing", "docs/build.md"], root);

  runJson(["rules", "add", "--kind", "regression", "--id", "REG-timeout", "--summary", "Timeout path needs a regression test", "--evidence", "run#D3", "--pending"], root);
  assert.equal(fs.existsSync(path.join(root, "agents", "rules", "pending", "REG-timeout.md")), true);

  const report = runJson(["rules", "check"], root, { allowFailure: true }).json;
  assert.equal(report.pending.count, 1);
  assert.equal(report.pending.items[0].id, "REG-timeout");

  const index = fs.readFileSync(path.join(root, "agents", "rules", "INDEX.md"), "utf8");
  assert.match(index, /FACT-build \| fact \| active/);
  assert.match(index, /REG-timeout \| regression \| pending/);
});

test("rules relevant finds invariants by path and text query", () => {
  const root = initGitRepo();
  write(path.join(root, "draft.md"), invariantDraft());
  runJson(["rules", "add", "--file", "draft.md"], root);

  const byPath = runJson(["rules", "relevant", "--paths", "src/deep/file.js"], root).json;
  assert.equal(byPath.invariants.length, 1);

  const byQuery = runJson(["rules", "relevant", "--query", "suite green"], root).json;
  assert.equal(byQuery.invariants.length, 1);

  const miss = runJson(["rules", "relevant", "--paths", "unrelated/file.py", "--query", "zzz-not-there"], root).json;
  assert.equal(miss.invariants.length, 0);
});

test("seed-agents-md creates AGENTS.md with the namespace section and a CLAUDE.md symlink, idempotently", () => {
  const root = initGitRepo();
  const first = runJson(["seed-agents-md"], root).json;
  assert.equal(first.agentsMd.action, "created");
  assert.equal(first.claudeMd.action, "symlinked");

  const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /Harness Namespace/);
  assert.match(agentsMd, /agents\/rules/);
  assert.match(agentsMd, /CLAUDE\.md is always a symlink/);
  assert.equal(fs.lstatSync(path.join(root, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(root, "CLAUDE.md")), "AGENTS.md");

  const second = runJson(["seed-agents-md"], root).json;
  assert.equal(second.agentsMd.action, "unchanged");
  assert.equal(second.claudeMd.action, "already-symlink");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), agentsMd,
    "reruns must not duplicate the seeded section");
});

test("seed-agents-md refuses a bare CLAUDE.md without --adopt-claude-md, then adopts it verbatim", () => {
  const root = initGitRepo();
  write(path.join(root, "CLAUDE.md"), "# Existing notes\nKeep me.");
  const refused = run(["seed-agents-md"], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /rerun with --adopt-claude-md/);

  const adopted = runJson(["seed-agents-md", "--adopt-claude-md"], root).json;
  assert.equal(adopted.ok, true);
  const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /Keep me\./);
  assert.match(agentsMd, /Harness Namespace/);
  assert.equal(fs.lstatSync(path.join(root, "CLAUDE.md")).isSymbolicLink(), true);
});

test("namespace.root override relocates harness artifacts", () => {
  const root = initGitRepo();
  write(path.join(root, "agents", "config.json"), JSON.stringify({
    namespace: { root: "meta" },
  }, null, 2));
  // The rules engine and every artifact path must honor the override.
  write(path.join(root, "draft.md"), invariantDraft());
  runJson(["rules", "add", "--file", "draft.md"], root);
  assert.equal(fs.existsSync(path.join(root, "meta", "rules", "INDEX.md")), true,
    "ledger lands under the overridden namespace root");
  assert.equal(fs.existsSync(path.join(root, "agents", "rules")), false);

  const seeded = runJson(["seed-agents-md"], root).json;
  assert.equal(seeded.ok, true);
  const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agentsMd, /meta\/rules/);
});
