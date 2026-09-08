import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { stripSessionEnv } from "./helpers/session_env.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shipScript = path.join(repoRoot, "skills", "ship", "scripts", "prd_ship.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    env: options.env || stripSessionEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function write(file, text, mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  if (mode !== null) fs.chmodSync(file, mode);
}

function initMergeFixture({ includeDelivery = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prd-ship-merge-"));
  const bare = `${root}-origin.git`;
  run("git", ["init", "--bare", bare], { cwd: os.tmpdir() });
  run("git", ["init", "-b", "main"], { cwd: root });
  run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  run("git", ["config", "user.name", "Harness Test"], { cwd: root });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  write(path.join(root, "README.md"), "# Test\n");
  write(path.join(root, ".gitignore"), "agents/runs/\nfake-bin/\n");
  run("git", ["add", "README.md", ".gitignore"], { cwd: root });
  run("git", ["commit", "-m", "Initial"], { cwd: root });
  run("git", ["remote", "add", "origin", bare], { cwd: root });
  run("git", ["push", "-u", "origin", "main"], { cwd: root });
  run("git", ["checkout", "-b", "prd/merge-flow"], { cwd: root });
  write(path.join(root, "src", "feature.js"), "export const ready = true;\n");
  run("git", ["add", "src/feature.js"], { cwd: root });
  run("git", ["commit", "-m", "Add reviewed feature"], { cwd: root });
  run("git", ["push", "-u", "origin", "prd/merge-flow"], { cwd: root });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  const stateDir = path.join(root, "agents", "runs", "merge-flow");
  const statePath = path.join(stateDir, "state.json");
  const state = {
    schema: "sasu.implement.state.v9",
    status: "complete",
    topicSlug: "merge-flow",
    projectRoot: root,
    runDir: "agents/runs/merge-flow",
    completion: { fingerprint: "fixture-completion" },
  };
  if (includeDelivery) state.delivery = { mode: "pr", branch: "prd/merge-flow", baseBranch: "main" };
  write(statePath, JSON.stringify(state, null, 2));
  write(path.join(stateDir, "receipt.json"), JSON.stringify({
    schema: "sasu.implement.receipt.v5",
    status: "complete",
    completionFingerprint: "fixture-completion",
    ownedFiles: ["src/feature.js"],
    sourceFingerprint: "fixture-source",
    verificationAttemptId: "verify-1",
    delivery: { eligible: true, reasons: [] },
    artifacts: [],
    mechanical: [{ command: "node src/check.js", cwd: root, exitCode: 0, finishedAt: "2026-07-14T11:00:00Z" }],
    review: { verdict: "PASS", result: { summary: "The complete contract matches the implementation.", findings: [] } },
    findings: [],
    humanConfirmations: [],
    riskFindings: [],
  }, null, 2));

  const bin = path.join(root, "fake-bin");
  const ghLog = path.join(root, "gh.log");
  const mergedMarker = path.join(root, "merged.marker");
  write(path.join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  printf '%s\\n' '[{"name":"ci","state":"SUCCESS","bucket":"pass","link":"https://example.test/ci"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  touch "$FAKE_GH_MERGED"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$FAKE_GH_MERGED" ]; then
    printf '{"number":7,"url":"https://example.test/pr/7","state":"MERGED","isDraft":false,"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","headRefName":"prd/merge-flow","headRefOid":"%s","baseRefName":"main","statusCheckRollup":[],"mergedAt":"2026-07-14T12:00:00Z","mergeCommit":{"oid":"merged-commit-sha"}}\\n' "$FAKE_HEAD_SHA"
  else
    printf '{"number":7,"url":"https://example.test/pr/7","state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","headRefName":"prd/merge-flow","headRefOid":"%s","baseRefName":"main","statusCheckRollup":[],"mergedAt":null,"mergeCommit":null}\\n' "$FAKE_HEAD_SHA"
  fi
  exit 0
fi
exit 1
`, 0o755);
  write(path.join(bin, "sasu"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.startsWith("rules check")) {
  process.stdout.write(JSON.stringify({ ok: true, results: [], failures: [], manualConfirmations: [], pending: { count: 0, items: [] } }) + "\\n");
} else if (args.startsWith("implement status")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    detail: {
      status: "complete",
      verification: { verdict: "PASS" },
      delivery: { eligible: true, reasons: [] },
      artifactProblems: [],
      completion: { fingerprint: "fixture-completion" }
    }
  }) + "\\n");
} else {
  process.stderr.write("unexpected sasu command: " + args + "\\n");
  process.exit(1);
}
`, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_MERGED: mergedMarker,
    FAKE_HEAD_SHA: head,
  };
  return { root, stateDir, statePath, head, ghLog, env };
}

function initLocalFixture({ checkpoint = false } = {}) {
  const fixture = initMergeFixture({ includeDelivery: false });
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  state.delivery = { mode: "local" };
  state.initialSource = { head: fixture.head };
  state.baselineAttribution = { head: fixture.head };
  write(fixture.statePath, JSON.stringify(state, null, 2));
  write(path.join(fixture.root, "src", "feature.js"), "export const ready = 'local';\n");
  if (checkpoint) {
    run("git", ["add", "src/feature.js"], { cwd: fixture.root });
    run("git", ["commit", "-m", "checkpoint: src (1 edited)"], { cwd: fixture.root });
  }
  return fixture;
}

test("local delivery verifies, commits the allowlisted change, and never contacts GitHub", () => {
  const fixture = initLocalFixture();
  const result = run(process.execPath, [
    shipScript,
    "local",
    "--state", fixture.statePath,
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "local");
  assert.equal(output.status, "committed");
  assert.equal(output.alreadyCommitted, false);
  assert.equal(output.commit.committed, true);
  assert.equal(output.commit.subject, "Implement merge-flow");
  assert.deepEqual(output.commit.staged, ["src/feature.js"]);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: fixture.root }).stdout.trim(), "Implement merge-flow");
  assert.equal(fs.existsSync(fixture.ghLog), false);

  const deliveryResult = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "delivery", "delivery-result.json"), "utf8"));
  assert.equal(deliveryResult.status, "committed");
  assert.equal(deliveryResult.implementationHead, output.implementationHead);
  const shipLog = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8");
  assert.match(shipLog, /"event":"local"/);
});

test("local delivery is idempotent and does not create a second commit", () => {
  const fixture = initLocalFixture();
  const args = [shipScript, "local", "--state", fixture.statePath];
  const first = JSON.parse(run(process.execPath, args, { cwd: fixture.root, env: fixture.env }).stdout);
  const before = run("git", ["rev-list", "--count", "HEAD"], { cwd: fixture.root }).stdout.trim();
  const second = JSON.parse(run(process.execPath, args, { cwd: fixture.root, env: fixture.env }).stdout);
  const after = run("git", ["rev-list", "--count", "HEAD"], { cwd: fixture.root }).stdout.trim();
  assert.equal(second.alreadyCommitted, true);
  assert.equal(second.implementationHead, first.implementationHead);
  assert.equal(after, before);
  const events = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(events.length, 1);
});

test("default state discovery uses the current CLI namespace", () => {
  const fixture = initLocalFixture();
  write(path.join(fixture.root, "agents", "runs", ".prd-implement-active.json"), JSON.stringify({
    statePath: fixture.statePath,
    projectRoot: fixture.root,
  }));
  write(path.join(fixture.root, "agents", "config.json"), JSON.stringify({ namespace: { root: "retired-root" } }));
  const result = run(process.execPath, [shipScript, "body"], {
    cwd: fixture.root,
    env: stripSessionEnv(fixture.env),
  });
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(fs.existsSync(path.join(fixture.stateDir, "delivery", "pr-body.md")), true);
});

test("local delivery promotes an unpushed checkpoint instead of stacking another commit", () => {
  const fixture = initLocalFixture({ checkpoint: true });
  const before = run("git", ["rev-list", "--count", "HEAD"], { cwd: fixture.root }).stdout.trim();
  const result = run(process.execPath, [
    shipScript,
    "local",
    "--state", fixture.statePath,
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  const after = run("git", ["rev-list", "--count", "HEAD"], { cwd: fixture.root }).stdout.trim();
  assert.equal(output.commit.promotedCheckpoint, true);
  assert.equal(output.commit.subject, "Implement merge-flow");
  assert.equal(after, before);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: fixture.root }).stdout.trim(), "Implement merge-flow");
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("local delivery refuses a PR-configured run before any delivery side effect", () => {
  const fixture = initMergeFixture();
  const result = run(process.execPath, [
    shipScript,
    "local",
    "--state", fixture.statePath,
  ], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not 'local'/);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("merge requires explicit user approval before contacting GitHub", () => {
  const fixture = initMergeFixture();
  const result = run(process.execPath, [shipScript, "merge", "--state", fixture.statePath, "--pr", "https://example.test/pr/7"], {
    cwd: fixture.root,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --approval/);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("merge pins the reviewed PR head, requires passing CI, and records delivery evidence", () => {
  const fixture = initMergeFixture();
  const result = run(process.execPath, [
    shipScript,
    "merge",
    "--state", fixture.statePath,
    "--pr", "https://example.test/pr/7",
    "--approval", "User approved merge after CI passes",
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.status, "merged");
  assert.equal(output.ci.verdict, "pass");
  assert.equal(output.merge.matchedHeadCommit, fixture.head);
  assert.equal(output.merge.commit, "merged-commit-sha");

  const calls = fs.readFileSync(fixture.ghLog, "utf8");
  assert.match(calls, new RegExp(`pr merge .* --squash --match-head-commit ${fixture.head}`));
  const deliveryResult = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "delivery", "delivery-result.json"), "utf8"));
  assert.equal(deliveryResult.pr.url, "https://example.test/pr/7");
  assert.equal(deliveryResult.approval, "User approved merge after CI passes");
  const shipLog = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8");
  assert.match(shipLog, /"event":"merge"/);
});

test("merge records a later explicit PR-delivery approval for a current state with default delivery config", () => {
  const fixture = initMergeFixture({ includeDelivery: false });
  const approval = "User approved immediate merge";
  const result = run(process.execPath, [
    shipScript,
    "merge",
    "--state", fixture.statePath,
    "--pr", "https://example.test/pr/7",
    "--approval", approval,
    "--override-mode",
    "--reason", approval,
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "merged");
  assert.deepEqual(output.overrides, [{ kind: "mode", from: "local", reason: approval }]);

  const deliveryResult = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "delivery", "delivery-result.json"), "utf8"));
  assert.deepEqual(deliveryResult.overrides, output.overrides);
  const shipLog = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8");
  assert.match(shipLog, /"kind":"mode"/);
  assert.match(shipLog, /User approved immediate merge/);
});

test("permitted pending human judgments ship and the body describes shared tests and review", () => {
  const fixture = initLocalFixture();
  const receiptPath = path.join(fixture.stateDir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.status = "complete-pending-human";
  receipt.humanConfirmations.push({
    id: "F1", kind: "human-confirmation", status: "open", problem: "The user judges the wording.",
    nextAction: "Confirm the wording after completion.", human: { sourceRef: "D-01", quote: "I will review the wording afterwards", timing: "post-completion" }, responses: [],
  });
  write(receiptPath, JSON.stringify(receipt, null, 2));
  const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
  state.status = "complete-pending-human";
  write(fixture.statePath, JSON.stringify(state, null, 2));
  const sasuStub = path.join(fixture.root, "fake-bin", "sasu");
  write(sasuStub, fs.readFileSync(sasuStub, "utf8").replace('status: "complete",', 'status: "complete-pending-human",'), 0o755);
  const body = JSON.parse(run(process.execPath, [shipScript, "body", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env }).stdout);
  const draft = fs.readFileSync(path.join(fixture.root, body.bodyPath), "utf8");
  assert.match(draft, /## Open Human Confirmations/);
  assert.match(draft, /F1.*The user judges the wording/);
  assert.match(draft, /node src\/check.js/);
  assert.match(draft, /The complete contract matches the implementation/);
  assert.doesNotMatch(draft, /## Behaviors|Verification Lanes|Acceptance lane|Fidelity lane|Score:|--row/);
  const output = JSON.parse(run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env }).stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.commit.staged, ["src/feature.js"]);
});

test("an explicit human rejection refuses delivery before any side effect", () => {
  const fixture = initLocalFixture();
  const receiptPath = path.join(fixture.stateDir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.status = "complete-pending-human";
  receipt.delivery = { eligible: false, reasons: ["F1: human rejected the wording"] };
  receipt.humanConfirmations = [{ id: "F1", status: "open", responses: [{ response: "rejected", evidence: "too stiff" }] }];
  write(receiptPath, JSON.stringify(receipt, null, 2));
  const head = gitHead(fixture.root);
  const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not delivery-eligible.*human rejected/);
  assert.equal(gitHead(fixture.root), head);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

function gitHead(root) { return run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim(); }

test("current CLI rejection cannot be bypassed by an older eligible receipt", () => {
  const fixture = initLocalFixture();
  const stub = path.join(fixture.root, "fake-bin", "sasu");
  write(stub, fs.readFileSync(stub, "utf8").replace('delivery: { eligible: true, reasons: [] }', 'delivery: { eligible: false, reasons: ["human rejection"] }'), 0o755);
  const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /human rejection/);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("receipt schema is checked before completed status is consumed", () => {
  const fixture = initLocalFixture();
  write(path.join(fixture.stateDir, "receipt.json"), JSON.stringify({ schema: "sasu.implement.receipt.v4", status: "complete" }));
  const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /received schema sasu.implement.receipt.v4; expected sasu.implement.receipt.v5; last supported commit 488d3cc/);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("local delivery refuses unrelated dirty paths outside receipt ownership", () => {
  const fixture = initLocalFixture();
  write(path.join(fixture.root, "unrelated.js"), "export const unrelated = true;");
  const head = gitHead(fixture.root);
  const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the PRD delivery allowlist/);
  assert.equal(gitHead(fixture.root), head);
  assert.equal(fs.readFileSync(path.join(fixture.root, "unrelated.js"), "utf8").trim(), "export const unrelated = true;");
});

test("a blocked receipt does not ship", () => {
  const fixture = initLocalFixture();
  const receiptPath = path.join(fixture.stateDir, "receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.status = "blocked";
  write(receiptPath, JSON.stringify(receipt, null, 2));
  const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Cannot ship receipt status 'blocked'/);
});

test("stale verification and mismatched completion identities refuse local delivery", () => {
  for (const [from, to, expected] of [
    ['verification: { verdict: "PASS" }', 'verification: { verdict: "STALE" }', /not PASS/],
    ['completion: { fingerprint: "fixture-completion" }', 'completion: { fingerprint: "changed-completion" }', /completion fingerprint does not match/],
  ]) {
    const fixture = initLocalFixture();
    const stub = path.join(fixture.root, "fake-bin", "sasu");
    write(stub, fs.readFileSync(stub, "utf8").replace(from, to), 0o755);
    const head = gitHead(fixture.root);
    const result = run(process.execPath, [shipScript, "local", "--state", fixture.statePath], { cwd: fixture.root, env: fixture.env, allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(gitHead(fixture.root), head);
    assert.equal(fs.existsSync(fixture.ghLog), false);
  }
});
