import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// --- AC29: the supervisor's remark rides the design lane it already has -----
//
// R10/D-25 refuses a second review surface for supervisor remarks, so what has
// to be proved is not that a new channel works but that the remark becomes the
// SAME kind of debt as a lane comment: answered by the one disposition command
// that already exists, and refused by the one finalize guard that already
// exists. These run against the CLI from outside, so the proof is the exit
// code and the record, never a claim about the code (AGENTS.md Review Guide 1).

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

const REMARK = {
  area: "one-cause-n-symptoms",
  path: "lib/remote.sh",
  text: "the retry ladder is spelled out at each call site",
  suggestion: "one helper the three callers share",
};

function prd() {
  return `---
topic: "implement design fixture"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "design comment fixture"
source_intake: "current conversation"
---

# PRD: implement design fixture

## 1. Summary

Exercise the design comment ledger from both ends.

## 2. Problem, Goal, And Users

A supervisor's remark has to be answered, not outlived.

## 3. Scope And Non-Goals

Only the design comment lifecycle is in scope.

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

Report the design comment ledger.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-design-e2e-"));
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

/** `comments` is what the design lane will report on the NEXT verify. */
function stubEnv(root, comments = []) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
      },
      "implement:design": { comments },
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

const raise = (root, extra = []) => run(root, [
  "implement", "design", "--raise", "--issuer", "observer",
  "--area", REMARK.area, "--path", REMARK.path, "--text", REMARK.text, "--suggestion", REMARK.suggestion,
  ...extra,
]);

test("AC29: a supervisor raises a design comment, and it blocks finalize until answered", () => {
  const root = makeProject();
  const env = stubEnv(root);
  proveAndClose(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  const raised = raise(root);
  assert.equal(raised.status, 0, raised.stderr + raised.stdout);
  assert.equal(raised.json.detail.comment.id, "D1");
  assert.equal(raised.json.detail.comment.raisedBy, "observer");
  assert.equal(raised.json.detail.open.length, 1);

  // Recorded as a verb AND as an event: the event is what wakes the
  // implementor's waiter, so a remark nobody is told about is not a remark.
  const verb = state(root).verbs.at(-1);
  assert.equal(verb.verb, "comment");
  assert.equal(verb.issuer, "observer");
  assert.equal(verb.outcome, "accepted");
  const event = state(root).events.at(-1);
  assert.equal(event.kind, "comment");
  assert.equal(event.actor, "observer");
  assert.equal(event.subject, "D1");

  // The inherited guard, word for word the lane comment's refusal.
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /design comment D1 \(one-cause-n-symptoms @ lib\/remote\.sh\) has no disposition/);

  // The next verify must not dissolve it. For a lane comment the lane's
  // silence IS the fix; for a raised one there is no lane, so silence means
  // nothing and the comment stands.
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  assert.equal(state(root).designComments[0].status, "open");
  assert.equal(run(root, ["implement", "finalize"]).status, 2);

  // Answered through the one disposition command that already existed.
  const accepted = run(root, ["implement", "design", "--id", "D1", "--accept", "the third caller is deleted next week"]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  assert.equal(accepted.json.detail.open.length, 0);
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
  const report = fs.readFileSync(path.join(root, finalized.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /D1 \[one-cause-n-symptoms\] lib\/remote\.sh/);
  assert.match(report, /Disposition: accepted .*the third caller is deleted next week/);
});

test("AC29: a raised remark and a lane comment share one ledger, one numbering, and one guard", () => {
  const root = makeProject();
  const env = stubEnv(root, [{
    area: "dead-weight",
    path: "lib/common.sh",
    text: "the helper has no second caller",
    suggestion: "inline it",
  }]);
  proveAndClose(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  assert.equal(raise(root).json.detail.comment.id, "D2", "ids are minted from one high-water mark, not per origin");

  // Both are open debts, so finalize is refused on the pair.
  assert.equal(run(root, ["implement", "finalize"]).status, 2);
  // The lane goes quiet on the next attempt: that resolves ITS comment only.
  stubEnv(root, []);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  const tracked = state(root).designComments;
  assert.equal(tracked.find((entry) => entry.id === "D1").status, "resolved", "the lane went quiet, so its comment is fixed");
  assert.equal(tracked.find((entry) => entry.id === "D2").status, "open", "the same silence proves nothing about a raised remark");
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /design comment D2 .* has no disposition/);
});

test("AC29/AC45: the implementor may not raise a remark, and every field is required", () => {
  const root = makeProject();
  stubEnv(root);

  // Raising and answering are opposite ends of one debt: an implementor that
  // could do both would clear its own guard.
  const refused = run(root, ["implement", "design", "--raise",
    "--area", REMARK.area, "--path", REMARK.path, "--text", REMARK.text, "--suggestion", REMARK.suggestion]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.json.message, /implementor may not issue `sasu implement design-raise`/);
  assert.match(refused.json.message, /limited to observer, human/);
  assert.equal(refused.json.detail.rejectedCheck, "authority");
  assert.equal(state(root).designComments ?? undefined, undefined, "a refused raise mints no comment");

  // ...and the supervisor may not answer one either.
  assert.equal(run(root, ["implement", "design", "--issuer", "observer", "--id", "D1", "--accept", "fine"]).status, 2);

  for (const missing of ["area", "path", "text", "suggestion"]) {
    const argv = ["implement", "design", "--raise", "--issuer", "observer"];
    for (const [name, value] of Object.entries(REMARK)) {
      if (name !== missing) argv.push(`--${name}`, value);
    }
    const refusedField = run(root, argv);
    assert.equal(refusedField.status, 2, refusedField.stdout);
    assert.match(refusedField.json.message, new RegExp(`missing required --${missing}`));
  }
  // Blank counts as missing, so no path mints a comment with an empty field.
  const blankRun = run(root, ["implement", "design", "--raise", "--issuer", "observer",
    "--area", REMARK.area, "--path", REMARK.path, "--text", "   ", "--suggestion", REMARK.suggestion]);
  assert.equal(blankRun.status, 2, blankRun.stdout);
  assert.match(blankRun.json.message, /missing required --text/);
});
