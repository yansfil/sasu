import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// --- one run whose every answer is known in advance --------------------------
//
// The unit tests each prove one rule against one input. This file proves the
// rules still hold when they are assembled, which is a different claim: the
// 2026-08-20 failure mode was a run where every part passed and the receipt
// still lied about the whole (AGENTS.md Review Guide 6).
//
// The calibration, fixed before anything runs:
//
//   B1  check:  the same command as suite S1               -> green
//   B2  check:  fails, then is parked                      -> scored apart
//   B3  judge:  proved by a drive, not by the implementor  -> brief + trail
//   B4  check:  its PRD row is later amended               -> loses green alone
//   S1  suite   the duplicate of B1's command
//   S2  suite   orphan: no row names it, and it is red
//
// Expected end state: `기계·판사: 3/4 PASS (parked 1: B2 ...) | suite: 2/2 GREEN`,
// unified verdict PASS, and the suite executed exactly once per command.

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

const SUITE_TEST = "node --test test/suite.test.mjs";
const SUITE_BUILD = "node scripts/build.mjs";
const PLATFORM_CHECK = "node --test test/platform.test.mjs";
const LEDGER_CHECK = "node scripts/ledger.mjs";

// Test-only approval strings, self-identifying so a fixture can never be
// mistaken for a verbatim quote from a real person in an audit ledger.
const TEST_APPROVAL = "TEST-FIXTURE-APPROVAL: not a real human quote";

const B4_ROW = "| B4 | The ledger records the run. | check: `node scripts/ledger.mjs` | D-04 |";

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

## Goal

A run whose every answer is known before it starts.

## Non-goals

Anything beyond the fixture lifecycle.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | the suite command is the proof for the shared row | one execution, one policy |
| D-02 | an unprovable row is parked, never faked | a park is scored apart from a failure |
| D-03 | a driven row is proved by someone other than the implementor | a self-driven proof proves nothing |
| D-04 | an amended row loses only its own proof | a correction costs what it invalidates |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | The runner executes the shared suite command. | check: \`node --test test/suite.test.mjs\` | D-01 |
| B2 | The unavailable platform check passes. | check: \`node --test test/platform.test.mjs\` | D-02 |
| B3 | The operator can see the summary on screen. | judge: a drive capture registered as an artifact for B3 | D-03 |
${B4_ROW}

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

/** The same spawn without `--json`, for the output a person actually reads. */
function runPlain(root, args) {
  const merged = { ...process.env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: merged });
}

/**
 * `buildGreen` decides whether the orphan suite command (S2) starts red;
 * `platformGreen` decides whether B2's own check can ever pass here.
 */
function makeProject({ buildGreen = false, platformGreen = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-calibrated-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd());
  // The suite list is sealed from this config at start.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    verify: { commands: { test: SUITE_TEST, build: SUITE_BUILD } },
  }));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "suite.test.mjs"), "import test from 'node:test';\ntest('suite', () => {});\n");
  fs.writeFileSync(
    path.join(root, "test", "platform.test.mjs"),
    platformGreen
      ? "import test from 'node:test';\ntest('platform', () => {});\n"
      : "import test from 'node:test';\ntest('platform', () => { throw new Error('no platform'); });\n",
  );
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeBuild(root, buildGreen);
  fs.writeFileSync(path.join(root, "scripts", "ledger.mjs"), "process.exit(0);\n");
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
const rowStatus = (root, id) => state(root).rows.find((entry) => entry.id === id).status;

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
      "implement:acceptance:B3": {
        verdict: "PASS",
        criteria: [{ id: "B3", verdict: "PASS", reason: "the capture shows the summary", evidence: "registered drive capture" }],
      },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
}

const check = (root, id) => {
  const checked = run(root, ["implement", "check", "--row", id]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(checked.json.detail.status, "green");
  return checked;
};

/**
 * B3 is proved by someone driving the screen, never by the implementor
 * asserting it works. The brief is the only sanctioned source of the script,
 * and the trail has to echo the brief it was issued and cover every step.
 */
function proveDrivenRow(root, { driver = "human" } = {}) {
  const issued = run(root, ["implement", "qa-brief", "--row", "B3"]);
  assert.equal(issued.status, 0, issued.stderr + issued.stdout);
  const brief = issued.json.detail.brief;
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "b3.txt"), "the operator sees the summary\n");
  const registered = run(root, ["implement", "artifact", "--row", "B3", "--kind", "log",
    "--path", "shots/b3.txt", "--description", "drive capture for B3"]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const trail = run(root, ["implement", "trail", "--row", "B3", "--brief", brief.briefId,
    "--steps", brief.steps.map((step) => step.id).join(","), "--driver", driver,
    "--artifacts", "shots/b3.txt"]);
  assert.equal(trail.status, 0, trail.stderr + trail.stdout);
  return brief;
}

test("calibration: the run seals the two suite commands and the four rows the fixture declared", () => {
  const root = makeProject();
  const sealed = state(root).suite;
  assert.deepEqual(sealed.commands.map((entry) => [entry.id, entry.command, entry.cwd]), [
    ["S1", SUITE_TEST, "."],
    ["S2", SUITE_BUILD, "."],
  ]);
  assert.deepEqual(sealed.exclusions, []);
  assert.deepEqual(
    state(root).rows.map((entry) => [entry.id, entry.check.kind, entry.status]),
    [["B1", "check", "pending"], ["B2", "check", "pending"], ["B3", "judge", "pending"], ["B4", "check", "pending"]],
  );
  assert.deepEqual(state(root).rows.map((entry) => entry.check.command ?? null), [SUITE_TEST, PLATFORM_CHECK, null, LEDGER_CHECK]);

  // The sealed list is the authority from here, not the config file.
  fs.writeFileSync(path.join(root, "agents", "config.json"), JSON.stringify({
    verify: { commands: { test: "node -e \"process.exit(0)\"" } },
  }));
  assert.deepEqual(
    state(root).suite.commands.map((entry) => entry.command),
    [SUITE_TEST, SUITE_BUILD],
    "a mid-run config edit must not change what this run is measured against",
  );
});

test("every row proved and a red orphan still blocks: the row axis and the suite axis are independent", () => {
  const root = makeProject();
  const env = stubEnv(root);
  // The drive comes first: its capture lands in the judged tree, and a
  // check: row's green names the tree it was earned on.
  proveDrivenRow(root);
  // B1's cell names the very command suite S1 carries: the row's own attempt
  // and the suite batch go through one executor, one policy.
  assert.equal(check(root, "B1").json.detail.command, SUITE_TEST);
  check(root, "B2");
  check(root, "B4");

  const verified = run(root, ["implement", "verify"], env);
  // Every row is proved and the run still fails, because a suite command no
  // row watches is red. The two axes are independent.
  assert.equal(verified.status, 1, verified.stdout);
  const attempt = state(root).verificationAttempts.at(-1);
  assert.equal(attempt.verdict, "FAIL");

  // The verify batch is the sealed suite alone, each command executed once;
  // check: rows were settled by their own ledger, not re-run here.
  assert.deepEqual(attempt.mechanical.map((entry) => entry.command), [SUITE_TEST, SUITE_BUILD]);
  const suite = state(root).suite;
  assert.equal(suite.results.find((entry) => entry.commandId === "S1").status, "GREEN");
  // ...and the orphan is the only red, on its own axis.
  assert.equal(suite.results.find((entry) => entry.commandId === "S2").status, "RED");
  assert.equal(suite.results.filter((entry) => entry.status === "RED").length, 1);
  for (const id of ["B1", "B2", "B4"]) assert.equal(rowStatus(root, id), "green");
  assert.equal(state(root).rows.find((entry) => entry.id === "B1").attempts.length, 1, "verify never re-runs a check: row's command");
});

test("the receipt reads the calibration, and an amendment costs only the row it changed", () => {
  const root = makeProject({ buildGreen: true, platformGreen: false });
  const env = stubEnv(root);
  proveDrivenRow(root);
  check(root, "B1");
  check(root, "B4");

  // B2 is the row that cannot be proved here: it fails on its own command,
  // then the supervisor parks it on the human's recorded word.
  for (let i = 0; i < 2; i += 1) {
    const failed = run(root, ["implement", "check", "--row", "B2"]);
    assert.equal(failed.status, 1, failed.stdout);
    assert.equal(failed.json.detail.status, "fail");
  }
  const parked = run(root, ["implement", "park", "--issuer", "observer", "--row", "B2",
    "--approval", TEST_APPROVAL, "--reason", "the platform binary is unavailable on this runner"]);
  assert.equal(parked.status, 0, parked.stdout);
  assert.equal(parked.json.detail.issuer, "observer");
  assert.equal(parked.json.detail.park.approval, TEST_APPROVAL);

  const verified = run(root, ["implement", "verify"], env);
  assert.equal(verified.status, 0, verified.stdout);
  // The calibrated score, in the string a person reads.
  assert.equal(scoreLineOf(root), "기계·판사: 3/4 PASS (parked 1: B2 the platform binary is unavailable on this runner) | suite: 2/2 GREEN");

  // A parked row is not a failure and still refuses a complete close.
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /B2 is parked/);

  // Amend one behavior cell. Only that row loses its green.
  const before = new Map(state(root).rows.map((entry) => [entry.id, entry.status]));
  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  const amendedPrd = fs.readFileSync(prdPath, "utf8")
    .replace(B4_ROW, "| B4 | The ledger records the run and its clock. | check: `node scripts/ledger.mjs` | D-04 |");
  assert.notEqual(amendedPrd, fs.readFileSync(prdPath, "utf8"), "the B4 row this test amends moved");
  fs.writeFileSync(prdPath, amendedPrd);
  const amended = run(root, ["implement", "amend", "--issuer", "human",
    "--approval", TEST_APPROVAL, "--reason", "the row was wrong"]);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);

  const after = new Map(state(root).rows.map((entry) => [entry.id, entry.status]));
  assert.equal(after.get("B4"), "pending", "the amended row loses its green");
  assert.equal(after.get("B1"), before.get("B1"), "an untouched row keeps its evidence");
  assert.equal(after.get("B2"), "parked", "and a parked row whose text did not change stays parked");
  assert.equal(state(root).rows.find((entry) => entry.id === "B4").attempts.length, 1, "the attempt history stays readable; only the verdict is taken back");
  // Append-only: the amendment is recorded, and the earlier snapshot survives.
  const amendments = state(root).amendments;
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].issuer, "human");
  assert.equal(amendments[0].scope, "behaviors");
  assert.deepEqual(amendments[0].invalidatedRows, ["B4"]);
  assert.ok(fs.existsSync(path.join(root, amendments[0].previousSnapshotPath)));
});

/** The score line as the receipt would print it, read from the live ledger. */
function scoreLineOf(root) {
  const summary = runPlain(root, ["implement", "status"]).stdout.split("\n");
  return summary.find((line) => line.startsWith("기계·판사: "));
}

test("the supervisor's channel, the waiter's backlog, and the stall wake", () => {
  const root = makeProject({ buildGreen: true });
  stubEnv(root);

  // Three checks, and the one that refuses names itself. The observer may
  // park a row on the human's word; it may not do the work or call it done.
  const forbidden = run(root, ["implement", "check", "--issuer", "observer", "--row", "B1"]);
  assert.equal(forbidden.status, 2, forbidden.stdout);
  assert.equal(forbidden.json.detail.rejectedCheck, "authority");
  // A park with no approval quote is refused by the TRANSITION check: the
  // verb is well-formed and permitted, and the row's own rule says no.
  const unquoted = run(root, ["implement", "park", "--issuer", "observer", "--row", "B2", "--reason", "no approval yet"]);
  assert.equal(unquoted.status, 2, unquoted.stdout);
  assert.equal(unquoted.json.detail.rejectedCheck, "transition");
  // Every verb, accepted and refused, is in the history with which check ruled.
  assert.deepEqual(
    state(root).verbs.map((entry) => [entry.verb, entry.outcome, entry.rejection?.check ?? null]),
    [["check", "rejected", "authority"], ["park", "rejected", "transition"]],
  );
  assert.deepEqual(state(root).rows.map((entry) => entry.status), ["pending", "pending", "pending", "pending"], "a refused verb moves nothing");

  // A refused verb is history, not an event: nothing changed, so nobody needs
  // waking. Real work is what raises events, so do some.
  assert.deepEqual(state(root).events, []);
  check(root, "B1");
  assert.deepEqual(state(root).events.map((entry) => entry.kind), ["check-attempt", "row-status"]);
  // The run already has events, so a waiter behind the cursor returns the
  // backlog instead of blocking - an event raised while nobody watched is not
  // an event that is lost.
  const backlog = run(root, ["implement", "await", "--since", "1"]);
  assert.equal(backlog.status, 0, backlog.stderr + backlog.stdout);
  assert.equal(backlog.json.detail.reason, "event");
  assert.equal(backlog.json.detail.events[0].id, 2, "it resumes at the cursor, and does not replay what was seen");

  // With the last event aged past the constant, the waiter wakes on stall.
  // The clock is moved rather than waited out - the threshold is a code
  // constant on purpose, so the fixture ages the record instead.
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

test("the all-green close prints both axes and finalize runs nothing", () => {
  const root = makeProject({ buildGreen: true });
  const env = stubEnv(root);
  proveDrivenRow(root);
  for (const id of ["B1", "B2", "B4"]) check(root, id);
  const verified = run(root, ["implement", "verify"], env);
  assert.equal(verified.status, 0, verified.stdout);

  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, finalized.json.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.scoreLine, "기계·판사: 4/4 PASS | suite: 2/2 GREEN");
  assert.deepEqual(receipt.score.rows.parked, []);
  assert.deepEqual(receipt.behaviors.map((entry) => [entry.id, entry.parked]), [["B1", null], ["B2", null], ["B3", null], ["B4", null]]);
  assert.equal(receipt.executionCallsDuringFinalize, 0, "finalize runs nothing; it reads the record");

  const report = fs.readFileSync(path.join(root, finalized.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /기계·판사: 4\/4 PASS \| suite: 2\/2 GREEN/);
  // The driven row's proof is a drive by someone other than the implementor,
  // and the report says so rather than asserting the screen works.
  assert.match(report, /B3/);
  assert.equal(state(root).trails.at(-1).driverRole, "human");
});
