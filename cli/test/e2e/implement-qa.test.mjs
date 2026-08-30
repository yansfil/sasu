import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

function prd() {
  return `---
topic: "implement qa fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "qa-brief and trail fixture"
source_intake: "current conversation"
---

# PRD: implement qa fixture

## 1. Summary

Exercise the briefing channel and trail registration.

## 2. Problem, Goal, And Users

A driven criterion needs a driver who is not the implementor.

## 3. Scope And Non-Goals

Only the qa-brief and trail lifecycle is in scope.

## 4. Pre-Work And Required Decisions

None required.

## 5. Major Technical Structure Changes

No fixture structure change.

## 6. Requirements

- R1. The machine criterion works. Covers AC1.
- R2. The driven criterion works. Covers AC2.

## 7. Acceptance Criteria

| ID | Criterion | Judgment | Evidence Declaration |
| --- | --- | --- | --- |
| AC1 | The runner executes each command once. Covers R1. | machine | - |
| AC2 | The operator can name two things: ①the parked item and its reason ②the next move. The summary fits one screen. Covers R2. | judged | A capture of the summary output. |

## 8. PRD-Level Tasks

- T1. Implement AC1. Covers R1, AC1. Depends on: none.
- T2. Implement AC2. Covers R2, AC2. Depends on: none.

## 9. Verification Contract

### 9.1 Test Mode Contract

| Mode | Required For Done | Covers | Human Decision |
| --- | --- | --- | --- |
| automated behavior | yes | fixture lifecycle | none |

### 9.2 Required Agent Verification

| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked |
| --- | --- | --- | --- | --- | --- |
| V1 | automated behavior | R1, R2, AC1, AC2 | fixture lifecycle passes | yes | no |

## 10. Risks And Open Decisions

None.

## 11. Implementation Guardrails

Do not expand the fixture.

## 12. Implementation Result Report Contract

Report the brief and trail ledgers.
`;
}

function run(root, args) {
  const env = { ...process.env };
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

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-qa-e2e-"));
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

const state = (root) => JSON.parse(fs.readFileSync(path.join(root, "agents", "runs", "fixture", "state.json"), "utf8"));

function brief(root, ac = "AC2") {
  const issued = run(root, ["implement", "qa-brief", "--ac", ac]);
  assert.equal(issued.status, 0, issued.stderr + issued.stdout);
  return issued.json.detail.brief;
}

const registerTrail = (root, options) => run(root, [
  "implement", "trail",
  "--ac", options.ac ?? "AC2",
  "--brief", options.brief,
  "--steps", options.steps.join(","),
  "--driver", options.driver ?? "human",
  ...(options.artifacts ? ["--artifacts", options.artifacts.join(",")] : []),
]);

test("AC30: the brief is numbered, derived from the sealed row, and its steps carry the criterion and its evidence", () => {
  const root = makeProject();
  const issued = brief(root);
  assert.deepEqual(issued.steps.map((step) => step.id), ["S1", "S2", "S3", "S4", "S5"]);
  assert.match(issued.steps[1].text, /parked item and its reason/);
  assert.match(issued.steps[2].text, /next move/);
  assert.match(issued.steps[3].text, /fits one screen/);
  assert.match(issued.steps[4].text, /capture of the summary/);
  assert.equal(issued.prdSha256, state(root).prd.sha256, "the script is bound to the snapshot it came from");
  assert.equal(state(root).events.at(-1).kind, "trail");
});

test("AC30: a machine criterion has no brief to issue", () => {
  const root = makeProject();
  const refused = run(root, ["implement", "qa-brief", "--ac", "AC1"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /proven by its Check, not by a driver/);
  assert.equal(state(root).qaBriefs.length, 0);
});

test("AC30: reissuing mints a distinct briefId and the old one stops being registrable", () => {
  const root = makeProject();
  const first = brief(root);
  const reissued = run(root, ["implement", "qa-brief", "--ac", "AC2"]);
  assert.equal(reissued.status, 0);
  const second = reissued.json.detail.brief;
  assert.notEqual(first.briefId, second.briefId);
  assert.equal(reissued.json.detail.supersedes, first.briefId);

  const stale = registerTrail(root, { brief: first.briefId, steps: first.steps.map((step) => step.id) });
  assert.notEqual(stale.status, 0);
  assert.match(stale.json.message, /is superseded/);
  assert.equal(stale.json.detail.rejectedCheck, "transition");

  const current = registerTrail(root, { brief: second.briefId, steps: second.steps.map((step) => step.id) });
  assert.equal(current.status, 0, current.stderr + current.stdout);
});

test("AC31: the three exit checks each refuse on their own", () => {
  const root = makeProject();
  const issued = brief(root);
  const allSteps = issued.steps.map((step) => step.id);

  const wrongEcho = registerTrail(root, { brief: "AC2-B1-000000000000", steps: allSteps });
  assert.notEqual(wrongEcho.status, 0);
  assert.match(wrongEcho.json.message, /only briefing channel/);

  const partial = registerTrail(root, { brief: issued.briefId, steps: ["S1", "S2"] });
  assert.notEqual(partial.status, 0);
  assert.match(partial.json.message, /uncovered steps: S3.*S4.*S5/s);

  const byImplementor = registerTrail(root, { brief: issued.briefId, steps: allSteps, driver: "implementor" });
  assert.notEqual(byImplementor.status, 0);
  assert.match(byImplementor.json.message, /may not drive the criterion it built/);
  assert.equal(byImplementor.json.detail.rejectedCheck, "authority");

  assert.equal(state(root).trails.length, 0, "no refused drive reached the ledger");
});

test("AC32: an accepted trail records the declared role and supersedes the previous one", () => {
  const root = makeProject();
  const issued = brief(root);
  const allSteps = issued.steps.map((step) => step.id);

  const first = registerTrail(root, { brief: issued.briefId, steps: allSteps, driver: "qa-agent" });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(first.json.detail.trail.driverRole, "qa-agent");
  assert.equal(first.json.detail.trail.status, "accepted");
  assert.deepEqual(first.json.detail.trail.coveredStepIds, allSteps);

  const second = registerTrail(root, { brief: issued.briefId, steps: allSteps, driver: "observer" });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  const trails = state(root).trails;
  assert.deepEqual(trails.map((entry) => entry.status), ["superseded", "accepted"]);
  assert.equal(trails[0].driverRole, "qa-agent", "the superseded drive stays readable with the role that made it");
});

test("AC32: the solver may not register a drive", () => {
  const root = makeProject();
  const issued = brief(root);
  const refused = registerTrail(root, { brief: issued.briefId, steps: issued.steps.map((step) => step.id), driver: "solver" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.message, /diagnoses and never drives/);
});

test("a trail may carry registered capture artifacts and only those", () => {
  const root = makeProject();
  const issued = brief(root);
  const allSteps = issued.steps.map((step) => step.id);

  const unregistered = registerTrail(root, { brief: issued.briefId, steps: allSteps, artifacts: ["shots/summary.txt"] });
  assert.notEqual(unregistered.status, 0);
  assert.match(unregistered.json.message, /unregistered artifact/);

  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  fs.writeFileSync(path.join(root, "shots", "summary.txt"), "AC2 parked: none; next move: close T2\n");
  const registered = run(root, [
    "implement", "artifact", "--ac", "AC2", "--kind", "log", "--path", "shots/summary.txt", "--description", "summary output capture",
  ]);
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);

  const accepted = registerTrail(root, { brief: issued.briefId, steps: allSteps, artifacts: ["shots/summary.txt"] });
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.deepEqual(accepted.json.detail.trail.artifactPaths, ["shots/summary.txt"]);
});
