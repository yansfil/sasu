import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { oracleHistory, oracleRepeatFailureNote } from "../../dist/gates/oracle_history.js";

// Reads the gate's own recorded artifacts, so the fixture is real files on disk
// in the layout recordGateResult writes: agents/gates/<slug>/artifacts/*.json
// with an `oracle` array, pointed at by the history rows.
function projectWithRounds(rounds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-oracle-history-"));
  const artifactDir = path.join(root, "agents", "gates", "demo", "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  const history = rounds.map((oracle, index) => {
    const rel = path.join("agents", "gates", "demo", "artifacts", `verify-${index}.json`);
    if (oracle !== null) fs.writeFileSync(path.join(root, rel), JSON.stringify({ oracle }));
    return { at: `2026-08-11T0${index}:00:00Z`, verdict: "FAIL", findingCount: 1, requiresHuman: false, error: null, artifact: rel };
  });
  return { root, record: { history } };
}

const met = (id, value) => ({ id, met: value });

test("sequences are built oldest-first and count only the comebacks", () => {
  // The audited tetris shape: AC1 flip-flopped while AC2 never failed and AC3
  // has been red since it went red.
  const { root, record } = projectWithRounds([
    [met("AC1", true), met("AC2", true), met("AC3", true)],
    [met("AC1", false), met("AC2", true), met("AC3", true)],
    [met("AC1", true), met("AC2", true), met("AC3", false)],
    [met("AC1", false), met("AC2", true), met("AC3", false)],
    [met("AC1", true), met("AC2", true), met("AC3", false)],
  ]);
  const history = oracleHistory(root, record);

  assert.deepEqual(history.get("AC1"), { id: "AC1", sequence: "PFPFP", runs: 5, failures: 2, returnedToPass: 2 });
  assert.deepEqual(history.get("AC2"), { id: "AC2", sequence: "PPPPP", runs: 5, failures: 0, returnedToPass: 0 });
  assert.deepEqual(history.get("AC3"), { id: "AC3", sequence: "PPFFF", runs: 5, failures: 3, returnedToPass: 0 });

  // The bar is "has already failed AND come back", because that is the only
  // reading that tells the agent this failure is not the first of its kind.
  assert.match(oracleRepeatFailureNote(history.get("AC1")), /failed in 2 of the last 5 gate rounds and returned to passing 2 time\(s\)/);
  assert.match(oracleRepeatFailureNote(history.get("AC1")), /oldest first: PFPFP/);
  assert.equal(oracleRepeatFailureNote(history.get("AC2")), null, "a check that never failed has nothing to report");
  assert.equal(oracleRepeatFailureNote(history.get("AC3")), null, "an ordinary open failure is not a comeback");
  assert.equal(oracleRepeatFailureNote(undefined), null, "a criterion with no recorded history is silent");
});

test("the note states the observation and never calls a check flaky", () => {
  // The harness must not turn a sequence of booleans into a verdict about the
  // check: red-then-green can be a real regression the agent fixed. It hands
  // over the material and names the comparison to make (PRINCIPLES items 7, 10).
  const { root, record } = projectWithRounds([[met("AC1", true)], [met("AC1", false)], [met("AC1", true)]]);
  const note = oracleRepeatFailureNote(oracleHistory(root, record).get("AC1"));
  assert.doesNotMatch(note, /flaky|unreliable|broken check/i);
  assert.match(note, /compare the evidence from this round against the last round where it passed/);
});

test("unreadable rounds drop out instead of failing the read", () => {
  // Observer only: an advisory note may never break a verification, so a
  // missing, truncated, or oracle-less artifact costs that round and no more.
  const { root, record } = projectWithRounds([
    [met("AC1", true)],
    null, // history row points at a file that was never written
    [met("AC1", false)],
    [met("AC1", true)],
  ]);
  fs.writeFileSync(path.join(root, "agents", "gates", "demo", "artifacts", "verify-2.json"), "{ truncated");
  const history = oracleHistory(root, record);
  assert.deepEqual(history.get("AC1").sequence, "PP", "only the two readable rounds survive");

  // A pre-field record and a record with no history at all both read as empty.
  assert.equal(oracleHistory(root, { history: [] }).size, 0);
  assert.equal(oracleHistory(root, undefined).size, 0);
});
