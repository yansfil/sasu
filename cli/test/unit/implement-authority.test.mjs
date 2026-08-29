import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";
import { COMMAND_AUTHORITY, ISSUED_COMMANDS, UNGATED_COMMANDS, VerbRejected, assertCommandAuthority, isIssuedCommand, resolveIssuer } from "../../dist/implement/verbs.js";
import { parkCriterion } from "../../dist/implement/checks.js";
import { recordEvent, eventsSince } from "../../dist/implement/events.js";

const criterion = (overrides = {}) => ({
  id: "AC7",
  judgment: "machine",
  check: { status: "pending", bindings: [], attempts: [], consecutiveFailures: 0, decisionPoints: [], parks: [], ...overrides },
});

test("AC19: an unknown issuer is an argument refusal, not an authority one", () => {
  assert.equal(resolveIssuer(undefined), "implementor", "the default is the commonest caller");
  assert.equal(resolveIssuer("  Observer "), "observer");
  const error = (() => { try { resolveIssuer("root"); } catch (caught) { return caught; } })();
  assert.ok(error instanceof VerbRejected);
  assert.equal(error.check, "arguments");
});

test("AC19/AC45: the supervisor may not issue implementation commands", () => {
  for (const command of ["check", "task", "artifact", "verify", "finalize"]) {
    const error = (() => { try { assertCommandAuthority(command, "observer"); } catch (caught) { return caught; } })();
    assert.ok(error instanceof VerbRejected, `${command} must refuse an observer`);
    assert.equal(error.check, "authority");
    assert.match(error.message, /not authenticated/, "the refusal must not imply this is a security boundary");
  }
  for (const command of ["park", "resume", "resequence", "escalate", "design-raise"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "observer"), `${command} is the supervisor's own channel`);
  }
});

test("AC12/AC46: correcting the question and declaring it unanswerable are both human-only", () => {
  for (const command of ["amend", "risk-non-convergent"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "human"));
    for (const issuer of ["implementor", "observer"]) {
      assert.throws(() => assertCommandAuthority(command, issuer), /limited to human/);
    }
  }
});

test("AC45: the authority table and the recorded verb vocabulary are one list", () => {
  assert.deepEqual([...ISSUED_COMMANDS].sort(), Object.keys(COMMAND_AUTHORITY).sort());
  assert.ok(isIssuedCommand("design-raise"));
  assert.equal(isIssuedCommand("intake"), false, "a read-only surface is not in the table and is not gated");
});

test("the implementor keeps every path it had, so the default changes nothing", () => {
  for (const command of Object.keys(COMMAND_AUTHORITY)) {
    const allowed = COMMAND_AUTHORITY[command].includes("implementor");
    // design-raise joins this list because raising and answering a comment are
    // opposite ends of one debt (R10): the supervisor remarks, the implementor
    // answers. An implementor that could do both would clear its own guard.
    const isSupervisorOnly = ["resequence", "escalate", "design-raise"].includes(command);
    const isHumanOnly = ["amend", "risk-non-convergent"].includes(command);
    assert.equal(allowed, !isSupervisorOnly && !isHumanOnly, `${command} authority for implementor`);
  }
});

test("AC20: the supervisor may park only a criterion the harness already flagged", () => {
  const open = criterion({ decisionPoints: [{ id: "DP1", kind: "five-failures", openedAt: "t", attemptId: "A1", message: "m", resolvedAt: null, resolution: null }] });
  parkCriterion(open, { approval: "", reason: "stuck on a missing fixture", evidence: null, parkedBy: "observer" });
  assert.equal(open.check.status, "parked");
  assert.equal(open.check.parks.at(-1).parkedBy, "observer");
  assert.equal(open.check.parks.at(-1).approval, "", "an observer park carries no approval quote");

  const unflagged = criterion();
  assert.throws(
    () => parkCriterion(unflagged, { approval: "", reason: "I would rather not", evidence: null, parkedBy: "observer" }),
    /no open decision point/,
  );
  assert.equal(unflagged.check.status, "pending");
});

test("AC20: an observer park may not launder a human approval quote", () => {
  const flagged = criterion({ decisionPoints: [{ id: "DP1", kind: "same-class", openedAt: "t", attemptId: "A1", message: "m", resolvedAt: null, resolution: null }] });
  assert.throws(
    () => parkCriterion(flagged, { approval: "the user said fine", reason: "r", evidence: null, parkedBy: "observer" }),
    /--approval belongs to a human park/,
  );
});

test("a human park still requires the verbatim approval and records parkedBy human", () => {
  const item = criterion();
  assert.throws(() => parkCriterion(item, { approval: "", reason: "r", evidence: null }), /requires --approval/);
  parkCriterion(item, { approval: "user 2026-08-29: park it", reason: "r", evidence: null });
  assert.equal(item.check.parks.at(-1).parkedBy, "human");
});

test("AC21: events carry the issuer label and a --since cursor never replays", () => {
  const state = { events: [] };
  recordEvent(state, { kind: "park", actor: "observer", subject: "AC7", summary: "parked", at: "t1" });
  recordEvent(state, { kind: "task-status", actor: "implementor", subject: "T3", summary: "closed", at: "t2" });
  assert.deepEqual(state.events.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(state.events.map((entry) => entry.actor), ["observer", "implementor"]);
  assert.deepEqual(eventsSince(state, null).map((entry) => entry.id), [1, 2]);
  assert.deepEqual(eventsSince(state, 1).map((entry) => entry.id), [2]);
  assert.deepEqual(eventsSince(state, 2), []);
});

// The gate is fail-open on an unknown command, so a command that reaches the
// dispatcher without an authority row would open silently. Reading the
// dispatcher itself is what makes that impossible to forget: adding a
// subcommand and no authority row fails here, not in production.
test("AC45: every dispatched subcommand is either gated or listed as deliberately ungated", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "implement", "commands.ts"),
    "utf8",
  );
  const dispatched = [...source.matchAll(/if \(subcommand === "([a-z-]+)"\)/g)].map((match) => match[1]);
  assert.ok(dispatched.length > 10, "the dispatcher scrape found nothing - the pattern drifted");
  const accounted = new Set([...ISSUED_COMMANDS, ...UNGATED_COMMANDS]);
  const orphans = dispatched.filter((name) => !accounted.has(name));
  assert.deepEqual(orphans, [], "a dispatched subcommand with no authority row would open to every issuer");
  // ...and nothing is claimed to be ungated that the table also gates.
  assert.deepEqual(UNGATED_COMMANDS.filter((name) => ISSUED_COMMANDS.includes(name)), []);
});
