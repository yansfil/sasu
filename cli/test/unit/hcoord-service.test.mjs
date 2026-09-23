import assert from "node:assert/strict";
import test from "node:test";
import { emptyLedger } from "../../dist/hcoord/model.js";
import { execute } from "../../dist/hcoord/service.js";

test("an escalated human answer reaches the assigned parent and retains an unresolved relay", () => {
  const at = "2026-09-01T00:00:00.000Z";
  const state = emptyLedger(at);
  const run = (operation, args = {}, time = at) => execute(state, operation, args, time).value;
  const register = (name, instance) => run("agent.register", { machine: "local", hostScope: "default", session: name, instance, name, pane: `${name}-pane`, runtime: "idle" });
  const parent = register("parent", "one");
  const child = register("child", "two");
  const request = run("request.send", { from: child.id, to: parent.id, body: "Choose a path", intent: "choice" });
  run("request.escalate", { id: request.id, actor: parent.id });
  const answered = run("request.reply", { id: request.id, body: "Proceed with A", respondent: "human", recordedBy: "human" });
  assert.equal(answered.intermediary, parent.id);
  assert.equal(answered.deliveries.at(-1).recipient, parent.id);
  assert.equal(run("inbox").find((item) => item.requestId === request.id).kind, "relay_problem");
  const reminderAt = "2026-09-01T00:15:01.000Z";
  run("tick", {}, reminderAt);
  assert.equal(state.requests[request.id].relayRemindedAt, reminderAt);
  const escalationAt = "2026-09-01T00:30:01.000Z";
  run("tick", {}, escalationAt);
  assert.equal(state.requests[request.id].relayEscalatedAt, escalationAt);
  assert.equal(state.requests[request.id].deliveries.filter((delivery) => delivery.recipient === "human").length, 2);
  run("tick", {}, "2026-09-01T00:31:01.000Z");
  assert.equal(state.requests[request.id].deliveries.filter((delivery) => delivery.recipient === "human").length, 2, "one reminder episode does not create repeated human notifications");
  run("request.relay", { id: request.id, actor: parent.id, body: "Proceed with A" });
  assert.equal(state.requests[request.id].deliveries.at(-1).recipient, child.id);
  assert.equal(run("inbox").some((item) => item.requestId === request.id && item.kind === "relay_problem"), false);
});

test("a restart coalesces overdue reminders and an expired empty event history rejects old cursors", () => {
  const at = "2026-09-01T00:00:00.000Z";
  const state = emptyLedger(at);
  const run = (operation, args = {}, time = at) => execute(state, operation, args, time).value;
  const sender = run("agent.register", { machine: "local", hostScope: "default", session: "s", instance: "i", name: "sender", pane: "p", runtime: "idle" });
  const request = run("request.send", { from: sender.id, to: "human", body: "Choose", intent: "one" });
  const lateTick = "2026-09-01T00:31:00.000Z";
  run("tick", {}, lateTick);
  assert.equal(state.requests[request.id].remindedAt, lateTick);
  assert.equal(state.requests[request.id].escalatedAt, lateTick);
  assert.equal(state.requests[request.id].deliveries.filter((delivery) => delivery.recipient === "human").length, 2, "initial notification plus one coalesced escalation");
  assert.equal(state.events.some((entry) => entry.type === "request.reminded"), false);
  run("request.cancel", { id: request.id, actor: sender.id }, "2026-09-01T00:32:00.000Z");
  run("tick", {}, "2026-10-03T00:00:00.000Z");
  assert.equal(state.events.length, 0);
  assert.ok(state.seq > 0);
  assert.throws(() => run("events", { cursor: 0 }), { code: "cursor_expired" });
  assert.equal(run("status").eventCursor, state.seq);
});

test("caller IDs cannot address inherited records or mutate policy prototypes", () => {
  const state = emptyLedger("2026-09-01T00:00:00.000Z");
  const run = (operation, args) => execute(state, operation, args, "2026-09-01T00:00:00.000Z").value;
  assert.throws(() => run("request.send", { from: "__proto__", to: "human", body: "spoof", intent: "probe" }), { code: "not_found" });
  assert.throws(() => run("request.cancel", { id: "__proto__", actor: "human" }), { code: "not_found" });
  assert.throws(() => run("agent.show", { id: "constructor" }), { code: "not_found" });
  assert.throws(() => run("config.set", { key: "constructor", value: 1000 }), { code: "invalid_argument" });
  assert.equal(Object.prototype.status, undefined);
  assert.equal(Object.keys(state.requests).length, 0);
  const parent = run("agent.register", { machine: "local", hostScope: "default", session: "s", instance: "i", name: "parent", pane: "p", runtime: "idle" });
  const intent = run("agent.spawn.reserve", { parent: parent.id, intent: "__proto__", machine: "local", session: "s", name: "child", kind: "codex", nativeArgs: [] });
  assert.equal(run("agent.spawn.reserve", { parent: parent.id, intent: "__proto__", machine: "local", session: "s", name: "child", kind: "codex", nativeArgs: [] }).key, intent.key);
  assert.equal(Object.getPrototypeOf(state.spawnIntents), Object.prototype);
  assert.equal(Object.hasOwn(state.spawnIntents, "__proto__"), true);
});

test("watch handover preserves one unchecked cycle and graph history", () => {
  const at = "2026-09-01T00:00:00.000Z", state = emptyLedger(at);
  const run = (operation, args = {}, time = at) => execute(state, operation, args, time).value;
  const register = (name) => run("agent.register", { machine: "local", hostScope: "default", session: name, instance: name, name, pane: `${name}-pane`, runtime: "idle" });
  const target = register("target"), first = register("first"), second = register("second");
  run("watch.start", { target: target.id, observer: first.id, actor: first.id, intervalMs: 1000 });
  run("tick", {}, "2026-09-01T00:00:01.000Z");
  const cycle = state.watches[target.id].cycle;
  const original = Object.values(state.requests).find((item) => item.intent.startsWith("watch:"));
  assert.ok(original);
  assert.throws(() => run("watch.start", { target: target.id, observer: first.id, actor: first.id }), { code: "conflict" });
  const handed = run("watch.assign", { target: target.id, observer: second.id, actor: first.id, expectedGeneration: "1" }, "2026-09-01T00:00:02.000Z");
  assert.equal(handed.cycle, cycle);
  assert.equal(original.to, second.id);
  assert.equal(original.deliveries[0].status, "superseded");
  assert.equal(original.deliveries[1].recipient, second.id);
  run("tick", {}, "2026-09-01T00:00:03.000Z");
  assert.equal(Object.values(state.requests).filter((item) => item.intent.startsWith("watch:")).length, 1);
  assert.deepEqual(run("graph").watch.filter((edge) => edge.target === target.id).map((edge) => edge.status), ["stopped", "active"]);
  run("watch.check", { target: target.id, cycle, actor: second.id });
  assert.equal(original.status, "answered");
  assert.equal(original.deliveries[1].status, "superseded");
});

test("request intent checks the full routing policy and notify-only has no question", () => {
  const at = "2026-09-01T00:00:00.000Z", state = emptyLedger(at);
  const run = (operation, args = {}) => execute(state, operation, args, at).value;
  const register = (name) => run("agent.register", { machine: "local", hostScope: "default", session: name, instance: name, name, pane: `${name}-pane`, runtime: "idle" });
  const sender = register("sender"), first = register("first"), second = register("second");
  const args = { from: sender.id, to: "human", body: "A?", intent: "same", intermediary: first.id, context: "context", waiting: true };
  const original = run("request.send", args);
  assert.equal(run("request.send", args).id, original.id);
  for (const changed of [{ intermediary: second.id }, { context: "other" }, { waiting: false }, { notifyOnly: true }]) {
    assert.throws(() => run("request.send", { ...args, ...changed }), { code: "intent_conflict" });
  }
  const notice = run("request.send", { from: sender.id, to: "human", body: "Heads up", intent: "notice", notifyOnly: true });
  assert.equal(notice.requiresReply, false);
  assert.equal(run("inbox").some((item) => item.requestId === notice.id && item.kind === "question"), false);
  const escalated = run("request.send", { from: sender.id, to: first.id, body: "Decide", intent: "escalated" });
  run("request.escalate", { id: escalated.id, actor: first.id });
  run("request.reply", { id: escalated.id, body: "Yes", respondent: "human", recordedBy: "human" });
  assert.equal(escalated.intermediary, first.id);
  assert.equal(run("request.send", { from: sender.id, to: first.id, body: "Decide", intent: "escalated" }).id, escalated.id, "the original payload remains idempotent after relay ownership is assigned");
});

test("answer and relay deliveries have distinct receipts and unresolved answers survive retention", () => {
  const at = "2026-09-01T00:00:00.000Z", state = emptyLedger(at);
  const run = (operation, args = {}, time = at) => execute(state, operation, args, time).value;
  const register = (name) => run("agent.register", { machine: "local", hostScope: "default", session: name, instance: name, name, pane: `${name}-pane`, runtime: "idle" });
  const child = register("child"), parent = register("parent");
  const direct = run("request.send", { from: child.id, to: parent.id, body: "Question", intent: "direct" });
  direct.deliveries[0].status = "accepted";
  run("request.ack", { id: direct.id, actor: parent.id });
  run("request.escalate", { id: direct.id, actor: parent.id });
  run("request.reply", { id: direct.id, body: "Human answer", respondent: "human", recordedBy: "human" });
  const answerDelivery = direct.deliveries.at(-1);
  assert.equal(answerDelivery.phase, "answer");
  assert.equal(answerDelivery.recipient, parent.id);
  answerDelivery.status = "accepted";
  run("request.ack", { id: direct.id, actor: parent.id });
  assert.equal(answerDelivery.status, "acknowledged", "an earlier receipt does not hide the latest accepted delivery");
  run("request.relay", { id: direct.id, actor: parent.id, body: "Human answer" });
  const relayDelivery = direct.deliveries.at(-1);
  assert.equal(relayDelivery.phase, "relay");
  run("tick", {}, "2026-10-03T00:00:00.000Z");
  assert.ok(state.requests[direct.id], "a pending relay preserves the original answer beyond retention");
  assert.ok(direct.deliveryRemindedAt, "an undelivered child answer reminds the parent");
  assert.ok(direct.deliveryEscalatedAt, "an unresolved delivery reaches the human inbox deadline");
  assert.equal(direct.deliveries.filter((delivery) => delivery.phase === "delivery_problem").length, 2);
  relayDelivery.status = "accepted";
  run("request.ack", { id: direct.id, actor: child.id, delivery: relayDelivery.id });
  assert.equal(direct.deliveries.filter((delivery) => delivery.phase === "delivery_problem").every((delivery) => delivery.status === "superseded"), true);
  run("tick", {}, "2026-10-03T00:01:00.000Z");
  assert.equal(state.requests[direct.id], undefined);
  const childAnswer = run("request.send", { from: child.id, to: parent.id, body: "Second", intent: "direct-answer" }, "2026-10-03T00:02:00.000Z");
  run("request.reply", { id: childAnswer.id, body: "Parent answer", respondent: parent.id, recordedBy: parent.id }, "2026-10-03T00:02:01.000Z");
  assert.equal(childAnswer.deliveries[0].status, "superseded");
  assert.equal(childAnswer.deliveries[1].phase, "answer");
  assert.equal(childAnswer.deliveries[1].recipient, child.id);
});

test("retention releases ended participants and completed spawn intents without breaking the parent", () => {
  const at = "2026-09-01T00:00:00.000Z", state = emptyLedger(at);
  const run = (operation, args = {}, time = at) => execute(state, operation, args, time).value;
  const parent = run("agent.register", { machine: "local", hostScope: "default", session: "parent", instance: "parent", name: "parent", pane: "parent-pane", runtime: "idle" });
  run("agent.spawn.reserve", { parent: parent.id, intent: "completed-child", machine: "local", session: "parent", name: "child", kind: "codex", noWatch: true, nativeArgs: [] });
  run("agent.spawn.pane", { intent: "completed-child", pane: "child-pane" });
  const child = run("agent.spawn.complete", { intent: "completed-child", runtimeSession: "child", instance: "child", runtime: "done" }).participant;
  run("tick", {}, "2026-10-03T00:00:00.000Z");
  assert.equal(state.participants[child.id], undefined);
  assert.equal(state.spawnIntents["completed-child"], undefined);
  assert.ok(state.participants[parent.id]);
});
