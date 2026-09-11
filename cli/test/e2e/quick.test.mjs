// Real CLI boundary, actual commands/files/git, external judge transport stub.
// These tests prove harness behavior, never live semantic omission detection.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const CLI = path.resolve(import.meta.dirname, "../../dist/cli.js");
const CONTRACT = "---\ntopic: demo\nstatus: active\n---\n## Goal\nRender and persist a widget.\n## Acceptance Criteria\n- AC1. renders\n- AC2. persists state\n";
const PASS = { summary: "Whole contract assessed", findings: [], priorDispositions: [] };
const DEFECT = { kind: "defect", requirementRefs: ["AC2"], problem: "Save control is disconnected", evidenceRefs: ["widget.js"], nextAction: "Connect save event" };
function git(dir, args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {cwd: dir, encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function project(t, suffix = "", config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-quick-v2-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, "agents/quick/demo"), {recursive: true});
  fs.writeFileSync(path.join(dir, "agents/quick/demo/contract.md"), CONTRACT + suffix);
  if (config) fs.writeFileSync(path.join(dir, "agents/config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, ".gitignore"), "agents/\n");
  fs.writeFileSync(path.join(dir, "widget.js"), "export const render = () => null;\n");
  git(dir, ["init", "-b", "main"]); git(dir, ["add", "."]); git(dir, ["commit", "-m", "initial widget"]);
  fs.appendFileSync(path.join(dir, "widget.js"), "export const persist = value => value;\n");
  return dir;
}
function run(dir, response = PASS, extra = [], env = {}) {
  const stub = path.join(dir, "agents/stub.json");
  fs.writeFileSync(stub, JSON.stringify(response)); fs.rmSync(`${stub}.cursor`, {force: true});
  const processEnv = {...process.env, SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: stub, ...env};
  delete processEnv.SASU_HERDR_ROLE;
  const raw = spawnSync("node", [CLI, "gate", "verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json", ...extra], {cwd: dir, encoding: "utf8", env: processEnv});
  let result; try { result = JSON.parse(raw.stdout); } catch {}
  return {...raw, result};
}
function state(dir) { return JSON.parse(fs.readFileSync(path.join(dir, "agents/runs/demo/gates/gates.json"), "utf8")); }
function successful(output) { assert.equal(output.status, 0, output.stdout + output.stderr); return output.result; }

test("one full-contract review covers thirty requirements without outcomes per AC", t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, "agents/quick/demo/contract.md"), CONTRACT.replace(/## Acceptance Criteria[\s\S]*/, "## Acceptance Criteria\n" + Array.from({length: 30}, (_, i) => `- AC${i+1}. behavior ${i+1}`).join("\n")));
  const capture = path.join(dir, "agents/prompts");
  const result = successful(run(dir, PASS, [], {SASU_JUDGE_STUB_CAPTURE_DIR: capture}));
  assert.deepEqual(result.review, PASS);
  assert.equal(result.criteria, undefined); assert.equal(result.judgedCriteriaIds, undefined);
  assert.equal(state(dir).judgeCalls.length, 1);
  const prompts = fs.readdirSync(capture).filter(file => file.endsWith(".prompt.txt")).map(file => fs.readFileSync(path.join(capture, file), "utf8")).join("\n");
  assert.match(prompts, /AC15\. behavior 15/); assert.match(prompts, /AC30\. behavior 30/);
  assert.match(result.mechanicalWarning, /No tests ran/);
});

test("actual required command failure prevents any judge call and cannot be skipped", t => {
  const dir = project(t, "", {verify: {commands: {test: 'node -e "process.exit(9)"'}}});
  const output = run(dir);
  assert.equal(output.status, 1); assert.equal(output.result.mechanical.runs[0].exitCode, 9);
  assert.equal(state(dir).judgeCalls.length, 0); assert.equal(output.result.zeroJudgeCalls, true);
  const bypass = run(dir, PASS, ["--skip-mechanical"]);
  assert.notEqual(bypass.status, 0); assert.match(bypass.stderr + bypass.stdout, /removed|retired|unknown|unsupported/i);
});

test("repeated identical command runs once per attempt, and runs again on the next attempt", t => {
  const cmd = 'node -e "require(\'fs\').appendFileSync(\'agents/runs.txt\',\'x\')"';
  const dir = project(t, `\n## Checks\n- \`${cmd}\`\n- \`${cmd}\`\n`, {verify: {commands: {test: cmd}}});
  successful(run(dir)); successful(run(dir));
  assert.equal(fs.readFileSync(path.join(dir, "agents/runs.txt"), "utf8"), "xx");
  assert.equal(state(dir).judgeCalls.length, 2);
});

test("first defect stays open with stable ID and explicit resolution is required", t => {
  const dir = project(t, "\n## Checks\n- `node -e \"process.exit(0)\"`\n");
  const first = run(dir, {...PASS, findings: [DEFECT]});
  assert.equal(first.status, 1); assert.equal(state(dir).gates.verify.reviewFindings[0].id, "F1");
  const omitted = run(dir, PASS);
  assert.equal(omitted.status, 1); assert.equal(omitted.result.error.code, "judge-invalid-output");
  assert.equal(state(dir).gates.verify.reviewFindings[0].problem, DEFECT.problem);
  const fixed = {...PASS, priorDispositions: [{findingId: "F1", status: "resolved", reason: "Handler now connected", evidenceRefs: ["widget.js"]}]};
  successful(run(dir, fixed)); assert.deepEqual(state(dir).gates.verify.reviewFindings, []);
});

test("an unresolved defect cannot become a passing advisory on the next review", t => {
  const dir = project(t, "\n## Checks\n- `node -e \"process.exit(0)\"`\n");
  assert.equal(run(dir, {...PASS, findings: [DEFECT]}).status, 1);
  const downgrade = run(dir, {...PASS, findings: [{...DEFECT, kind: "advisory", priorFindingId: "F1"}], priorDispositions: [{findingId: "F1", status: "open", reason: "Save control is still disconnected", evidenceRefs: ["widget.js"]}]});
  assert.equal(downgrade.status, 1);
  assert.equal(downgrade.result.error.code, "judge-invalid-output");
  assert.match(downgrade.result.error.message, /F1 cannot change kind/);
  assert.equal(state(dir).gates.verify.reviewFindings[0].kind, "defect");
  assert.equal(state(dir).gates.verify.reviewFindings[0].id, "F1");
});

test("semantic static reruns refuse without spend; source and input changes allow a new review", t => {
  const dir = project(t);
  assert.equal(run(dir, {...PASS, findings: [DEFECT]}).status, 1);
  assert.match(run(dir).stderr, /rerun short-circuit/);
  assert.equal(state(dir).judgeCalls.length, 1);
  fs.appendFileSync(path.join(dir, "widget.js"), "// connects action\n");
  successful(run(dir, {...PASS, priorDispositions: [{findingId: "F1", status: "resolved", reason: "Action connected", evidenceRefs: ["widget.js"]}]}));
});

// The read-evidence gate has three inputs, not two: a metered zero, a metered
// positive count, and a backend that attests nothing. The third must be
// refused as unverified - mapping it to zero would reject honest backends,
// and mapping it to satisfied would let an unread review pass (harness item
// 10). Each shape is pinned here because prose cannot hold that distinction.
test("an oversized diff review passes only on positive read evidence, and names which evidence was missing", t => {
  const inline = (dir) => {
    // Past VERIFY_DIFF_MAX_CHARS the gate stops inlining the diff and requires
    // the reviewer to read the source itself.
    fs.appendFileSync(path.join(dir, "widget.js"), Array.from({length: 8_000}, (_, index) => `export const padding${index} = ${index};`).join("\n") + "\n");
  };
  const observed = project(t);
  inline(observed);
  successful(run(observed, PASS, [], {SASU_JUDGE_STUB_READ_ROUNDS: "3"}));
  assert.equal(state(observed).gates.verify.verdict, "PASS");

  for (const [rounds, expected] of [[undefined, /observed zero read commands and zero tool rounds/], ["unmetered", /attested no command trace and no round count, so its reading is unverified rather than zero/]]) {
    const dir = project(t);
    inline(dir);
    const output = run(dir, PASS, [], rounds === undefined ? {} : {SASU_JUDGE_STUB_READ_ROUNDS: rounds});
    assert.equal(output.status, 1, `${rounds}: an unproven read must not pass`);
    const recorded = state(dir);
    const detail = JSON.stringify({ judgeCalls: recorded.judgeCalls, gate: recorded.gates.verify });
    assert.match(detail, expected, `${rounds}: the record must say which read evidence was missing`);
    assert.doesNotMatch(detail, rounds === undefined ? /unverified rather than zero/ : /observed zero read commands/, `${rounds}: the two shapes must not be reported as one`);
  }
});

// A change can be large enough to stop inlining the diff and still leave the
// reviewer nothing to open: past VERIFY_DIFF_MAX_CHARS the gate goes agentic
// on diff size alone, and its evidence list is the changed files that still
// exist. Delete enough and that list is empty. The read-evidence rejection
// exists to stop a verdict reached without opening the allowlisted source; with
// no allowlisted source it was rejecting a reviewer for not reading what was
// not there, so a big enough deletion could not pass this gate at all.
test("a purely deleting change large enough to go agentic can still be reviewed", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-quick-v2-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, "agents/quick/demo"), {recursive: true});
  fs.writeFileSync(path.join(dir, "agents/quick/demo/contract.md"), CONTRACT);
  fs.writeFileSync(path.join(dir, ".gitignore"), "agents/\n");
  fs.writeFileSync(path.join(dir, "widget.js"), "export const render = () => null;\n");
  fs.writeFileSync(path.join(dir, "legacy.js"),
    Array.from({length: 8_000}, (_, index) => `export const legacy${index} = ${index};`).join("\n") + "\n");
  git(dir, ["init", "-b", "main"]); git(dir, ["add", "."]); git(dir, ["commit", "-m", "initial"]);
  fs.rmSync(path.join(dir, "legacy.js"));

  // No read rounds are set: there is nothing in the workspace to read, and the
  // judge reporting zero is the honest answer rather than a withheld one.
  const output = run(dir, PASS);
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.equal(state(dir).gates.verify.verdict, "PASS");
});

test("registered shared evidence is hash-pinned and changed content stales PASS", t => {
  const dir = project(t, "\n## Evidence\n- agents/observed.txt\n");
  fs.writeFileSync(path.join(dir, "agents/observed.txt"), "Observed installed app at test time\n");
  const result = successful(run(dir));
  assert.equal(result.evidence[0].criterionId, undefined);
  assert.equal(result.evidence[0].path, "agents/observed.txt");
  assert.match(result.evidence[0].sha256, /^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(dir, "agents/observed.txt"), "changed\n");
  const status = spawnSync("node", [CLI, "gate", "status", "--slug", "demo", "--gate", "verify", "--json"], {cwd: dir, encoding: "utf8"});
  assert.match(status.stdout, /STALE/);
});

test("missing, empty, binary, escaping and oversized evidence blocks before review", t => {
  for (const kind of ["missing", "empty", "binary", "symlink", "hardlink", "large"]) {
    const dir = project(t, "\n## Evidence\n- agents/evidence.txt\n");
    const file = path.join(dir, "agents/evidence.txt");
    if (kind === "empty") fs.writeFileSync(file, "");
    if (kind === "binary") fs.writeFileSync(file, Buffer.from([0,1,2]));
    if (kind === "large") fs.writeFileSync(file, "x".repeat(65537));
    if (kind === "symlink") fs.symlinkSync("/etc/hosts", file);
    if (kind === "hardlink") fs.linkSync(path.join(dir, "widget.js"), file);
    const output = run(dir);
    assert.equal(output.status, 1, kind); assert.equal(output.result.zeroJudgeCalls, true, kind);
    assert.equal(state(dir).judgeCalls.length, 0, kind);
  }
});

test("shared captures actually execute and unavailable image access never becomes human PASS", t => {
  const dir = project(t, '\n## Evidence\n- capture: `node agents/capture.cjs` -> agents/shot.png\n');
  fs.writeFileSync(path.join(dir, "agents/capture.cjs"), 'require("fs").writeFileSync("agents/shot.png", Buffer.from("89504e470d0a1a0a", "hex"));');
  const output = run(dir, PASS, [], {SASU_JUDGE_STUB_NO_ATTACHMENTS: "1"});
  assert.equal(output.status, 1); assert.ok(fs.existsSync(path.join(dir, "agents/shot.png")));
  assert.equal(output.result.status.requiresHuman, false);
  assert.match(output.result.status.findings[0].missing, /cannot be read/);
});

test("run-wide Human Review remains conservative while every AC reaches review", t => {
  const dir = project(t, "\n## Human Review\nOwner compares visual fit later.\n");
  const output = run(dir);
  assert.equal(output.status, 1); assert.equal(output.result.status.effective, "NEEDS_HUMAN");
  assert.equal(state(dir).judgeCalls.length, 1); assert.deepEqual(output.result.review, PASS);
});

test("retired per-AC method contract is refused before mechanical execution", t => {
  const dir = project(t, "  - check: `node absent.cjs`\n");
  const output = run(dir);
  assert.equal(output.status, 1); assert.equal(output.result.prelint.ok, false);
  assert.match(output.result.prelint.findings[0].missing, /488d3cc/);
});

test("an overall PASS string cannot conceal a defect in the new review contract", t => {
  const dir = project(t);
  const output = run(dir, {...PASS, verdict: "PASS", findings: [DEFECT]});
  assert.equal(output.status, 1); assert.equal(output.result.error.code, "judge-invalid-output");
});
