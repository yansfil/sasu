import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(import.meta.dirname, "../../dist/hcoord/cli.js");
const ADAPTER = path.resolve(import.meta.dirname, "../../../examples/hcoord/channel-adapter.mjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("coordinator keeps a request identity, answer, cancellation, and watch cycle through restart", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcoord-e2e-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const target=process.argv[4];
if(process.argv[2]==='agent' && process.argv[3]==='get') {
  const row=target==='parent-pane'?{name:'parent',session:'one',instance:'a'}:target==='child-pane'?{name:'child',session:'two',instance:'b'}:target?.endsWith('-pane') && fs.existsSync(path.join(process.env.HOME,target+'.started'))?{name:target.slice(0,-5),session:target+'-session',instance:target+'-instance'}:null;
  if(!row){process.stderr.write(JSON.stringify({error:{code:'agent_not_found'}}));process.exitCode=1;}
  else process.stdout.write(JSON.stringify({result:{type:'agent_info',agent:{pane_id:target,name:row.name,agent:'codex',agent_session:{value:row.session},terminal_id:row.instance,agent_status:'idle',input_guard:process.env.HCOORD_FAKE_GUARD==='1'?'test-guard':undefined}}}));
} else if(process.argv[2]==='pane' && process.argv[3]==='get') {
  process.stdout.write(JSON.stringify({result:{type:'pane_info',pane:{workspace_id:'test-workspace',cwd:process.env.HOME}}}));
} else if(process.argv[2]==='tab' && process.argv[3]==='create') {
  const label=process.argv[process.argv.indexOf('--label')+1], marker=path.join(process.env.HOME,label+'.tab');
  if(fs.existsSync(marker)){process.stderr.write('duplicate tab');process.exitCode=9;}
  else {fs.writeFileSync(marker,'1');process.stdout.write(JSON.stringify({result:{root_pane:{pane_id:label+'-pane'}}}));}
} else if(process.argv[2]==='agent' && process.argv[3]==='start') {
  const name=process.argv[4], pane=process.argv[process.argv.indexOf('--pane')+1];
  fs.writeFileSync(path.join(process.env.HOME,pane+'.started'),'1');
  process.stdout.write(JSON.stringify({result:{agent:{name,pane_id:pane}}}));
} else if(process.argv[2]==='agent' && process.argv[3]==='prompt') {
  if(process.argv[4]==='--help') process.stdout.write('Usage: herdr agent prompt <TARGET> <TEXT>'+(process.env.HCOORD_FAKE_GUARD==='1'?' --expected-input-guard <GUARD>':''));
  else if(process.env.HCOORD_FAKE_GUARD==='1' && process.argv[process.argv.indexOf('--expected-input-guard')+1]==='test-guard') {
    fs.appendFileSync(path.join(process.env.HOME,'guarded-prompts.jsonl'),JSON.stringify({target:process.argv[4],text:process.argv[5]})+'\\n');
    process.stdout.write(JSON.stringify({result:{outcome:'submitted'}}));
  } else {fs.writeFileSync(path.join(process.env.HOME,'UNSAFE_PROMPT'),'1');process.stderr.write('unexpected unguarded prompt');process.exitCode=9;}
} else if(process.argv[2]==='notification' && process.argv[3]==='show') {
  fs.writeFileSync(path.join(process.env.HOME,'notification-args.json'),JSON.stringify(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({result:{outcome:'shown'}}));
} else {process.stderr.write('unexpected Herdr operation');process.exitCode=9;}
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.HERDR_SOCKET_PATH;
  let daemon = null;
  const start = async () => {
    daemon = spawn(process.execPath, [CLI, "daemon", "run"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    daemon.stderr.on("data", (chunk) => { error += chunk; });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (fs.existsSync(path.join(home, ".hcoord", "api.sock"))) return;
      if (daemon.exitCode !== null) throw new Error(`daemon exited: ${error}`);
      await wait(20);
    }
    throw new Error(`daemon did not create socket: ${error}`);
  };
  const stop = async () => {
    if (!daemon) return;
    const old = daemon;
    if (old.exitCode === null) {
      old.kill("SIGTERM");
      await new Promise((resolve) => old.once("exit", resolve));
    }
    daemon = null;
  };
  t.after(async () => { await stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const command = (...args) => spawnSync(process.execPath, [CLI, ...args, "--json"], { env, encoding: "utf8" });
  const ok = (...args) => {
    const result = command(...args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr} ${result.stdout}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    return parsed.value;
  };
  await start();
  assert.equal(fs.statSync(path.join(home, ".hcoord", "api.sock")).mode & 0o777, 0o600);
  assert.equal(ok("daemon", "status").platform.macos.localSocket, "verified_isolated");
  const parent = ok("agent", "register", "--machine", "local", "--session", "one", "--instance", "a", "--name", "parent", "--pane", "parent-pane");
  const child = ok("agent", "register", "--machine", "local", "--session", "two", "--instance", "b", "--name", "child", "--parent", parent.id, "--pane", "child-pane");
  ok("sasu", "enable");
  const sasuArgs = ["sasu", "register", "--run", "run-one", "--project", home, "--observer-name", "parent", "--observer-pane", "parent-pane", "--observer-session", "one", "--observer-instance", "a", "--implementor-name", "child", "--implementor-pane", "child-pane", "--implementor-session", "two", "--implementor-instance", "b"];
  const registeredRun = ok(...sasuArgs);
  assert.equal(registeredRun.owner, "hcoord");
  assert.equal(ok(...sasuArgs).watch.generation, registeredRun.watch.generation);
  assert.equal(ok("status").counts.sasuRuns, 1);
  assert.ok(ok("status").usage.ledgerBytes > 0);
  const spawned = ok("agent", "spawn", "--parent", parent.id, "--machine", "local", "--session", "one", "--name", "worker", "--intent", "spawn-1");
  assert.equal(spawned.participant.parent, parent.id);
  assert.equal(spawned.watch.observer, parent.id);
  assert.equal(ok("agent", "spawn", "--parent", parent.id, "--machine", "local", "--session", "one", "--name", "worker", "--intent", "spawn-1").participant.id, spawned.participant.id);
  assert.equal(fs.readFileSync(path.join(home, "worker.tab"), "utf8"), "1");
  const unobserved = ok("agent", "spawn", "--parent", parent.id, "--machine", "local", "--session", "one", "--name", "solo", "--intent", "spawn-2", "--no-watch");
  assert.equal(unobserved.watch, null);
  assert.equal(ok("graph").creation.find((edge) => edge.child === unobserved.participant.id).parent, parent.id);
  const sent = ok("request", "send", "--from", child.id, "--to", "human", "--intermediary", parent.id, "--body", "Which option?", "--intent", "choice-1");
  assert.equal(ok("request", "send", "--from", child.id, "--to", "human", "--intermediary", parent.id, "--body", "Which option?", "--intent", "choice-1").id, sent.id);
  assert.equal(command("request", "send", "--from", child.id, "--to", "human", "--body", "Other?", "--intent", "choice-1").status, 1);
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(home, "notification-args.json")); attempt += 1) await wait(100);
  assert.equal(fs.existsSync(path.join(home, "notification-args.json")), true);
  assert.equal(fs.readFileSync(path.join(home, "notification-args.json"), "utf8").includes("Which option?"), false);
  const answered = ok("request", "reply", sent.id, "--body", "A, not B", "--as", "human", "--recorded-by", parent.id);
  assert.equal(answered.answer, "A, not B");
  assert.equal(answered.recordedBy, parent.id);
  assert.equal(ok("inbox").find((item) => item.requestId === sent.id).kind, "relay_problem");
  ok("request", "relay", sent.id, "--body", "A", "--actor", parent.id);
  assert.equal(ok("inbox").some((item) => item.requestId === sent.id && item.kind === "relay_problem"), false);
  const canceled = ok("request", "send", "--from", child.id, "--to", "human", "--body", "Cancel this?", "--intent", "choice-2");
  ok("request", "cancel", canceled.id, "--actor", child.id);
  const late = ok("request", "reply", canceled.id, "--body", "Late A", "--as", "human");
  assert.equal(late.status, "canceled");
  assert.equal(late.lateAnswers.length, 1);
  assert.equal(late.lateAnswers[0].recordedBy, "human");
  const adapterRequest = ok("request", "send", "--from", child.id, "--to", "human", "--body", "Adapter question", "--intent", "adapter-1");
  const adapter = (...args) => spawnSync(process.execPath, [ADAPTER, ...args], { env, encoding: "utf8" });
  const notice = adapter("notify-only", adapterRequest.id);
  assert.equal(notice.status, 0, notice.stderr);
  assert.match(JSON.parse(notice.stdout).replyPath, /hcoord request reply/);
  assert.equal(notice.stdout.includes("Adapter question"), false);
  const callback = adapter("reply", adapterRequest.id, "Approved A");
  assert.equal(callback.status, 0, callback.stderr);
  assert.equal(ok("request", "show", adapterRequest.id).answer, "Approved A");
  assert.equal(adapter("reply", adapterRequest.id, "Changed answer").status, 1);
  assert.equal(ok("request", "show", adapterRequest.id).answer, "Approved A");
  ok("watch", "start", child.id, "--observer", parent.id, "--interval", "1s");
  let watch;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    watch = ok("watch", "list").find((item) => item.target === child.id);
    if (watch?.cycle) break;
    await wait(100);
  }
  assert.ok(watch.cycle);
  const cycleRequestId = ok("events").events.find((item) => item.type === "watch.cycle").detail.requestId;
  let cycleRequest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    cycleRequest = ok("request", "show", cycleRequestId);
    if (cycleRequest.deliveries[0].status === "deferred") break;
    await wait(100);
  }
  assert.equal(cycleRequest.deliveries[0].status, "deferred");
  assert.match(cycleRequest.deliveries[0].reason, /input guard is absent/);
  assert.equal(fs.existsSync(path.join(home, "UNSAFE_PROMPT")), false);
  ok("watch", "check", child.id, "--cycle", watch.cycle, "--actor", parent.id);
  assert.equal(ok("watch", "list").find((item) => item.target === child.id).cycle, null);
  assert.equal(command("watch", "assign", child.id, "--observer", parent.id, "--actor", "human").status, 1);
  assert.equal(command("watch", "assign", child.id, "--observer", parent.id, "--actor", "human", "--expected-generation", "0").status, 1);
  assert.equal(ok("watch", "assign", child.id, "--observer", parent.id, "--actor", "human", "--expected-generation", "2").generation, 3);
  await stop();
  const stale = ok("request", "show", sent.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.data.answer, "A, not B");
  assert.equal(command("request", "send", "--from", child.id, "--to", "human", "--body", "No service", "--intent", "choice-3").status, 1);
  env.HCOORD_FAKE_GUARD = "1";
  await start();
  assert.equal(ok("request", "show", sent.id).answer, "A, not B");
  assert.equal(ok("graph").creation.find((edge) => edge.child === child.id).parent, parent.id);
  const guarded = ok("request", "send", "--from", child.id, "--to", parent.id, "--body", "Guarded question", "--intent", "guarded-1");
  let accepted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    accepted = ok("request", "show", guarded.id);
    if (accepted.deliveries[0].status === "accepted") break;
    await wait(100);
  }
  assert.equal(accepted.deliveries[0].status, "accepted");
  assert.equal(accepted.status, "open", "Herdr acceptance is not a request answer");
  const acknowledged = ok("request", "ack", guarded.id, "--actor", parent.id);
  assert.equal(acknowledged.deliveries[0].status, "acknowledged");
  assert.equal(ok("request", "ack", guarded.id, "--actor", parent.id).deliveries[0].status, "acknowledged");
  const promptCount = () => fs.readFileSync(path.join(home, "guarded-prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.text.includes(guarded.id)).length;
  assert.equal(promptCount(), 1);
  await stop();
  await start();
  await wait(1100);
  assert.equal(promptCount(), 1, "restart does not repeat an accepted external submission");
  assert.equal(ok("daemon", "stop").stopped, true);
  for (let attempt = 0; attempt < 250 && daemon.exitCode === null; attempt += 1) await wait(20);
  assert.notEqual(daemon.exitCode, null);
  const manuallyStopped = command("daemon", "run");
  assert.equal(manuallyStopped.status, 1);
  assert.equal(JSON.parse(manuallyStopped.stdout).error.code, "manual_stop");
});
