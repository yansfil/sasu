import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, parseImplementState } from "../../dist/implement/store.js";

test("v5 state is rejected instead of being migrated into the v6 check contract", () => {
  assert.throws(() => parseImplementState(JSON.stringify({
    schema: "sasu.implement.state.v5",
    status: "active",
    topicSlug: "fixture",
    projectRoot: "/tmp/fixture",
    worktree: null,
    runDir: "agents/runs/fixture",
    prdPath: "agents/prd/fixture/prd.md",
    prd: {
      sha256: "prd-sha",
      snapshotPath: "agents/runs/fixture/prd.md",
      reviewProfile: "high-risk",
    },
    initialSource: { head: null, digest: "source", entries: [] },
    baselineAttribution: { disposition: "clean", paths: [], baselineDigest: "source", head: null },
    tasks: [],
    requirements: [],
    acceptanceCriteria: [],
    verification: [],
    deviations: [],
    artifacts: [],
    verificationAttempts: [],
    retirement: null,
    completion: null,
  })), /unsupported implement state schema sasu\.implement\.state\.v5.*accepts only sasu\.implement\.state\.v6/);
});

test("source freshness is commit-invariant when judged bytes do not change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-fingerprint-"));
  fs.writeFileSync(path.join(root, "source.txt"), "same bytes\n");
  for (const args of [["init", "-q"], ["config", "user.name", "fixture"], ["config", "user.email", "fixture@example.com"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  const before = captureSourceSnapshot(root);
  assert.equal(spawnSync("git", ["add", "source.txt"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-q", "-m", "same tree"], { cwd: root }).status, 0);
  const after = captureSourceSnapshot(root);
  assert.notEqual(before.head, after.head);
  assert.equal(before.digest, after.digest);
});

test("baseline snapshot pins dirty paths to HEAD so pre-start work stays run-owned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-baseline-"));
  try {
    fs.writeFileSync(path.join(root, "base.txt"), "committed body\n");
    fs.writeFileSync(path.join(root, "gone.txt"), "deleted later\n");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "fixture"],
      ["config", "user.email", "fixture@example.com"],
      ["add", "base.txt", "gone.txt"],
      ["commit", "-q", "-m", "baseline"],
    ]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    // The restart scenario: implementation work exists before `implement start`.
    fs.writeFileSync(path.join(root, "base.txt"), "modified before start\n");
    fs.writeFileSync(path.join(root, "new.txt"), "untracked implementation\n");
    fs.rmSync(path.join(root, "gone.txt"));

    const dirty = dirtySourcePaths(root);
    assert.throws(
      () => captureBaselineSnapshot(root, [{ path: "base.txt", disposition: "pre-existing" }]),
      /dirty source paths changed while binding baseline attribution \(added: gone\.txt, new\.txt\)/,
    );
    const baseline = captureBaselineSnapshot(root, dirty.map((entry) => ({ path: entry, disposition: "run-owned" })));
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("base.txt").sha256, captureSourceSnapshotSha("committed body\n"));
    assert.equal(byPath.has("new.txt"), false, "a file absent at HEAD is run-owned work, not baseline");
    assert.equal(byPath.get("gone.txt").sha256, captureSourceSnapshotSha("deleted later\n"));

    const working = captureSourceSnapshot(root);
    assert.deepEqual(changedPathsSince(baseline, working), ["base.txt", "gone.txt", "new.txt"]);

    const mixed = captureBaselineSnapshot(root, dirty.map((entry) => ({
      path: entry,
      disposition: entry === "base.txt" ? "pre-existing" : "run-owned",
    })));
    assert.deepEqual(changedPathsSince(mixed, working), ["gone.txt", "new.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline snapshot without a git HEAD is the working tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-baseline-plain-"));
  try {
    fs.writeFileSync(path.join(root, "only.txt"), "no repository here\n");
    const baseline = captureBaselineSnapshot(root, []);
    const working = captureSourceSnapshot(root);
    assert.deepEqual(baseline, working);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function captureSourceSnapshotSha(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-sha-"));
  try {
    fs.writeFileSync(path.join(dir, "f"), body);
    return captureSourceSnapshot(dir).entries[0].sha256;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("source snapshot excludes only the root agents bookkeeping namespace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-agents-"));
  try {
    fs.mkdirSync(path.join(root, "agents", "implement"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "agents", "implement", "state.json"), "bookkeeping\n");
    fs.writeFileSync(path.join(root, "src", "agents", "worker.ts"), "export const worker = true;\n");

    const snapshot = captureSourceSnapshot(root);

    assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["src/agents/worker.ts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact integrity pins file identity without coupling it to the source tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-artifact-integrity-"));
  try {
    fs.mkdirSync(path.join(root, "proof"), { recursive: true });
    fs.writeFileSync(path.join(root, "source.txt"), "implementation\n");
    fs.writeFileSync(path.join(root, "proof", "run.log"), "runtime observation\n");
    const artifactSha = captureSourceSnapshot(root).entries.find((entry) => entry.path === "proof/run.log").sha256;
    const state = {
      artifacts: [{
        verificationId: "V1",
        path: "proof/run.log",
        sha256: artifactSha,
        sourceFingerprint: "legacy-v5-field-is-ignored",
      }],
    };

    fs.writeFileSync(path.join(root, "source.txt"), "implementation revised\n");
    assert.deepEqual(artifactIntegrityProblems(root, state), []);

    fs.writeFileSync(path.join(root, "proof", "run.log"), "different bytes\n");
    assert.match(artifactIntegrityProblems(root, state).join("\n"), /artifact hash changed: proof\/run\.log/);

    fs.rmSync(path.join(root, "proof", "run.log"));
    assert.match(artifactIntegrityProblems(root, state).join("\n"), /artifact missing: proof\/run\.log/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
