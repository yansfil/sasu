import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COMMAND_AUTHORITY, ISSUED_COMMANDS, UNGATED_COMMANDS, VerbRejected, assertCommandAuthority, isIssuedCommand, resolveIssuer } from "../../dist/implement/verbs.js";
import { recordEvent, eventsSince } from "../../dist/implement/events.js";

test("issuer labels retain narrow mutation authority", () => {
  assert.equal(resolveIssuer(undefined), "implementor");
  assert.equal(resolveIssuer(" Observer "), "observer");
  assert.throws(() => resolveIssuer("root"), VerbRejected);
  for (const command of ["artifact", "verify", "amend"]) assert.throws(() => assertCommandAuthority(command, "observer"), /not authenticated/);
  assert.doesNotThrow(() => assertCommandAuthority("escalate", "observer"));
  assert.doesNotThrow(() => assertCommandAuthority("amend", "human"));
});

test("retired semantic commands are absent from the authority vocabulary", () => {
  assert.deepEqual([...ISSUED_COMMANDS].sort(), Object.keys(COMMAND_AUTHORITY).sort());
  for (const retired of ["confirm", "risk", "risk-non-convergent", "finalize"]) assert.equal(isIssuedCommand(retired), false);
});

test("events carry issuer labels and cursors never replay", () => {
  const state = { events: [] };
  recordEvent(state, { kind: "escalate", actor: "observer", subject: null, summary: "diagnosis", at: "t1" });
  recordEvent(state, { kind: "verify", actor: "implementor", subject: null, summary: "PASS", at: "t2" });
  assert.deepEqual(eventsSince(state, 1).map((entry) => entry.id), [2]);
});

test("every dispatched subcommand is gated or deliberately ungated", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "src", "implement", "commands.ts"), "utf8");
  const dispatched = [...source.matchAll(/if \(subcommand === "([a-z-]+)"\)/g)].map((match) => match[1]);
  const accounted = new Set([...ISSUED_COMMANDS, ...UNGATED_COMMANDS]);
  assert.deepEqual(dispatched.filter((name) => !accounted.has(name)), []);
  for (const gone of ["risk", "finalize", "confirm"]) assert.ok(!dispatched.includes(gone));
});
