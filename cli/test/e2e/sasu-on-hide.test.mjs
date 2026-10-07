// Actual commands descend from native panes on a private server and HOME.
// Sasu prepares instructions; the Observer invokes Hide's public commands.
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

test("native Hide owns lineage, retry convergence, watches and direct letters for the sealed run", async (t) => {
  const fixture = await nativeHideFixture(t), lead = await fixture.startObserver("lead");
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).stdout.trim();
  const observerArgs = ["agent", "spawn", "--parent", "here", "--name", "observer", "--intent", "native-observer", "--kind", "claude", "--repo", fixture.root, "--branch", branch, "--path", fixture.root];
  const parent = success(await fixture.hide(lead, observerArgs)).value;
  assert.ok(parent.parent); assert.ok(parent.watch);
  const observer = parent.pane;
  success(await fixture.sasu(observer, ["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"]));
  const prepared = success(await fixture.sasu(observer, ["implement", "dispatch", "--name", "impl"], { input: PACKET })).detail;
  const state = () => JSON.parse(fs.readFileSync(path.join(fixture.root, STATE_PATH), "utf8"));
  assert.equal(state().schema, "sasu.implement.state.v13.contract-only");
  for (const key of ["ownerSessionId", "supervision", "pendingDispatch", "dispatches"]) assert.equal(key in state(), false);
  assert.equal(success(await fixture.hide(observer, ["agent", "list"])).value.items.some((item) => item.name === "impl"), false, "preparation never starts a process");
  const child = success(await fixture.hide(observer, prepared.argv)).value;
  assert.equal(child.parent, parent.id);
  assert.equal(child.watch.parent.pane_id, observer);
  assert.equal(child.watch.target.pane_id, child.pane);
  const nativeArgs = fs.readFileSync(path.join(fixture.runRoot, "commands", `${child.pane}.argv`), "utf8").split("\0").filter(Boolean);
  assert.ok(nativeArgs.includes(prepared.prompt), "first prompt is one native argument");
  assert.equal(nativeArgs[nativeArgs.indexOf("--effort") + 1], "high");
  assert.match(fs.readFileSync(prepared.promptPath, "utf8"), /hide request send/);

  const repeated = success(await fixture.sasu(observer, ["implement", "dispatch"], { env: { CODEX_THREAD_ID: "after-compaction" } })).detail;
  assert.equal(repeated.reused, true);
  assert.deepEqual(repeated.argv, prepared.argv);
  const sameChild = success(await fixture.hide(observer, repeated.argv)).value;
  assert.equal(sameChild.id, child.id); assert.equal(sameChild.pane, child.pane);
  const keptParent = success(await fixture.hide(lead, ["agent", "show", parent.id])).value;
  assert.equal(keptParent.parent, parent.parent); assert.equal(keptParent.watch.id, parent.watch.id);

  for (const args of [["gate", "gap-audit", "--slug", "fixture", "--qa-log", "missing.md"], ["implement", "escalate", "--intent", "child-escape", "--reason", "blocked"]]) {
    const refused = await fixture.sasu(child.pane, args);
    assert.notEqual(refused.status, 0, refused.text);
    assert.match(refused.text, /run child in Hide/);
  }

  const block = delivered(await fixture.hide(child.pane, ["request", "send", parent.id, "--intent", "native-block", "--kind", "block", "--body", "Which approved behavior applies?"]));
  const inbox = delivered(await fixture.hide(observer, ["inbox", "--hook", "--bell"]));
  assert.ok(inbox.ids.includes(block.id));
  delivered(await fixture.hide(observer, ["request", "reply", block.id, "--intent", "native-answer", "--body", "Use the sealed behavior"]));
  assert.equal(delivered(await fixture.hide(child.pane, ["request", "show", block.id])).waiting_answer, false);

  const advice = success(await fixture.sasu(observer, ["implement", "escalate", "--intent", "diagnose", "--reason", "Inspect the failed product flow"])).detail;
  const advisor = success(await fixture.hide(observer, advice.argv)).value;
  assert.equal(advisor.parent, parent.id); assert.ok(advisor.watch);
  const answer = delivered(await fixture.hide(advisor.pane, ["request", "send", parent.id, "--intent", "diagnosis-report", "--kind", "report", "--body", "Observed the boundary; retry the sealed suite"]));
  assert.ok(delivered(await fixture.hide(observer, ["inbox", "--hook", "--bell"])).ids.includes(answer.id));
  delivered(await fixture.hide(observer, ["inbox", "--confirm", answer.id]));
  assert.equal(success(await fixture.hide(observer, ["agent", "show", advisor.id])).value.watch, null);

  const report = delivered(await fixture.hide(child.pane, ["request", "send", parent.id, "--intent", "native-report", "--kind", "report", "--body", "Native flow checked"]));
  delivered(await fixture.hide(observer, ["request", "ack", report.id]));
  assert.ok(success(await fixture.hide(observer, ["agent", "show", child.id])).value.watch, "ack alone does not claim delivery");
  assert.ok(delivered(await fixture.hide(observer, ["inbox", "--hook", "--bell"])).ids.includes(report.id));
  delivered(await fixture.hide(observer, ["inbox", "--confirm", report.id]));
  assert.equal(success(await fixture.hide(observer, ["agent", "show", child.id])).value.watch, null);
  assert.equal(state().escalations.length, 1);
  fs.writeFileSync(path.join(fixture.runRoot, "acceptance.json"), JSON.stringify({ schema: "sasu.native-hide.acceptance.v2", printOnlyDispatch: true, nativePrompt: true, sameIntentSameChild: true, nestedObserverLineage: true, childRolesRefused: true, directBlockReply: true, visibleAdvisor: true, confirmedReportEndsWatch: true }) + "\n");
});
