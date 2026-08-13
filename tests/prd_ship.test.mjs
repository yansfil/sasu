import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { stripSessionEnv } from "./helpers/session_env.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shipScript = path.join(repoRoot, "skills", "ship", "scripts", "prd_ship.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    shell: false,
    encoding: "utf8",
    env: options.env || stripSessionEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function write(file, text, mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  if (mode !== null) fs.chmodSync(file, mode);
}

function initMergeFixture({ includeDelivery = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prd-ship-merge-"));
  const bare = `${root}-origin.git`;
  run("git", ["init", "--bare", bare], { cwd: os.tmpdir() });
  run("git", ["init", "-b", "main"], { cwd: root });
  run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  run("git", ["config", "user.name", "Harness Test"], { cwd: root });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  write(path.join(root, "README.md"), "# Test\n");
  run("git", ["add", "README.md"], { cwd: root });
  run("git", ["commit", "-m", "Initial"], { cwd: root });
  run("git", ["remote", "add", "origin", bare], { cwd: root });
  run("git", ["push", "-u", "origin", "main"], { cwd: root });
  run("git", ["checkout", "-b", "prd/merge-flow"], { cwd: root });
  write(path.join(root, "src", "feature.js"), "export const ready = true;\n");
  run("git", ["add", "src/feature.js"], { cwd: root });
  run("git", ["commit", "-m", "Add reviewed feature"], { cwd: root });
  run("git", ["push", "-u", "origin", "prd/merge-flow"], { cwd: root });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  const stateDir = path.join(root, "agents", "implement", "merge-flow");
  const statePath = path.join(stateDir, "state.json");
  const state = {
    schema: "sasu.implement.state.v3",
    status: "complete",
    topicSlug: "merge-flow",
    projectRoot: root,
    runDir: "agents/implement/merge-flow",
    completion: { fingerprint: "fixture-completion" },
  };
  if (includeDelivery) state.delivery = { mode: "pr", branch: "prd/merge-flow", baseBranch: "main" };
  write(statePath, JSON.stringify(state, null, 2));
  write(path.join(stateDir, "receipt.json"), JSON.stringify({
    schema: "sasu.implement.receipt.v3",
    status: "complete",
    completionFingerprint: "fixture-completion",
  }, null, 2));

  const bin = path.join(root, "fake-bin");
  const ghLog = path.join(root, "gh.log");
  const mergedMarker = path.join(root, "merged.marker");
  write(path.join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  printf '%s\\n' '[{"name":"ci","state":"SUCCESS","bucket":"pass","link":"https://example.test/ci"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  touch "$FAKE_GH_MERGED"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$FAKE_GH_MERGED" ]; then
    printf '{"number":7,"url":"https://example.test/pr/7","state":"MERGED","isDraft":false,"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","headRefName":"prd/merge-flow","headRefOid":"%s","baseRefName":"main","statusCheckRollup":[],"mergedAt":"2026-07-14T12:00:00Z","mergeCommit":{"oid":"merged-commit-sha"}}\\n' "$FAKE_HEAD_SHA"
  else
    printf '{"number":7,"url":"https://example.test/pr/7","state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","headRefName":"prd/merge-flow","headRefOid":"%s","baseRefName":"main","statusCheckRollup":[],"mergedAt":null,"mergeCommit":null}\\n' "$FAKE_HEAD_SHA"
  fi
  exit 0
fi
exit 1
`, 0o755);
  write(path.join(bin, "sasu"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.startsWith("rules check")) {
  process.stdout.write(JSON.stringify({ ok: true, results: [], failures: [], manualConfirmations: [], pending: { count: 0, items: [] } }) + "\\n");
} else if (args.startsWith("implement status")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    detail: {
      status: "complete",
      verification: { verdict: "PASS" },
      artifactProblems: [],
      completion: { fingerprint: "fixture-completion" }
    }
  }) + "\\n");
} else {
  process.stderr.write("unexpected sasu command: " + args + "\\n");
  process.exit(1);
}
`, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_MERGED: mergedMarker,
    FAKE_HEAD_SHA: head,
  };
  return { root, stateDir, statePath, head, ghLog, env };
}

test("merge requires explicit user approval before contacting GitHub", () => {
  const fixture = initMergeFixture();
  const result = run(process.execPath, [shipScript, "merge", "--state", fixture.statePath, "--pr", "https://example.test/pr/7"], {
    cwd: fixture.root,
    env: fixture.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --approval/);
  assert.equal(fs.existsSync(fixture.ghLog), false);
});

test("merge pins the reviewed PR head, requires passing CI, and records delivery evidence", () => {
  const fixture = initMergeFixture();
  const result = run(process.execPath, [
    shipScript,
    "merge",
    "--state", fixture.statePath,
    "--pr", "https://example.test/pr/7",
    "--approval", "User approved merge after CI passes",
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.status, "merged");
  assert.equal(output.ci.verdict, "pass");
  assert.equal(output.merge.matchedHeadCommit, fixture.head);
  assert.equal(output.merge.commit, "merged-commit-sha");

  const calls = fs.readFileSync(fixture.ghLog, "utf8");
  assert.match(calls, new RegExp(`pr merge .* --squash --match-head-commit ${fixture.head}`));
  const deliveryResult = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "delivery", "delivery-result.json"), "utf8"));
  assert.equal(deliveryResult.pr.url, "https://example.test/pr/7");
  assert.equal(deliveryResult.approval, "User approved merge after CI passes");
  const shipLog = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8");
  assert.match(shipLog, /"event":"merge"/);
});

test("merge records a later explicit PR-delivery approval for v3 state without delivery config", () => {
  const fixture = initMergeFixture({ includeDelivery: false });
  const approval = "User approved immediate merge";
  const result = run(process.execPath, [
    shipScript,
    "merge",
    "--state", fixture.statePath,
    "--pr", "https://example.test/pr/7",
    "--approval", approval,
    "--override-mode",
    "--reason", approval,
  ], { cwd: fixture.root, env: fixture.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "merged");
  assert.deepEqual(output.overrides, [{ kind: "mode", from: "local", reason: approval }]);

  const deliveryResult = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "delivery", "delivery-result.json"), "utf8"));
  assert.deepEqual(deliveryResult.overrides, output.overrides);
  const shipLog = fs.readFileSync(path.join(fixture.stateDir, "delivery", "ship-log.jsonl"), "utf8");
  assert.match(shipLog, /"kind":"mode"/);
  assert.match(shipLog, /User approved immediate merge/);
});
