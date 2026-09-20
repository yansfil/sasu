import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { appendLog, LOG_CAP_BYTES, LOG_EVENT_CAP_BYTES, MAX_UNKNOWN_WAKE_ATTEMPTS, MAX_WAKE_BYTES, processIncarnation, rotateLog, runTick, TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP, TICK_DEADLINE_MS } from "../../dist/supervisor/tick.js";
import { readIndex, enrollRun, MISSING_TICKS_BEFORE_CLEANUP, updateIndex } from "../../dist/supervisor/index.js";
import { MAX_RUN_STATE_BYTES } from "../../dist/supervisor/facts.js";
import { WAKE_MARKER } from "../../dist/supervisor/wake.js";
import { agent, fakeTickHerdr, implementorIdentity, IMPLEMENTOR_PANE, makeSupervisedRun, OBSERVER_PANE, OBSERVER_SESSION, observerIdentity, patchState } from "../helpers/supervised-run.mjs";

const T0 = Date.parse("2026-09-18T10:00:00.000Z");
const MIN = 60_000;
const indexFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-tick-")), "index.json");
const observer = (fields = {}) => agent(OBSERVER_PANE, { sessionId: OBSERVER_SESSION, terminalId: "term_obs", status: "idle", ...fields });
const implementor = (fields = {}) => agent(IMPLEMENTOR_PANE, { name: "impl", sessionId: "impl-sess", status: "working", activityAt: T0, ...fields });
const silent = () => {};

function tick(index, herdr, now, extra = {}) {
  return runTick({ indexFile: index, herdr: herdr.herdr, now: () => now, log: silent, ...extra });
}

test("engineering 10/15: a log rotation failure is surfaced instead of silently growing the sink", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-log-"));
  const log = path.join(directory, "tick.log");
  fs.writeFileSync(log, Buffer.alloc(LOG_CAP_BYTES, 120));
  fs.mkdirSync(`${log}.1`);
  assert.throws(() => rotateLog(log), /EISDIR|directory/i);
  assert.equal(fs.statSync(log).size, LOG_CAP_BYTES, "the failed rotation does not append beyond the cap");
});

test("engineering 15: one oversized structured event becomes an explicit bounded truncation record", () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-log-event-")), "tick.log");
  appendLog(log, { event: "large", at: "2026-09-18T10:00:00.000Z", payload: "x".repeat(LOG_EVENT_CAP_BYTES) });
  const recorded = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(recorded.event, "supervisor.log.truncated");
  assert.equal(recorded.originalEvent, "large");
  assert.ok(recorded.originalBytes > LOG_EVENT_CAP_BYTES);
  assert.ok(fs.statSync(log).size < 1024);
});

test("engineering 10/15: the total tick deadline persists an actionable continuation and releases its executor", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  let clock = T0;
  const result = runTick({ indexFile: index, herdr: herdr.herdr, now: () => { const value = clock; clock += TICK_DEADLINE_MS + 1; return value; }, log: silent });
  assert.equal(result.executor, "ran");
  assert.match(result.runs[0].detail, new RegExp(`tick deadline ${TICK_DEADLINE_MS}ms exhausted`));
  const persisted = readIndex(index);
  assert.equal(persisted.tickExecutor, null, "the deadline exit cannot strand the serialized executor");
  assert.equal(persisted.lastTickAt, result.at, "the next tick must continue after the recorded budget exit");
  assert.match(persisted.entries[0].lastFailure.detail, /tick deadline/);
});

test("engineering 11: a lease claim lost to a competing revision never executes", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const originalLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (...args) => {
    if (!injected && String(args[1]).startsWith(`${index}.revision-`)) {
      injected = true;
      updateIndex(index, (held) => {
        held.tickExecutor = {
          operationId: "competing-executor",
          pid: process.pid,
          processIncarnation: processIncarnation(process.pid),
          startedAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 5 * MIN).toISOString(),
        };
      });
    }
    return originalLink(...args);
  };
  try {
    const result = tick(index, herdr, T0 + MIN);
    assert.equal(result.executor, "already-running");
    assert.equal(herdr.prompts.length, 0, "the CAS loser owns no authority to submit");
    assert.equal(readIndex(index).tickExecutor.operationId, "competing-executor");
  } finally {
    fs.linkSync = originalLink;
  }
});

test("engineering 14: a live executor is not stolen merely because its lease timestamp elapsed", () => {
  const index = indexFile();
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "live-but-delayed",
      pid: process.pid,
      processIncarnation: processIncarnation(process.pid),
      startedAt: new Date(T0 - 10 * MIN).toISOString(),
      expiresAt: new Date(T0 - MIN).toISOString(),
    };
  });
  const herdr = fakeTickHerdr();
  const result = tick(index, herdr, T0);
  assert.equal(result.executor, "already-running");
  const executor = readIndex(index).tickExecutor;
  assert.equal(executor.operationId, "live-but-delayed");
  assert.equal("expiresAt" in executor, false, "legacy expiry metadata is not retained as a false recovery promise");
});

test("engineering 11/14: process incarnation is stable across caller timezone changes", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = processIncarnation(process.pid);
    process.env.TZ = "Asia/Seoul";
    const seoul = processIncarnation(process.pid);
    assert.notEqual(utc, null);
    assert.equal(seoul, utc, "scheduled and manual ticks must agree on the exact live owner");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("engineering 11/14: a timezone change cannot steal a live executor and submit", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(T0).toISOString() });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const previous = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    updateIndex(index, (held) => {
      held.tickExecutor = {
        operationId: "utc-executor",
        pid: process.pid,
        processIncarnation: processIncarnation(process.pid),
        startedAt: new Date(T0 - MIN).toISOString(),
        expiresAt: new Date(T0 + MIN).toISOString(),
      };
    });
    process.env.TZ = "Asia/Seoul";
    const result = tick(index, herdr, T0);
    assert.equal(result.executor, "already-running");
    assert.equal(herdr.prompts.length, 0, "a caller environment change cannot create a second delivery executor");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("engineering 1/11/14: a live unversioned process identity fails closed across an upgrade", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  const now = Date.now();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(now).toISOString() });
  const legacy = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "America/Los_Angeles" } });
  assert.equal(legacy.status, 0);
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "unversioned-live-executor",
      pid: process.pid,
      processIncarnation: `${process.platform}:${legacy.stdout.trim().replace(/\s+/g, " ")}`,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + MIN).toISOString(),
    };
  });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const result = tick(index, herdr, now);
  assert.equal(result.executor, "already-running");
  assert.equal(herdr.prompts.length, 0, "an encoding transition is not positive PID-reuse evidence");
});

test("B3/engineering 14: a reused PID does not preserve a dead executor lease", () => {
  const index = indexFile();
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "prior-process",
      pid: process.pid,
      processIncarnation: "prior-boot:other-process",
      startedAt: new Date(T0 - 24 * 60 * MIN).toISOString(),
      expiresAt: new Date(T0 - 23 * 60 * MIN).toISOString(),
    };
  });
  const result = tick(index, fakeTickHerdr(), T0);
  assert.equal(result.executor, "ran", "only the exact process incarnation owns the executor");
  assert.equal(readIndex(index).tickExecutor, null);
});

test("B3/engineering 1/14: a legacy prior-boot lease recognizes positive PID reuse", () => {
  const index = indexFile();
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "legacy-prior-process",
      pid: process.pid,
      startedAt: new Date(T0 - 24 * 60 * MIN).toISOString(),
      expiresAt: new Date(T0 - 23 * 60 * MIN).toISOString(),
    };
  });
  const result = tick(index, fakeTickHerdr(), T0);
  assert.equal(result.executor, "ran", "the schema transition cannot strand a pre-incarnation lease after reboot");
  assert.equal(readIndex(index).tickExecutor, null);
});

test("engineering 1/11/14: a caller timezone cannot steal a live legacy executor", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  const now = Date.now();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(now).toISOString() });
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "legacy-live-executor",
      pid: process.pid,
      processIncarnation: null,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + MIN).toISOString(),
    };
  });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const result = tick(index, herdr, now);
    assert.equal(result.executor, "already-running");
    assert.equal(herdr.prompts.length, 0, "the schema transition must preserve one live delivery executor");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("engineering 1/11/14: a caller timezone still recovers a positively reused legacy PID", () => {
  const observed = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" } });
  assert.equal(observed.status, 0);
  const processStartedAt = Date.parse(`${observed.stdout.trim().replace(/\s+/g, " ")} UTC`);
  assert.equal(Number.isFinite(processStartedAt), true);
  const index = indexFile();
  updateIndex(index, (held) => {
    held.tickExecutor = {
      operationId: "legacy-reused-executor",
      pid: process.pid,
      processIncarnation: null,
      startedAt: new Date(processStartedAt - MIN).toISOString(),
      expiresAt: new Date(processStartedAt).toISOString(),
    };
  });
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Seoul";
    const result = tick(index, fakeTickHerdr(), processStartedAt + MIN);
    assert.equal(result.executor, "ran", "positive PID reuse evidence cannot be hidden by the caller timezone");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("engineering 10/15: slow external probes persist continuation instead of rescanning forever", () => {
  const index = indexFile();
  const base = makeSupervisedRun();
  const template = JSON.parse(fs.readFileSync(base.statePath, "utf8"));
  const agents = {};
  for (let number = 0; number < 20; number += 1) {
    const statePath = path.join(path.dirname(base.statePath), `slow-${number}.json`);
    const state = structuredClone(template);
    state.topicSlug = `slow-${number}`;
    state.supervision.runInstanceId = `slow-instance-${number}`;
    state.supervision.observer = observerIdentity({ sessionId: `slow-observer-${number}`, terminalId: `slow-observer-term-${number}`, paneId: `slow-observer-pane-${number}`, hostScope: `slow-scope-${number}` });
    state.supervision.implementor = implementorIdentity({ sessionId: `slow-implementor-${number}`, terminalId: `slow-implementor-term-${number}`, paneId: `slow-implementor-pane-${number}`, agent: `slow-implementor-${number}`, hostScope: `slow-scope-${number}` });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    enrollRun(index, { statePath, runInstanceId: state.supervision.runInstanceId, recoveryOwner: "supervisor", at: new Date(T0 + number).toISOString() });
    agents[`slow-observer-${number}`] = observer({ sessionId: `slow-observer-${number}`, terminalId: `slow-observer-term-${number}`, paneId: `slow-observer-pane-${number}` });
    agents[`slow-implementor-${number}`] = implementor({ name: `slow-implementor-${number}`, sessionId: `slow-implementor-${number}`, terminalId: `slow-implementor-term-${number}`, paneId: `slow-implementor-pane-${number}`, status: "blocked" });
  }
  const fake = fakeTickHerdr({ agents });
  let clock = T0;
  const slowHerdr = {
    probe(scope) { clock += 2_000; return fake.herdr.probe(scope); },
    getAgent(target, scope) { clock += 2_000; return fake.herdr.getAgent(target, scope); },
    promptAgent(input, scope) { clock += 2_000; return fake.herdr.promptAgent(input, scope); },
  };
  const limited = runTick({ indexFile: index, herdr: slowHerdr, now: () => clock, log: silent });
  assert.equal(limited.executor, "ran");
  assert.ok(fake.prompts.length > 0, "the decision phase leaves enough wall-clock budget for delivery");
  assert.equal(readIndex(index).lastTickAt, limited.at, "elapsed work is durable progress rather than a repeated prefix");
  assert.equal(readIndex(index).entries.some((entry) => entry.lastFailure?.detail.includes("budget")), true);

  for (let pass = 1; pass <= 19; pass += 1) {
    const continued = runTick({ indexFile: index, herdr: slowHerdr, now: () => clock, log: silent });
    assert.equal(continued.executor, "ran");
  }
  assert.equal(fake.prompts.length, 20, "persistent latency still rotates through every deferred enrollment");
  assert.equal(new Set(fake.prompts.map((prompt) => prompt.target)).size, 20);
});

test("engineering 11/15: one slow ready run completes inside the admitted tick deadline", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(T0).toISOString() });
  const fake = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  let clock = T0;
  const budgets = [];
  const slowHerdr = {
    probe(scope, timeoutMs) { budgets.push(timeoutMs); clock += 6_000; return fake.herdr.probe(scope); },
    getAgent(target, scope, timeoutMs) { budgets.push(timeoutMs); clock += 6_000; return fake.herdr.getAgent(target, scope); },
    promptAgent(input, scope, timeoutMs) { budgets.push(timeoutMs); clock += 6_000; return fake.herdr.promptAgent(input, scope); },
  };

  const result = runTick({ indexFile: index, herdr: slowHerdr, now: () => clock, log: silent });

  assert.equal(result.runs[0].action, "sent");
  assert.equal(fake.prompts.length, 1);
  assert.ok(clock - T0 <= TICK_DEADLINE_MS, `tick took ${clock - T0}ms`);
  assert.equal(budgets.length, 4, "one implementor observation, initial Observer observation, final identity check and submission");
  assert.equal(budgets.every((budget) => Number.isFinite(budget) && budget > 0 && budget <= TICK_DEADLINE_MS), true, "every adapter call receives the remaining monotonic budget");
});

test("engineering 10/11/15: a slow single-run delivery reaches a bounded actionable outcome instead of starving", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(T0).toISOString() });
  const fake = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  let clock = T0;
  const slowHerdr = {
    probe(scope, timeoutMs) { clock += Math.min(6_500, timeoutMs ?? 6_500); return fake.herdr.probe(scope); },
    getAgent(target, scope, timeoutMs) { clock += Math.min(6_500, timeoutMs ?? 6_500); return fake.herdr.getAgent(target, scope); },
    promptAgent(input, scope, timeoutMs) {
      const allowed = timeoutMs ?? 6_500;
      clock += Math.min(6_500, allowed);
      if (allowed < 6_500) return { outcome: "unknown", path: "session-match", code: "herdr_prompt_timeout", detail: "admitted deadline reached" };
      return fake.herdr.promptAgent(input, scope);
    },
  };

  const results = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const started = clock;
    results.push(runTick({ indexFile: index, herdr: slowHerdr, now: () => clock, log: silent }));
    assert.ok(clock - started <= TICK_DEADLINE_MS, `tick ${pass + 1} exceeded the total bound`);
    clock += MIN;
  }

  assert.equal(readIndex(index).entries[0].pendingWake.attempts, MAX_UNKNOWN_WAKE_ATTEMPTS);
  assert.equal(results.at(-1).runs[0].action, "failed");
  assert.match(results.at(-1).runs[0].detail, /no further automatic input/);
});

test("engineering 10/15: a fair bounded batch eventually delivers every ready run", () => {
  const index = indexFile();
  const base = makeSupervisedRun();
  const template = JSON.parse(fs.readFileSync(base.statePath, "utf8"));
  const agents = {};
  for (let number = 0; number < 64; number += 1) {
    const statePath = path.join(path.dirname(base.statePath), `ready-${String(number).padStart(2, "0")}.json`);
    const state = structuredClone(template);
    state.topicSlug = `ready-${number}`;
    state.supervision.runInstanceId = `instance-${number}`;
    state.supervision.observer = observerIdentity({ sessionId: `observer-${number}`, terminalId: `observer-term-${number}`, paneId: `observer-pane-${number}`, hostScope: `scope-${number}` });
    state.supervision.implementor = implementorIdentity({ sessionId: `implementor-${number}`, terminalId: `implementor-term-${number}`, paneId: `implementor-pane-${number}`, agent: `implementor-${number}`, hostScope: `scope-${number}` });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    enrollRun(index, { statePath, runInstanceId: `instance-${number}`, recoveryOwner: "supervisor", at: new Date(T0 + number).toISOString() });
    agents[`observer-${number}`] = observer({ sessionId: `observer-${number}`, terminalId: `observer-term-${number}`, paneId: `observer-pane-${number}` });
    agents[`implementor-${number}`] = implementor({ name: `implementor-${number}`, sessionId: `implementor-${number}`, terminalId: `implementor-term-${number}`, paneId: `implementor-pane-${number}`, status: "blocked" });
  }
  const herdr = fakeTickHerdr({ agents });
  for (let pass = 1; pass <= 4; pass += 1) {
    const result = tick(index, herdr, T0 + pass * MIN);
    assert.equal(result.executor, "ran");
  }
  assert.equal(herdr.prompts.length, 64, "bounded continuation cannot rescan the same prefix forever");
  assert.equal(new Set(herdr.prompts.map((prompt) => prompt.target)).size, 64);
  assert.equal(readIndex(index).entries.filter((entry) => entry.pendingWake !== null).length, 0, "no call-budget failure spends an unsubmitted attempt");
});

test("engineering 10/11: a deadline after reservation releases the provably unsubmitted attempt", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(T0).toISOString() });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  for (let pass = 1; pass <= 2; pass += 1) {
    const started = T0 + pass * MIN;
    let clock = started;
    let reservationObserved = false;
    const originalLink = fs.linkSync;
    fs.linkSync = (...args) => {
      const answer = originalLink(...args);
      if (!reservationObserved) {
        try {
          const candidate = JSON.parse(fs.readFileSync(String(args[0]), "utf8"));
          reservationObserved = candidate.entries?.some((entry) => entry.pendingWake?.status === "reserved") === true;
          if (reservationObserved) clock = started + TICK_DEADLINE_MS;
        } catch {}
      }
      return answer;
    };
    try {
      const result = runTick({ indexFile: index, herdr: herdr.herdr, now: () => clock, log: silent });
      assert.equal(result.executor, "ran");
      assert.match(result.runs.find((entry) => entry.statePath === run.statePath).detail, /tick deadline/);
      assert.equal(reservationObserved, true);
    } finally {
      fs.linkSync = originalLink;
    }
    assert.equal(readIndex(index).entries[0].pendingWake, null, "an input call that never began consumes no uncertainty budget");
  }
  assert.equal(herdr.prompts.length, 0);
});

test("engineering 10/15: the latest failed processing attempt rotates a healthy run into the next batch", () => {
  const index = indexFile();
  const base = makeSupervisedRun();
  const template = JSON.parse(fs.readFileSync(base.statePath, "utf8"));
  for (let number = 0; number < 20; number += 1) {
    const statePath = path.join(path.dirname(base.statePath), `malformed-${number}.json`);
    fs.writeFileSync(statePath, "{malformed");
    enrollRun(index, { statePath, runInstanceId: `malformed-${number}`, recoveryOwner: "supervisor", at: new Date(T0 + number).toISOString() });
  }
  const healthyPath = path.join(path.dirname(base.statePath), "healthy.json");
  const healthy = structuredClone(template);
  healthy.topicSlug = "healthy";
  healthy.supervision.runInstanceId = "healthy-instance";
  fs.writeFileSync(healthyPath, `${JSON.stringify(healthy, null, 2)}\n`);
  enrollRun(index, { statePath: healthyPath, runInstanceId: "healthy-instance", recoveryOwner: "supervisor", at: new Date(T0 + 20).toISOString() });
  updateIndex(index, (held) => {
    for (const entry of held.entries.filter((candidate) => candidate.statePath !== healthyPath)) {
      entry.lastObservation = { at: new Date(T0).toISOString(), observer: "prior", implementor: "prior", guardedPrompt: false };
    }
  });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  tick(index, herdr, T0 + MIN);
  assert.equal(herdr.prompts.length, 0);
  tick(index, herdr, T0 + 2 * MIN);
  assert.equal(herdr.prompts.length, 1, "newer failures cannot hide behind an older successful observation forever");
  assert.match(herdr.prompts[0].text, /healthy/);
});

test("B8/B10: a settled implementor wakes exactly the recorded Observer once, with an identity note, and the index records the wake", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "idle", activityAt: T0 }) } });

  const first = tick(index, herdr, T0 + 2 * MIN);
  assert.deepEqual(first.runs.map((entry) => entry.action), ["sent"]);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(herdr.prompts[0].target, OBSERVER_PANE);
  assert.equal(herdr.prompts[0].sessionId, OBSERVER_SESSION);
  const body = herdr.prompts[0].text;
  assert.match(body, new RegExp(`^${WAKE_MARKER}\\n`));
  assert.match(body, new RegExp(`observer: ${OBSERVER_SESSION}`));
  assert.match(body, /run: fixture instance instance-1/);
  assert.match(body, /reason: settled/);
  assert.match(body, new RegExp(`inspect: sasu implement status --state '${run.statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' --instance 'instance-1' --observer '${OBSERVER_SESSION}' --digest`));
  assert.doesNotMatch(body, /implementation\.txt|Requirement/, "no transcript, no PRD content: an identity note only");

  const recorded = readIndex(index);
  assert.equal(recorded.lastTickAt, new Date(T0 + 2 * MIN).toISOString());
  assert.deepEqual({ reasons: recorded.entries[0].lastWake.reasons, outcome: recorded.entries[0].lastWake.outcome, path: recorded.entries[0].lastWake.path }, { reasons: ["settled"], outcome: "accepted", path: "session-match" });
  assert.equal(recorded.entries[0].lastObservation.guardedPrompt, false);

  const second = tick(index, herdr, T0 + 3 * MIN);
  assert.deepEqual(second.runs.map((entry) => entry.action), ["none"]);
  assert.equal(herdr.prompts.length, 1, "the same settled episode is not woken twice");
});

test("B9: a replacement session in the Observer's pane receives nothing and status shows observer-gone", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer({ sessionId: "a-new-session" }), impl: implementor({ status: "blocked" }) } });
  const outcome = tick(index, herdr, T0 + MIN);
  assert.deepEqual(outcome.runs.map((entry) => entry.action), ["deferred"]);
  assert.match(outcome.runs[0].detail, /observer-gone/);
  assert.equal(herdr.prompts.length, 0, "zero input to the stranger");
  const entry = readIndex(index).entries[0];
  assert.match(entry.lastObservation.observer, /^observer-gone/);
  assert.equal(entry.lastWake, null);
  assert.match(entry.lastFailure.detail, /not the recorded Observer/);
});

test("D-06: Observer identity and host scope are checked again immediately before transmission", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const lookups = [];
  const prompts = [];
  let observerReads = 0;
  const herdr = { herdr: {
    probe: (hostScope) => {
      assert.equal(hostScope, "sock");
      return { available: true, detail: null };
    },
    getAgent: (target, hostScope) => {
      lookups.push({ target, hostScope });
      if (target === IMPLEMENTOR_PANE) return { kind: "found", agent: implementor({ status: "blocked" }) };
      observerReads += 1;
      return { kind: "found", agent: observer(observerReads === 1 ? {} : { sessionId: "replacement-session" }) };
    },
    promptAgent: (input, hostScope) => {
      prompts.push({ input, hostScope });
      return { outcome: "accepted", path: "session-match", code: "submitted", detail: "ok" };
    },
  } };

  const outcome = tick(index, herdr, T0 + MIN);
  assert.equal(observerReads, 2, "the pre-send read is uncached");
  assert.equal(outcome.runs[0].action, "deferred");
  assert.match(outcome.runs[0].detail, /observer-gone/);
  assert.equal(prompts.length, 0, "the replacement receives no input");
  assert.equal(lookups.every((lookup) => lookup.hostScope === "sock"), true, "all identity checks use the recorded socket scope");
  const entry = readIndex(index).entries[0];
  assert.match(entry.lastObservation.observer, /^observer-gone/, "the final uncached observation replaces the stale healthy one");
  assert.match(entry.lastFailure.detail, /not the recorded Observer/);
});

test("D-06: re-enrollment during the final Observer lookup discards the stale wake", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  let observerReads = 0;
  const prompts = [];
  const herdr = { herdr: {
    probe: () => ({ available: true, detail: null }),
    getAgent: (target) => {
      if (target === IMPLEMENTOR_PANE) return { kind: "found", agent: implementor({ status: "blocked" }) };
      observerReads += 1;
      if (observerReads === 2) enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:30.000Z" });
      return { kind: "found", agent: observer() };
    },
    promptAgent: (input) => {
      prompts.push(input);
      return { outcome: "accepted", path: "session-match", code: "submitted", detail: "ok" };
    },
  } };

  const outcome = tick(index, herdr, T0 + MIN);
  assert.equal(outcome.runs[0].action, "deferred");
  assert.match(outcome.runs[0].detail, /changed during the final identity lookup/);
  assert.equal(prompts.length, 0);
  assert.equal(readIndex(index).entries[0].lastWake, null);
});

test("engineering 15: a single wake above the input byte cap is reported and not submitted", () => {
  const index = indexFile();
  const longName = "i".repeat(MAX_WAKE_BYTES);
  const run = makeSupervisedRun({ implementor: implementorIdentity({ agent: longName }) });
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ name: longName, status: "blocked" }) } });
  const outcome = tick(index, herdr, T0 + MIN);
  assert.equal(outcome.runs[0].action, "failed");
  assert.match(outcome.runs[0].detail, /above the .* byte cap/);
  assert.equal(herdr.prompts.length, 0);
  assert.match(readIndex(index).entries[0].lastFailure.detail, /above the .* byte cap/);
});

test("B4: several runs - two repositories with one slug, and one Observer watching two runs - each wake reaches only its own Observer, bundled per Observer", () => {
  const index = indexFile();
  const a = makeSupervisedRun({ runInstanceId: "a" });
  const b = makeSupervisedRun({ runInstanceId: "b", observer: observerIdentity({ sessionId: "other-observer", paneId: "w9:p1", terminalId: "term_other" }), implementor: implementorIdentity({ paneId: "w9:p2", sessionId: "sess", agent: "impl" }) });
  const c = makeSupervisedRun({ runInstanceId: "c", implementor: implementorIdentity({ paneId: "w3:p1", sessionId: "sess", agent: "impl-c" }) });
  for (const [run, id] of [[a, "a"], [b, "b"], [c, "c"]]) enrollRun(index, { statePath: run.statePath, runInstanceId: id, recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: {
    obs: observer(),
    other: agent("w9:p1", { sessionId: "other-observer", terminalId: "term_other", status: "idle" }),
    implA: implementor({ status: "blocked", stateChangeSeq: 2 }),
    implB: agent("w9:p2", { name: "impl", status: "blocked", stateChangeSeq: 3 }),
    implC: agent("w3:p1", { name: "impl-c", status: "idle", activityAt: T0, stateChangeSeq: 4 }),
  } });
  const outcome = tick(index, herdr, T0 + 2 * MIN);
  assert.deepEqual(outcome.runs.map((entry) => entry.action), ["sent", "sent", "sent"]);
  assert.equal(herdr.prompts.length, 2, "one prompt per Observer, not per run");
  const mine = herdr.prompts.find((prompt) => prompt.sessionId === OBSERVER_SESSION);
  const theirs = herdr.prompts.find((prompt) => prompt.sessionId === "other-observer");
  assert.match(mine.text, /run: fixture instance a[\s\S]*run: fixture instance c/, "both of this Observer's runs in one note");
  assert.doesNotMatch(mine.text, /instance b/);
  assert.match(theirs.text, /instance b/);
  assert.doesNotMatch(theirs.text, /instance a|instance c/);
});

test("B12: one run's broken state.json, missing file or instance mismatch is its own failure; the others are still judged", () => {
  const index = indexFile();
  const good = makeSupervisedRun({ runInstanceId: "good" });
  const broken = makeSupervisedRun({ runInstanceId: "broken" });
  const mismatched = makeSupervisedRun({ runInstanceId: "recorded" });
  const vanished = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gone-")), "agents", "runs", "gone", "state.json");
  fs.writeFileSync(broken.statePath, "{ not json");
  for (const [statePath, id] of [[good.statePath, "good"], [broken.statePath, "broken"], [mismatched.statePath, "indexed-differently"], [vanished, "vanished"]]) enrollRun(index, { statePath, runInstanceId: id, recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });

  const outcome = tick(index, herdr, T0 + MIN);
  const byPath = Object.fromEntries(outcome.runs.map((entry) => [entry.statePath, entry]));
  assert.equal(byPath[good.statePath].action, "sent");
  assert.equal(byPath[broken.statePath].action, "failed");
  assert.match(byPath[broken.statePath].detail, /malformed implement state JSON/);
  assert.equal(byPath[mismatched.statePath].action, "failed");
  assert.match(byPath[mismatched.statePath].detail, /run instance recorded in state.json is not the indexed indexed-differently/);
  assert.equal(byPath[vanished].action, "failed");
  assert.match(byPath[vanished].detail, /missing \(1 consecutive tick/);
  assert.equal(herdr.prompts.length, 1);
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 4, "nothing is dropped on a first failure");
  assert.equal(recorded.entries.find((entry) => entry.statePath === vanished).missingTicks, 1);
});

test("B12/engineering 15: one oversized state and one legacy identity fail closed without blocking a good run", () => {
  const index = indexFile();
  const good = makeSupervisedRun({ runInstanceId: "good" });
  const oversized = makeSupervisedRun({ runInstanceId: "oversized" });
  const legacy = makeSupervisedRun({ runInstanceId: "legacy" });
  fs.truncateSync(oversized.statePath, MAX_RUN_STATE_BYTES + 1);
  patchState(legacy.statePath, (state) => { delete state.supervision.implementor.sessionId; });
  for (const [run, id] of [[good, "good"], [oversized, "oversized"], [legacy, "legacy"]]) {
    enrollRun(index, { statePath: run.statePath, runInstanceId: id, recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  }
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const outcome = tick(index, herdr, T0 + MIN);
  const byPath = Object.fromEntries(outcome.runs.map((entry) => [entry.statePath, entry]));
  assert.equal(byPath[good.statePath].action, "sent");
  assert.match(byPath[oversized.statePath].detail, new RegExp(`above the ${MAX_RUN_STATE_BYTES} byte cap`));
  assert.match(byPath[legacy.statePath].detail, /supervision\.implementor\.sessionId/);
  assert.equal(herdr.prompts.length, 1);
});

test("B15: a state.json that stays missing is removed after N consecutive ticks with its cause, and a file that comes back resets the count", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const bytes = fs.readFileSync(run.statePath);
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  fs.rmSync(run.statePath);
  tick(index, herdr, T0 + MIN);
  fs.writeFileSync(run.statePath, bytes);
  tick(index, herdr, T0 + 2 * MIN);
  assert.equal(readIndex(index).entries[0].missingTicks, 0, "a readable file resets the count");
  fs.rmSync(run.statePath);
  for (let i = 0; i < MISSING_TICKS_BEFORE_CLEANUP - 1; i += 1) tick(index, herdr, T0 + (3 + i) * MIN);
  assert.equal(readIndex(index).entries.length, 1, "one tick short of the bound keeps the entry");
  const final = tick(index, herdr, T0 + 10 * MIN);
  assert.equal(final.runs[0].action, "removed");
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 0);
  assert.match(recorded.removed.at(-1).cause, new RegExp(`missing for ${MISSING_TICKS_BEFORE_CLEANUP} consecutive ticks`));
});

test("B15: a retired run is woken once with reason terminal and then leaves the index", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  patchState(run.statePath, (state) => { state.status = "retired"; state.retirement = { retiredAt: "2026-09-18T10:05:00.000Z", retiredBySessionId: null }; });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  const outcome = tick(index, herdr, T0 + 6 * MIN);
  assert.equal(outcome.runs[0].action, "sent");
  assert.match(herdr.prompts[0].text, /reason: terminal/);
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 0);
  assert.match(recorded.removed.at(-1).cause, /run retired; terminal wake accepted/);
  assert.equal(tick(index, herdr, T0 + 7 * MIN).runs.length, 0);
  assert.equal(herdr.prompts.length, 1);
});

test("B15: a retired run with a missing Observer is removed after a bounded failed-delivery window", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  patchState(run.statePath, (state) => { state.status = "retired"; state.retirement = { retiredAt: "2026-09-18T10:05:00.000Z", retiredBySessionId: null }; });
  const herdr = fakeTickHerdr({ agents: { impl: implementor() } });
  for (let i = 1; i < TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP; i += 1) {
    assert.equal(tick(index, herdr, T0 + i * MIN).runs[0].action, "deferred");
  }
  const final = tick(index, herdr, T0 + TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP * MIN);
  assert.equal(final.runs[0].action, "undelivered-terminal");
  const recorded = readIndex(index);
  assert.equal(recorded.entries.length, 0);
  assert.equal(recorded.undeliveredTerminal.length, 1);
  assert.match(recorded.undeliveredTerminal[0].detail, new RegExp(`${TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP}`));
  assert.equal(herdr.prompts.length, 0);
});

test("B15/engineering 4: terminal notification defers without budget loss while the Observer is working", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  patchState(run.statePath, (state) => { state.status = "retired"; state.retirement = { retiredAt: "2026-09-18T10:05:00.000Z", retiredBySessionId: null }; });
  const herdr = fakeTickHerdr({ agents: { obs: observer({ status: "working" }), impl: implementor() } });
  for (let i = 1; i <= TERMINAL_FAILURE_TICKS_BEFORE_CLEANUP + 2; i += 1) {
    assert.equal(tick(index, herdr, T0 + i * MIN).runs[0].action, "deferred");
  }
  assert.equal(readIndex(index).entries[0].terminalFailureTicks, 0);
  assert.equal(readIndex(index).undeliveredTerminal.length, 0);
  herdr.state.agents.obs = observer({ status: "idle" });
  assert.equal(tick(index, herdr, T0 + 10 * MIN).runs[0].action, "sent");
  assert.equal(herdr.prompts.length, 1);
  assert.equal(readIndex(index).entries.length, 0);
});

test("B8: a working Observer is not interrupted; the same condition is delivered on the next tick it is idle", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer({ status: "working" }), impl: implementor({ status: "blocked" }) } });
  const deferred = tick(index, herdr, T0 + MIN);
  assert.equal(deferred.runs[0].action, "deferred");
  assert.equal(herdr.prompts.length, 0);
  herdr.state.agents.obs = observer({ status: "idle" });
  const delivered = tick(index, herdr, T0 + 2 * MIN);
  assert.equal(delivered.runs[0].action, "sent");
  assert.equal(herdr.prompts.length, 1);
});

test("B11: when herdr returns an input_guard for the Observer the wake goes guarded, and a guard the server then refuses is a routing failure, never a plain resend", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const guardedHerdr = fakeTickHerdr({ guardSupport: true, agents: { obs: observer({ inputGuard: "guard-1" }), impl: implementor({ status: "blocked" }) } });
  const sent = tick(index, guardedHerdr, T0 + MIN);
  assert.equal(sent.runs[0].action, "sent");
  assert.equal(guardedHerdr.prompts[0].guard, "guard-1");
  assert.equal(readIndex(index).entries[0].lastWake.path, "guarded");
  assert.equal(readIndex(index).entries[0].lastObservation.guardedPrompt, true);

  const index2 = indexFile();
  enrollRun(index2, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const refusingHerdr = fakeTickHerdr({ guardSupport: false, agents: { obs: observer({ inputGuard: "guard-1" }), impl: implementor({ status: "blocked" }) } });
  const failed = tick(index2, refusingHerdr, T0 + MIN);
  assert.equal(failed.runs[0].action, "failed");
  assert.equal(refusingHerdr.prompts.length, 0, "no unguarded fallback");
  const entry = readIndex(index2).entries[0];
  assert.equal(entry.lastWake.code, "guarded_prompt_unsupported");
  assert.match(entry.lastFailure.detail, /guarded_prompt_unsupported/);
});

test("B12: when herdr is not answering, the tick judges from state.json, sends nothing, and says observation was impossible", () => {
  const index = indexFile();
  const run = makeSupervisedRun({ dispatchedAt: "2026-09-18T09:00:00.000Z" });
  patchState(run.statePath, (state) => { state.createdAt = "2026-09-18T09:00:00.000Z"; });
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T09:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor() } });
  herdr.state.down = true;
  const outcome = tick(index, herdr, Date.parse("2026-09-18T10:30:00.000Z"));
  assert.equal(outcome.herdr.available, false);
  assert.equal(outcome.runs[0].action, "deferred");
  assert.deepEqual(outcome.runs[0].decision.due.map((entry) => entry.reason), ["stall"], "state.json alone still yields the stall judgment");
  assert.match(outcome.runs[0].detail, /observer unobservable/);
  assert.equal(herdr.prompts.length, 0);
  assert.deepEqual(readIndex(index).lastHerdr, { available: false, detail: "socket down" });
});

test("D-09: a definite rejection retries, while unknown delivery retries only to its bound", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  herdr.herdr.promptAgent = () => ({ outcome: "rejected", path: "session-match", code: "agent_not_ready", detail: "not ready" });
  assert.equal(tick(index, herdr, T0 + MIN).runs[0].action, "failed");
  herdr.herdr.promptAgent = () => ({ outcome: "unknown", path: "session-match", code: "herdr_prompt_timeout", detail: "timeout" });
  assert.equal(tick(index, herdr, T0 + 2 * MIN).runs[0].action, "failed", "an uncertain effect is retried but never labeled sent");
  assert.equal(tick(index, herdr, T0 + 3 * MIN).runs[0].action, "failed", "one bounded retry follows an unknown outcome");
  assert.equal(tick(index, herdr, T0 + 4 * MIN).runs[0].action, "failed", "the same episode stops after the bounded retry");
});

test("D-09: definite rejections do not erase the same episode's uncertain-delivery budget", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  const outcomes = ["unknown", "rejected", "unknown", "rejected", "unknown"];
  let submissions = 0;
  herdr.herdr.promptAgent = () => {
    const outcome = outcomes[submissions++] ?? "unknown";
    return outcome === "unknown"
      ? { outcome, path: "session-match", code: "herdr_prompt_timeout", detail: "timeout" }
      : { outcome, path: "session-match", code: "agent_not_ready", detail: "not ready" };
  };
  for (let offset = 1; offset <= 5; offset += 1) tick(index, herdr, T0 + offset * MIN);
  assert.equal(submissions, 3, "two uncertain submissions plus one definite rejection exhaust the episode's automatic input budget");
  assert.equal(readIndex(index).entries[0].pendingWake.attempts, 2);
});

test("engineering 11: concurrent ticks cannot exceed one episode's uncertain-delivery budget", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  let submissions = 0;
  herdr.herdr.promptAgent = () => {
    submissions += 1;
    if (submissions === 1) {
      const reserved = readIndex(index).entries[0].pendingWake;
      assert.equal(reserved.status, "reserved", "the attempt is durable before the external submission");
      assert.equal(reserved.attempts, 1);
      assert.match(reserved.operationId, /^[0-9a-f-]{36}$/);
      const competing = [tick(index, herdr, T0 + 2 * MIN), tick(index, herdr, T0 + 3 * MIN)];
      assert.deepEqual(competing.map((result) => result.executor), ["already-running", "already-running"]);
    }
    return { outcome: "unknown", path: "session-match", code: "herdr_prompt_timeout", detail: "timeout" };
  };
  tick(index, herdr, T0 + MIN);
  tick(index, herdr, T0 + 4 * MIN);
  assert.equal(submissions, MAX_UNKNOWN_WAKE_ATTEMPTS, "a competing tick must defer instead of spending or overwriting the same delivery budget");
});

test("engineering 11: concurrent ticks cannot submit an acknowledged second episode twice", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked", stateChangeSeq: 1 }) } });
  let submissions = 0;
  herdr.herdr.promptAgent = () => {
    submissions += 1;
    if (submissions === 1) {
      herdr.state.agents.impl = implementor({ status: "blocked", stateChangeSeq: 2 });
      tick(index, herdr, T0 + 2 * MIN);
    }
    return { outcome: "accepted", path: "session-match", code: "submitted", detail: "ok" };
  };
  tick(index, herdr, T0 + MIN);
  tick(index, herdr, T0 + 3 * MIN);
  assert.equal(submissions, 2, "the second episode acknowledgment must survive the older tick's completion");
});

test("engineering 11: a handover that replaces a committed reservation sends nothing to the former Observer", () => {
  for (const guarded of [false, true]) {
    const index = indexFile();
    const run = makeSupervisedRun();
    enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
    const herdr = fakeTickHerdr({ agents: { obs: observer(guarded ? { inputGuard: "guard-old" } : {}), impl: implementor({ status: "blocked" }) }, guardSupport: guarded });
    const originalLink = fs.linkSync;
    let replaced = false;
    fs.linkSync = (...args) => {
      const temporary = String(args[0]);
      let reservation = false;
      try {
        const candidate = JSON.parse(fs.readFileSync(temporary, "utf8"));
        reservation = candidate.entries?.some((entry) => entry.pendingWake?.status === "reserved") === true;
      } catch {}
      const answer = originalLink(...args);
      if (!replaced && reservation) {
        replaced = true;
        patchState(run.statePath, (state) => {
          state.supervision.observer = observerIdentity({ sessionId: "observer-new", terminalId: "term-new", paneId: "observer-pane-new" });
        });
        herdr.state.agents.newObserver = observer({ sessionId: "observer-new", terminalId: "term-new", paneId: "observer-pane-new", inputGuard: guarded ? "guard-new" : null });
        enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: new Date(T0 + MIN).toISOString() });
      }
      return answer;
    };
    try {
      tick(index, herdr, T0 + MIN);
      assert.equal(herdr.prompts.length, 0, `the ${guarded ? "guarded" : "unguarded"} stale reservation is not executable authority`);
      assert.equal(readIndex(index).entries[0].pendingWake, null);
    } finally {
      fs.linkSync = originalLink;
    }
  }
});

test("D-09: interacting wake reasons keep independent episode acknowledgements", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  patchState(run.statePath, (state) => {
    const id = Math.max(0, ...state.events.map((event) => event.id)) + 1;
    state.events.push({ id, at: "2026-09-18T10:01:00.000Z", kind: "escalate", actor: "implementor", subject: null, summary: "review requested" });
  });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "working" }) } });
  assert.match(tick(index, herdr, T0 + 2 * MIN).runs[0].detail, /escalate/);
  assert.match(tick(index, herdr, T0 + 20 * MIN).runs[0].detail, /patrol/, "a prior escalation must not suppress patrol");
  herdr.state.agents.impl = implementor({ status: "idle", activityAt: T0 + 20 * MIN, stateChangeSeq: 9 });
  assert.match(tick(index, herdr, T0 + 21 * MIN).runs[0].detail, /settled/, "a prior patrol must not suppress a new settled episode");
  assert.equal(tick(index, herdr, T0 + 22 * MIN).runs[0].action, "none");
  assert.equal(herdr.prompts.length, 3);
});

test("a stale tick cannot acknowledge or remove a newer enrollment at the same state path", () => {
  const index = indexFile();
  const run = makeSupervisedRun();
  enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-1", recoveryOwner: "supervisor", at: "2026-09-18T10:00:00.000Z" });
  const herdr = fakeTickHerdr({ agents: { obs: observer(), impl: implementor({ status: "blocked" }) } });
  let reenrolled = false;
  tick(index, herdr, T0 + MIN, { beforePersist: () => {
    if (reenrolled) return;
    reenrolled = true;
    patchState(run.statePath, (state) => { state.supervision.runInstanceId = "instance-2"; });
    enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-2", recoveryOwner: "supervisor", at: "2026-09-18T10:00:30.000Z" });
  } });
  assert.equal(reenrolled, true);
  let entry = readIndex(index).entries[0];
  assert.equal(entry.runInstanceId, "instance-2");
  assert.equal(entry.lastWake, null, "the old tick cannot acknowledge the new enrollment");

  patchState(run.statePath, (state) => { state.status = "retired"; state.retirement = { retiredAt: "2026-09-18T10:02:00.000Z", retiredBySessionId: null }; });
  tick(index, herdr, T0 + 3 * MIN, { beforePersist: () => {
    patchState(run.statePath, (state) => { state.status = "active"; state.retirement = null; state.supervision.runInstanceId = "instance-3"; });
    enrollRun(index, { statePath: run.statePath, runInstanceId: "instance-3", recoveryOwner: "supervisor", at: "2026-09-18T10:02:30.000Z" });
  } });
  entry = readIndex(index).entries[0];
  assert.equal(entry.runInstanceId, "instance-3", "the old terminal decision cannot remove the new enrollment");
});
