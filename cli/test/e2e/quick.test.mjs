// Quick-path verify: `sasu verify --contract` replaces the 12-section PRD
// with a tiny goal+AC contract while keeping the whole gate machinery -
// prelint, mechanical, semantic judge, gate store, and (new) the tree
// fingerprint the Stop-hook quick guard compares against.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const { semanticVerifyPrompt } = await import("../../dist/gates/prompts.js");

const CONTRACT = `---
topic: demo
status: active
---

## Goal

Render and persist the widget.

## Acceptance Criteria

- AC1. the widget renders
- AC2. the widget persists its state
`;

function git(dir, args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeGitProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-quick-e2e-"));
  git(dir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "widget.js"), "module.exports = () => null;\n");
  fs.mkdirSync(path.join(dir, "agents", "quick", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "quick", "demo", "contract.md"), CONTRACT);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  // The uncommitted change is what verify judges against HEAD.
  fs.appendFileSync(path.join(dir, "widget.js"), "render(); persist();\n");
  return dir;
}

function stubFile(dir, response) {
  const file = path.join(dir, "stub.json");
  fs.writeFileSync(file, JSON.stringify(response));
  fs.rmSync(`${file}.cursor`, { force: true });
  return file;
}

function runCli(cwd, args, { stub, env: extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (stub) {
    env.SASU_JUDGE_BACKEND = "stub";
    env.SASU_JUDGE_STUB_FILE = stub;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

function gatesState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "gates", "demo", "gates.json"), "utf8"));
}

const PASS_RESPONSE = {
  verdict: "PASS",
  criteria: [
    { id: "AC1", verdict: "PASS", reason: "render() added", evidence: "diff hunk" },
    { id: "AC2", verdict: "PASS", reason: "persist() added", evidence: "diff hunk" },
  ],
};

const FAIL_RESPONSE = {
  verdict: "FAIL",
  criteria: [
    { id: "AC1", verdict: "PASS", reason: "render() added", evidence: "diff hunk" },
    { id: "AC2", verdict: "FAIL", reason: "no persistence in the diff" },
  ],
};

test("contract verify PASS records the verdict, contract hash, and tree fingerprint", () => {
  const dir = makeGitProject();
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, PASS_RESPONSE),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status.effective, "PASS");
  assert.equal(parsed.prelint.ok, true);

  const record = gatesState(dir).gates.verify;
  assert.equal(record.verdict, "PASS");
  // The judged document plus the project config, which declares the mechanical
  // commands the gate runs and is pinned whether or not it exists.
  assert.equal(record.inputs.length, 2);
  assert.ok(record.inputs.some(input => input.path.endsWith("contract.md")));
  assert.deepEqual(
    record.inputs.filter(input => input.kind === "config").map(input => input.path),
    [path.join("agents", "config.json")],
  );
  assert.ok(record.treeFingerprint, "verdict must pin the tree it was earned on");
  assert.equal(typeof record.treeFingerprint.vouched, "string", "fingerprint must carry the vouched content hash");
  assert.ok(record.treeFingerprint.vouched.length > 0, "vouched hash must be non-empty");
  assert.equal(typeof record.treeFingerprint.entryCount, "number", "fingerprint must carry the vouched entry count");
});

test("contract verify FAIL blocks with per-criterion findings and consumes an attempt", () => {
  const dir = makeGitProject();
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, FAIL_RESPONSE),
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.status.findings.some((f) => f.missing.startsWith("AC2:")));
  assert.equal(gatesState(dir).gates.verify.attempts, 1);
});

test("a FAIL rerun on the identical tree is refused at zero cost until the tree moves", () => {
  const dir = makeGitProject();
  const first = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, FAIL_RESPONSE),
  });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.equal(gatesState(dir).gates.verify.attempts, 1);

  // Nothing changed: the rerun is refused before any spend.
  const refused = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, FAIL_RESPONSE),
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /rerun short-circuit/);
  assert.match(refused.stderr, /fallback-mode vouched fingerprint/, "the refusal names the fingerprint mode");
  assert.match(refused.stderr, /no persistence in the diff/, "the recorded findings are replayed");
  assert.match(refused.stderr, /gate override/, "the user escape hatch is named");
  const afterRefusal = gatesState(dir).gates.verify;
  assert.equal(afterRefusal.attempts, 1, "a refusal must not charge an attempt");
  assert.equal(afterRefusal.totalAttempts, 1, "a refusal is not a run");
  assert.equal(afterRefusal.history.length, 1, "a refusal must not append a history row");
  assert.equal(gatesState(dir).judgeCalls.length, 1, "a refusal must not spend a judge call");

  // The tree moved: the rerun is a real attempt again.
  fs.appendFileSync(path.join(dir, "widget.js"), "persistHarder();\n");
  const rerun = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, FAIL_RESPONSE),
  });
  assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
  assert.equal(gatesState(dir).gates.verify.attempts, 2);
  assert.equal(gatesState(dir).gates.verify.totalAttempts, 2);
});

// Helpers for the Stop-hook half of the two blocked close-out tests below.
const HARNESS_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "skills", "implement", "scripts", "prd_state_harness.js",
);

function armQuickMarker(dir) {
  fs.writeFileSync(
    path.join(dir, "agents", "quick", ".quick-active.json"),
    JSON.stringify({ slug: "demo", contractPath: "agents/quick/demo/contract.md", startedAt: new Date().toISOString() }),
  );
}

function stopDirective(dir, sessionId) {
  const hook = spawnSync("node", [HARNESS_SCRIPT, "hook", "stop"], {
    cwd: dir,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "Stop", cwd: dir, session_id: sessionId }),
  });
  assert.equal(hook.status, 0, hook.stderr);
  return JSON.parse(hook.stdout);
}

// The livelock this wave set out to kill, in its final shape: a semantic FAIL at
// attempts 1/3 arms the rerun short-circuit, so every remaining attempt is
// unspendable at $0, `attempts` can never reach the budget, and a
// budget-exhausted-only terminal predicate is unreachable. Before the fix the
// Stop hook here still said "attempt 1/3, fix and re-run" while `sasu verify`
// answered with the refusal - two components issuing contradictory directives,
// with a user override as the only exit. The honest close-out must open NOW, and
// it must report 1/3, never a faked 3/3 (PRINCIPLES item 10).
test("a FAIL whose rerun is refused is terminally blocked at once: the guard stops saying re-run", () => {
  const dir = makeGitProject();
  const stub = stubFile(dir, FAIL_RESPONSE);
  const first = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], { stub });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const record = gatesState(dir).gates.verify;
  assert.equal(record.attempts, 1, "exactly one attempt was spent");
  assert.equal(record.usedLiveMaterial, false, "a diff-only round is what arms the refusal");

  // The refusal is real: an identical rerun costs nothing and records nothing,
  // which is precisely why the budget can never be spent down.
  const refused = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], { stub });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /rerun short-circuit/);
  assert.match(refused.stderr, /close the run out honestly as blocked/, "the refusal names the exit it creates");
  assert.equal(gatesState(dir).gates.verify.attempts, 1, "still 1/3 - the budget is unspendable, not spent");

  armQuickMarker(dir);
  const directive = stopDirective(dir, "quick-e2e-refused");
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /attempt 1\/3/, "the directive reports the honest attempt count, never a faked exhaustion");
  assert.match(directive.reason, /identical re-run is refused on this unchanged tree/);
  assert.match(directive.reason, /status: blocked/, "the close-out is the blocked shape");
  assert.ok(!/status: complete/.test(directive.reason), "a failed run must not be told to record itself complete");
  assert.ok(!/exhausted its 3-attempt verify budget/.test(directive.reason), "the budget was NOT exhausted; say so");
  // The contradiction itself: this guard used to print "attempt 1/3 ... Fix the
  // findings and re-run" while `sasu verify` answered with the refusal.
  assert.ok(!/Fix the findings and re-run/.test(directive.reason),
    "a Stop hook must never point at a command that will exit with the refusal");
  // The one move that could still reach a PASS must be named, or "blocked" reads
  // as the only option and the guard becomes a give-up button.
  assert.match(directive.reason, /change the code under judgment/i);

  // And it really is a re-arm, not a dead end: a tree change makes the gate run
  // again, so the escape the directive names actually works.
  fs.appendFileSync(path.join(dir, "widget.js"), "persistForReal();\n");
  const rerun = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, FAIL_RESPONSE),
  });
  assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
  assert.equal(gatesState(dir).gates.verify.attempts, 2, "a tree change re-arms verification and spends a real attempt");
});

test("an exhausted retry budget hands off as an honest blocked close-out, not a fake complete", () => {
  const dir = makeGitProject();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Real fix-loop shape: the tree moves between attempts, so all three
    // attempts are genuinely spent. This is the budget-exhausted twin of the
    // refusal test above - kept distinct on purpose, because the two terminal
    // causes must report different numbers and different reasons.
    if (attempt > 0) fs.appendFileSync(path.join(dir, "widget.js"), `attempt${attempt}();\n`);
    const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
      stub: stubFile(dir, FAIL_RESPONSE),
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  assert.equal(gatesState(dir).gates.verify.attempts, 3);
  assert.equal(gatesState(dir).gates.verify.totalAttempts, 3, "the cumulative counter tracks every real run");

  // The Stop-hook quick guard consumes the very gates.json the CLI just
  // wrote: with the default 3-attempt budget spent, the directive must
  // demand a `blocked` contract, never tell the failed run to say complete.
  armQuickMarker(dir);
  const directive = stopDirective(dir, "quick-e2e-blocked");
  assert.equal(directive.decision, "block");
  assert.match(directive.reason, /exhausted its 3-attempt verify budget/);
  assert.match(directive.reason, /status: blocked/);
  assert.ok(!/status: complete/.test(directive.reason), "a failed run must not be told to record itself complete");
});

test("a structurally broken contract blocks at prelint without a judge call", () => {
  const dir = makeGitProject();
  fs.writeFileSync(
    path.join(dir, "agents", "quick", "demo", "contract.md"),
    CONTRACT.replace("## Acceptance Criteria", "## Criteria"),
  );
  // No stub: reaching the judge would fail loudly with judge-binary-missing.
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, PASS_RESPONSE),
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.prelint.ok, false);
  assert.equal(parsed.prelint.findings[0].rule, "contract-ac-section-missing");
  const gatesPath = path.join(dir, "agents", "gates", "demo", "gates.json");
  assert.ok(
    !fs.existsSync(gatesPath) || JSON.parse(fs.readFileSync(gatesPath, "utf8")).gates.verify.verdict === null,
    "prelint block must not record a verdict or consume a gate attempt",
  );
});

// --- evidence lane ---

function writeContract(dir, body) {
  fs.writeFileSync(path.join(dir, "agents", "quick", "demo", "contract.md"), `---\ntopic: demo\nstatus: active\n---\n\n## Goal\n\nDemo.\n\n${body}`);
}

function verifyJson(dir, response, extraArgs = []) {
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json", ...extraArgs], {
    stub: stubFile(dir, response),
  });
  return { result, parsed: JSON.parse(result.stdout) };
}

test("a contract check command runs on the harness clock and blocks the judge when it fails", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Checks\n\n- `bash -c \"exit 3\"`\n\n## Acceptance Criteria\n\n- AC1. the widget renders\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  const run = parsed.mechanical.runs.find((r) => r.kind === "check");
  assert.ok(run, "the contract check must appear as a mechanical run");
  assert.equal(run.source, "contract");
  assert.equal(run.exitCode, 3);
  assert.ok(parsed.status.findings.some((f) => f.area === "mechanical"));
});

test("text evidence is hash-pinned as an evidence input and reaches the judge", () => {
  const dir = makeGitProject();
  fs.mkdirSync(path.join(dir, "agents", "quick", "demo", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "quick", "demo", "evidence", "api.json"), '{"status":200}\n');
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/api.json\n");
  const { result, parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "evidence shows 200", evidence: "diff hunk" }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(parsed.status.effective, "PASS");
  const inputs = gatesState(dir).gates.verify.inputs;
  const evidence = inputs.find((i) => i.path.endsWith("api.json"));
  assert.ok(evidence, "the evidence file must join the PASS pin");
  assert.equal(evidence.kind, "evidence");

  // Editing the artifact after the pass re-opens the gate, like the contract does.
  fs.writeFileSync(path.join(dir, "agents", "quick", "demo", "evidence", "api.json"), '{"status":500}\n');
  const view = JSON.parse(runCli(dir, ["gate", "status", "--slug", "demo", "--json"]).stdout).verify;
  assert.equal(view.effective, "STALE");
  assert.ok(view.staleInputs.some((i) => i.path.endsWith("api.json") && i.reason === "changed"));
});

test("a declared evidence file that is missing blocks before the judge is called", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/nope.json\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  assert.ok(parsed.status.findings.some((f) => f.area === "evidence" && f.missing.includes("nope.json")));
  assert.equal(gatesState(dir).judgeCalls.length, 0, "a missing artifact must not spend a judge call");
});

test("oversized text evidence is pushed back to a check command instead of the prompt", () => {
  const dir = makeGitProject();
  fs.mkdirSync(path.join(dir, "agents", "quick", "demo", "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "quick", "demo", "evidence", "big.log"), "x".repeat(70 * 1024));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/big.log\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  const finding = parsed.status.findings.find((f) => f.area === "evidence");
  assert.match(finding.missing, /over the \d+-byte inline budget/);
  assert.match(finding.recommendation, /Checks/);
});

test("a capture command produces the artifact on the harness clock and pins it", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the widget renders\n  - capture: `bash -c \"printf shot > out.png\"` -> out.png\n",
  );
  const { result, parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "the capture shows the widget", evidence: "diff hunk" }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captureRun = parsed.mechanical.runs.find((r) => r.kind === "capture");
  assert.deepEqual(captureRun.criterionIds, ["AC1"]);
  assert.equal(fs.readFileSync(path.join(dir, "out.png"), "utf8"), "shot");
  assert.ok(gatesState(dir).gates.verify.inputs.some((i) => i.path === "out.png" && i.kind === "evidence"));
});

test("a capture whose command writes nothing blocks with a capture-specific finding", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - capture: `true` -> out.png\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  assert.ok(parsed.status.findings.some((f) => f.area === "evidence" && f.missing.includes("produced no artifact")));
});

test("a human criterion is never judged and comes back as a requiresHuman handoff", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. matches the mock\n  - human: compare with the printed mock\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  assert.equal(parsed.status.requiresHuman, true);
  assert.ok(parsed.status.findings.some((f) => f.area === "human-verification" && f.requiresHuman));
  assert.equal(gatesState(dir).judgeCalls.length, 0, "an all-human contract must cost zero judge calls");
});

test("a human criterion keeps the gate closed even when every judged criterion passes", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n- AC2. matches the mock\n  - human: eyeball it\n");
  // The stub answers for AC1 only: the human criterion must never be sent.
  const { result, parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "render() added", evidence: "diff hunk" }],
  });
  assert.equal(result.status, 1);
  assert.equal(parsed.status.verdict, "FAIL");
  assert.equal(parsed.status.requiresHuman, true);
  assert.equal(gatesState(dir).judgeCalls.length, 1);
});

test("image evidence falls to the human lane when the backend cannot attach", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. dark mode renders\n  - capture: `bash -c \"printf png > shot.png\"` -> shot.png\n",
  );
  const stub = stubFile(dir, PASS_RESPONSE);
  const env = { ...process.env, SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: stub, SASU_JUDGE_STUB_NO_ATTACHMENTS: "1" };
  const result = spawnSync("node", [CLI, "verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  const finding = parsed.status.findings.find((f) => f.area === "human-verification");
  assert.ok(finding, JSON.stringify(parsed.status.findings, null, 2));
  assert.match(finding.missing, /no attachment support/);
  assert.match(finding.recommendation, /codex/);
  // The capture still ran and is still pinned: the artifact is fresh evidence
  // for the human, not something the fallback throws away.
  assert.equal(fs.readFileSync(path.join(dir, "shot.png"), "utf8"), "png");
  assert.ok(gatesState(dir).gates.verify.inputs.some((i) => i.path === "shot.png"));
});

// --- evidence-lane hardening (QA findings, 2026-08-09) ---

test("a symlink out of the project is refused at read time, not just lexically", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const outside = path.join(dir, "..", `sasu-quick-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, "SECRET-OUTSIDE-THE-PROJECT\n");
  fs.symlinkSync(outside, path.join(evidenceDir, "link.txt"));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/link.txt\n");
  try {
    const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
    assert.equal(result.status, 1);
    // The lexical lint cannot see a symlink, so this must be caught later.
    assert.equal(parsed.prelint.ok, true);
    const finding = parsed.status.findings.find((f) => f.area === "evidence");
    assert.ok(finding, JSON.stringify(parsed.status.findings, null, 2));
    assert.match(finding.missing, /resolves outside the project/);
    assert.ok(!result.stdout.includes("SECRET-OUTSIDE-THE-PROJECT"), "the outside file must never be read into the run");
    assert.equal(gatesState(dir).judgeCalls.length, 0, "nothing may be shipped to a judge");
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("an image declared as plain evidence is never attached: only a capture proves freshness", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "shot.png"), "png-bytes");
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. dark mode renders\n  - evidence: agents/quick/demo/evidence/shot.png\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  const finding = parsed.status.findings.find((f) => f.area === "human-verification");
  assert.match(finding.missing, /not produced by a capture command/);
  assert.match(finding.recommendation, /capture:/);
});

test("binary evidence is refused instead of inlined as mojibake", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "dump.bin"), Buffer.from([0x01, 0x00, 0x02, 0x03]));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/dump.bin\n");
  const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 1);
  assert.match(parsed.status.findings.find((f) => f.area === "evidence").missing, /binary, not text/);
});

test("a contract check restating a configured command runs once, but captures always run", () => {
  const dir = makeGitProject();
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ verify: { commands: { test: "true" } } }));
  writeContract(dir, "## Checks\n\n- `true`\n\n## Acceptance Criteria\n\n- AC1. the widget renders\n  - capture: `bash -c \"printf x > a.txt\"` -> a.txt\n");
  const { parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }],
  });
  assert.equal(parsed.mechanical.runs.filter((r) => r.command === "true").length, 1, "the duplicated command must not run twice");
  assert.equal(parsed.mechanical.runs.filter((r) => r.kind === "capture").length, 1);
});

test("verify --json carries everything the receipt must quote", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":200}\n');
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/api.json\n- AC2. matches the mock\n  - human: eyeball it\n",
  );
  const { parsed } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.deepEqual(parsed.judgedCriteriaIds, ["AC1"], "the human criterion must be provably absent from the judge's view");
  assert.equal(parsed.judgedVerdict, "PASS");
  assert.equal(parsed.status.verdict, "FAIL", "an unsettled human criterion keeps the gate closed");
  assert.ok(parsed.inputs.some((i) => i.kind === "evidence" && i.path.endsWith("api.json")));
  const evidence = parsed.evidence.find((e) => e.path.endsWith("api.json"));
  assert.equal(evidence.criterionId, "AC1");
  assert.ok(evidence.sha256 && evidence.bytes > 0);
  assert.ok(!("text" in evidence), "the receipt summary must not re-embed the whole artifact");
});

test("gate status reports the tree fingerprint, so it cannot disagree with the Stop hook", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n");
  const { result } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(result.status, 0);
  fs.appendFileSync(path.join(dir, "widget.js"), "// edited after the pass\n");
  const view = JSON.parse(runCli(dir, ["gate", "status", "--slug", "demo", "--json"]).stdout).verify;
  assert.equal(view.effective, "STALE");
  assert.ok(view.staleInputs.some((i) => i.path === "<worktree>"));
});

test("a human-blocked gate still reports evidence drift instead of hiding it", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":200}\n');
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/api.json\n- AC2. matches the mock\n  - human: eyeball it\n",
  );
  verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":500}\n');
  const view = JSON.parse(runCli(dir, ["gate", "status", "--slug", "demo", "--json"]).stdout).verify;
  assert.equal(view.effective, "BLOCKED", "a blocked gate must not be relabelled STALE");
  assert.ok(
    view.staleInputs.some((i) => i.path.endsWith("api.json") && i.reason === "changed"),
    "swapping the artifact a human is about to read must be visible",
  );
});

// --- round-2 hardening ---

test("a hard link to an outside file is refused: realpath cannot see it", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const outside = path.join(dir, "..", `sasu-quick-hardlink-${process.pid}.txt`);
  fs.writeFileSync(outside, "SECRET-OUTSIDE-THE-PROJECT\n");
  fs.linkSync(outside, path.join(evidenceDir, "hard.txt"));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/hard.txt\n");
  try {
    const { result, parsed } = verifyJson(dir, PASS_RESPONSE);
    assert.equal(result.status, 1);
    assert.match(parsed.status.findings.find((f) => f.area === "evidence").missing, /hard link/);
    assert.ok(!result.stdout.includes("SECRET-OUTSIDE-THE-PROJECT"));
    assert.equal(gatesState(dir).judgeCalls.length, 0);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("a criterion-scoped check reaches the judge as evidence for that criterion", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the health endpoint answers\n  - check: `bash -c \"echo HEALTHPROBE-OK\"`\n",
  );
  const { result, parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [{ id: "AC1", verdict: "PASS", reason: "the harness check exited 0", evidence: "diff hunk" }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = parsed.mechanical.runs.find((r) => r.kind === "check");
  assert.deepEqual(run.criterionIds, ["AC1"], "a criterion check must be attributed to its criterion");
  assert.deepEqual(parsed.checks, [
    { criterionId: "AC1", command: 'bash -c "echo HEALTHPROBE-OK"', exitCode: 0, tail: "HEALTHPROBE-OK" },
  ]);
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(dir, "agents", "gates", "demo", "artifacts", fs.readdirSync(path.join(dir, "agents", "gates", "demo", "artifacts"))[0]),
      "utf8",
    ),
  );
  assert.equal(artifact.checks[0].criterionId, "AC1");
  assert.ok(artifact.promptSha256);
});

test("a run-wide check stays a gate signal and is not attributed to a criterion", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Checks\n\n- `true`\n\n## Acceptance Criteria\n\n- AC1. the widget renders\n");
  const { parsed } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(parsed.mechanical.runs.find((r) => r.kind === "check").criterionIds, undefined);
  assert.deepEqual(parsed.checks, []);
});

test("an identical command declared as both check and capture runs once", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    '## Acceptance Criteria\n\n- AC1. the shot exists\n  - check: `bash -c "printf x > a.txt"`\n  - capture: `bash -c "printf x > a.txt"` -> a.txt\n',
  );
  const { parsed } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  const matching = parsed.mechanical.runs.filter((r) => r.command === 'bash -c "printf x > a.txt"');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].kind, "capture", "the capture wins: it must still produce its artifact");
});

test("every settled path emits the receipt keys, including an all-human close", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. matches the mock\n  - human: eyeball it\n");
  const { parsed } = verifyJson(dir, PASS_RESPONSE);
  for (const key of ["criteria", "inputs", "evidence", "checks", "judgedCriteriaIds"]) {
    assert.ok(key in parsed, `${key} must be present so the receipt can be written from --json alone`);
  }
  assert.deepEqual(parsed.criteria, []);
  assert.deepEqual(parsed.judgedCriteriaIds, []);

  const blocked = makeGitProject();
  writeContract(blocked, "## Acceptance Criteria\n\n- AC1. x\n  - evidence: agents/quick/demo/evidence/missing.txt\n");
  const evidenceBlocked = verifyJson(blocked, PASS_RESPONSE).parsed;
  for (const key of ["criteria", "inputs", "evidence", "checks", "judgedCriteriaIds"]) {
    assert.ok(key in evidenceBlocked, `${key} must be present on an evidence block too`);
  }
});

test("drift on a blocked gate is visible through inputsDrifted, not just stale", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":200}\n');
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the widget renders\n  - evidence: agents/quick/demo/evidence/api.json\n- AC2. matches the mock\n  - human: eyeball it\n",
  );
  verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":500}\n');
  const view = JSON.parse(runCli(dir, ["gate", "status", "--slug", "demo", "--json"]).stdout).verify;
  assert.equal(view.stale, false, "a blocked gate cannot be stale");
  assert.equal(view.inputsDrifted, true, "but the drift must still be a first-class signal");
});

test("skipping the mechanical stage never tells the judge the checks passed", () => {
  const dir = makeGitProject();
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the widget renders\n");
  const stub = stubFile(dir, PASS_RESPONSE);
  runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--skip-mechanical", "--json"], { stub });
  // The stub echoes nothing back, so assert on the prompt the judge would see.
  const skipped = semanticVerifyPrompt("diff", [{ id: "AC1", text: "x" }], [], [], { mechanicalRan: false });
  assert.match(skipped, /were SKIPPED for this run/);
  assert.ok(!/already passed/.test(skipped), "a skipped stage must not be reported as passing");
  assert.match(semanticVerifyPrompt("diff", [{ id: "AC1", text: "x" }]), /already passed/);
});

// --- round-3 hardening ---

test("one command declared by two criteria runs once and proves both", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    '## Acceptance Criteria\n\n- AC1. stdout says ok\n  - check: `bash -c "printf x >> runs.log; echo DUAL-OK"`\n- AC2. the artifact exists\n  - capture: `bash -c "printf x >> runs.log; echo DUAL-OK"` -> runs.log\n',
  );
  const { result, parsed } = verifyJson(dir, {
    verdict: "PASS",
    criteria: [
      { id: "AC1", verdict: "PASS", reason: "check exited 0", evidence: "diff hunk" },
      { id: "AC2", verdict: "PASS", reason: "artifact written", evidence: "diff hunk" },
    ],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "runs.log"), "utf8"), "x", "the command must execute exactly once");
  const run = parsed.mechanical.runs.find((r) => r.command.includes("DUAL-OK"));
  assert.equal(run.kind, "capture", "the capture must win so its artifact is produced");
  assert.deepEqual([...run.criterionIds].sort(), ["AC1", "AC2"], "deduping must not drop a criterion's proof");
  assert.deepEqual(parsed.checks.map((c) => c.criterionId).sort(), ["AC1", "AC2"]);
});

test("an artifact no judge could read is still reported with its hash", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. dark mode renders\n  - capture: `bash -c \"printf png > shot.png\"` -> shot.png\n",
  );
  const stub = stubFile(dir, PASS_RESPONSE);
  const result = spawnSync("node", [CLI, "verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: stub, SASU_JUDGE_STUB_NO_ATTACHMENTS: "1" },
  });
  const parsed = JSON.parse(result.stdout);
  const artifact = parsed.evidence.find((e) => e.path === "shot.png");
  assert.ok(artifact, "a human-lane artifact must still reach the receipt");
  assert.ok(artifact.sha256 && artifact.bytes > 0);
  assert.equal(artifact.criterionId, "AC1");
});

test("a broken judge call still reports the work the run really did", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":200}\n');
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. the API answers\n  - check: `true`\n  - evidence: agents/quick/demo/evidence/api.json\n",
  );
  // A stub reply that is not JSON drives the judge-invalid-output path.
  const { result, parsed } = verifyJson(dir, "this is not a verdict");
  assert.equal(result.status, 1);
  assert.equal(parsed.error.code, "judge-invalid-output");
  for (const key of ["criteria", "inputs", "evidence", "checks", "judgedCriteriaIds", "mechanical"]) {
    assert.ok(key in parsed, `${key} must survive a judge failure so the receipt is still writable`);
  }
  assert.deepEqual(parsed.judgedCriteriaIds, ["AC1"]);
  assert.equal(parsed.checks[0].criterionId, "AC1");
  assert.ok(parsed.evidence.some((e) => e.path.endsWith("api.json")));
  const artifacts = path.join(dir, "agents", "gates", "demo", "artifacts");
  const written = fs.readdirSync(artifacts).map((f) => JSON.parse(fs.readFileSync(path.join(artifacts, f), "utf8")));
  assert.ok(written.some((a) => a.stage === "judge-error" && a.promptSha256), "the failed run must leave an auditable artifact");
});

// --- round-4 hardening ---

test("files the run created are part of the diff the judge sees", () => {
  const dir = makeGitProject();
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "brand-new.js"), "module.exports = () => 'NEWFILE-TOKEN';\n");
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the new module exists\n");
  const { result } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const artifacts = path.join(dir, "agents", "gates", "demo", "artifacts");
  const payload = JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), "utf8"));
  assert.ok(payload.promptSha256, "the run must have reached the judge at all");
});

test("a run that only adds files still has something to verify", () => {
  const dir = makeGitProject();
  // Undo the tracked edit makeGitProject leaves behind: new files only.
  spawnSync("git", ["checkout", "--", "widget.js"], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "added-only.js"), "module.exports = 1;\n");
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the module exists\n");
  const { result, parsed } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(result.status, 0, `an add-only run must not die on an empty diff: ${result.stdout}${result.stderr}`);
  assert.equal(parsed.status.effective, "PASS");
});

test("the harness's own run bookkeeping stays out of the diff", () => {
  const dir = makeGitProject();
  const evidenceDir = path.join(dir, "agents", "quick", "demo", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "api.json"), '{"status":200}\n');
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. x\n  - evidence: agents/quick/demo/evidence/api.json\n");
  const { result } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(result.status, 0);
  // The contract and its artifacts are pinned as inputs; replaying them as
  // diff hunks would just crowd out the code under review.
  const artifacts = path.join(dir, "agents", "gates", "demo", "artifacts");
  const payload = JSON.parse(fs.readFileSync(path.join(artifacts, fs.readdirSync(artifacts)[0]), "utf8"));
  assert.ok(payload.inputs.some((i) => i.path.endsWith("api.json")));
});

test("a criterion check that collides with a configured command keeps its attribution", () => {
  const dir = makeGitProject();
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ verify: { commands: { test: "true" } } }));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. the suite proves it\n  - check: `true`\n");
  const { parsed } = verifyJson(dir, { verdict: "PASS", criteria: [{ id: "AC1", verdict: "PASS", reason: "ok", evidence: "diff hunk" }] });
  assert.equal(parsed.mechanical.runs.filter((r) => r.command === "true").length, 1, "still runs once");
  assert.deepEqual(
    parsed.checks.map((c) => c.criterionId),
    ["AC1"],
    "the surviving run keeps the project's kind, so attribution - not kind - must decide what the judge sees",
  );
});

test("criterion check results reach every settled close, not just the judged one", () => {
  const dir = makeGitProject();
  writeContract(
    dir,
    "## Acceptance Criteria\n\n- AC1. proven by command\n  - check: `bash -c \"echo CHECKTAIL-OK\"`\n- AC2. matches the mock\n  - human: eyeball it\n",
  );
  const { parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(parsed.status.requiresHuman, true, "an all-human-blocked close");
  assert.deepEqual(parsed.checks, [
    { criterionId: "AC1", command: 'bash -c "echo CHECKTAIL-OK"', exitCode: 0, tail: "CHECKTAIL-OK" },
  ]);

  const failed = makeGitProject();
  fs.writeFileSync(path.join(failed, "agents", "config.json"), JSON.stringify({ verify: { commands: { test: "false" } } }));
  writeContract(failed, "## Acceptance Criteria\n\n- AC1. x\n  - check: `true`\n");
  const mechanicalFail = verifyJson(failed, PASS_RESPONSE).parsed;
  assert.equal(mechanicalFail.status.verdict, "FAIL");
  for (const key of ["criteria", "inputs", "evidence", "checks", "judgedCriteriaIds"]) {
    assert.ok(key in mechanicalFail, `${key} must be present on a mechanical-failure close too`);
  }
});

test("a failing run-wide check still collects the criterion proof that was going to pass", () => {
  const dir = makeGitProject();
  fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify({ verify: { commands: { test: "false" } } }));
  writeContract(dir, "## Acceptance Criteria\n\n- AC1. proven by command\n  - check: `bash -c \"echo CRITERION-STILL-RAN\"`\n");
  const { parsed } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(parsed.status.verdict, "FAIL", "the failing project check must still block");
  assert.deepEqual(
    parsed.checks,
    [{ criterionId: "AC1", command: 'bash -c "echo CRITERION-STILL-RAN"', exitCode: 0, tail: "CRITERION-STILL-RAN" }],
    "the receipt for a failed run is exactly the one that needs to say which criteria were already satisfied",
  );
});

// --- diff curation + oversized-diff guard (audited run, 2026-08) ---

test("lockfiles and the agents/ namespace are curated out of the judged diff on both sides", () => {
  const dir = makeGitProject();
  // Tracked noise: commit lockfiles and a harness doc, then bloat them far
  // past the judge input budget. If any of it leaked into the diff, the
  // truncation guard would fail the command instead of judging.
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lock: 1\n");
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "pnpm-lock.yaml"), "lock: 1\n");
  fs.mkdirSync(path.join(dir, "agents", "prd"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "prd", "prd.md"), "# prd\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "add noise sources"]);
  const noise = "x".repeat(200_000);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), noise);
  fs.writeFileSync(path.join(dir, "app", "pnpm-lock.yaml"), noise);
  fs.writeFileSync(path.join(dir, "agents", "prd", "prd.md"), noise);
  // Untracked noise too: the exclusion predicate must agree on both sides.
  fs.writeFileSync(path.join(dir, "yarn.lock"), noise);
  fs.writeFileSync(path.join(dir, "agents", "prd", "notes.md"), noise);
  const { result } = verifyJson(dir, PASS_RESPONSE);
  assert.equal(result.status, 0, `noise must not reach the judge or trip the size guard: ${result.stdout}${result.stderr}`);
});

test("an oversized real diff fails the command up front on a non-agentic backend, without touching gate state", () => {
  const dir = makeGitProject();
  fs.appendFileSync(path.join(dir, "widget.js"), `// ${"x".repeat(200_000)}\n`);
  // SASU_JUDGE_STUB_NO_AGENTIC rehearses the codex case: no read tools means
  // no agentic fallback, so the original fail-up-front contract must hold.
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, PASS_RESPONSE),
    env: { SASU_JUDGE_STUB_NO_AGENTIC: "1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /judge input budget/);
  assert.match(result.stderr, /No judgment ran and no retry attempt was spent/);
  assert.ok(
    !fs.existsSync(path.join(dir, "agents", "gates", "demo", "gates.json")),
    "an oversized diff must not create gate state or charge an attempt",
  );
});

test("an oversized real diff on an agentic backend falls back to the read-only judge and passes", () => {
  const dir = makeGitProject();
  fs.appendFileSync(path.join(dir, "widget.js"), `// ${"x".repeat(200_000)}\n`);
  const result = runCli(dir, ["verify", "--slug", "demo", "--contract", "agents/quick/demo/contract.md", "--json"], {
    stub: stubFile(dir, {
      verdict: "PASS",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "render() present", evidence: "read widget.js" },
        { id: "AC2", verdict: "PASS", reason: "persist() present", evidence: "read widget.js" },
      ],
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  const artifactsDir = path.join(dir, "agents", "gates", "demo", "artifacts");
  const artifacts = fs.readdirSync(artifactsDir).map((f) => JSON.parse(fs.readFileSync(path.join(artifactsDir, f), "utf8")));
  const semantic = artifacts.find((a) => a.stage === "semantic");
  assert.equal(semantic.lanes[0].agenticFallback, true, "the artifact must record the agentic fallback");
});

test("passing both --prd and --contract is rejected", () => {
  const dir = makeGitProject();
  const result = runCli(dir, [
    "verify",
    "--slug",
    "demo",
    "--prd",
    "agents/quick/demo/contract.md",
    "--contract",
    "agents/quick/demo/contract.md",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not both/);
});
