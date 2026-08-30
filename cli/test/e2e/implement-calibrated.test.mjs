import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// --- T14: one run whose every answer is known in advance --------------------
//
// The unit tests each prove one rule against one input. This file proves the
// rules still hold when they are assembled, which is a different claim: the
// 2026-08-20 failure mode was a run where every part passed and the receipt
// still lied about the whole (AGENTS.md Review Guide 6, PRD V3).
//
// The calibration, fixed before anything runs:
//
//   AC1  machine  binds the SAME (cwd, command) as suite S1  -> one execution,
//                                                               two attributions
//   AC2  machine  fails, then is parked                      -> scored apart
//   AC3  judged   proved by a drive, not by the implementor  -> brief + trail
//   AC4  machine  its PRD row is later amended               -> loses green alone
//   S1   suite    the duplicate of AC1's command
//   S2   suite    orphan: no criterion binds it, and it is red
//
// Expected end state: `AC: 3/4 PASS (parked 1: AC2 ...) | suite: 2/2 GREEN`,
// unified verdict PASS, and every mechanical command executed exactly once.

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

const SUITE_TEST = "node --test test/suite.test.mjs";
const SUITE_BUILD = "node scripts/build.mjs";

function prd() {
  return `---
topic: "implement calibrated fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "calibrated end-to-end fixture"
source_intake: "current conversation"
---

# PRD: implement calibrated fixture

## 1. Summary

A run whose every answer is known before it starts.

## 2. Problem, Goal, And Users

Units pass and the assembled receipt still lies.

## 3. Scope And Non-Goals

Only the fixture lifecycle is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The duplicate command runs once. Covers AC1.
- R2. The unprovable criterion is parked. Covers AC2.
- R3. The driven criterion is proved by a drive. Covers AC3.
- R4. The amended criterion loses only its own green. Covers AC4.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes the shared command once. Covers R1. | machine | - |
| AC2 | The unavailable platform check passes. Covers R2. | machine | - |
| AC3 | The operator can see the summary on screen. Covers R3. | judged | a drive capture registered as an artifact |
| AC4 | The ledger records the run. Covers R4. | machine | - |

## 8. PRD-Level Tasks

- T1. Implement AC1 and AC2. Covers R1, R2, AC1, AC2. Depends on: none.
- T2. Implement AC3 and AC4. Covers R3, R4, AC3, AC4. Depends on: T1.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |
| build | yes | fixture build | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R2, R3, AC1, AC2, AC3 | the suite is green | yes | no |
| V2 | build | R4, AC4 | the build is green | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report both score axes.
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

/** The same spawn without `--json`, for the output a person actually reads. */
function runPlain(root, args) {
  const merged = { ...process.env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: merged });
}

/** `green` decides whether the orphan suite command (S2) starts red. */
function makeProject({ buildGreen = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-calibrated-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  // The suite list is sealed from this config at start (AC5).
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    verify: { commands: { test: SUITE_TEST, build: SUITE_BUILD } },
  }));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "suite.test.mjs"), "import test from 'node:test';\ntest('suite', () => {});\n");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeBuild(root, buildGreen);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
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

function writeBuild(root, green) {
  fs.writeFileSync(
    path.join(root, "scripts", "build.mjs"),
    green ? "process.exit(0);\n" : "console.error('the orphan suite command is red');\nprocess.exit(1);\n",
  );
}

const STATE_REL = path.join("agents", "runs", "fixture", "state.json");
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));

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
      "implement:acceptance:AC3": {
        verdict: "PASS",
        criteria: [{ id: "AC3", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered drive capture" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
}

const bind = (root, ac, command) => {
  const bound = run(root, ["implement", "check", "--ac", ac, "--bind", command]);
  assert.equal(bound.status, 0, bound.stderr + bound.stdout);
  return bound.json.detail.binding;
};

const closeTasks = (root, ids = ["T1", "T2"]) => {
  for (const id of ids) {
    const closed = run(root, ["implement", "task", "--id", id, "--status", "complete"]);
    assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  }
};

/**
 * AC3 is proved by someone driving the screen, never by the implementor
 * asserting it works. The brief is the only sanctioned source of the script,
 * and the trail has to echo the brief it was issued and cover every step.
 */
function proveDrivenCriterion(root, { driver = "human" } = {}) {
  const issued = run(root, ["implement", "qa-brief", "--ac", "AC3"]);
  assert.equal(issued.status, 0, issued.stderr + issued.stdout);
  const brief = issued.json.detail.brief;
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "ac3.txt"), "the operator sees the summary\n");
  const registered = run(root, ["implement", "artifact", "--ac", "AC3", "--kind", "log",
    "--path", "shots/ac3.txt", "--description", "drive capture for AC3"]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const trail = run(root, ["implement", "trail", "--ac", "AC3", "--brief", brief.briefId,
    "--steps", brief.steps.map((step) => step.id).join(","), "--driver", driver,
    "--artifacts", "shots/ac3.txt"]);
  assert.equal(trail.status, 0, trail.stderr + trail.stdout);
  return brief;
}

test("T14 calibration: the run seals the two suite commands the fixture declared", () => {
  const root = makeProject();
  const sealed = state(root).suite;
  assert.deepEqual(sealed.commands.map((entry) => [entry.id, entry.command, entry.cwd]), [
    ["S1", SUITE_TEST, "."],
    ["S2", SUITE_BUILD, "."],
  ]);
  assert.deepEqual(sealed.commands.map((entry) => entry.verificationIds), [["V1"], ["V2"]]);
  assert.deepEqual(sealed.exclusions, []);

  // AC5: the sealed list is the authority from here, not the config file.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    verify: { commands: { test: "node -e \"process.exit(0)\"" } },
  }));
  assert.deepEqual(
    state(root).suite.commands.map((entry) => entry.command),
    [SUITE_TEST, SUITE_BUILD],
    "a mid-run config edit must not change what this run is measured against",
  );
});

test("AC1/AC3: the shared command runs once for two owners, and a red orphan blocks a perfect AC score", () => {
  const root = makeProject();
  const env = stubEnv(root);
  // AC1 binds the very command suite S1 already carries: one (cwd, command).
  assert.equal(bind(root, "AC1", SUITE_TEST).command, SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  assert.equal(bind(root, "AC2", SUITE_TEST).command, SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC2"]).status, 0);
  assert.equal(bind(root, "AC4", SUITE_TEST).command, SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC4"]).status, 0);
  proveDrivenCriterion(root);
  closeTasks(root);

  const verified = run(root, ["implement", "verify"], env);
  // AC3 (R2): every criterion is green and the run still fails, because a
  // suite command no criterion watches is red. The two axes are independent.
  assert.equal(verified.status, 1, verified.stdout);
  const attempt = state(root).verificationAttempts.at(-1);
  assert.equal(attempt.verdict, "FAIL");

  // AC1 (R1): the duplicate pair executed exactly once, and that one result
  // is attributed to both owners. One execution record, not two.
  const shared = attempt.mechanical.filter((entry) => entry.command === SUITE_TEST);
  assert.equal(shared.length, 1, `the shared command must run once, ran ${shared.length} times; mechanical=${JSON.stringify(attempt.mechanical.map((e) => [e.command, e.status]))} suite=${JSON.stringify(state(root).suite.results.map((e) => [e.commandId, e.status]))}`);

  const suite = state(root).suite;
  const s1 = suite.results.find((entry) => entry.commandId === "S1");
  assert.equal(s1.status, "GREEN");
  assert.deepEqual([...s1.attributedCriteria].sort(), ["AC1", "AC2", "AC4"], "the one execution scored all three criteria that named it");
  assert.equal(s1.startedAt, shared[0].startedAt, "criterion and suite read the SAME execution, not two runs of one command");

  // ...and the orphan is the only red, on its own axis.
  const s2 = suite.results.find((entry) => entry.commandId === "S2");
  assert.equal(s2.status, "RED");
  assert.deepEqual(s2.attributedCriteria, [], "no criterion watches it - that is what makes it an orphan");
  assert.equal(suite.results.filter((entry) => entry.status === "RED").length, 1);
  for (const id of ["AC1", "AC2", "AC4"]) {
    assert.equal(state(root).acceptanceCriteria.find((entry) => entry.id === id).check.status, "green");
  }
});

test("AC10/AC13/AC16: the receipt reads the calibration, and an amendment costs only the row it changed", () => {
  const root = makeProject({ buildGreen: true });
  const env = stubEnv(root);
  bind(root, "AC1", SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  bind(root, "AC4", SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC4"]).status, 0);
  proveDrivenCriterion(root);

  // AC2 is the criterion that cannot be proved here: fail it until the
  // harness opens a decision point, then let the supervisor park it.
  fs.writeFileSync(path.join(root, "test", "red.test.mjs"), "import test from 'node:test';\ntest('red', () => { throw new Error('no platform'); });\n");
  bind(root, "AC2", "node --test test/red.test.mjs");
  for (let i = 0; i < 5; i += 1) run(root, ["implement", "check", "--ac", "AC2"]);
  const parked = run(root, ["implement", "park", "--issuer", "observer", "--ac", "AC2",
    "--reason", "the platform binary is unavailable on this runner"]);
  assert.equal(parked.status, 0, parked.stdout);
  assert.equal(parked.json.detail.park.parkedBy, "observer");
  closeTasks(root);

  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  // The calibrated score, in the string a person reads.
  const line = state(root).verificationAttempts.at(-1) && scoreLineOf(root);
  assert.match(line, /^AC: 3\/4 PASS \(parked 1: AC2 the platform binary is unavailable on this runner\) \| suite: 2\/2 GREEN$/);

  // AC10: a parked criterion is not a failure and still refuses a complete close.
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /AC2 is parked/);

  // AC13/AC16: amend one AC row. Only that row loses its green.
  const before = new Map(state(root).acceptanceCriteria.map((entry) => [entry.id, entry.check.status]));
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  fs.writeFileSync(prdPath, fs.readFileSync(prdPath, "utf8")
    .replace("| AC4 | The ledger records the run. Covers R4. | machine | - |",
      "| AC4 | The ledger records the run and its clock. Covers R4. | machine | - |"));
  const amended = run(root, ["implement", "amend", "--issuer", "human",
    "--approval", "AC4 as written did not say what it had to say", "--reason", "the row was wrong"]);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);

  const after = new Map(state(root).acceptanceCriteria.map((entry) => [entry.id, entry.check.status]));
  assert.equal(after.get("AC4"), "pending", "the amended row loses its green");
  assert.equal(after.get("AC1"), before.get("AC1"), "an untouched row keeps its evidence");
  assert.equal(after.get("AC2"), "parked", "and a parked row whose text did not change stays parked");
  // Append-only: the amendment is recorded, and the earlier snapshot survives.
  const amendments = state(root).amendments;
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].issuer, "human");
  assert.deepEqual(amendments[0].invalidated ?? amendments[0].invalidatedCriteria, ["AC4"]);
});

/** The score line as the receipt would print it, read from the live ledger. */
function scoreLineOf(root) {
  const summary = runPlain(root, ["implement", "status"]).stdout.split("\n");
  return summary.find((line) => line.startsWith("AC: "));
}

test("AC19/AC23/AC25: the supervisor's channel, the waiter's backlog, and the stall wake", () => {
  const root = makeProject({ buildGreen: true });
  stubEnv(root);

  // AC19: three checks, and the one that refuses names itself. The observer
  // may reorder pending work; it may not do the work or call it done.
  const reordered = run(root, ["implement", "resequence", "--issuer", "observer",
    "--order", "T2,T1", "--reason", "T2's deliverable unblocks T1's reviewer"]);
  assert.equal(reordered.status, 0, reordered.stdout);
  assert.deepEqual(state(root).tasks.map((entry) => entry.id), ["T2", "T1"]);
  const forbidden = run(root, ["implement", "task", "--issuer", "observer", "--id", "T1", "--status", "complete"]);
  assert.equal(forbidden.json.detail.rejectedCheck, "authority");
  // A partial permutation is refused by the ARGUMENT check: the order is
  // malformed before it is a state question (AC17, AC19).
  const badOrder = run(root, ["implement", "resequence", "--issuer", "observer", "--order", "T1", "--reason", "half of it"]);
  assert.equal(badOrder.json.detail.rejectedCheck, "arguments");
  // Every verb, accepted and refused, is in the history with which check ruled.
  assert.deepEqual(
    state(root).verbs.map((entry) => [entry.verb, entry.outcome, entry.rejection?.check ?? null]),
    [["resequence", "accepted", null], ["task", "rejected", "authority"], ["resequence", "rejected", "arguments"]],
  );
  // AC18: reordering moved no evidence.
  assert.deepEqual(state(root).acceptanceCriteria.map((entry) => entry.check.status), ["pending", "pending", "pending", "pending"]);

  // AC23: the run already has events, so a waiter behind the cursor returns
  // the backlog instead of blocking - an event raised while nobody watched
  // is not an event that is lost.
  // A refused verb is history, not an event: nothing changed, so nobody needs
  // waking. Real work is what raises events, so do some.
  assert.deepEqual(state(root).events.map((entry) => entry.kind), ["resequence"]);
  bind(root, "AC1", SUITE_TEST);
  assert.equal(run(root, ["implement", "check", "--ac", "AC1"]).status, 0);
  const events = state(root).events;
  assert.ok(events.length >= 3, `binding and running a check must raise events, got ${JSON.stringify(events.map((e) => e.kind))}`);
  const backlog = run(root, ["implement", "await", "--since", "1"]);
  assert.equal(backlog.status, 0, backlog.stderr + backlog.stdout);
  assert.equal(backlog.json.detail.reason, "event");
  assert.equal(backlog.json.detail.events[0].id, 2, "it resumes at the cursor, and does not replay what was seen");

  // AC25/AC38: with the last event aged past the constant, the waiter wakes on
  // stall. The clock is moved rather than waited out - the threshold is a code
  // constant on purpose (D-18), so the fixture ages the record instead.
  const aged = state(root);
  const longAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  for (const entry of aged.events) entry.at = longAgo;
  fs.writeFileSync(path.join(root, STATE_REL), JSON.stringify(aged, null, 2));
  const stalled = run(root, ["implement", "await", "--since", String(aged.events.at(-1).id)]);
  assert.equal(stalled.status, 0, stalled.stderr + stalled.stdout);
  assert.equal(stalled.json.detail.reason, "stall");
  assert.match(stalled.json.message, /woke on stall/);

  // The re-arm is the loop's one unguarded link, so the wake hands it back
  // assembled: cursor advanced past what this wake reported, probe flag
  // carried over, ready to run as-is.
  assert.equal(
    backlog.json.detail.rearm,
    `sasu implement await --since ${backlog.json.detail.events.at(-1).id}`,
    "an event wake must hand back the next waiter with the cursor advanced",
  );
  const probed = run(root, ["implement", "await", "--since", String(aged.events.at(-1).id), "--pid", String(process.pid)]);
  assert.equal(probed.json.detail.reason, "stall");
  assert.match(probed.json.detail.rearm, new RegExp(`--pid ${process.pid}$`), "the probe flag survives the re-arm");
  assert.match(probed.json.message, /re-arm in the background with: sasu implement await/);

  // A dead implementor gets no re-arm: the recovery is a replacement pane, and
  // another waiter on a corpse would wake instantly and forever.
  const gone = run(root, ["implement", "await", "--since", String(aged.events.at(-1).id), "--pid", "2147483646"]);
  assert.equal(gone.json.detail.reason, "implementor-gone");
  assert.equal(gone.json.detail.rearm, null);
  assert.doesNotMatch(gone.json.message, /re-arm/);
});

test("AC10 end to end: the all-green close prints both axes and calls no judge", () => {
  const root = makeProject({ buildGreen: true });
  const env = stubEnv(root);
  for (const ac of ["AC1", "AC2", "AC4"]) {
    bind(root, ac, SUITE_TEST);
    assert.equal(run(root, ["implement", "check", "--ac", ac]).status, 0);
  }
  proveDrivenCriterion(root);
  closeTasks(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, finalized.json.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.scoreLine, "AC: 4/4 PASS | suite: 2/2 GREEN");
  assert.equal(receipt.score.acceptance.parked.length, 0);
  assert.equal(receipt.executionCallsDuringFinalize, 0, "finalize runs nothing; it reads the record");

  const report = fs.readFileSync(path.join(root, finalized.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /AC: 4\/4 PASS \| suite: 2\/2 GREEN/);
  // The driven criterion's proof is a drive by someone other than the
  // implementor, and the report says so rather than asserting the screen works.
  assert.match(report, /AC3/);
  assert.equal(state(root).trails.at(-1).driverRole, "human");
});
