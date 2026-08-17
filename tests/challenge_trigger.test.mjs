import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { context, rounds } from "../scripts/challenge_trigger.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const trigger = path.join(repoRoot, "scripts", "challenge_trigger.mjs");

function run(stdin) {
  return spawnSync(process.execPath, [trigger], { input: stdin, encoding: "utf8" });
}

test("the round cap is owned by the harness, not by the prompt", () => {
  assert.equal(rounds(""), 1);
  assert.equal(rounds("1"), 1);
  assert.equal(rounds("2"), 2);
  // PRINCIPLES item 13: an over-request cannot buy more adversarial rounds.
  assert.equal(rounds("3"), 2);
  assert.equal(rounds("99"), 2);
  // Degenerate values fall back to one round rather than to zero.
  assert.equal(rounds("0"), 1);
});

test("a clamped request tells the agent it was clamped", () => {
  const clamped = context("!rv5 이거 다시 봐줘");
  assert.match(clamped, /Round budget: 2 \(harness cap 2\)/);
  assert.match(clamped, /asked for 5 rounds; that was clamped/);

  const plain = context("!rv");
  assert.match(plain, /Round budget: 1/);
  assert.doesNotMatch(plain, /clamped/);
});

test("the trigger routes to the challenge skill and disowns the token", () => {
  const ctx = context("the plan looks wrong !rv");
  assert.match(ctx, /"challenge" skill/);
  assert.match(ctx, /not part of the request/);
  assert.match(ctx, /new evidence, never on new opinion/);
});

test("non-trigger prompts produce no output at all", () => {
  assert.equal(context("just a normal prompt"), null);
  // A bare word must not fire: only the ! form is the trigger.
  assert.equal(context("rv2 is a car"), null);
  // Mid-word matches must not fire either.
  assert.equal(context("foo!rvbar"), null);
  assert.equal(run(JSON.stringify({ prompt: "hello" })).stdout, "");
});

test("the hook never fails a turn on a payload it does not understand", () => {
  for (const input of ["", "not json", JSON.stringify({}), JSON.stringify({ prompt: 42 })]) {
    const result = run(input);
    assert.equal(result.status, 0, `exited non-zero on ${JSON.stringify(input)}`);
    assert.equal(result.stdout, "");
  }
});

test("a firing trigger emits UserPromptSubmit additionalContext", () => {
  const result = run(JSON.stringify({ prompt: "!rv2 반박해봐" }));
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /Round budget: 2/);
});
