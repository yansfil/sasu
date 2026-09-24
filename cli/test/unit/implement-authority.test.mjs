import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ISSUED_COMMANDS, UNRECORDED_COMMANDS, VerbRejected, isIssuedCommand, resolveIssuer } from "../../dist/implement/verbs.js";
import { recordEvent, eventsSince } from "../../dist/implement/events.js";

test("issuer labels are recorded declarations with a default, not a gate", () => {
  assert.equal(resolveIssuer(undefined), "implementor");
  assert.equal(resolveIssuer(" Observer "), "observer");
  assert.throws(() => resolveIssuer("root"), VerbRejected);
});

test("retired semantic commands are absent from the verb vocabulary", () => {
  for (const retired of ["confirm", "risk", "risk-non-convergent", "finalize"]) assert.equal(isIssuedCommand(retired), false);
});

test("events carry issuer labels and cursors never replay", () => {
  const state = { events: [] };
  recordEvent(state, { kind: "escalate", actor: "observer", subject: null, summary: "diagnosis", at: "t1" });
  recordEvent(state, { kind: "verify", actor: "implementor", subject: null, summary: "PASS", at: "t2" });
  assert.deepEqual(eventsSince(state, 1).map((entry) => entry.id), [2]);
});

test("every dispatched subcommand is a recorded verb or deliberately unrecorded", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "src", "implement", "commands.ts"), "utf8");
  const dispatched = [...source.matchAll(/if \(subcommand === "([a-z-]+)"\)/g)].map((match) => match[1]);
  const accounted = new Set([...ISSUED_COMMANDS, ...UNRECORDED_COMMANDS]);
  assert.deepEqual(dispatched.filter((name) => !accounted.has(name)), []);
  for (const gone of ["risk", "finalize", "confirm"]) assert.ok(!dispatched.includes(gone));
});
