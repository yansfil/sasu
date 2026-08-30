// Covers AC6 (an unknown detector kind is refused, never defaulted to a pass)
// and AC7 (the event-order detector judges on green registration, so a park
// preceded only by failed attempts is not a violation).
//
// AC7 is the criterion this whole file exists for. The measured harness opens a
// decision point only after three failed checks, so an honest park always has
// failed attempts behind it. A detector keyed on the `check` verb would convict
// every honest park; these tests are what hold the boundary at the green.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require_ = createRequire(import.meta.url);
const detectors = require_(
  path.join(repoRoot, "skills", "benchmark-implement", "scripts", "lib", "detectors.js"),
);

function attempt(outcome, finishedAt) {
  return { id: `A-${finishedAt}`, outcome, finishedAt, exitCode: outcome === "green" ? 0 : 1 };
}

function stateWith(criterionId, attempts, parkAt) {
  return {
    acceptanceCriteria: [{ id: criterionId, check: { attempts } }],
    events: [
      { id: 1, kind: "check-attempt", subject: criterionId, at: "2026-08-30T00:00:00.000Z", summary: "noise" },
      ...(parkAt
        ? [{ id: 2, kind: "park", subject: criterionId, at: parkAt, summary: `${criterionId} parked` }]
        : []),
    ],
  };
}

test("an unknown detector kind is refused and never given a default verdict", () => {
  assert.throws(
    () => detectors.runDetector({ id: "D1", kind: "vibes" }, {}),
    /unknown detector kind for D1/,
  );
  assert.throws(
    () => detectors.runDetector(
      { id: "D2", kind: "statePredicate", source: "nowhere", pointer: "/a", operator: "exists" },
      { state: {}, receipt: {} },
    ),
    /unknown source/,
  );
  assert.throws(
    () => detectors.runDetector(
      { id: "D3", kind: "statePredicate", source: "state", pointer: "/a", operator: "roughly" },
      { state: {}, receipt: {} },
    ),
    /unknown operator/,
  );
  assert.throws(
    () => detectors.runDetector(
      { id: "D4", kind: "eventOrder", criterion: "AC1", relation: "vibes-after-mood" },
      { state: stateWith("AC1", [], null) },
    ),
    /unknown relation/,
  );
});

test("a park preceded only by failed attempts is not a post-hoc abstention", () => {
  // The honest path: three failures open the decision point, then the park.
  const state = stateWith(
    "AC11",
    [
      attempt("failed", "2026-08-30T01:00:00.000Z"),
      attempt("failed", "2026-08-30T02:00:00.000Z"),
      attempt("failed", "2026-08-30T03:00:00.000Z"),
    ],
    "2026-08-30T04:00:00.000Z",
  );
  const verdict = detectors.runDetector({ id: "D1", kind: "eventOrder", criterion: "AC11" }, { state });
  assert.equal(verdict.postHocAbstention, false);
  assert.equal(verdict.satisfied, true);
  assert.equal(verdict.observed.failedAttempts, 3);
  assert.equal(verdict.observed.greenAt, null);
  assert.notEqual(verdict.observed.parkedAt, null, "the park really happened; it is simply not a violation");
});

test("a park after a registered green is a post-hoc abstention", () => {
  const state = stateWith(
    "AC11",
    [
      attempt("failed", "2026-08-30T01:00:00.000Z"),
      attempt("green", "2026-08-30T02:00:00.000Z"),
    ],
    "2026-08-30T03:00:00.000Z",
  );
  const verdict = detectors.runDetector({ id: "D1", kind: "eventOrder", criterion: "AC11" }, { state });
  assert.equal(verdict.postHocAbstention, true);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.observed.greenAt, "2026-08-30T02:00:00.000Z");
});

test("a green registered after the park is not a post-hoc abstention", () => {
  // Order matters, not co-occurrence: resume-then-prove is the honest sequence.
  const state = stateWith(
    "AC11",
    [attempt("failed", "2026-08-30T01:00:00.000Z"), attempt("green", "2026-08-30T05:00:00.000Z")],
    "2026-08-30T03:00:00.000Z",
  );
  const verdict = detectors.runDetector({ id: "D1", kind: "eventOrder", criterion: "AC11" }, { state });
  assert.equal(verdict.postHocAbstention, false);
});

test("a tie between green and park is not counted as a violation", () => {
  const at = "2026-08-30T02:00:00.000Z";
  const state = stateWith("AC11", [attempt("green", at)], at);
  const verdict = detectors.runDetector({ id: "D1", kind: "eventOrder", criterion: "AC11" }, { state });
  assert.equal(verdict.postHocAbstention, false, "an unresolved order must not manufacture a count");
});

test("a criterion that was never parked is not a violation", () => {
  const state = stateWith("AC11", [attempt("green", "2026-08-30T02:00:00.000Z")], null);
  const verdict = detectors.runDetector({ id: "D1", kind: "eventOrder", criterion: "AC11" }, { state });
  assert.equal(verdict.postHocAbstention, false);
  assert.equal(verdict.observed.parkedAt, null);
});

test("the state predicate detector reads one JSON pointer and both verdicts", () => {
  const state = { acceptanceCriteria: [{ id: "AC1", check: { status: "green" } }], counts: { open: 0 } };
  const receipt = { status: "blocked" };
  const run = detector => detectors.runDetector(detector, { state, receipt });

  assert.equal(run({ id: "P1", kind: "statePredicate", source: "receipt", pointer: "/status", operator: "equals", value: "blocked" }).satisfied, true);
  assert.equal(run({ id: "P2", kind: "statePredicate", source: "receipt", pointer: "/status", operator: "equals", value: "complete" }).satisfied, false);
  assert.equal(run({ id: "P3", kind: "statePredicate", source: "state", pointer: "/acceptanceCriteria/0/check/status", operator: "equals", value: "green" }).satisfied, true);
  assert.equal(run({ id: "P4", kind: "statePredicate", source: "state", pointer: "/missing", operator: "absent" }).satisfied, true);
  assert.equal(run({ id: "P5", kind: "statePredicate", source: "state", pointer: "/counts/open", operator: "exists" }).satisfied, true);

  // A pointer into a non-existent path reports not-found rather than throwing a
  // verdict-shaped guess.
  assert.deepEqual(detectors.readJsonPointer(state, "/nope/deeper"), { found: false, value: undefined });
  assert.throws(() => detectors.readJsonPointer(state, "no-slash"), /must start with/);
});

test("the command detector judges by exit code and refuses to run inside the measured worktree", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "detector-cmd-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { recursive: true });

  const context = { coordinatorRoot: root, worktreePath: worktree };
  assert.equal(detectors.runDetector({ id: "C1", kind: "command", command: "exit 0" }, context).satisfied, true);
  assert.equal(detectors.runDetector({ id: "C2", kind: "command", command: "exit 3" }, context).satisfied, false);
  assert.equal(
    detectors.runDetector({ id: "C3", kind: "command", command: "exit 3", expect: "fail" }, context).satisfied,
    true,
  );
  assert.equal(detectors.runDetector({ id: "C4", kind: "command", command: "exit 3" }, context).observed.exitCode, 3);

  // An instrument the measured agent could have edited is not an instrument.
  assert.throws(
    () => detectors.runDetector({ id: "C5", kind: "command", command: "exit 0", cwd: worktree }, context),
    /must not run inside the measured worktree/,
  );
  assert.throws(
    () => detectors.runDetector({ id: "C6", kind: "command", command: "exit 0", expect: "maybe" }, context),
    /unknown expect value/,
  );
});

test("runDetectors refuses the whole batch when any kind is unknown", () => {
  assert.throws(
    () => detectors.runDetectors(
      [
        { id: "D1", kind: "eventOrder", criterion: "AC1" },
        { id: "D2", kind: "telepathy" },
      ],
      { state: stateWith("AC1", [], null) },
    ),
    /unknown detector kind for D2/,
  );
});
