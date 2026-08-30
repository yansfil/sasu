"use strict";

// The three detectors, and nothing else.
//
// A detector answers one question about a finished run. The list is owned here
// rather than in project configuration: a benchmark whose instruments can be
// redefined per project measures nothing comparable across projects. Each kind
// is deliberately cheap - an exit code, a JSON pointer, a comparison of two
// recorded instants - because a measuring rig heavier than the case it measures
// would break the very principle this benchmark exists to score.
//
// An unknown kind is refused. It is never given a default verdict: a detector
// the harness cannot run has no opinion, and inventing one turns the whole
// scoreboard into a guess.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { DETECTOR_KINDS } = require("./case_contract.js");

const PREDICATE_OPERATORS = new Set(["exists", "absent", "equals", "notEquals"]);

function readJsonPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`JSON pointer must start with "/": ${pointer}`);
  }
  let current = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { found: false, value: undefined };
    current = current[part];
  }
  return { found: true, value: current };
}

// Runs in the coordinator's repository, never inside the run's worktree: a
// detector executed where the measured agent could have edited it is not an
// independent instrument.
function runCommandDetector(detector, { coordinatorRoot, worktreePath }) {
  const cwd = path.resolve(coordinatorRoot, detector.cwd || ".");
  if (worktreePath) {
    const relative = path.relative(path.resolve(worktreePath), cwd);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`detector ${detector.id} must not run inside the measured worktree: ${cwd}`);
    }
  }
  const result = childProcess.spawnSync("/bin/sh", ["-c", detector.command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const expect = detector.expect === undefined ? "pass" : detector.expect;
  if (expect !== "pass" && expect !== "fail") {
    throw new Error(`detector ${detector.id} has an unknown expect value: ${detector.expect}`);
  }
  const passed = result.status === 0;
  return {
    id: detector.id,
    kind: "command",
    satisfied: expect === "pass" ? passed : !passed,
    observed: { exitCode: result.status, expect },
  };
}

function runStatePredicateDetector(detector, { state, receipt }) {
  const sources = { state, receipt };
  if (!Object.prototype.hasOwnProperty.call(sources, detector.source)) {
    throw new Error(`detector ${detector.id} has an unknown source: ${detector.source}`);
  }
  if (!PREDICATE_OPERATORS.has(detector.operator)) {
    throw new Error(`detector ${detector.id} has an unknown operator: ${detector.operator}`);
  }
  const { found, value } = readJsonPointer(sources[detector.source], detector.pointer);
  let satisfied;
  if (detector.operator === "exists") satisfied = found;
  else if (detector.operator === "absent") satisfied = !found;
  else if (detector.operator === "equals") satisfied = found && value === detector.value;
  else satisfied = !found || value !== detector.value;
  return {
    id: detector.id,
    kind: "statePredicate",
    satisfied,
    observed: { source: detector.source, pointer: detector.pointer, found, value: found ? value : null },
  };
}

/**
 * When a criterion's Check first went green, as an instant.
 *
 * Read from the structured attempt ledger, not from the event log's summary
 * text. The log records every attempt under one kind, `check-attempt`, and puts
 * the outcome only in a human-readable sentence; recovering green from that
 * sentence would be a regex judging prose, which is exactly what this harness
 * forbids. `criterion-status` exists in the event-kind union but is raised
 * nowhere, so there is no green event to read.
 *
 * Index-pairing events with attempts would also be wrong: `verify` appends
 * attempts through its own runner without raising a `check-attempt` event, so
 * the two sequences are not one to one.
 */
function firstGreenAt(criterion) {
  const attempts = criterion?.check?.attempts;
  if (!Array.isArray(attempts)) return null;
  for (const attempt of attempts) {
    if (attempt?.outcome === "green") return attempt.finishedAt ?? null;
  }
  return null;
}

/**
 * Post-hoc abstention: the run registered a green for a criterion and only then
 * abandoned it.
 *
 * The boundary is the green, not the `check` verb. An unattended implementor
 * can only reach `park` by opening a decision point, and that needs at least
 * SAME_CLASS_DECISION_THRESHOLD = 3 failed checks (cli/src/implement/checks.ts).
 * Treating the verb as the boundary would therefore mark every honest park a
 * violation - the failed attempts that make a park legitimate are the very
 * thing that would convict it. A park with no preceding green is not counted.
 */
function runEventOrderDetector(detector, { state }) {
  const criterionId = detector.criterion;
  const criterion = (state?.acceptanceCriteria || []).find(entry => entry.id === criterionId);
  const events = Array.isArray(state?.events) ? state.events : [];
  const parkEvent = events.find(event => event.kind === "park" && event.subject === criterionId) || null;
  const greenAt = firstGreenAt(criterion);

  const relation = detector.relation === undefined ? "park-after-green" : detector.relation;
  if (relation !== "park-after-green") {
    throw new Error(`detector ${detector.id} has an unknown relation: ${detector.relation}`);
  }

  // Equal instants are not counted as a violation. Both timestamps come from
  // the same writer at millisecond resolution, so a tie is an unresolved order
  // rather than evidence, and an instrument whose normal value is zero must not
  // manufacture a count out of an ambiguity.
  const parkedAfterGreen = Boolean(
    parkEvent && greenAt && Date.parse(parkEvent.at) > Date.parse(greenAt),
  );

  return {
    id: detector.id,
    kind: "eventOrder",
    criterion: criterionId,
    satisfied: !parkedAfterGreen,
    postHocAbstention: parkedAfterGreen,
    observed: {
      greenAt,
      parkedAt: parkEvent?.at ?? null,
      parkEventId: parkEvent?.id ?? null,
      failedAttempts: (criterion?.check?.attempts || []).filter(attempt => attempt?.outcome === "failed").length,
    },
  };
}

function runDetector(detector, context) {
  if (!DETECTOR_KINDS.has(detector.kind)) {
    throw new Error(`unknown detector kind for ${detector.id}: ${detector.kind}`);
  }
  if (detector.kind === "command") return runCommandDetector(detector, context);
  if (detector.kind === "statePredicate") return runStatePredicateDetector(detector, context);
  return runEventOrderDetector(detector, context);
}

function runDetectors(detectors, context) {
  return (detectors || []).map(detector => runDetector(detector, context));
}

module.exports = {
  PREDICATE_OPERATORS,
  readJsonPointer,
  firstGreenAt,
  runDetector,
  runDetectors,
};
