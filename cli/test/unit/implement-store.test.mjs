import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { artifactSourceFingerprint, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince } from "../../dist/implement/store.js";

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

    const baseline = captureBaselineSnapshot(root);
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("base.txt").sha256, captureSourceSnapshotSha("committed body\n"));
    assert.equal(byPath.has("new.txt"), false, "a file absent at HEAD is run-owned work, not baseline");
    assert.equal(byPath.get("gone.txt").sha256, captureSourceSnapshotSha("deleted later\n"));

    const working = captureSourceSnapshot(root);
    assert.deepEqual(changedPathsSince(baseline, working), ["base.txt", "gone.txt", "new.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline snapshot without a git HEAD is the working tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-baseline-plain-"));
  try {
    fs.writeFileSync(path.join(root, "only.txt"), "no repository here\n");
    const baseline = captureBaselineSnapshot(root);
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

test("an artifact's freshness basis excludes its own bytes and nothing else", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-artifact-fingerprint-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "code.txt"), "implementation\n");
  fs.writeFileSync(path.join(root, "docs", "evidence.md"), "first observation\n");
  const before = artifactSourceFingerprint(captureSourceSnapshot(root), "docs/evidence.md");

  // The artifact's own file changing must not move its basis: its bytes are
  // already pinned by the artifact's sha256, so counting them twice only makes
  // evidence invalidate itself.
  fs.appendFileSync(path.join(root, "docs", "evidence.md"), "second observation\n");
  assert.equal(artifactSourceFingerprint(captureSourceSnapshot(root), "docs/evidence.md"), before);

  // Any other file changing still moves it: the artifact proves something
  // about the tree, and the tree moved.
  fs.writeFileSync(path.join(root, "code.txt"), "implementation, revised\n");
  assert.notEqual(artifactSourceFingerprint(captureSourceSnapshot(root), "docs/evidence.md"), before);

  // A path that names no snapshot entry falls back to the whole-tree digest.
  const snapshot = captureSourceSnapshot(root);
  assert.equal(artifactSourceFingerprint(snapshot, "docs/never-registered.md"), snapshot.digest);
});
