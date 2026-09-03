import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindCriterionCheck,
  fingerprintCheckOutput,
  parkCriterion,
  resumeCriterion,
  runCriterionCheck,
  validateCheckBinding,
} from "../../dist/implement/checks.js";

const GOLDEN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "implement-check", "fingerprint-golden.json");

function criterion(id = "AC1", judgment = "machine") {
  return {
    id,
    text: "fixture criterion",
    title: "fixture criterion",
    requirements: ["R1"],
    acceptanceCriteria: [],
    status: "pending",
    evidence: [],
    judgment,
    evidenceDeclaration: judgment === "judged" ? "fixture runtime evidence" : null,
    check: { status: "pending", bindings: [], attempts: [], consecutiveFailures: 0, decisionPoints: [], parks: [] },
  };
}

function state(root, acceptanceCriteria) {
  return {
    projectRoot: root,
    runDir: "agents/runs/fixture",
    acceptanceCriteria,
  };
}

function script(root, name, source) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", name), source);
  return `node scripts/${name}`;
}

function bind(root, item, command, reason = null) {
  return bindCriterionCheck(item, { ...validateCheckBinding(root, command, "."), reason });
}

test("cargo, vitest, and pytest output golden pairs ignore volatile paths, times, and numbers", () => {
  const corpus = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(corpus.map((entry) => entry.runner), ["cargo", "vitest", "pytest"]);
  for (const entry of corpus) {
    const left = fingerprintCheckOutput(entry.left, "");
    const right = fingerprintCheckOutput(entry.right, "");
    assert.equal(left.failureClass, entry.expectedFailureClass, `${entry.runner} failure class golden drifted`);
    assert.equal(right.failureClass, entry.expectedFailureClass, `${entry.runner} volatile variant changed class`);
    assert.equal(left.outputFingerprint, entry.expectedOutputFingerprint, `${entry.runner} output golden drifted`);
    assert.equal(right.outputFingerprint, entry.expectedOutputFingerprint, `${entry.runner} volatile variant changed output fingerprint`);
  }
});

test("binding policy fails closed and records asset versus labor addresses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-bind-"));
  fs.mkdirSync(path.join(root, "agents", "tools"), { recursive: true });
  // Asset means the run left a durable guard behind, and the address is what
  // says so. `npm test` names no file, so under AC11 it is labor even though
  // it runs the project's suite - the assumption PRD 10장 records, with its
  // revisit trigger. It was scored as an asset before that rule existed.
  assert.equal(validateCheckBinding(root, "npm test", ".").classification, "labor");
  assert.equal(validateCheckBinding(root, "node test/guard.test.mjs", ".").classification, "asset");
  assert.equal(validateCheckBinding(root, "node agents/check.mjs", ".").classification, "labor");
  assert.equal(validateCheckBinding(root, "node check.mjs", "agents/tools").classification, "labor");
  assert.throws(() => validateCheckBinding(root, "curl https://example.com", "."), /outside the allowed runner forms/);
  assert.throws(() => validateCheckBinding(root, "npm test && echo hidden", "."), /without shell composition/);
  assert.throws(() => validateCheckBinding(root, "node ../outside.mjs", "."), /may not traverse outside/);
  assert.throws(() => validateCheckBinding(root, "node -e \"console.log(process.env)\"", "."), /may not execute inline code/);
  assert.throws(() => validateCheckBinding(root, "node -econsole.log(1)", "."), /may not execute inline code/);
  assert.throws(() => validateCheckBinding(root, "bash -c 'echo unsafe'", "."), /may not execute inline code/);
  assert.throws(() => validateCheckBinding(root, "bash -cecho", "."), /may not execute inline code/);
  for (const command of [
    "bash -lc 'echo unsafe'",
    "sh -xec 'echo unsafe'",
    "node -pe 'process.cwd()'",
    "python3 -Ic 'print(1)'",
    "ruby -we 'puts 1'",
  ]) assert.throws(() => validateCheckBinding(root, command, "."), /may not execute inline code/, command);
  assert.throws(() => validateCheckBinding(root, "python3 -c 'print(1)'", "."), /may not execute inline code/);
  assert.throws(() => validateCheckBinding(root, "npx vitest", "."), /require --no-install/);
  assert.throws(() => validateCheckBinding(root, "node --config=../../outside.json", "."), /may not traverse outside/);
  for (const command of [
    "node -r/tmp/evil.js scripts/check.mjs",
    "node -rscripts/setup.js scripts/check.mjs",
    "node --require=/tmp/evil.js scripts/check.mjs",
  ]) assert.throws(() => validateCheckBinding(root, command, "."), /(ambiguous attached path|path resolves outside|paths must be project-relative)/, command);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-outside-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(outside, "escape.mjs"), "console.log('outside');\n");
  fs.symlinkSync(outside, path.join(root, "linked-cwd"), "dir");
  fs.symlinkSync(path.join(outside, "escape.mjs"), path.join(root, "scripts", "escape.mjs"));
  assert.throws(() => validateCheckBinding(root, "node --version", "linked-cwd"), /cwd escapes the working tree/);
  assert.throws(() => validateCheckBinding(root, "node scripts/escape.mjs", "."), /path resolves outside/);
  assert.throws(() => validateCheckBinding(root, "node scripts/escape.mjs/new-output", "."), /path resolves outside/);
});

test("check execution uses a bookkeeping HOME and does not inherit agent secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-env-"));
  const item = criterion();
  const runState = state(root, [item]);
  // Written into the bookkeeping HOME rather than the project root: a check
  // that rewrites judged source is scored "tree-moved", and this test is
  // about the environment, not the tree.
  bind(root, item, script(root, "env.cjs", "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(process.env.HOME, 'env.json'), JSON.stringify({secret:process.env.SASU_TEST_SECRET ?? null, home:process.env.HOME}));\n"));
  const previous = process.env.SASU_TEST_SECRET;
  process.env.SASU_TEST_SECRET = "must-not-cross-check-boundary";
  try {
    assert.equal(runCriterionCheck(runState, root, item, null).outcome, "green");
  } finally {
    if (previous === undefined) delete process.env.SASU_TEST_SECRET;
    else process.env.SASU_TEST_SECRET = previous;
  }
  const observed = JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "check-runtime", "home", "env.json"), "utf8"));
  assert.equal(observed.secret, null);
  assert.equal(observed.home, path.join(root, "agents", "runs", "fixture", "check-runtime", "home"));
});

test("attempts append, same-class decisions are idempotent, and rebind invalidates green", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-ledger-"));
  const item = criterion();
  const runState = state(root, [item]);
  const failing = script(root, "fail.mjs", "console.error(`Error: /tmp/run-${Date.now()}/case.js:42 failed in 1.23s`); process.exit(1);\n");
  bind(root, item, failing);
  for (let index = 0; index < 4; index += 1) runCriterionCheck(runState, root, item, null);
  assert.equal(item.check.attempts.length, 4);
  assert.equal(item.check.consecutiveFailures, 4);
  assert.equal(item.check.decisionPoints.filter((point) => point.kind === "same-class").length, 1);
  assert.equal(item.check.decisionPoints[0].resolvedAt, null);

  const passing = script(root, "pass.mjs", "console.log('green');\n");
  assert.throws(() => bind(root, item, passing), /requires --reason/);
  bind(root, item, passing, "the original checker was broken");
  assert.equal(item.check.bindings.length, 2);
  assert.equal(item.check.status, "pending");
  assert.equal(item.check.consecutiveFailures, 0);
  assert.equal(item.check.decisionPoints[0].resolution, "rebound");
  const green = runCriterionCheck(runState, root, item, null);
  assert.equal(green.outcome, "green");
  assert.equal(item.check.status, "green");
  assert.equal(item.check.attempts.length, 5, "rebind never deletes prior attempts");
});

test("five distinct failure classes publish the backstop decision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-backstop-"));
  const item = criterion();
  const runState = state(root, [item]);
  const command = script(root, "variant.cjs", "const fs=require('fs'); console.error(`Error: ${fs.readFileSync('variant.txt','utf8').trim()}`); process.exit(1);\n");
  bind(root, item, command);
  for (const word of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    fs.writeFileSync(path.join(root, "variant.txt"), word);
    runCriterionCheck(runState, root, item, null);
  }
  assert.equal(new Set(item.check.attempts.map((attempt) => attempt.failureClass)).size, 5);
  assert.equal(item.check.decisionPoints.some((point) => point.kind === "five-failures"), true);
  assert.equal(item.check.decisionPoints.some((point) => point.kind === "same-class"), false);
});

test("bookkeeping-only work between failures publishes a tools-only decision", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-tools-"));
  const item = criterion();
  const runState = state(root, [item]);
  bind(root, item, script(root, "fail.mjs", "console.error('Error: still failing'); process.exit(1);\n"));
  runCriterionCheck(runState, root, item, null);
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "tool-note.txt"), "changed checker bookkeeping\n");
  runCriterionCheck(runState, root, item, null);
  assert.equal(item.check.decisionPoints.some((point) => point.kind === "tools-only"), true);
  assert.equal(item.check.attempts[0].tree.product, item.check.attempts[1].tree.product);
  assert.notEqual(item.check.attempts[0].tree.bookkeeping, item.check.attempts[1].tree.bookkeeping);
});

test("gate-human approval is consumed once and interrupted runs remain failed attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-check-human-"));
  const gated = criterion("AC1", "machine+gate:human");
  const runState = state(root, [gated]);
  bind(root, gated, script(root, "pass.mjs", "console.log('approved green');\n"));
  assert.throws(() => runCriterionCheck(runState, root, gated, null), /requires --human-window/);
  const green = runCriterionCheck(runState, root, gated, "operator approved once");
  assert.equal(green.humanWindow.evidence, "operator approved once");
  assert.equal(green.humanWindow.criterionId, "AC1");
  assert.throws(() => runCriterionCheck(runState, root, gated, "operator approved once"), /already consumed/);

  const interrupted = criterion("AC2");
  bind(root, interrupted, script(root, "interrupt.mjs", "process.kill(process.pid, 'SIGTERM');\n"));
  const attempt = runCriterionCheck(state(root, [interrupted]), root, interrupted, null);
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.signal, "SIGTERM");
  assert.equal(attempt.timedOut, false);
  assert.equal(interrupted.check.consecutiveFailures, 1);
});

test("park and resume preserve audit history while resetting only live state", () => {
  const item = criterion();
  assert.throws(() => parkCriterion(item, { approval: "", reason: "later", evidence: null }), /requires --approval/);
  parkCriterion(item, { approval: "operator said park", reason: "waiting for hardware", evidence: "ticket-1" });
  assert.equal(item.check.status, "parked");
  assert.equal(item.check.parks[0].parkedBy, "human");
  assert.throws(() => parkCriterion(item, { approval: "again", reason: "again", evidence: null }), /already parked/);
  resumeCriterion(item);
  assert.equal(item.check.status, "pending");
  assert.equal(item.check.consecutiveFailures, 0);
  assert.equal(typeof item.check.parks[0].resumedAt, "string");
  assert.throws(() => resumeCriterion(item), /is not parked/);
});
