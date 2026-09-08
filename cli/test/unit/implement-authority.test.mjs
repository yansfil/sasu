import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";
import { COMMAND_AUTHORITY, ISSUED_COMMANDS, UNGATED_COMMANDS, VerbRejected, assertCommandAuthority, isIssuedCommand, resolveIssuer } from "../../dist/implement/verbs.js";
import { recordEvent, eventsSince } from "../../dist/implement/events.js";

test("an unknown issuer is an argument refusal, not an authority one", () => {
  assert.equal(resolveIssuer(undefined), "implementor", "the default is the commonest caller");
  assert.equal(resolveIssuer("  Observer "), "observer");
  const error = (() => { try { resolveIssuer("root"); } catch (caught) { return caught; } })();
  assert.ok(error instanceof VerbRejected);
  assert.equal(error.check, "arguments");
});

test("the supervisor may not issue implementation commands", () => {
  for (const command of ["artifact", "verify", "finalize", "risk", "amend"]) {
    const error = (() => { try { assertCommandAuthority(command, "observer"); } catch (caught) { return caught; } })();
    assert.ok(error instanceof VerbRejected, `${command} must refuse an observer`);
    assert.equal(error.check, "authority");
    assert.match(error.message, /not authenticated/, "the refusal must not imply this is a security boundary");
  }
  for (const command of ["escalate"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "observer"), `${command} is the supervisor's own channel`);
  }
});

// A human confirmation is closed by the person's own words. Declaring a
// finding unfixable is a judgment about the question, not the answer.
test("confirm and risk-non-convergent are human-only", () => {
  for (const command of ["confirm", "risk-non-convergent"]) {
    assert.doesNotThrow(() => assertCommandAuthority(command, "human"));
    for (const issuer of ["implementor", "observer"]) {
      assert.throws(() => assertCommandAuthority(command, issuer), /limited to human/);
    }
  }
});

test("changing the approved contract is human-only", () => {
  for (const issuer of ["implementor", "observer"]) assert.throws(() => assertCommandAuthority("amend", issuer), /limited to human/);
  assert.doesNotThrow(() => assertCommandAuthority("amend", "human"));
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
    const isSupervisorOnly = ["escalate"].includes(command);
    const isHumanOnly = ["confirm", "risk-non-convergent", "amend"].includes(command);
    assert.equal(allowed, !isSupervisorOnly && !isHumanOnly, `${command} authority for implementor`);
  }
});

test("events carry the issuer label and a --since cursor never replays", () => {
  const state = { events: [] };
  recordEvent(state, { kind: "escalate", actor: "observer", subject: "review", summary: "diagnosis", at: "t1" });
  recordEvent(state, { kind: "verify", actor: "implementor", subject: "review", summary: "PASS", at: "t2" });
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
  assert.ok(dispatched.length >= 10, "the dispatcher scrape found nothing - the pattern drifted");
  const accounted = new Set([...ISSUED_COMMANDS, ...UNGATED_COMMANDS]);
  const orphans = dispatched.filter((name) => !accounted.has(name));
  assert.deepEqual(orphans, [], "a dispatched subcommand with no authority row would open to every issuer");
  // ...and nothing is claimed to be ungated that the table also gates.
  assert.deepEqual(UNGATED_COMMANDS.filter((name) => ISSUED_COMMANDS.includes(name)), []);
  for (const gone of ["task", "resequence", "check", "park", "resume", "qa-brief", "trail", "design"]) assert.ok(!dispatched.includes(gone), `${gone} must not be dispatched any more`);
});
