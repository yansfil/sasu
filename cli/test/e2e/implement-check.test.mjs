import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

/** One Behaviors row: `{ id, behavior, method }` where method is the whole 검사 방법 cell. */
function prd(rows) {
  const table = rows.map((entry) => `| ${entry.id} | ${entry.behavior} | ${entry.method} | D-01 |`).join("\n");
  return `---
topic: "implement check fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "completion authority fixture"
source_intake: "current conversation"
---

# PRD: implement check fixture

## Goal

The operator needs machine-owned completion evidence.

## Non-goals

Only the fixture CLI lifecycle is in scope.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | a check: row is proved by its exit code alone | the agent's report is not evidence |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
${table}

## Technical structure

No fixture structure change.

## Risks

None.
`;
}

const check = (command) => `check: \`${command}\``;

function run(root, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of SESSION_KEYS) delete env[key];
  delete env.SASU_HERDR_ROLE;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env });
  let json;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

function makeProject(rows, scripts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-check-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd(rows));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const [name, source] of Object.entries(scripts)) fs.writeFileSync(path.join(root, "scripts", name), source);
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
  ]) {
    const executed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
  }
  return root;
}

function start(root) {
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  fs.writeFileSync(path.join(root, "implementation.txt"), "run-owned fixture implementation\n");
}

function state(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));
}

const row = (root, id) => state(root).rows.find((entry) => entry.id === id);

function stub(root, judgeRows, overrides = {}) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  const byPurpose = {
    "implement:fidelity": {
      verdict: "PASS",
      checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
    },
    "implement:design": { comments: [] },
  };
  for (const id of judgeRows) {
    byPurpose[`implement:acceptance:${id}`] = {
      verdict: "PASS",
      criteria: [{ id, verdict: "PASS", reason: "fixture proof passed", evidence: "registered artifact" }],
    };
  }
  Object.assign(byPurpose, overrides);
  fs.writeFileSync(file, JSON.stringify({ byPurpose }));
  return { file, capture, env: { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture } };
}

// The incident: a check whose command rewrote judged source was recorded in a
// shape the loader refused, and every later command on the run failed before
// its verb ran. The observable contract is that the check is scored
// "tree-moved" and the run stays loadable.
test("a check that rewrites judged source is scored tree-moved and the run still loads", () => {
  const root = makeProject([{ id: "B1", behavior: "machine proof", method: check("node scripts/writes.cjs") }], {
    "writes.cjs": "require('node:fs').writeFileSync('generated.txt', 'built\\n'); console.log('ok');\n",
  });
  start(root);
  const checked = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(checked.status, 1, checked.stderr + checked.stdout);
  assert.equal(checked.json.detail.attempt.outcome, "tree-moved");
  assert.equal(checked.json.detail.attempt.exitCode, 0);
  assert.equal(checked.json.detail.attempt.mutatedTree, true);
  assert.equal(checked.json.detail.attempt.failureClass, null);
  assert.equal(checked.json.detail.status, "fail");
  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.equal(row(root, "B1").attempts[0].outcome, "tree-moved");
});

test("readiness reports the row kinds and refuses a row whose method is not in the 검사 방법 cell", () => {
  const rows = [
    { id: "B1", behavior: "machine proof", method: check("npm test") },
    { id: "B2", behavior: "judge proof", method: "judge: scripted status transcript" },
    { id: "B3", behavior: "human proof", method: "human: the operator says it reads well" },
  ];
  const root = makeProject(rows);
  const ready = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(ready.status, 0, ready.stderr + ready.stdout);
  assert.deepEqual(ready.json.detail.parsed.rowKinds, { check: 1, judge: 1, human: 1 });
  assert.equal(ready.json.detail.parsed.rowCount, 3);

  const prdPath = path.join(root, "agents", "prd", "fixture", "prd.md");
  const original = fs.readFileSync(prdPath, "utf8");
  fs.writeFileSync(prdPath, original.replace("| judge: scripted status transcript |", "| scripted status transcript |"));
  const untagged = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(untagged.status, 1);
  assert.ok(untagged.json.detail.blockingGaps.some((gap) => gap.rule === "prd-behavior-row"), JSON.stringify(untagged.json.detail));
  fs.writeFileSync(prdPath, original.replace("| judge proof | judge: scripted status transcript |", "| judge proof. judge: scripted status transcript | judge: scripted status transcript |"));
  const methodInBehavior = run(root, ["prd", "readiness", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(methodInBehavior.status, 1);
  assert.ok(methodInBehavior.json.detail.blockingGaps.some((gap) => gap.rule === "prd-behavior-row"));
});

test("a check: row is proved by the harness alone, and the other kinds are refused with their own channel", () => {
  const rows = [
    { id: "B1", behavior: "machine flow closes", method: check("npm test") },
    { id: "B2", behavior: "the close reads honestly", method: "judge: scripted status transcript" },
    { id: "B3", behavior: "the operator likes it", method: "human: the operator says so" },
  ];
  const root = makeProject(rows);
  start(root);

  const judgeRow = run(root, ["implement", "check", "--row", "B2"]);
  assert.equal(judgeRow.status, 2);
  assert.match(judgeRow.json.message, /B2는 judge: 행이라 verify가 판정한다/);
  const humanRow = run(root, ["implement", "check", "--row", "B3"]);
  assert.equal(humanRow.status, 2);
  assert.match(humanRow.json.message, /B3는 human: 행이라 사용자가 confirm으로 닫는다/);
  const unknownRow = run(root, ["implement", "check", "--row", "B9"]);
  assert.equal(unknownRow.status, 2);

  // Evidence is written before the check so the green is earned on the tree
  // verify will judge.
  fs.writeFileSync(path.join(root, "transcript.log"), "B2 status transcript\n");
  const checked = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(checked.json.detail.attempt.outcome, "green");
  assert.equal(checked.json.detail.status, "green");
  assert.equal(typeof checked.json.detail.attempt.outputFingerprint, "string");
  assert.equal(typeof checked.json.detail.attempt.tree.product, "string");
  assert.deepEqual(state(root).events.slice(-2).map((entry) => entry.kind), ["check-attempt", "row-status"]);

  const artifact = run(root, [
    "implement", "artifact", "--row", "B2", "--kind", "log", "--path", "transcript.log", "--description", "status transcript",
  ]);
  assert.equal(artifact.status, 0, artifact.stderr + artifact.stdout);
  assert.equal(artifact.json.detail.artifact.rowId, "B2");

  const judge = stub(root, ["B2"]);
  const verified = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const manifest = state(root).verificationAttempts.at(-1).inputManifest.checkLedger;
  assert.equal(typeof manifest.sha256, "string");
  assert.deepEqual(manifest.rows.map(({ rowId, kind, status }) => ({ rowId, kind, status })), [
    { rowId: "B1", kind: "check", status: "green" },
    { rowId: "B2", kind: "judge", status: "pending" },
    { rowId: "B3", kind: "human", status: "OPEN" },
  ]);
  // The check: row summons no judge; its result reaches the judge of the row
  // that does, as a FACT in the envelope. Without that ledger a judge could
  // not tell a row that passed from one whose command was swapped until it did.
  assert.equal(fs.existsSync(path.join(judge.capture, "implement_acceptance_B1.prompt.txt")), false);
  const prompt = fs.readFileSync(path.join(judge.capture, "implement_acceptance_B2.prompt.txt"), "utf8");
  assert.match(prompt, /HARNESS-OWNED ROW LEDGER/);
  assert.match(prompt, /"rowId": "B1"[\s\S]*"status": "green"/);

  // The human: row never blocks the close; it decides which close the run gets.
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  assert.equal(finalized.json.detail.receipt.status, "complete-pending-human");
  assert.deepEqual(finalized.json.detail.receipt.parkedRows, []);
  const report = fs.readFileSync(path.join(root, "agents", "runs", "fixture", "implementation-result.md"), "utf8");
  assert.match(report, /### Parked Rows\n\nNone\./);
});

test("a forged green status without a harness attempt is refused by the next command", () => {
  const root = makeProject([{ id: "B1", behavior: "forged prose cannot close", method: check("npm test") }]);
  start(root);
  const statePath = path.join(root, "agents", "runs", "fixture", "state.json");
  const forged = JSON.parse(fs.readFileSync(statePath, "utf8"));
  forged.rows[0].status = "green";
  fs.writeFileSync(statePath, JSON.stringify(forged));
  const refused = run(root, ["implement", "status"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /status green contradicts the harness-owned ledger/);
});

test("repeated failures are counted, park unlocks verify, and resume blocks finalize until re-proof", () => {
  const root = makeProject([{ id: "B1", behavior: "repeat failure flow", method: check("node scripts/flaky.cjs") }], {
    "flaky.cjs": "const fs=require('node:fs'); if (fs.existsSync('green.txt')) process.exit(0); console.error('Error: fixture still failing'); process.exit(1);\n",
  });
  start(root);
  const selfReported = run(root, ["implement", "check", "--row", "B1", "--outcome", "green"]);
  assert.equal(selfReported.status, 2);
  assert.match(selfReported.json.message, /--outcome is harness-owned/);
  for (let index = 0; index < 4; index += 1) {
    const failed = run(root, ["implement", "check", "--row", "B1"]);
    assert.equal(failed.status, 1);
  }
  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0);
  assert.equal(status.json.detail.rows[0].consecutiveFailures, 4);
  assert.equal(status.json.detail.rows[0].status, "fail");

  assert.equal(run(root, ["implement", "park", "--row", "B1", "--reason", "wait for operator"]).status, 2);
  const parked = run(root, [
    "implement", "park", "--row", "B1", "--approval", "operator approved overnight park",
    "--reason", "wait for the morning fixture", "--evidence", "fixture-ticket",
  ]);
  assert.equal(parked.status, 0, parked.stderr + parked.stdout);
  assert.equal(parked.json.detail.park.approval, "operator approved overnight park");
  assert.equal(parked.json.detail.park.reason, "wait for the morning fixture");
  assert.equal(parked.json.detail.park.evidence, "fixture-ticket");
  assert.equal(typeof parked.json.detail.park.parkedAt, "string");
  assert.equal(run(root, ["implement", "park", "--row", "B1", "--approval", "again", "--reason", "again"]).status, 2);
  assert.equal(run(root, ["implement", "check", "--row", "B1"]).status, 2, "a parked row cannot be checked until resumed");

  const judge = stub(root, []);
  const verified = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.deepEqual(verified.json.detail.attempt.parkedRows, [{ id: "B1", reason: "wait for the morning fixture" }]);
  const blocked = run(root, ["implement", "finalize"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.json.message, /B1 is parked and was skipped by verification/);

  const resumed = run(root, ["implement", "resume", "--row", "B1"]);
  assert.equal(resumed.status, 0);
  assert.equal(resumed.json.detail.consecutiveFailures, 0);
  assert.equal(run(root, ["implement", "resume", "--row", "B1"]).status, 2);
  fs.writeFileSync(path.join(root, "green.txt"), "fixed\n");
  assert.equal(run(root, ["implement", "check", "--row", "B1"]).status, 0);
  assert.equal(row(root, "B1").attempts.length, 5, "the failed attempts stay on the record");
  assert.equal(run(root, ["implement", "verify"], { env: judge.env }).status, 0);
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

test("a judge: row fails without a judge when its evidence is missing, and recovers once it is registered", () => {
  const root = makeProject([{ id: "B1", behavior: "status transcript is convincing", method: "judge: scripted status transcript" }]);
  start(root);
  const judge = stub(root, ["B1"]);
  const missing = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(missing.status, 1);
  assert.equal(missing.json.detail.attempt.lanes.acceptance.verdict, "FAIL");
  const invocation = state(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations[0];
  assert.equal(invocation.verdict, "FAIL");
  assert.equal(invocation.judge, null);
  assert.equal(fs.existsSync(path.join(judge.capture, "implement_acceptance_B1.prompt.txt")), false);
  assert.equal(row(root, "B1").status, "FAIL");

  fs.writeFileSync(path.join(root, "status.log"), "scripted status transcript\n");
  assert.equal(run(root, [
    "implement", "artifact", "--row", "B1", "--kind", "log", "--path", "status.log", "--description", "status transcript",
  ]).status, 0);
  const configured = JSON.parse(fs.readFileSync(judge.file, "utf8"));
  configured.byPurpose["implement:acceptance:B1"].criteria[0].priorDisposition = {
    status: "resolved",
    reason: "the declared transcript is now registered",
  };
  fs.writeFileSync(judge.file, JSON.stringify(configured));
  assert.equal(run(root, ["implement", "verify"], { env: judge.env }).status, 0);
  assert.equal(row(root, "B1").status, "PASS");
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

// The other half of the recovery above. That test proves the recovery from a
// PRE-judge failure: evidence was missing, so the lane failed without ever
// calling a judge (`judge: null`, no captured prompt). The rejection a person
// actually meets is the opposite one - the judge ran, read the evidence, and
// said no. Replace the evidence of a JUDGE-REJECTED row and it returns to
// verification with the rejected evidence still on the record.
test("a judge-rejected row returns to verification when its evidence is replaced", () => {
  const root = makeProject([{ id: "B1", behavior: "status transcript is convincing", method: "judge: scripted status transcript" }]);
  start(root);

  fs.writeFileSync(path.join(root, "status.log"), "a transcript that does not show the transition\n");
  const registered = run(root, [
    "implement", "artifact", "--row", "B1", "--kind", "log", "--path", "status.log", "--description", "status transcript",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const rejectedSha = state(root).artifacts.find((entry) => entry.path === "status.log").sha256;

  const judge = stub(root, [], {
    "implement:acceptance:B1": {
      verdict: "FAIL",
      criteria: [{
        id: "B1",
        verdict: "FAIL",
        reason: "the transcript stops before the transition the row is about",
        evidence: "status.log",
      }],
    },
  });
  const rejected = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(rejected.status, 1, rejected.stdout);
  assert.equal(rejected.json.detail.attempt.lanes.acceptance.verdict, "FAIL");

  // This is what separates this case from the missing-evidence one: a judge
  // was actually called on the registered evidence and returned the verdict.
  const invocation = state(root).verificationAttempts.at(-1).lanes.acceptance.result.invocations[0];
  assert.equal(invocation.verdict, "FAIL");
  assert.notEqual(invocation.judge, null, "the judge ran; this is a rejection, not a pre-judge failure");
  assert.equal(fs.existsSync(path.join(judge.capture, "implement_acceptance_B1.prompt.txt")), true);
  assert.equal(row(root, "B1").status, "FAIL");
  const sealed = state(root).verificationAttempts.at(-1).inputFingerprint;

  // Replace the rejected evidence. The record must keep what became of it -
  // otherwise a run could quietly swap the bytes a judge ruled on.
  fs.writeFileSync(path.join(root, "status.log"), "a transcript that shows the transition\n");
  const replaced = run(root, [
    "implement", "artifact", "--row", "B1", "--kind", "log", "--path", "status.log", "--description", "corrected status transcript",
  ]);
  assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
  const history = state(root).evidenceReplacements;
  assert.equal(history.length, 1);
  assert.equal(history[0].rowId, "B1");
  assert.equal(history[0].kind, "artifact");
  assert.equal(history[0].priorDisposition, "invalidated");
  assert.match(history[0].previous, new RegExp(`status\\.log @ ${rejectedSha}`), "the rejected evidence is named in the record");
  assert.equal(state(root).artifacts.filter((entry) => entry.path === "status.log").length, 1, "one current vouch, not two");

  // The rejected verdict cannot be carried forward: the row is back in front
  // of verification, and finalize refuses until it is re-judged.
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2, refused.stdout);

  const configured = JSON.parse(fs.readFileSync(judge.file, "utf8"));
  configured.byPurpose["implement:acceptance:B1"] = {
    verdict: "PASS",
    criteria: [{
      id: "B1",
      verdict: "PASS",
      reason: "the replaced transcript shows the transition",
      evidence: "status.log",
      priorDisposition: { status: "resolved", reason: "the rejected transcript was replaced" },
    }],
  };
  fs.writeFileSync(judge.file, JSON.stringify(configured));
  const reverified = run(root, ["implement", "verify"], { env: judge.env });
  assert.equal(reverified.status, 0, reverified.stdout);
  assert.notEqual(state(root).verificationAttempts.at(-1).inputFingerprint, sealed,
    "a fresh attempt on the replaced evidence, not the rejected verdict reused");
  assert.equal(run(root, ["implement", "finalize"]).status, 0);
});

test("an old state schema refuses check, park, and resume with new-run guidance", () => {
  const root = makeProject([{ id: "B1", behavior: "legacy state", method: check("npm test") }]);
  const legacy = path.join(root, "agents", "runs", "legacy", "state.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  for (const version of ["v5", "v7"]) {
    fs.writeFileSync(legacy, JSON.stringify({ schema: `sasu.implement.state.${version}` }));
    for (const command of ["check", "park", "resume"]) {
      const refused = run(root, ["implement", command, "--state", "agents/runs/legacy/state.json", "--row", "B1"]);
      assert.equal(refused.status, 2);
      assert.match(refused.json.message, new RegExp(`unsupported implement state schema sasu\\.implement\\.state\\.${version}`));
      assert.match(refused.json.message, /Start a new run with `sasu implement start/);
    }
  }
});
