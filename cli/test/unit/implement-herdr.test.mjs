import assert from "node:assert/strict";
import test from "node:test";

import { herdrCapabilities, isAgentAlive, readPane, spawnImplementor } from "../../dist/implement/herdr.js";

const ok = (stdout = "") => () => ({ status: 0, stdout, stderr: "" });
const fails = (status = 1, stderr = "boom") => () => ({ status, stdout: "", stderr });

// R9: herdr is a convenience, never a contract. The harness must work in a
// bare terminal, under launchd, and in CI.
test("AC27: outside herdr all three holes close and say so, without throwing", () => {
  const capabilities = herdrCapabilities({ env: {}, run: ok() });
  assert.equal(capabilities.available, false);
  assert.deepEqual(capabilities.holes, { spawn: false, read: false, alive: false });
  assert.match(capabilities.reason, /not running under herdr/);
  assert.match(capabilities.reason, /keeps its event wake-up and verb channel/, "the reason must say what still works");
});

test("AC27: herdr present but not answering is distinguished from herdr absent", () => {
  const capabilities = herdrCapabilities({ env: { HERDR_ENV: "1" }, run: fails(3) });
  assert.equal(capabilities.available, false);
  assert.match(capabilities.reason, /present but not answering/);
});

test("AC27: each hole degrades to a named problem rather than an exception", () => {
  const env = {};
  for (const [label, call] of [
    ["spawn", () => spawnImplementor({ name: "impl", cwd: ".", prompt: "p" }, { env, run: ok() })],
    ["read", () => readPane({ name: "impl" }, { env, run: ok() })],
    ["alive", () => isAgentAlive({ name: "impl" }, { env, run: ok() })],
  ]) {
    const outcome = call();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.value, null);
    assert.match(outcome.problem, new RegExp(`^${label} unavailable:`), `${label} must name itself`);
  }
});

test("all three holes work when herdr answers", () => {
  const env = { HERDR_ENV: "1" };
  const agents = JSON.stringify({ result: { agents: [{ name: "impl", status: "running" }, { name: "old", status: "exited" }] } });
  assert.equal(spawnImplementor({ name: "impl", cwd: ".", prompt: "p" }, { env, run: ok('{"result":{}}') }).ok, true);
  assert.equal(readPane({ name: "impl" }, { env, run: ok("pane text") }).value, "pane text");
  assert.equal(isAgentAlive({ name: "impl" }, { env, run: ok(agents) }).value, true);
  assert.equal(isAgentAlive({ name: "old" }, { env, run: ok(agents) }).value, false);
  assert.equal(isAgentAlive({ name: "never-existed" }, { env, run: ok(agents) }).value, false);
});

// The prompt carries the whole handoff in one argv entry and a failing
// wrapper may echo argv, so this call never retains output.
test("a failed spawn redacts the prompt from its problem line", () => {
  const outcome = spawnImplementor(
    { name: "impl", cwd: ".", prompt: "SECRET-OPERATIONAL-CONTEXT" },
    { env: { HERDR_ENV: "1" }, run: (args) => (args[1] === "list" ? { status: 0, stdout: "{}", stderr: "" } : { status: 1, stdout: "SECRET-OPERATIONAL-CONTEXT", stderr: "SECRET-OPERATIONAL-CONTEXT" }) },
  );
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.problem, /SECRET-OPERATIONAL-CONTEXT/);
  assert.match(outcome.problem, /<redacted prompt>/);
});
