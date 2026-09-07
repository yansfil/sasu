import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { herdrCapabilities, isAgentAlive, readPane, spawnImplementor } from "../../dist/implement/herdr.js";

const ok = (stdout = "") => () => ({ status: 0, stdout, stderr: "" });
const fails = (status = 1, stderr = "boom") => () => ({ status, stdout: "", stderr });

const LIVE = { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12" };

/** herdr 0.8.2's `agent list` shape: `agent_status`, and `name` only when named. */
const listing = (...agents) => JSON.stringify({ result: { agents, type: "agent_list" } });
const dispatcher = { agent: "claude", agent_status: "working", pane_id: "w4G:p12" };
const splitOk = JSON.stringify({ result: { pane: { pane_id: "w4G:p13" }, type: "pane_info" } });

/**
 * Record every argv and answer each herdr call, so a test can assert the shape
 * of the whole dispatch rather than one command in isolation.
 */
function recorder(overrides = {}) {
  const argv = [];
  const run = (args) => {
    argv.push(args);
    const key = args.slice(0, 2).join(" ");
    if (key in overrides) return overrides[key];
    if (key === "agent list") return { status: 0, stdout: listing(dispatcher), stderr: "" };
    if (key === "pane split") return { status: 0, stdout: splitOk, stderr: "" };
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const matching = (key) => argv.filter((args) => args.slice(0, 2).join(" ") === key);
  return { argv, run, of: (key) => matching(key)[0], count: (key) => matching(key).length };
}

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
  assert.deepEqual(capabilities.holes, { spawn: false, read: true, alive: false });
  assert.match(capabilities.reason, /present but not answering/);
});

// The misattribution that hid the original bug: herdr answered every call
// correctly and the probe still reported "not answering", because the probe
// called every non-zero exit a dead server. An adapter must be able to say it
// is the one that is out of date.
test("an argv herdr rejects is reported as this adapter being stale, not as herdr being down", () => {
  const asked = [];
  const capabilities = herdrCapabilities({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12" },
    run: (args) => {
      asked.push(args.join(" "));
      if (args[0] === "--version") return { status: 0, stdout: "herdr 9.9.9\n", stderr: "" };
      if (args[0] === "api") return { status: 0, stdout: "Herdr API schema\nprotocol: 42\n", stderr: "" };
      return { status: 2, stdout: "", stderr: "usage: herdr agent list\n" };
    },
  });
  assert.equal(capabilities.available, false);
  assert.deepEqual(capabilities.holes, { spawn: true, read: true, alive: false });
  assert.match(capabilities.reason, /THIS ADAPTER is out of date, not herdr/);
  assert.match(capabilities.reason, /cli\/src\/implement\/herdr\.ts/, "the message must name the file to re-measure");
  assert.match(capabilities.reason, /herdr 9\.9\.9, protocol 42/, "it must name what is installed");
  assert.match(capabilities.reason, /measured against herdr 0\.8\.2 protocol 21/, "and what it was written against");
  assert.doesNotMatch(capabilities.reason, /not answering/);
  assert.deepEqual(asked, ["agent list", "--version", "api schema"]);
});

test("a herdr that is genuinely not answering keeps its own diagnosis and costs no extra calls", () => {
  const asked = [];
  const capabilities = herdrCapabilities({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12" },
    run: (args) => { asked.push(args.join(" ")); return { status: 3, stdout: "", stderr: "connection refused" }; },
  });
  assert.match(capabilities.reason, /present but not answering/);
  assert.doesNotMatch(capabilities.reason, /out of date/);
  assert.deepEqual(asked, ["agent list"], "version probing belongs on the rejection path only");
});

// Exit 2 alone is not the signal: some other failure could reuse the code.
test("only a usage line makes an exit 2 an argv rejection", () => {
  const capabilities = herdrCapabilities({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12" },
    run: () => ({ status: 2, stdout: "", stderr: "socket closed" }),
  });
  assert.match(capabilities.reason, /present but not answering/);
});

test("a working probe never pays for the version calls", () => {
  const asked = [];
  const capabilities = herdrCapabilities({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w4G:p12" },
    run: (args) => { asked.push(args.join(" ")); return { status: 0, stdout: listing(), stderr: "" }; },
  });
  assert.equal(capabilities.available, true);
  assert.deepEqual(asked, ["agent list"]);
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
  const { run } = recorder();
  const spawned = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  assert.equal(spawned.ok, true);
  assert.deepEqual(spawned.value, { paneId: "w4G:p13", name: "impl", kind: "claude" });
  assert.equal(readPane({ name: "impl" }, { env: LIVE, run: ok("pane text") }).value, "pane text");
});

// The probe is what every hole consults first, so one unsupported flag on it
// shut spawn, read AND alive against a herdr that was answering fine
// (2026-09-07). Pin the argv, not just the behaviour.
test("the capability probe lists agents with no flags herdr 0.8.2 rejects", () => {
  const argv = [];
  herdrCapabilities({ env: LIVE, run: (args) => { argv.push(args); return { status: 0, stdout: listing(), stderr: "" }; } });
  assert.deepEqual(argv, [["agent", "list"]]);
});

test("liveness reads the same list argv as the probe", () => {
  const { run, of } = recorder();
  isAgentAlive({ name: "impl" }, { env: LIVE, run });
  assert.deepEqual(of("agent list"), ["agent", "list"]);
});

// herdr 0.8.2's AgentStatus enum is idle|working|blocked|done|unknown: no
// value means dead, and a dead agent leaves the list. Reading `status` (which
// does not exist) against "exited" (which never occurs) answered "alive" for
// everything, including names that were never dispatched.
test("liveness is presence in the list, over the agent_status field herdr actually sends", () => {
  const agents = listing(dispatcher, { name: "impl", agent_status: "working" }, { name: "quiet", agent_status: "done" });
  const env = LIVE;
  assert.equal(isAgentAlive({ name: "impl" }, { env, run: ok(agents) }).value, true);
  assert.equal(isAgentAlive({ name: "quiet" }, { env, run: ok(agents) }).value, true, "done is a turn ending, not a death");
  assert.equal(isAgentAlive({ name: "never-existed" }, { env, run: ok(agents) }).value, false);
});

// The marker cannot move into the handoff text: an unmarked pane routes as a
// supervisor and may dispatch recursively.
test("a dispatch injects the implementor marker when the pane is created", () => {
  const { run, of } = recorder();
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  const split = of("pane split");
  assert.deepEqual(split, ["pane", "split", "--pane", "w4G:p12", "--direction", "right", "--cwd", "/repo", "--env", "SASU_HERDR_ROLE=implementor", "--no-focus"]);
  assert.deepEqual(of("agent start").slice(0, 7), ["agent", "start", "impl", "--kind", "claude", "--pane", "w4G:p13"]);
  assert.deepEqual(of("agent prompt"), ["agent", "prompt", "impl", "p"]);
});

test("the dispatched kind defaults to the dispatching pane's own agent and can be overridden", () => {
  const detected = recorder({ "agent list": { status: 0, stdout: listing({ agent: "codex", pane_id: "w4G:p12" }), stderr: "" } });
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run: detected.run });
  assert.equal(detected.of("agent start")[4], "codex");

  assert.equal(detected.count("agent list"), 1, "only kind detection needs a list");

  const overridden = recorder();
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p", kind: "codex" }, { env: LIVE, run: overridden.run });
  assert.equal(overridden.of("agent start")[4], "codex");
  assert.equal(overridden.count("agent list"), 0, "an explicit kind has no list dependency");
});

test("an undetectable kind is refused before anything is created", () => {
  const { run, of } = recorder({ "agent list": { status: 0, stdout: listing({ agent: "claude", pane_id: "somewhere-else" }), stderr: "" } });
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /cannot detect the agent kind/);
  assert.equal(of("pane split"), undefined, "nothing may be created before the kind is known");
});

// herdr passes everything after `--` to the agent executable, so the
// translation is per-CLI: claude has a native --effort, codex takes it as a
// config override (measured against both CLIs 2026-09-07).
test("model and effort are forwarded as the started agent's own native arguments", () => {
  const claude = recorder();
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p", model: "opus", effort: "xhigh" }, { env: LIVE, run: claude.run });
  assert.deepEqual(claude.of("agent start").slice(7), ["--", "--model", "opus", "--effort", "xhigh"]);

  const codex = recorder();
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p", kind: "codex", effort: "xhigh" }, { env: LIVE, run: codex.run });
  assert.deepEqual(codex.of("agent start").slice(7), ["--", "--config", 'model_reasoning_effort="xhigh"']);

  const plain = recorder();
  spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run: plain.run });
  assert.equal(plain.of("agent start").length, 7, "no launch settings means no trailing separator");
});

// The pane is created before the agent starts, so a failure in between would
// strand an empty pane.
test("a failed agent start closes only the empty pane it created", () => {
  const { run, of } = recorder({
    "agent start": { status: 1, stdout: "", stderr: "no shell prompt" },
    "pane process-info": { status: 0, stderr: "", stdout: JSON.stringify({ result: { process_info: {
      pane_id: "w4G:p13", shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }],
    } } }) },
  });
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /no shell prompt/);
  assert.deepEqual(of("pane close"), ["pane", "close", "w4G:p13"]);
  assert.match(outcome.problem, /the empty pane was closed/);
});

test("a started implementor is never closed just because its handoff failed", () => {
  const { run, of } = recorder({ "agent prompt": { status: 1, stdout: "", stderr: "busy" } });
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  assert.equal(outcome.ok, false);
  assert.equal(of("pane close"), undefined, "the agent is alive; the supervisor must be able to look at it");
  assert.match(outcome.problem, /running in w4G:p13 with no handoff/);
});

// The prompt carries the whole handoff in one argv entry and a failing wrapper
// may echo argv, so this call never retains output.
test("a failed handoff redacts the prompt from its problem line", () => {
  const { run } = recorder({ "agent prompt": { status: 1, stdout: "SECRET-OPERATIONAL-CONTEXT", stderr: "SECRET-OPERATIONAL-CONTEXT" } });
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "SECRET-OPERATIONAL-CONTEXT" }, { env: LIVE, run });
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.problem, /SECRET-OPERATIONAL-CONTEXT/);
  assert.match(outcome.problem, /<redacted prompt>/);
});

test("a split that reports no pane id never starts an agent into the unknown", () => {
  const { run, of } = recorder({ "pane split": { status: 0, stdout: "{}", stderr: "" } });
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /no pane id/);
  assert.equal(of("agent start"), undefined);
});

test("an unset pane id closes spawn alone and never dispatches without a pane to split", () => {
  const env = { HERDR_ENV: "1" };
  const capabilities = herdrCapabilities({ env, run: ok(listing()) });
  assert.deepEqual(capabilities.holes, { spawn: false, read: true, alive: true });
  assert.match(capabilities.reason, /HERDR_PANE_ID is unset/);

  const { run, of } = recorder();
  const outcome = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env, run });
  assert.equal(outcome.ok, false);
  assert.equal(of("pane split"), undefined, "a dispatch with no supervising pane must be refused, not sent");
  assert.match(outcome.problem, /^spawn unavailable:/);
});

test("a blank pane id is treated as unset rather than dispatched verbatim", () => {
  const capabilities = herdrCapabilities({ env: { HERDR_ENV: "1", HERDR_PANE_ID: "   " }, run: ok(listing()) });
  assert.equal(capabilities.holes.spawn, false);
});

/**
 * The guard that was missing.
 *
 * Every test above answers a fake `run`, so all of them passed for weeks while
 * the real herdr rejected `agent list --json` with exit 2 and knew nothing of
 * `agent new --prompt`. Mocking the CLI you are adapting cannot detect that
 * the CLI changed. This asks the installed herdr whether the flags this
 * adapter spells actually exist, and skips where herdr is not installed -
 * which is exactly the bare terminal, launchd and CI case R9 designs for.
 */
const herdrHelp = (args) => {
  const run = spawnSync("herdr", [...args, "--help"], { encoding: "utf8", timeout: 15_000 });
  return run.error === undefined && run.status === 0 ? `${run.stdout}${run.stderr}` : null;
};

const binaryProbe = spawnSync("herdr", ["--version"], { encoding: "utf8", timeout: 15_000 });
const noHerdr = binaryProbe.error?.code === "ENOENT";

test("the argv this adapter sends matches the installed herdr's own contract", { skip: noHerdr ? "herdr is not installed" : false }, () => {
  const listing = spawnSync("herdr", ["agent", "list"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(listing.status, 0, "the capability probe's argv must succeed against the installed herdr");
  assert.doesNotThrow(() => JSON.parse(listing.stdout), "`agent list` is expected to print JSON with no --json flag");

  for (const [args, flags] of [
    [["pane", "split"], ["--pane", "--direction", "--cwd", "--env", "--no-focus"]],
    [["agent", "start"], ["--kind", "--pane"]],
    [["pane", "process-info"], ["--pane"]],
    [["agent", "read"], ["--source", "--lines"]],
  ]) {
    const help = herdrHelp(args);
    assert.notEqual(help, null, `herdr ${args.join(" ")} --help must answer`);
    for (const flag of flags) {
      assert.ok(help.includes(flag), `herdr ${args.join(" ")} no longer accepts ${flag}; this adapter still sends it`);
    }
  }
});


test("list failure does not disable read or explicit-kind startup", () => {
  const recorded = recorder({ "agent list": { status: 2, stdout: "", stderr: "usage: herdr agent list" } });
  assert.equal(readPane({ name: "impl" }, { env: LIVE, run: recorded.run }).ok, true);
  assert.equal(spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p", kind: "claude" }, { env: LIVE, run: recorded.run }).ok, true);
  assert.equal(recorded.count("agent list"), 0);
  assert.equal(isAgentAlive({ name: "impl" }, { env: LIVE, run: recorded.run }).value, null);
});

test("malformed successful lists are unknown rather than evidence of absence", () => {
  for (const stdout of ["garbage", "{}", "null", '{"result":{"agents":{}}}', listing(null), listing({ name: 1 })]) {
    const observed = isAgentAlive({ name: "impl" }, { env: LIVE, run: ok(stdout) });
    assert.equal(observed.ok, false);
    assert.equal(observed.value, null);
    assert.match(observed.problem, /invalid agent list/);
  }
});

test("failed startup retains unready, live, and unobservable panes without sending a handoff", () => {
  for (const [stderr, processInfo] of [
    [JSON.stringify({ error: { code: "agent_not_ready" } }), { status: 0, stdout: "{}", stderr: "" }],
    ["startup failed", { status: 0, stdout: JSON.stringify({ result: { process_info: {
      pane_id: "w4G:p13", shell_pid: 42, foreground_process_group_id: 99, foreground_processes: [{ pid: 99 }],
    } } }), stderr: "" }],
    ["startup failed", { status: 1, stdout: "", stderr: "connection refused" }],
    ["startup failed", { status: 0, stdout: "malformed", stderr: "" }],
  ]) {
    const recorded = recorder({ "agent start": { status: 1, stdout: "", stderr }, "pane process-info": processInfo });
    const result = spawnImplementor({ name: "impl", cwd: "/repo", prompt: "p" }, { env: LIVE, run: recorded.run });
    assert.equal(result.ok, false);
    assert.match(result.problem, /pane w4G:p13 was retained/);
    assert.equal(recorded.count("pane close"), 0);
    assert.equal(recorded.count("agent prompt"), 0);
    assert.equal(recorded.count("agent wait"), 0);
  }
});

test("installed CLI errors use stderr and retain unknown liveness on connection failure", { skip: noHerdr ? "herdr is not installed" : false }, () => {
  const missing = `missing-${process.pid}-${Date.now()}`;
  const read = spawnSync("herdr", ["agent", "read", missing, "--source", "recent-unwrapped", "--lines", "1"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(read.status, 1);
  assert.equal(read.stdout, "");
  assert.equal(JSON.parse(read.stderr).error.code, "agent_not_found");
  const run = (args) => spawnSync("herdr", args, { encoding: "utf8", timeout: 15_000,
    env: { ...process.env, HERDR_SOCKET_PATH: `/tmp/${missing}.sock` } });
  const failure = run(["agent", "list"]);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.equal(JSON.parse(failure.stderr).error.code, "server_not_running");
  const observed = isAgentAlive({ name: missing }, { env: LIVE, run });
  assert.equal(observed.ok, false);
  assert.equal(observed.value, null);
});
