import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HIDE_MISSING, HideCallFailed, checkObserver, runHide, sameExecution, sendRunNotice, showParticipant } from "../../dist/implement/hide.js";
function binary(t, answer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hide-contract-")); const old = process.env.PATH;
  fs.writeFileSync(path.join(root, "hide"), `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(path.join(root, "argv"))},JSON.stringify(process.argv.slice(2))+"\\n");${answer}\n`, { mode: 0o755 });
  process.env.PATH = root;
  t.after(() => { process.env.PATH = old; fs.rmSync(root, { recursive: true, force: true }); });
  return () => fs.readFileSync(path.join(root, "argv"), "utf8").trim().split("\n").map(JSON.parse);
}
test("missing Hide refuses before an executable fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-hide-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => runHide(["agent", "list"], { PATH: root }), (error) => error instanceof HideCallFailed && error.code === "not_installed" && error.message === HIDE_MISSING);
});
test("a registration check must positively name the exact Observer pane", (t) => {
  const argv = binary(t, `const a=process.argv.slice(2);process.stdout.write(JSON.stringify({ok:true,value:{registered:false,name:a[a.indexOf("--name")+1],pane:a[a.indexOf("--pane")+1]}}));`);
  const observer = { name: "observer", identity: { paneId: "w1:p1", runtime: "claude", sessionId: "session", terminalId: "terminal", hostScope: "socket", recordedAt: "2026-10-03T00:00:00.000Z" } };
  checkObserver(observer);
  assert.deepEqual(argv()[0].slice(0, 3), ["agent", "register", "--check"]);
});
test("a malformed successful check cannot grant caller authority", (t) => {
  binary(t, `process.stdout.write(JSON.stringify({ok:true,value:{registered:false,name:"observer",pane:"w1:p2"}}));`);
  assert.throws(() => checkObserver({ name: "observer", identity: { paneId: "w1:p1", runtime: "claude", sessionId: "session", terminalId: "terminal", hostScope: "socket", recordedAt: "2026-10-03T00:00:00.000Z" } }), /unusable registration check/);
});
test("Pending report remains unconfirmed and uses the public envelope and argv", (t) => {
  const argv = binary(t, `const a=process.argv.slice(2);process.stdout.write(JSON.stringify({type:"workspace_result",ok:true,result:{id:"letter-1",intent:a[a.indexOf("--intent")+1],state:"pending"}}));`);
  const first = sendRunNotice("run", { observer: "parent", implementor: "child" }, "report", "done");
  const retry = sendRunNotice("run", { observer: "parent", implementor: "child" }, "report", "done");
  assert.equal(first.delivery, "pending"); assert.equal(first.intent, retry.intent);
  assert.deepEqual(argv()[0], ["request", "send", "parent", "--kind", "report", "--intent", first.intent, "--body", "done"]);
});
test("plan sends an ordinary request with durable intent", (t) => {
  const argv = binary(t, `const a=process.argv.slice(2);process.stdout.write(JSON.stringify({type:"workspace_result",ok:true,result:{id:"letter-2",intent:a[a.indexOf("--intent")+1],state:"delivered"}}));`);
  const sent = sendRunNotice("run", { observer: "parent", implementor: "child" }, "plan", "plan");
  assert.equal(sent.delivery, "delivered"); assert.equal(argv()[0][4], "request");
});
test("delivery refusal carries reason and next action", (t) => {
  binary(t, `process.stdout.write(JSON.stringify({ok:false,reason:"native_identity_required",next_action:"Retry from the actual agent pane"}));process.exit(1);`);
  assert.throws(() => sendRunNotice("run", { observer: "parent", implementor: "child" }, "block", "question"), /native_identity_required.*Retry from the actual agent pane/);
});
test("a malformed participant view cannot imply an ended watch", (t) => {
  binary(t, `process.stdout.write(JSON.stringify({ok:true,value:{id:"agent",name:"impl"}}));`);
  assert.throws(() => showParticipant("agent"), /unusable participant/);
});
test("pane and session bind an execution across terminal rotation", () => {
  const identity = { machine: "local", hostScope: "socket", pane: "w1:p1", session: "s1", instance: "term-1" };
  assert.equal(sameExecution(identity, { ...identity, instance: "term-2" }), true);
  for (const changed of [{ session: "s2" }, { pane: "w1:p2" }, { hostScope: "other" }, { machine: "remote" }]) assert.equal(sameExecution(identity, { ...identity, ...changed }), false);
});
