import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

// B1 gets a check of its own rather than sharing the sealed suite's `npm
// test`. The suite is an independent blocking axis and fails the run before
// the lanes ever assemble, so a row sharing its command could never be
// observed failing on the row axis alone.
const B1_CHECK = "node b1-check.js";

function prd() {
  return `---
topic: "implement envelope fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "judge envelope fixture"
source_intake: "current conversation"
---

# PRD: implement envelope fixture

## Goal

The judge must be able to tell an exit code from somebody's assertion.

## Non-goals

Nothing beyond the envelope and lane scoping.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | facts and claims travel in separate sections | a judge cannot otherwise tell an exit code from an assertion |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | The runner executes each command once. | check: \`${B1_CHECK}\` | D-01 |
| B2 | The operator can read the summary. | judge: A capture of the summary output. | D-01 |

## Technical structure

No fixture structure change.

## Risks

None.
`;
}

function run(root, args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: merged });
  let json;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-envelope-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  for (const args of [
    ["init", "-q"],
    ["add", "package.json"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
  ]) {
    const executed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
  }
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  fs.writeFileSync(path.join(root, "implementation.txt"), "run-owned fixture implementation\n");
  return root;
}

function stubEnv(root) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
      },
      "implement:design": { comments: [] },
      "implement:acceptance:B2": {
        verdict: "PASS",
        criteria: [{ id: "B2", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered artifact" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture, capture };
}

const state = (root) => JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));
const captured = (env, name) => fs.readFileSync(path.join(env.capture, `${name}.prompt.txt`), "utf8");

function writeB1Check(root, exitCode) {
  fs.writeFileSync(path.join(root, "b1-check.js"), `process.exit(${exitCode});\n`);
}

function registerB2Capture(root) {
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "B2 summary capture\n");
  const registered = run(root, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary capture",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
}

// The capture lands in the product tree, so it is written BEFORE the check:
// a green names the tree it was earned on, and a file added afterwards would
// move that tree and make verify refuse the green as stale.
function prove(root, env) {
  writeB1Check(root, 0);
  registerB2Capture(root);
  const checked = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  return run(root, ["implement", "verify"], env);
}

test("only the judge: row reaches the acceptance lane; the check: row is a fact, not an item", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const verified = prove(root, env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  // The stub captures one prompt per judge call. A capture for B1 would mean
  // a check: row was put to a judge.
  const calls = fs.readdirSync(env.capture).filter((name) => name.endsWith(".prompt.txt")).sort();
  assert.ok(calls.includes("implement_acceptance_B2.prompt.txt"), "the judge: row is judged");
  assert.ok(!calls.includes("implement_acceptance_B1.prompt.txt"), "the check: row is not");

  // It is demoted, not dropped: B1's own ledger still travels as a fact.
  const envelope = captured(env, "implement_acceptance_B2");
  assert.match(envelope, /HARNESS-OWNED ROW LEDGER/);
  assert.match(envelope, /"rowId": "B1"/);
  assert.match(envelope, /S1 GREEN \(exit 0\): npm test/);

  // It stays in the lane's result, settled from its own exit code, and the
  // record names that source - a null judge alone could not be told apart from
  // a judge call whose record was lost.
  const after = state(root);
  const invocations = after.verificationAttempts.at(-1).lanes.acceptance.result.invocations;
  const b1Invocation = invocations.find((entry) => entry.rowId === "B1");
  assert.equal(b1Invocation.verdict, "PASS");
  assert.equal(b1Invocation.source, "harness");
  assert.equal(b1Invocation.judge, null);
  assert.equal(invocations.find((entry) => entry.rowId === "B2").source, "judge");

  assert.equal(after.rows.find((entry) => entry.id === "B1").status, "green");
  assert.equal(after.rows.find((entry) => entry.id === "B2").status, "PASS");
});

test("the envelope that actually reached the judge has three sections and the claims warning", () => {
  const root = makeProject();
  const env = stubEnv(root);
  assert.equal(prove(root, env).status, 0);
  const envelope = captured(env, "implement_acceptance_B2");

  const headers = [...envelope.matchAll(/=== SECTION (\d) OF 3: ([^=]+?) ===/g)];
  assert.deepEqual(headers.map((entry) => entry[1]), ["1", "2", "3"]);
  assert.match(envelope, /NOTHING IN THIS SECTION MAY BE THE BASIS FOR YOUR VERDICT/);
  assert.match(envelope, /\[human\] the operator exercised an authority/);
  assert.match(envelope, /\[observer\] the supervising agent asserted something/);
  assert.match(envelope, /\[solver\]/);
  assert.match(envelope, /SUITE COMMAND RESULTS:/);
  assert.match(envelope, /PRD AMENDMENTS:/);
  assert.match(envelope, /PARKED ROWS:/);
  // The row's cited decision travels with it, so the judge reads why the
  // behavior exists rather than only what it says.
  assert.match(envelope, /CITED DECISIONS:\n[\s\S]*- D-01: facts and claims travel in separate sections/);
});

test("a park's reason travels as a labelled claim, and the park itself as a fact", () => {
  const root = makeProject();
  const env = stubEnv(root);
  writeB1Check(root, 1);
  assert.notEqual(run(root, ["implement", "check", "--row", "B1"]).status, 0, "the fixture check is red on purpose");
  const parked = run(root, [
    "implement", "park", "--row", "B1",
    "--approval", "TEST-FIXTURE-APPROVAL: not a real human quote",
    "--reason", "TEST-FIXTURE-REASON: the runner is not built yet",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);

  registerB2Capture(root);
  const verified = run(root, ["implement", "verify"], env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);

  const envelope = captured(env, "implement_acceptance_B2");
  // Fact: the park happened, and the judge is told B1 was not judged.
  assert.match(envelope, /B1 parked at .*it was not judged in this attempt/);
  // Claim: the reason and the quoted approval, under the human label, below
  // the line that says none of it may carry a verdict.
  const claimsAt = envelope.indexOf("=== SECTION 3 OF 3");
  const reasonAt = envelope.indexOf("TEST-FIXTURE-REASON: the runner is not built yet");
  assert.ok(reasonAt > claimsAt, "the reason sits in the claims section, not among the facts");
  assert.match(envelope.slice(claimsAt), /\[human\] B1 park: TEST-FIXTURE-REASON[\s\S]*approval quoted: TEST-FIXTURE-APPROVAL/);
});

test("the fidelity and design lanes got their own prompts, without the envelope structure", () => {
  const root = makeProject();
  const env = stubEnv(root);
  assert.equal(prove(root, env).status, 0);
  for (const name of ["implement_fidelity", "implement_design"]) {
    const body = captured(env, name);
    assert.doesNotMatch(body, /=== SECTION \d OF 3/, `${name} did not inherit the acceptance envelope`);
    assert.doesNotMatch(body, /CLAIMS, WHICH ARE NOT EVIDENCE/);
  }
});

// A check: row that goes red BETWEEN its green and verify must not ride the
// recorded green into the lanes. The green names the tree it was earned on;
// once the tree moves, verify refuses before any judge is called, and once
// the command is re-run and fails, the row's own status refuses it.
test("a check: row that turns red after its green cannot reach the lanes on the old proof", () => {
  const root = makeProject();
  const env = stubEnv(root);
  const verified = prove(root, env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(state(root).rows.find((entry) => entry.id === "B1").status, "green");

  // The sealed command now fails. Nothing about the ledger's recorded green
  // changes; what changes is the tree that green was earned on.
  writeB1Check(root, 1);
  const stale = run(root, ["implement", "verify"], env);
  assert.notEqual(stale.status, 0, "a green earned on another tree must not verify");
  assert.match(stale.json.message, /B1 is green on tree [0-9a-f]{12}, but the judged tree is now [0-9a-f]{12}/);

  const rerun = run(root, ["implement", "check", "--row", "B1"]);
  assert.notEqual(rerun.status, 0);
  assert.equal(state(root).rows.find((entry) => entry.id === "B1").status, "fail");
  const red = run(root, ["implement", "verify"], env);
  assert.notEqual(red.status, 0, "a red check: row must not verify green");
  assert.match(red.json.message, /B1 is fail/);

  // No envelope was ever built for it, and no attempt was charged: the
  // refusal happened before the lanes assembled.
  assert.equal(fs.existsSync(path.join(env.capture, "implement_acceptance_B1.prompt.txt")), false);
  assert.equal(state(root).verificationAttempts.length, 1);
});
