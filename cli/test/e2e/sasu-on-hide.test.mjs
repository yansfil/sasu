// Actual Sasu CLI commands run as descendants of actual native Herdr panes.
// No operator HOME, server, installed app or forged capability is consulted.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PRD_PATH, STATE_PATH } from "../helpers/implement-fixture.mjs";
import { nativeHideFixture } from "../helpers/native-hide.mjs";

const success = (run) => { assert.equal(run.status, 0, run.text); assert.equal(run.json?.ok, true, run.text); return run.json; };
const delivered = (run) => success(run).result;
const PACKET = "ROLE: Implementor.\nPIPELINE: implement\nSOURCE: approved native fixture\nRETURN CONTRACT: report the current status";

test("pinned native Hide: dispatch, plan confirmation, block reply, approved handover and delivered report", async (t) => {
  const fixture = await nativeHideFixture(t), observer = await fixture.startObserver("observer");
  const started = await fixture.sasu(observer, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"]);
  success(started);
  const dispatched = success(await fixture.sasu(observer, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH], { input: PACKET }));
  const state = () => JSON.parse(fs.readFileSync(path.join(fixture.root, STATE_PATH), "utf8"));
  const recorded = state(), implementor = recorded.supervision.implementor.paneId, ids = recorded.supervision.hide;
  assert.equal(recorded.schema, "sasu.implement.state.v12.hide");
  assert.equal(recorded.pendingDispatch, null);
  assert.equal(dispatched.detail.paneId, implementor);
  const shown = success(await fixture.hide(observer, ["agent", "show", ids.implementor])).value;
  assert.equal(shown.parent, ids.observer);
  assert.equal(shown.watch.id, ids.watchId);
  assert.equal(shown.watch.parent.pane_id, observer);
  assert.equal(shown.watch.target.pane_id, implementor);
  assert.match(fs.readFileSync(path.join(fixture.runRoot, "commands", `${implementor}.pty`), "utf8"), /HIDE LETTERS:/);

  const planPath = "agents/runs/fixture/execution-plan.md";
  fs.writeFileSync(path.join(fixture.root, planPath), "Use the approved behavior, verify the native message boundary, and preserve caller authority.\n");
  const plan = success(await fixture.sasu(implementor, ["implement", "plan", "--path", planPath]));
  assert.equal(plan.detail.hide.delivery, "pending");
  assert.match(plan.message, /keep working/);
  const duplicate = success(await fixture.sasu(implementor, ["implement", "plan", "--path", planPath]));
  assert.equal(duplicate.detail.hide.requestId, plan.detail.hide.requestId);
  const planLetter = delivered(await fixture.hide(observer, ["request", "show", plan.detail.hide.requestId]));
  assert.equal(planLetter.kind, "request"); assert.equal(planLetter.waiting_answer, true);
  delivered(await fixture.hide(observer, ["request", "ack", planLetter.id]));
  const acknowledgedPlan = delivered(await fixture.hide(observer, ["request", "show", planLetter.id]));
  assert.equal(acknowledgedPlan.waiting_answer, true);
  assert.equal(acknowledgedPlan.hook_confirmed, false);
  const planAfterAck = success(await fixture.sasu(implementor, ["implement", "plan", "--path", planPath]));
  assert.equal(planAfterAck.detail.hide.requestId, planLetter.id);
  assert.equal(planAfterAck.detail.hide.delivery, "pending");
  assert.match(planAfterAck.message, /delivery is not confirmed.*keep working/);
  delivered(await fixture.hide(observer, ["request", "reply", planLetter.id, "--intent", "native-plan-confirmed", "--body", "Plan confirmed; continue"]));
  assert.equal(delivered(await fixture.hide(observer, ["request", "show", planLetter.id])).waiting_answer, false);

  const blockArgs = ["implement", "block", "--kind", "product", "--question", "Which approved behavior applies?", "--recommendation", "Use the approved behavior", "--reversible", "yes", "--scope-impact", "No scope change"];
  const block = success(await fixture.sasu(implementor, blockArgs)), blockId = block.detail.hide.requestId;
  assert.equal(block.detail.hide.delivery, "pending");
  const intake = delivered(await fixture.hide(observer, ["inbox", "--hook", "--bell"]));
  assert.ok(intake.ids.includes(blockId)); assert.match(intake.context, /Hide letter .* from impl \(claude\) \[block\]/);
  delivered(await fixture.hide(observer, ["inbox", "--confirm", blockId]));
  const answered = delivered(await fixture.hide(observer, ["request", "reply", blockId, "--intent", "native-block-answer", "--body", "Use the approved behavior"]));
  assert.equal(answered.kind, "reply");
  assert.equal(delivered(await fixture.hide(implementor, ["request", "show", blockId])).waiting_answer, false);

  const next = await fixture.startObserver("next-observer");
  const handover = success(await fixture.sasu(next, ["supervisor", "handover", "--slug", "fixture", "--approval", "The new Observer takes this watch"]));
  assert.equal(handover.detail.observer.paneId, next);
  const transferred = success(await fixture.hide(next, ["agent", "show", ids.implementor])).value;
  assert.equal(transferred.watch.id, ids.watchId); assert.equal(transferred.watch.generation, 1);
  assert.equal(transferred.watch.parent.pane_id, next);
  assert.equal(transferred.parent, ids.observer, "watch handover preserves original registration ancestry");
  const unauthorised = await fixture.hide(next, ["agent", "end", ids.implementor]);
  assert.notEqual(unauthorised.status, 0); assert.equal(unauthorised.json.error.code, "agent_authority_required");
  const beforeRetirement = fs.readFileSync(path.join(fixture.root, STATE_PATH));
  const refusedRetirement = await fixture.sasu(next, ["implement", "retire", "--slug", "fixture", "--adopt", "Retire the fixture run"]);
  assert.notEqual(refusedRetirement.status, 0);
  assert.equal(refusedRetirement.json.detail.occupancyReleased, false);
  assert.match(refusedRetirement.json.message, /agent_authority_required.*original registered parent/);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, STATE_PATH)), beforeRetirement);

  const reportArgs = ["implement", "report", "--summary", "Native contract exercised"];
  const report = success(await fixture.sasu(implementor, reportArgs)), reportId = report.detail.hide.requestId;
  assert.equal(report.detail.hide.delivery, "pending");
  assert.ok(success(await fixture.hide(next, ["agent", "show", ids.implementor])).value.watch, "send alone does not end the watch");
  const pulled = delivered(await fixture.hide(next, ["inbox", "--hook", "--bell"]));
  assert.ok(pulled.ids.includes(reportId));
  assert.ok(success(await fixture.hide(next, ["agent", "show", ids.implementor])).value.watch, "hook pull without confirmation keeps the watch");
  delivered(await fixture.hide(next, ["request", "ack", reportId]));
  const acknowledgedReport = delivered(await fixture.hide(next, ["request", "show", reportId]));
  assert.equal(acknowledgedReport.state, "acknowledged");
  assert.equal(acknowledgedReport.hook_confirmed, false);
  const reportAfterAck = success(await fixture.sasu(implementor, reportArgs));
  assert.equal(reportAfterAck.detail.hide.requestId, reportId);
  assert.equal(reportAfterAck.detail.hide.delivery, "pending");
  assert.match(reportAfterAck.message, /delivery is not confirmed/);
  assert.ok(success(await fixture.hide(next, ["agent", "show", ids.implementor])).value.watch, "acknowledgement and notice retry do not end the watch");
  assert.ok(delivered(await fixture.hide(next, ["inbox", "--hook", "--bell"])).ids.includes(reportId), "interrupted intake replays the same acknowledged report");
  delivered(await fixture.hide(next, ["inbox", "--confirm", reportId]));
  assert.equal(success(await fixture.hide(next, ["agent", "show", ids.implementor])).value.watch, null);
  const confirmedReport = delivered(await fixture.hide(next, ["request", "show", reportId]));
  assert.equal(confirmedReport.state, "acknowledged");
  assert.equal(confirmedReport.hook_confirmed, true);
  const reportAfterConfirm = success(await fixture.sasu(implementor, reportArgs));
  assert.equal(reportAfterConfirm.detail.hide.requestId, reportId);
  assert.equal(reportAfterConfirm.detail.hide.delivery, "delivered");
  assert.match(reportAfterConfirm.message, /was delivered/);
  success(await fixture.hide(implementor, ["agent", "end", ids.implementor]));
  fs.writeFileSync(path.join(fixture.runRoot, "acceptance.json"), JSON.stringify({ schema: "sasu.native-hide.acceptance.v1", dispatch: true, planDedupe: true, ackDoesNotClose: true, planAckIsUnconfirmed: true, blockReply: true, handoverGeneration: 1, originalAncestryRetained: true, refusedRetirementPreservesState: true, pendingReportKeepsWatch: true, reportAckIsUnconfirmed: true, interruptedAckIntakeReplaysSameId: true, confirmedReportEndsWatch: true, confirmedAckReportIsDelivered: true, targetMayEndItself: true }) + "\n");
});

// A lead's `hide agent spawn --parent` registers the Observer under the lead;
// dispatch re-registering it without that parent was refused (sasu#19).
test("pinned native Hide: an Observer a lead spawned dispatches under the lead's registration and watch", async (t) => {
  const fixture = await nativeHideFixture(t), lead = await fixture.startObserver("lead");
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).stdout.trim();
  const spawned = success(await fixture.hide(lead, ["agent", "spawn", "--parent", "here", "--name", "observer-spawned", "--intent", "sasu-19", "--kind", "claude", "--repo", fixture.root, "--branch", branch])).value;
  assert.ok(spawned.parent, "spawn registers the lead as parent"); assert.ok(spawned.watch, "spawn starts the lead's watch");
  const observer = spawned.pane;
  success(await fixture.sasu(observer, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"]));
  success(await fixture.sasu(observer, ["implement", "dispatch", "--name", "impl", "--prd", PRD_PATH], { input: PACKET }));
  const ids = JSON.parse(fs.readFileSync(path.join(fixture.root, STATE_PATH), "utf8")).supervision.hide;
  assert.equal(ids.observer, spawned.id);
  const kept = success(await fixture.hide(lead, ["agent", "show", spawned.id])).value;
  assert.equal(kept.registered, true); assert.equal(kept.parent, spawned.parent);
  assert.equal(kept.watch.id, spawned.watch.id); assert.equal(kept.watch.parent.pane_id, lead);
  const implementor = success(await fixture.hide(observer, ["agent", "show", ids.implementor])).value;
  assert.equal(implementor.parent, spawned.id); assert.equal(implementor.watch.id, ids.watchId); assert.equal(implementor.watch.parent.pane_id, observer);
});
