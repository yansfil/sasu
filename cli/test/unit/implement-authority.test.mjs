import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";
import { COMMAND_AUTHORITY, ISSUED_COMMANDS, UNGATED_COMMANDS, VerbRejected, assertCommandAuthority, isIssuedCommand, resolveIssuer } from "../../dist/implement/verbs.js";
import { parkRow, resumeRow } from "../../dist/implement/checks.js";
import { recordEvent, eventsSince } from "../../dist/implement/events.js";

const row = (overrides = {}) => ({
  id: "B1",
  behavior: "the runner runs once",
  check: { kind: "check", command: "npm test", argv: ["npm", "test"] },
  decisionIds: [],
  status: "pending",
  attempts: [],
  consecutiveFailures: 0,
  parks: [],
  verdict: null,
  human: null,
  rejections: [],
  ...overrides,
});

test("an unknown issuer is an argument refusal, not an authority one", () => {
  assert.equal(resolveIssuer(undefined), "implementor", "the default is the commonest caller");
  assert.equal(resolveIssuer("  Observer "), "observer");
  const error = (() => { try { resolveIssuer("root"); } catch (caught) { return caught; } })();
  assert.ok(error instanceof VerbRejected);
  assert.equal(error.check, "arguments");
});

test("the supervisor may not issue implementation commands", () => {
  for (const command of ["check", "artifact", "verify", "finalize", "design", "risk"]) {
    const error = (() => { try { assertCommandAuthority(command, "observer"); } catch (caught) { return caught; } })();
    assert.ok(error instanceof VerbRejected, `${command} must refuse an observer`);
    assert.equal(error.check, "authority");
    assert.match(error.message, /not authenticated/, "the refusal must not imply this is a security boundary");
  }
  for (const command of ["park", "resume", "escalate", "design-raise", "amend", "qa-brief", "trail"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "observer"), `${command} is the supervisor's own channel`);
  }
});

// R8: a human: row is closed by the person's own words. R16: declaring a
// finding unfixable is a judgment about the question, not the answer.
test("confirm and risk-non-convergent are human-only", () => {
  for (const command of ["confirm", "risk-non-convergent"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "human"));
    for (const issuer of ["implementor", "observer"]) {
      assert.throws(() => assertCommandAuthority(command, issuer), /limited to human/);
    }
  }
});

// R6: the table admits observer and human; the diff inside amend.ts decides
// which of them may issue a given change. The implementor is refused outright.
test("amend is open to the observer and the human, never the implementor", () => {
  assert.throws(() => assertCommandAuthority("amend", "implementor"), /limited to observer, human/);
  for (const issuer of ["observer", "human"]) assert.doesNotThrow(() => assertCommandAuthority("amend", issuer));
});

test("the authority table and the recorded verb vocabulary are one list", () => {
  assert.deepEqual([...ISSUED_COMMANDS].sort(), Object.keys(COMMAND_AUTHORITY).sort());
  assert.ok(isIssuedCommand("confirm"));
  assert.equal(isIssuedCommand("task"), false, "the task ledger left with v8");
  assert.equal(isIssuedCommand("resequence"), false);
  assert.equal(isIssuedCommand("intake"), false, "a read-only surface is not in the table and is not gated");
});

test("the implementor keeps every implementation path, so the default changes nothing", () => {
  for (const command of Object.keys(COMMAND_AUTHORITY)) {
    const allowed = COMMAND_AUTHORITY[command].includes("implementor");
    // design-raise joins the supervisor list because raising and answering a
    // comment are opposite ends of one debt: the supervisor remarks, the
    // implementor answers. An implementor that could do both would clear its
    // own guard.
    const isSupervisorOnly = ["escalate", "design-raise", "amend"].includes(command);
    const isHumanOnly = ["confirm", "risk-non-convergent"].includes(command);
    assert.equal(allowed, !isSupervisorOnly && !isHumanOnly, `${command} authority for implementor`);
  }
});

test("a park requires the verbatim approval and a reason, and resume lifts only an active park", () => {
  const item = row();
  assert.throws(() => parkRow(item, { approval: "", reason: "r", evidence: null }), /requires --approval/);
  assert.throws(() => parkRow(item, { approval: "user said park it", reason: " ", evidence: null }), /requires --reason/);
  assert.equal(item.status, "pending");
  parkRow(item, { approval: "user 2026-08-29: park it", reason: "waiting for hardware", evidence: null });
  assert.equal(item.status, "parked");
  assert.equal(item.parks.at(-1).approval, "user 2026-08-29: park it");
  assert.throws(() => parkRow(item, { approval: "again", reason: "again", evidence: null }), /already parked/);
  resumeRow(item);
  assert.equal(item.status, "pending");
  assert.equal(typeof item.parks[0].resumedAt, "string");
  assert.throws(() => resumeRow(item), /is not parked/);
});

test("only a check: row can be parked; judge: and human: rows are refused with their own channel", () => {
  const judge = row({ id: "B2", check: { kind: "judge", evidence: "a capture" } });
  assert.throws(() => parkRow(judge, { approval: "ok", reason: "r", evidence: null }), /B2는 judge: 행이라 verify가 판정한다/);
  const human = row({ id: "B3", status: "OPEN", check: { kind: "human", confirmation: "the user says so" } });
  assert.throws(() => parkRow(human, { approval: "ok", reason: "r", evidence: null }), /B3는 human: 행이라 사용자가 confirm으로 닫는다/);
});

test("events carry the issuer label and a --since cursor never replays", () => {
  const state = { events: [] };
  recordEvent(state, { kind: "park", actor: "observer", subject: "B1", summary: "parked", at: "t1" });
  recordEvent(state, { kind: "row-status", actor: "implementor", subject: "B2", summary: "green", at: "t2" });
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
test("every dispatched subcommand is either gated or listed as deliberately ungated", () => {
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
  for (const gone of ["task", "resequence"]) assert.ok(!dispatched.includes(gone), `${gone} must not be dispatched any more`);
});
