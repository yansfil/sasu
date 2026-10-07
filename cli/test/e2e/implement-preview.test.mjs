import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CLI, git, isolatedEnv, makeProject, ok, readState, run, runAsync, runText, start, STATE_PATH } from "../helpers/implement-fixture.mjs";

// Contract: letter-735 permits a transient execution lease, never a preview
// attempt, result, evidence registration, report, or refusal history write.
function project(t, { suiteSource, commands = { test: "node suite.cjs" }, timeout = 2000 } = {}) {
  const root = makeProject({ suiteSource });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ verify: { commands, commandTimeoutMs: timeout } }));
  return root;
}
const stateText = (root) => fs.readFileSync(path.join(root, STATE_PATH), "utf8");
const preview = (root, extra = []) => run(root, ["implement", "verify", "--preview", ...extra]);
const amendExclude = (root, id) => ok(run(root, ["implement", "amend", "--exclude-suite", id, "--approval", "TEST: approved suite exclusion", "--reason", "Test approved exclusion"]));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(message);
}

test("preview executes every sealed suite after a failure, returns full output, and restores exact state bytes", (t) => {
  const root = project(t, {
    suiteSource: "process.stdout.write('first:' + 'x'.repeat(20000) + ':tail'); process.stderr.write('first-error'); process.exit(9);\n",
    commands: { test: "node suite.cjs", lint: "node later.cjs" },
  });
  fs.writeFileSync(path.join(root, "later.cjs"), "console.log('LATER-SUITE'); console.error('later-error');\n");
  start(root);
  // Configuration changes cannot replace the suite sealed by start.
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ verify: { commands: { test: "node --version" } } }));
  const noncanonical = JSON.stringify(readState(root), null, 1).replaceAll("\n", "\r\n") + "\r\n";
  fs.writeFileSync(path.join(root, STATE_PATH), noncanonical);
  const result = preview(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.json.action, "verify-preview");
  assert.equal(result.json.detail.recorded, false);
  const runs = result.json.detail.results;
  assert.deepEqual(runs.map((entry) => [entry.unit.suiteCommandId, entry.exitCode]), [["S1", 9], ["S2", 0]]);
  assert.equal(runs[0].stdout, "first:" + "x".repeat(20000) + ":tail");
  assert.equal(runs[0].stderr, "first-error");
  assert.equal(runs[1].stdout, "LATER-SUITE\n");
  assert.equal(runs[1].stderr, "later-error\n");
  assert.equal(stateText(root), noncanonical);
  assert.equal(readState(root).verificationReport, null);
  assert.equal(fs.existsSync(path.join(root, "agents/runs/fixture/verification-report.json")), false);
  assert.equal(fs.existsSync(path.join(root, "agents/runs/fixture/logs")), false);
  const human = runText(root, ["implement", "verify", "--preview"]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /LATER-SUITE/);
  assert.match(human.stdout, /first-error/);
  assert.equal(stateText(root), noncanonical);
});

test("preview shares verify cwd and scrubbed environment, honors exclusions, and preserves an existing report", (t) => {
  const root = project(t, {
    suiteSource: "require('node:fs').writeFileSync('agents/observed-env.json', JSON.stringify({cwd:process.cwd(),env:process.env})); console.log('ENV-OBSERVED');\n",
    commands: { test: "node suite.cjs", lint: "node excluded.cjs" },
  });
  fs.writeFileSync(path.join(root, "excluded.cjs"), "throw new Error('excluded command ran');\n");
  start(root);
  amendExclude(root, "S2");
  const env = { PREVIEW_PRIVATE_SECRET: "must-not-reach-suite" };
  ok(run(root, ["implement", "verify"], { env }));
  const observed = () => JSON.parse(fs.readFileSync(path.join(root, "agents/observed-env.json"), "utf8"));
  const real = observed();
  const before = stateText(root);
  const report = readState(root).verificationReport;
  const reports = [report.jsonPath, report.markdownPath].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const result = ok(run(root, ["implement", "verify", "--preview"], { env }));
  assert.equal(result.detail.results.length, 1);
  assert.equal(result.detail.results[0].unit.cwd, ".");
  assert.equal(result.detail.results[0].unit.suiteCommandId, "S1");
  const diagnostic = observed();
  assert.equal(diagnostic.cwd, fs.realpathSync(root));
  assert.equal(diagnostic.env.PREVIEW_PRIVATE_SECRET, undefined);
  assert.equal(diagnostic.env.CI, "1");
  assert.equal(diagnostic.env.NO_COLOR, "1");
  assert.equal(diagnostic.env.HOME, path.join(fs.realpathSync(root), "agents/runs/fixture/suite-runtime/home"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    assert.equal(diagnostic.env[key], result.detail.results[0].tmpdir);
    assert.equal(fs.existsSync(diagnostic.env[key]), false);
    delete real.env[key]; delete diagnostic.env[key];
  }
  assert.deepEqual(diagnostic, real);
  assert.equal(stateText(root), before);
  assert.deepEqual([report.jsonPath, report.markdownPath].map((file) => fs.readFileSync(path.join(root, file), "utf8")), reports);
  // A completely excluded suite has no commands, not a new PASS verdict.
  amendExclude(root, "S1");
  const emptyBefore = stateText(root);
  const empty = ok(preview(root));
  assert.deepEqual(empty.detail.results, []);
  assert.match(empty.message, /no required suite commands/);
  assert.equal(stateText(root), emptyBefore);
});

test("preview uses the configured timeout and still runs the later command", (t) => {
  const root = project(t, { suiteSource: "console.log('BEFORE-TIMEOUT'); setInterval(() => {}, 1000);\n", commands: { test: "node suite.cjs", lint: "node later.cjs" }, timeout: 250 });
  fs.writeFileSync(path.join(root, "later.cjs"), "console.log('AFTER-TIMEOUT');\n");
  start(root);
  const before = stateText(root);
  const result = preview(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const [timed, later] = result.json.detail.results;
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, 124);
  assert.match(timed.stdout, /BEFORE-TIMEOUT/);
  assert.match(timed.stderr, /timed out after 250ms/);
  assert.equal(later.stdout, "AFTER-TIMEOUT\n");
  assert.equal(later.exitCode, 0);
  assert.equal(stateText(root), before);
});

test("preview reports source mutation without recording a verification result", (t) => {
  const root = project(t, { suiteSource: "require('node:fs').writeFileSync('implementation.txt','suite rewrote source');\n" });
  start(root);
  const before = stateText(root);
  const result = preview(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.json.detail.results[0].mutatedTree, true);
  assert.notEqual(result.json.detail.treeMoved, null);
  assert.equal(stateText(root), before);
});

test("preview argument refusals do not append normal verify refusal records", (t) => {
  const root = project(t);
  start(root);
  const before = stateText(root);
  for (const flags of [["--preview=false"], ["--issuer", "bogus"], ["--slug"], ["--state"], ["--reason", "unsupported"], ["--correction-budget", "2"], ["extra"]]) {
    const result = preview(root, flags);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(stateText(root), before, `preview refusal changed state: ${flags}`);
  }
});

test("preview holds the shared lease, refuses overlap without writes, and preserves independent refusal history", async (t) => {
  const root = project(t, { suiteSource: "const fs=require('node:fs'); fs.writeFileSync('agents/ready',String(process.pid)); const timer=setInterval(()=>{if(fs.existsSync('agents/release')){clearInterval(timer); console.log('RELEASED');}},20);\n", timeout: 10000 });
  start(root);
  const before = readState(root);
  const running = runAsync(root, ["implement", "verify", "--preview"]);
  t.after(() => { if (running.child.exitCode === null) running.child.kill("SIGKILL"); });
  await waitFor(() => fs.existsSync(path.join(root, "agents/ready")), "preview child never became ready");
  const active = readState(root).activeVerification;
  assert.equal(active.mode, "preview");
  assert.equal(active.attemptId, undefined);
  assert.ok(active.executionPids.includes(Number(fs.readFileSync(path.join(root, "agents/ready"), "utf8"))));
  assert.deepEqual(readState(root).verificationAttempts, before.verificationAttempts);
  const held = stateText(root);
  const overlap = preview(root);
  assert.equal(overlap.status, 2);
  assert.match(overlap.json.message, /verification still active: preview/);
  assert.equal(stateText(root), held);
  const status = ok(run(root, ["implement", "status"]));
  assert.equal(status.detail.activeVerification.mode, "preview");
  assert.equal(stateText(root), held);
  const refused = run(root, ["implement", "retire", "--reason", "must wait for preview"]);
  assert.notEqual(refused.status, 0);
  const refusalState = readState(root);
  assert.equal(refusalState.verbs.length, before.verbs.length + 1);
  assert.equal(refusalState.verbs.at(-1).verb, "retire");
  assert.equal(refusalState.verbs.at(-1).outcome, "rejected");
  fs.writeFileSync(path.join(root, "agents/release"), "release\n");
  const result = await running.done;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  delete refusalState.activeVerification;
  assert.deepEqual(readState(root), refusalState, "cleanup must retain the other command's refusal and timestamp");
});

test("preview refuses a live real verification without touching its attempt or lease", async (t) => {
  const root = project(t, { suiteSource: "const fs=require('node:fs'); fs.writeFileSync('agents/ready','ready'); const timer=setInterval(()=>{if(fs.existsSync('agents/release'))clearInterval(timer);},20);\n", timeout: 10000 });
  start(root);
  const running = runAsync(root, ["implement", "verify"]);
  t.after(() => { if (running.child.exitCode === null) running.child.kill("SIGKILL"); });
  await waitFor(() => fs.existsSync(path.join(root, "agents/ready")), "verify child never became ready");
  const before = stateText(root);
  const result = preview(root);
  assert.equal(result.status, 2);
  assert.match(result.json.message, /verification lease exists/);
  assert.equal(stateText(root), before);
  fs.writeFileSync(path.join(root, "agents/release"), "release\n");
  const finished = await running.done;
  assert.equal(finished.status, 0, finished.stdout + finished.stderr);
});

for (const mode of ["preview", "verify"]) {
  test(`${mode} execution blocks status and standalone delivery until its lease closes`, async (t) => {
    // The report must come from a real committed verification. Only ignored
    // control files change between the PASS and the blocked execution.
    const root = project(t, {
      suiteSource: "const fs=require('node:fs'); if(fs.existsSync('agents/block')){fs.writeFileSync('agents/ready',String(process.pid)); const timer=setInterval(()=>{if(fs.existsSync('agents/release')){clearInterval(timer); console.log('RELEASED');}},20);} else console.log('VERIFIED');\n",
      timeout: 15000,
    });
    start(root);
    git(root, ["add", "implementation.txt"]);
    git(root, ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Implement fixture"]);
    ok(run(root, ["implement", "verify"]));
    const before = stateText(root);
    const report = readState(root).verificationReport;
    const reports = [report.jsonPath, report.markdownPath].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
    const bin = path.join(root, "agents/bin");
    fs.mkdirSync(bin, { recursive: true });
    // Standalone delivery resolves the real built CLI, never a status double.
    fs.writeFileSync(path.join(bin, "sasu"), `#!/usr/bin/env node\nrequire(${JSON.stringify(CLI)});\n`, { mode: 0o755 });
    const ship = () => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../../../skills/ship/scripts/prd_ship.js"), "local", "--state", path.join(root, STATE_PATH), "--no-gpg-sign"], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: isolatedEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
    });
    assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, true);
    const initialShip = ship();
    assert.equal(initialShip.status, 0, initialShip.stderr + initialShip.stdout);
    const deliveryPath = path.join(root, "agents/runs/fixture/delivery/delivery-result.json");
    const deliveryBefore = fs.readFileSync(deliveryPath, "utf8");
    fs.writeFileSync(path.join(root, "agents/block"), "block\n");
    const running = runAsync(root, ["implement", "verify", ...(mode === "preview" ? ["--preview"] : [])]);
    let during, duringShip, held, finished;
    try {
      await waitFor(() => fs.existsSync(path.join(root, "agents/ready")), `${mode} child never became ready`);
      held = stateText(root);
      during = ok(run(root, ["implement", "status"]));
      assert.equal(during.detail.activeVerification.pid, running.child.pid);
      assert.ok(during.detail.activeVerification.executionPids.includes(Number(fs.readFileSync(path.join(root, "agents/ready"), "utf8"))));
      duringShip = ship();
      const summary = runText(root, ["implement", "status"]);
      assert.equal(summary.status, 0, summary.stderr);
      assert.match(summary.stdout, /Next: wait for verification execution to finish, then check status/);
      assert.equal(stateText(root), held, "status and delivery checks must not change the held run record");
      assert.equal(fs.readFileSync(deliveryPath, "utf8"), deliveryBefore);
    } finally {
      fs.writeFileSync(path.join(root, "agents/release"), "release\n");
      finished = await running.done;
    }
    assert.equal(finished.status, 0, finished.stdout + finished.stderr);
    assert.deepEqual({ eligible: during.detail.delivery.eligible, shipExit: duringShip.status }, { eligible: false, shipExit: 1 }, duringShip.stderr + duringShip.stdout);
    assert.match(during.detail.delivery.reasons.join("; "), /execution is active/);
    assert.match(duringShip.stderr, /execution is active/);
    assert.equal(ok(run(root, ["implement", "status"])).detail.delivery.eligible, true);
    const afterShip = ship();
    assert.equal(afterShip.status, 0, afterShip.stderr + afterShip.stdout);
    if (mode === "preview") {
      assert.equal(during.detail.verification.verdict, "PASS", "preview does not replace the recorded verdict");
      assert.equal(stateText(root), before, "preview completion restores the exact prior record");
      assert.deepEqual([report.jsonPath, report.markdownPath].map((file) => fs.readFileSync(path.join(root, file), "utf8")), reports);
    }
  });
}
