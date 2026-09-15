import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shipScript = path.join(repoRoot, "skills", "ship", "scripts", "prd_ship.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
  if (!options.allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-ship-report-"));
  run("git", ["init", "-q"], { cwd: root });
  run("git", ["config", "user.name", "test"], { cwd: root });
  run("git", ["config", "user.email", "test@example.test"], { cwd: root });
  write(path.join(root, ".gitignore"), "agents/\n");
  write(path.join(root, "src", "feature.js"), "export const ready = false;\n");
  run("git", ["add", ".gitignore", "src/feature.js"], { cwd: root });
  run("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  write(path.join(root, "src", "feature.js"), "export const ready = true;\n");
  run("git", ["add", "src/feature.js"], { cwd: root });
  run("git", ["commit", "-q", "-m", "Implement feature"], { cwd: root });
  const implementationHead = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  const runDir = "agents/runs/fixture";
  const statePath = path.join(root, runDir, "state.json");
  const identity = {
    schema: "sasu.verification-report.v1",
    inputFingerprint: "input-current",
    prdSha256: "a".repeat(64),
    baseSha: head,
    headSha: implementationHead,
    sourceFingerprint: "source-current",
    generatedAt: "2026-09-15T00:00:00.000Z",
    status: "PASS",
    jsonPath: `${runDir}/verification-report.json`,
    markdownPath: `${runDir}/verification-report.md`,
  };
  const latest = {
    id: "verify-1",
    inputFingerprint: identity.inputFingerprint,
    prdSha256: identity.prdSha256,
    sourceFingerprint: identity.sourceFingerprint,
    verdict: "PASS",
  };
  const report = {
    ...identity,
    ownedFiles: ["src/feature.js"],
    requiredCommands: [{
      id: "S1",
      command: "node test.js",
      cwd: ".",
      excluded: false,
      result: { status: "GREEN", exitCode: 0, durationMs: 12, logPath: `${runDir}/artifacts/logs/test.log` },
    }],
    evidence: [],
    error: null,
    agentReview: { status: "NOT_RUN", authority: "advisory", instruction: "Run native review." },
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  identity.reportSha256 = crypto.createHash("sha256").update(reportText).digest("hex");
  const state = {
    schema: "sasu.implement.state.v11.stateless-verification",
    status: "active",
    topicSlug: "fixture",
    projectRoot: root,
    worktree: null,
    runDir,
    prdPath: "agents/prd/fixture/prd.md",
    delivery: { mode: "local" },
    initialSource: { head },
    baselineAttribution: { head },
    verificationAttempts: [latest],
    verificationReport: identity,
  };
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(path.join(root, runDir, "verification-report.json"), reportText);
  write(path.join(root, runDir, "verification-report.md"), "# Verification report\n\nStatus: **PASS**\n");

  const bin = path.join(root, "agents", "test-bin");
  write(path.join(bin, "sasu"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "rules") {
  process.stdout.write(JSON.stringify({ok:true,results:[],failures:[],manualConfirmations:[],pending:{count:0,items:[]}}));
  process.exit(0);
}
const statePath = args[args.indexOf("--state") + 1];
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const latest = state.verificationAttempts.at(-1);
process.stdout.write(JSON.stringify({ok:true,detail:{status:state.status,verification:{verdict:"PASS",latest},verificationReport:state.verificationReport,delivery:{eligible:true,reasons:[]},artifactProblems:[]}}));
`, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { root, statePath, state, report, env };
}

test("local delivery accepts a report bound to the already committed implementation head", () => {
  const current = fixture();
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath, "--no-gpg-sign"], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "local");
  assert.equal(output.commit.existing, true);
  assert.deepEqual(output.commit.staged, []);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: current.root }).stdout.trim(), "Implement feature");
});

test("local delivery never amends a verified checkpoint commit", () => {
  const current = fixture();
  run("git", ["commit", "--amend", "-q", "-m", "checkpoint: implementation"], { cwd: current.root });
  const checkpointHead = run("git", ["rev-parse", "HEAD"], { cwd: current.root }).stdout.trim();
  current.report.headSha = checkpointHead;
  const reportText = `${JSON.stringify(current.report, null, 2)}\n`;
  current.state.verificationReport.headSha = checkpointHead;
  current.state.verificationReport.reportSha256 = crypto.createHash("sha256").update(reportText).digest("hex");
  current.state.verificationAttempts[0].sourceFingerprint = current.report.sourceFingerprint;
  write(path.join(current.root, current.report.jsonPath), reportText);
  write(current.statePath, `${JSON.stringify(current.state, null, 2)}\n`);

  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath, "--no-gpg-sign"], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.commit.existing, true);
  assert.equal(output.commit.promotedCheckpoint, false);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: current.root }).stdout.trim(), checkpointHead);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: current.root }).stdout.trim(), "checkpoint: implementation");
});

test("PR body draft exposes deterministic checks and both review disposition sections", () => {
  const current = fixture();
  const result = run(process.execPath, [shipScript, "body", "--state", current.statePath], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  const body = fs.readFileSync(path.join(current.root, output.bodyPath), "utf8");
  assert.match(body, /## Deterministic Verification/);
  assert.match(body, /S1: GREEN/);
  assert.match(body, /## Agent Review: Fix Now/);
  assert.match(body, /## Agent Review: Follow-up Improvements/);
  assert.match(body, /verification-report\.json/);
});

test("delivery refuses a stale report identity before staging", () => {
  const current = fixture();
  const state = JSON.parse(fs.readFileSync(current.statePath, "utf8"));
  state.verificationReport.sourceFingerprint = "source-newer";
  fs.writeFileSync(current.statePath, JSON.stringify(state));
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the current state identity/);
  assert.equal(run("git", ["diff", "--cached", "--name-only"], { cwd: current.root }).stdout.trim(), "");
});

test("delivery refuses a report whose body was edited after verification", () => {
  const current = fixture();
  const reportPath = path.join(current.root, "agents", "runs", "fixture", "verification-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.ownedFiles = ["src/unrelated.js"];
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the current state identity/);
});

test("old receipt-era state is rejected explicitly", () => {
  const current = fixture();
  const state = JSON.parse(fs.readFileSync(current.statePath, "utf8"));
  state.schema = "sasu.implement.state.v10";
  fs.writeFileSync(current.statePath, JSON.stringify(state));
  const result = run(process.execPath, [shipScript, "body", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected sasu\.implement\.state\.v11\.stateless-verification/);
  assert.match(result.stderr, /last supported commit/);
});
