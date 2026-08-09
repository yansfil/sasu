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

function runCli(cwd, args, { stub } = {}) {
  const env = { ...process.env };
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
    { id: "AC1", verdict: "PASS", reason: "render() added" },
    { id: "AC2", verdict: "PASS", reason: "persist() added" },
  ],
};

const FAIL_RESPONSE = {
  verdict: "FAIL",
  criteria: [
    { id: "AC1", verdict: "PASS", reason: "render() added" },
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
  assert.equal(record.inputs.length, 1);
  assert.ok(record.inputs[0].path.endsWith("contract.md"));
  assert.ok(record.treeFingerprint, "verdict must pin the tree it was earned on");
  assert.ok(record.treeFingerprint.headSha, "fingerprint must carry HEAD");
  assert.ok(record.treeFingerprint.statusHash, "fingerprint must carry the status hash");
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
    criteria: [{ id: "AC1", verdict: "PASS", reason: "evidence shows 200" }],
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
    criteria: [{ id: "AC1", verdict: "PASS", reason: "the capture shows the widget" }],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captureRun = parsed.mechanical.runs.find((r) => r.kind === "capture");
  assert.equal(captureRun.criterionId, "AC1");
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
    criteria: [{ id: "AC1", verdict: "PASS", reason: "render() added" }],
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
