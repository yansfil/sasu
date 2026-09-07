import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";

import {
  assertCheckRow,
  fingerprintCheckOutput,
  parkRow,
  resumeRow,
  rowCheckIsGreen,
  runRowCheck,
  validateCheckCommand,
} from "../../dist/implement/checks.js";

const GOLDEN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "implement-check", "fingerprint-golden.json");

function checkRow(root, command, id = "B1") {
  const validated = validateCheckCommand(root, command);
  return {
    id,
    behavior: "fixture behavior",
    check: { kind: "check", command: validated.command, argv: validated.argv },
    decisionIds: [],
    status: "pending",
    attempts: [],
    consecutiveFailures: 0,
    parks: [],
    verdict: null,
    human: null,
    rejections: [],
  };
}

function state(root, rows) {
  return { projectRoot: root, runDir: "agents/runs/fixture", rows };
}

function script(root, name, source) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", name), source);
  return `node scripts/${name}`;
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

// R2: a check: cell is the same shape verify.commands accepts - one argv,
// no shell composition - plus the confinement rules an executed command needs.
test("a check: command fails closed on composition, escape, inline code, and fetching", () => {
  const root = scratchDir("sasu-check-validate-");
  assert.deepEqual(validateCheckCommand(root, "npm test").argv, ["npm", "test"]);
  assert.deepEqual(validateCheckCommand(root, "node test/guard.test.mjs").argv, ["node", "test/guard.test.mjs"]);
  assert.throws(() => validateCheckCommand(root, "curl https://example.com"), /outside the allowed runner forms/);
  assert.throws(() => validateCheckCommand(root, "npm test && echo hidden"), /without shell composition/);
  assert.throws(() => validateCheckCommand(root, "npm test | tail"), /without shell composition/);
  assert.throws(() => validateCheckCommand(root, "node ../outside.mjs"), /may not traverse outside/);
  assert.throws(() => validateCheckCommand(root, "node -e \"console.log(process.env)\""), /may not execute inline code/);
  assert.throws(() => validateCheckCommand(root, "node -econsole.log(1)"), /may not execute inline code/);
  assert.throws(() => validateCheckCommand(root, "bash -c 'echo unsafe'"), /may not execute inline code/);
  assert.throws(() => validateCheckCommand(root, "bash -cecho"), /may not execute inline code/);
  for (const command of [
    "bash -lc 'echo unsafe'",
    "sh -xec 'echo unsafe'",
    "node -pe 'process.cwd()'",
    "python3 -Ic 'print(1)'",
    "ruby -we 'puts 1'",
  ]) assert.throws(() => validateCheckCommand(root, command), /may not execute inline code/, command);
  assert.throws(() => validateCheckCommand(root, "python3 -c 'print(1)'"), /may not execute inline code/);
  assert.throws(() => validateCheckCommand(root, "npx vitest"), /require --no-install/);
  assert.throws(() => validateCheckCommand(root, "node --config=../../outside.json"), /may not traverse outside/);
  for (const command of [
    "node -r/tmp/evil.js scripts/check.mjs",
    "node -rscripts/setup.js scripts/check.mjs",
    "node --require=/tmp/evil.js scripts/check.mjs",
  ]) assert.throws(() => validateCheckCommand(root, command), /(ambiguous attached path|path resolves outside|paths must be project-relative)/, command);

  const outside = scratchDir("sasu-check-outside-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(outside, "escape.mjs"), "console.log('outside');\n");
  fs.symlinkSync(path.join(outside, "escape.mjs"), path.join(root, "scripts", "escape.mjs"));
  assert.throws(() => validateCheckCommand(root, "node scripts/escape.mjs"), /path resolves outside/);
  assert.throws(() => validateCheckCommand(root, "node scripts/escape.mjs/new-output"), /path resolves outside/);
  fs.symlinkSync(path.join(outside, "escape.mjs"), path.join(root, "escape.mjs"));
  assert.throws(() => validateCheckCommand(root, "node escape.mjs"), /path resolves outside/, "a basename still names a project path");
  fs.symlinkSync(path.join(outside, "not-created"), path.join(root, "future-output"));
  assert.throws(() => validateCheckCommand(root, "cargo test --target-dir future-output/build"), /cannot be resolved safely/, "a dangling link cannot be treated as a future project directory");
});

// R3: a row that is not settled by a command says which channel settles it.
test("judge: and human: rows are refused by check with their own channel named", () => {
  const judge = { id: "B2", check: { kind: "judge", evidence: "a capture" } };
  assert.throws(() => assertCheckRow(judge), /B2는 judge: 행이라 verify가 판정한다; `sasu implement verify`로 넘어가라/);
  const human = { id: "B3", check: { kind: "human", confirmation: "the operator says so" } };
  assert.throws(() => assertCheckRow(human), /B3는 human: 행이라 사용자가 confirm으로 닫는다; `sasu implement confirm --row B3 --evidence/);
  assert.doesNotThrow(() => assertCheckRow({ id: "B1", check: { kind: "check", command: "npm test", argv: ["npm", "test"] } }));
});

test("check execution uses a bookkeeping HOME and does not inherit agent secrets", async () => {
  const root = scratchDir("sasu-check-env-");
  // Written into the bookkeeping HOME rather than the project root: a check
  // that rewrites judged source is scored "tree-moved", and this test is
  // about the environment, not the tree.
  const row = checkRow(root, script(root, "env.cjs", "const fs=require('node:fs'); const path=require('node:path'); fs.writeFileSync(path.join(process.env.HOME, 'env.json'), JSON.stringify({secret:process.env.SASU_TEST_SECRET ?? null, home:process.env.HOME}));\n"));
  const runState = state(root, [row]);
  const previous = process.env.SASU_TEST_SECRET;
  process.env.SASU_TEST_SECRET = "must-not-cross-check-boundary";
  try {
    assert.equal((await runRowCheck(runState, root, row)).outcome, "green");
  } finally {
    if (previous === undefined) delete process.env.SASU_TEST_SECRET;
    else process.env.SASU_TEST_SECRET = previous;
  }
  const observed = JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "check-runtime", "home", "env.json"), "utf8"));
  assert.equal(observed.secret, null);
  assert.equal(observed.home, path.join(root, "agents", "runs", "fixture", "check-runtime", "home"));
});

test("exit 0 is green, anything else is fail, and attempts append with consecutive failures counted", async () => {
  const root = scratchDir("sasu-check-ledger-");
  const row = checkRow(root, script(root, "variant.cjs", "const fs=require('fs'); const word=fs.readFileSync('variant.txt','utf8').trim(); if (word==='green') process.exit(0); console.error(`Error: ${word}`); process.exit(1);\n"));
  const runState = state(root, [row]);
  for (const word of ["alpha", "bravo"]) {
    fs.writeFileSync(path.join(root, "variant.txt"), word);
    const attempt = await runRowCheck(runState, root, row);
    assert.equal(attempt.outcome, "failed");
    assert.equal(attempt.exitCode, 1);
    assert.equal(row.status, "fail");
  }
  assert.equal(row.attempts.length, 2);
  assert.equal(row.consecutiveFailures, 2);
  assert.deepEqual(row.attempts.map((attempt) => attempt.id), ["A1", "A2"]);
  assert.notEqual(row.attempts[0].failureClass, row.attempts[1].failureClass, "distinct failures carry distinct classes");
  assert.equal(rowCheckIsGreen(row), false);

  fs.writeFileSync(path.join(root, "variant.txt"), "green");
  const green = await runRowCheck(runState, root, row);
  assert.equal(green.outcome, "green");
  assert.equal(green.failureClass, null);
  assert.equal(row.status, "green");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.attempts.length, 3, "a green never deletes prior attempts");
  assert.equal(rowCheckIsGreen(row), true);
});

test("a check that rewrites judged source is tree-moved even on exit 0, and an interrupted run is a failed attempt", async () => {
  const root = scratchDir("sasu-check-tree-");
  const mover = checkRow(root, script(root, "move.cjs", "require('fs').writeFileSync('generated.txt', 'moved');\n"));
  const moved = await runRowCheck(state(root, [mover]), root, mover);
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.mutatedTree, true);
  assert.equal(moved.outcome, "tree-moved");
  assert.equal(mover.status, "fail", "exit 0 does not save a command that moved the goalposts");

  const interrupted = checkRow(root, script(root, "interrupt.mjs", "process.kill(process.pid, 'SIGTERM');\n"), "B2");
  const attempt = await runRowCheck(state(root, [interrupted]), root, interrupted);
  assert.equal(attempt.outcome, "failed");
  assert.equal(attempt.signal, "SIGTERM");
  assert.equal(attempt.timedOut, false);
  assert.equal(interrupted.consecutiveFailures, 1);
});

test("a sealed command that no longer tokenizes the same way is refused instead of run", async () => {
  const root = scratchDir("sasu-check-sealed-");
  const row = checkRow(root, script(root, "pass.mjs", "console.log('green');\n"));
  row.check.argv = ["node", "scripts/other.mjs"];
  await assert.rejects(() => runRowCheck(state(root, [row]), root, row), /no longer tokenizes to what was sealed at start; amend the row/);
  assert.equal(row.attempts.length, 0);
});

test("park and resume preserve audit history while resetting only live state", async () => {
  const root = scratchDir("sasu-check-park-");
  const row = checkRow(root, script(root, "pass.mjs", "console.log('green');\n"));
  assert.throws(() => parkRow(row, { approval: "", reason: "later", evidence: null }), /requires --approval/);
  parkRow(row, { approval: "operator said park", reason: "waiting for hardware", evidence: "ticket-1" });
  assert.equal(row.status, "parked");
  assert.equal(row.parks[0].evidence, "ticket-1");
  assert.throws(() => parkRow(row, { approval: "again", reason: "again", evidence: null }), /already parked/);
  await assert.rejects(() => runRowCheck(state(root, [row]), root, row), /B1 is parked; run `sasu implement resume --row B1`/);
  resumeRow(row);
  assert.equal(row.status, "pending");
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(typeof row.parks[0].resumedAt, "string");
  assert.throws(() => resumeRow(row), /is not parked/);
});
