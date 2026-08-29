import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// --- R16: the three defects the 2026-08-29 live run exposed -----------------
//
// Each of these is a rule that was written without its exception. The
// supervisor was meant to be read-only and nothing enforced or recorded it;
// the blocked close asked whether the judge budget was spent instead of
// whether another round could change anything; and `status` answered a
// question in 491 lines of JSON. Proof here is the exit code, the record, and
// the bytes actually printed - never a claim about the code.

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function prd() {
  return `---
topic: "implement defects fixture"
status: "ready"
human_approval: "approved"
review_profile: "high-risk"
review_rationale: "R16 defect fixture"
source_intake: "current conversation"
---

# PRD: implement defects fixture

## 1. Summary

Exercise the three defects the 2026-08-29 live run exposed.

## 2. Problem, Goal, And Users

A run that cannot converge has to be able to close honestly.

## 3. Scope And Non-Goals

Only the R16 defect paths are in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The machine criterion works. Covers AC1.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes each command once. Covers R1. | machine | - |

## 8. PRD-Level Tasks

- T1. Implement AC1. Covers R1, AC1. Depends on: none.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, AC1 | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the terminal reason.
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

/** The same spawn without `--json`: AC47 is about what a person actually sees. */
function runPlain(root, args) {
  const merged = { ...process.env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: merged });
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-defects-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "remote.sh"), "#!/bin/sh\necho remote\n");
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
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

const STATE_REL = path.join("agents", "runs", "fixture", "state.json");
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));

/** `findings` is what the risk lane will report on the NEXT verify. */
function stubEnv(root, findings = []) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
      },
      "implement:design": { comments: [] },
      "implement:risk": { verdict: findings.length === 0 ? "PASS" : "FAIL", findings },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
}

function proveAndClose(root) {
  const bound = run(root, ["implement", "check", "--ac", "AC1", "--bind", "npm test"]);
  assert.equal(bound.status, 0, bound.stderr + bound.stdout);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  const closed = run(root, ["implement", "task", "--id", "T1", "--status", "complete"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
}


// --- R16 ②/AC45: the supervisor is read-only, in code and in the record -----

test("AC45: a supervisor-labelled state change is refused and recorded as an authority violation", () => {
  const root = makeProject();
  stubEnv(root);

  // Closing a task is the exact move that used to rest on self-restraint.
  const refused = run(root, ["implement", "task", "--issuer", "observer", "--id", "T1", "--status", "complete"]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.json.message, /observer may not issue `sasu implement task`/);
  assert.match(refused.json.message, /not authenticated/, "the message must not claim to be a security boundary");
  assert.equal(refused.json.detail.rejectedCheck, "authority");
  assert.equal(state(root).tasks.find((entry) => entry.id === "T1").status, "pending", "the refusal changed nothing");

  // The refusal is IN the run's history. Without this the gate knew it had
  // refused and the record said nothing was ever attempted.
  const recorded = state(root).verbs.at(-1);
  assert.equal(recorded.verb, "task");
  assert.equal(recorded.issuer, "observer");
  assert.equal(recorded.outcome, "rejected");
  assert.equal(recorded.rejection.check, "authority");
  assert.equal(recorded.target, "T1");

  // Every implementation command, not just the one that hurt.
  for (const argv of [
    ["implement", "check", "--issuer", "observer", "--ac", "AC1", "--bind", "npm test"],
    ["implement", "artifact", "--issuer", "observer", "--ac", "AC1", "--kind", "log", "--path", "lib/remote.sh", "--description", "x"],
    ["implement", "finalize", "--issuer", "observer"],
    ["implement", "verify", "--issuer", "observer"],
  ]) {
    const each = run(root, argv);
    assert.equal(each.status, 2, `${argv[1]} must refuse an observer: ${each.stdout}`);
    assert.equal(each.json.detail.rejectedCheck, "authority");
  }
  const history = state(root).verbs;
  assert.deepEqual(
    history.filter((entry) => entry.outcome === "rejected").map((entry) => entry.verb),
    ["task", "check", "artifact", "finalize", "verify"],
    "every refusal lands, in order",
  );
  // Read-only surfaces are not in the table, so anyone may look.
  assert.equal(run(root, ["implement", "status", "--issuer", "observer"]).status, 0);
});

// --- R16 ③/AC46: closing honestly without burning rounds that cannot help ---

test("AC46: a non-convergent finding closes the run blocked, and the receipt says who declared it", () => {
  const root = makeProject();
  const env = stubEnv(root, [{ severity: "blocking", text: "the fixture pins a platform the harness cannot install" }]);
  proveAndClose(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  // A blocking finding does not fail the unified verdict; it blocks the
  // COMPLETE close, which is the state this test is about.
  assert.equal(state(root).riskFindings[0].id, "RF1");
  assert.equal(state(root).riskFindings[0].status, "open");

  // Before the declaration: blocked is refused because a round could still
  // run, and the refusal names the way out rather than just saying no.
  const early = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(early.status, 2);
  assert.match(early.json.message, /verification can still run/);
  assert.match(early.json.message, /undeclared: RF1/);

  // Only a human may declare it, and only with a quote and a reason.
  const byObserver = run(root, ["implement", "risk", "--non-convergent", "--issuer", "observer", "--id", "RF1",
    "--approval", "go ahead", "--reason", "no round can install it"]);
  assert.equal(byObserver.status, 2, byObserver.stdout);
  assert.match(byObserver.json.message, /limited to human/);
  const bare = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1", "--reason", "x"]);
  assert.equal(bare.status, 2);
  assert.match(bare.json.message, /missing required --approval/);

  const declared = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1",
    "--approval", "맞다 이건 이 저장소에서 못 고친다, blocked로 닫자",
    "--reason", "the platform binary is unavailable on any runner this harness can reach"]);
  assert.equal(declared.status, 0, declared.stderr + declared.stdout);
  assert.equal(declared.json.detail.finding.status, "open", "declaring it terminal does not resolve it");
  assert.equal(declared.json.detail.finding.nonConvergence.declaredBy, "human");
  assert.equal(typeof declared.json.detail.finding.nonConvergence.roundsUnchanged, "number");

  // It still refuses a COMPLETE close: nothing about it got fixed.
  const complete = run(root, ["implement", "finalize"]);
  assert.equal(complete.status, 2);
  assert.match(complete.json.message, /risk finding RF1 \(blocking\) is open/);

  const blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(blocked.status, 0, blocked.stderr + blocked.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, blocked.json.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.terminalReason, "non-convergent-findings");
  assert.equal(receipt.verificationBudget.budgetExhausted ?? false, false, "the budget was never spent to get here");
  assert.equal(receipt.nonConvergentFindings.length, 1);
  assert.equal(receipt.nonConvergentFindings[0].id, "RF1");
  assert.match(receipt.nonConvergentFindings[0].approval, /blocked로 닫자/);
  assert.equal(receipt.nonConvergentFindings[0].declaredBy, "human");
  const report = fs.readFileSync(path.join(root, blocked.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /Non-convergent: declared by human/);
  assert.match(report, /the platform binary is unavailable/);
});

test("AC46: one undeclared finding is enough to keep the run non-terminal", () => {
  const root = makeProject();
  const env = stubEnv(root, [
    { severity: "blocking", text: "the fixture pins an unavailable platform" },
    { severity: "blocking", text: "the second finding is an ordinary fixable bug" },
  ]);
  proveAndClose(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  assert.equal(run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1",
    "--approval", "yes", "--reason", "structural"]).status, 0);
  // RF2 could still be fixed by another round, so the run is not terminal:
  // the escape hatch is all-or-nothing on purpose.
  const refused = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /undeclared: RF2/);

  // An already-accepted finding cannot also be declared terminal - the two
  // dispositions mean opposite things about the same defect.
  assert.equal(run(root, ["implement", "risk", "--accept", "--id", "RF2", "--evidence", "user says ship it"]).status, 0);
  const doubled = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF2",
    "--approval", "yes", "--reason", "changed my mind"]);
  assert.equal(doubled.status, 2);
  assert.match(doubled.json.message, /is accepted, not open/);
});

// --- R16/AC47: the answer above the record ----------------------------------

test("AC47: status answers in a summary, and the JSON record is one flag away", () => {
  const root = makeProject();
  const env = stubEnv(root);
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "red.test.mjs"), "import test from 'node:test';\ntest('red', () => { throw new Error('the fixture binary is missing'); });\n");
  const bound = run(root, ["implement", "check", "--ac", "AC1", "--bind", "node --test test/red.test.mjs"]);
  assert.equal(bound.status, 0, bound.stdout);
  // Fail it enough times to open a decision point, then park it as the
  // supervisor - the exact state whose reason went missing in 491 lines.
  for (let i = 0; i < 5; i += 1) run(root, ["implement", "check", "--ac", "AC1"]);
  const parked = run(root, ["implement", "park", "--issuer", "observer", "--ac", "AC1",
    "--reason", "the fixture binary is missing on this runner"]);
  assert.equal(parked.status, 0, parked.stdout);

  const human = runPlain(root, ["implement", "status"]);
  assert.equal(human.status, 0, human.stderr + human.stdout);
  const printed = human.stdout;
  assert.doesNotMatch(printed, /"acceptanceChecks"/, "the machine record must not be dumped on top of the answer");
  assert.ok(printed.split("\n").length < 40, `the summary must stay readable, got ${printed.split("\n").length} lines`);
  // The three things a person opens status for.
  assert.match(printed, /AC: \d+\/\d+ PASS/);
  assert.match(printed, /parked \(1\)/);
  assert.match(printed, /AC1 \[by observer\] the fixture binary is missing on this runner/);
  assert.match(printed, /full record: re-run with --json/);

  // Nothing was taken away: --json still carries the whole record.
  const machine = run(root, ["implement", "status", "--json"]);
  assert.equal(machine.status, 0);
  assert.equal(machine.json.detail.parked.length, 1);
  assert.equal(machine.json.detail.acceptanceChecks.length, 1);
  assert.ok(machine.json.summary.length > 0, "the summary travels in the JSON too, for a caller that wants it");
});
