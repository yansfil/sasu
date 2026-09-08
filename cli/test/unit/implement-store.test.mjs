import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";

import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, parseImplementState, persistClose, persistState } from "../../dist/implement/store.js";

import { stateFixture, attemptFixture, humanFinding, AT } from "../helpers/implement-state.mjs";

test("retired states are refused before reading their fields with the last supporting commit", () => {
  for (const version of ["v5", "v6", "v7", "v8"]) {
    assert.throws(() => parseImplementState(JSON.stringify({ schema: `sasu.implement.state.${version}` })), /unsupported implement state schema.*sasu.implement.state.v9.*488d3cc/);
  }
});

test("source freshness is commit-invariant when judged bytes do not change", () => {
  const root = scratchDir("sasu-source-fingerprint-");
  fs.writeFileSync(path.join(root, "source.txt"), "same bytes\n");
  for (const args of [["init", "-q"], ["config", "user.name", "fixture"], ["config", "user.email", "fixture@example.com"], ["config", "commit.gpgsign", "false"]]) {
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
  const root = scratchDir("sasu-baseline-");
  try {
    fs.writeFileSync(path.join(root, "base.txt"), "committed body\n");
    fs.writeFileSync(path.join(root, "gone.txt"), "deleted later\n");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "fixture"],
      ["config", "user.email", "fixture@example.com"],
      ["config", "commit.gpgsign", "false"],
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
  const root = scratchDir("sasu-baseline-plain-");
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
  const dir = scratchDir("sasu-sha-");
  try {
    fs.writeFileSync(path.join(dir, "f"), body);
    return captureSourceSnapshot(dir).entries[0].sha256;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("source snapshot excludes only the root agents bookkeeping namespace", () => {
  const root = scratchDir("sasu-source-agents-");
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
  const root = scratchDir("sasu-artifact-integrity-");
  try {
    fs.mkdirSync(path.join(root, "proof"), { recursive: true });
    fs.writeFileSync(path.join(root, "source.txt"), "implementation\n");
    fs.writeFileSync(path.join(root, "proof", "run.log"), "runtime observation\n");
    const artifactSha = captureSourceSnapshot(root).entries.find((entry) => entry.path === "proof/run.log").sha256;
    const state = {
      artifacts: [{
        rowId: "B1",
        path: "proof/run.log",
        sha256: artifactSha,
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

test("static requirements cannot carry retired lifecycle or proof fields", () => {
  assert.equal(parseImplementState(JSON.stringify(stateFixture())).requirements.length, 1);
  assert.throws(() => parseImplementState(JSON.stringify(stateFixture(undefined, { requirements: [] }))), /requirements must not be empty/);
  const state = stateFixture();
  state.requirements[0].status = "PASS";
  assert.throws(() => parseImplementState(JSON.stringify(state)), /requirement field: status/);
  const missing = stateFixture();
  delete missing.suite;
  assert.throws(() => parseImplementState(JSON.stringify(missing)), /suite/);
});

test("a PASS must agree with the whole-review and mechanical results", () => {
  const state = stateFixture(undefined, { verificationAttempts: [attemptFixture({ phase: "complete", verdict: "PASS" })] });
  assert.throws(() => parseImplementState(JSON.stringify(state)), /PASS contradicts/);
  state.verificationAttempts[0].verdict = "ERROR";
  assert.doesNotThrow(() => parseImplementState(JSON.stringify(state)), "a pre-judge error is honest history");
});

test("human confirmations and rejections cannot be promoted by review", () => {
  for (const status of ["resolved", "confirmed"]) {
    assert.throws(() => parseImplementState(JSON.stringify(stateFixture(undefined, { findings: [humanFinding({ status })] }))), /human/);
  }
  const finding = humanFinding({ responses: [{ at: AT, response: "rejected", evidence: "TEST-FIXTURE: reject this result" }] });
  const review = { invocationId: "J1", startedAt: AT, finishedAt: AT, durationMs: 0, verdict: "PASS", result: { summary: "Full review complete", findings: [], priorDispositions: [] }, judge: null, error: null };
  const completed = { findings: [finding], verificationAttempts: [attemptFixture({ verdict: "PASS", review })], completion: { fingerprint: "a".repeat(64), completedAt: AT, receiptPath: "agents/receipt.json", implementationResultPath: "agents/result.md" } };
  assert.doesNotThrow(() => parseImplementState(JSON.stringify(stateFixture(undefined, { ...completed, status: "complete-pending-human" }))));
  assert.throws(() => parseImplementState(JSON.stringify(stateFixture(undefined, { ...completed, status: "complete" }))), /contradicts human findings/);
});

test("CAS rejects a stale close without publishing its receipt", (t) => {
  const root = scratchDir("sasu-store-close-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "agents/runs/fixture/state.json");
  persistState(statePath, stateFixture(root));
  const stale = loadState(root, { slug: "fixture" }).state;
  const winner = loadState(root, { slug: "fixture" }).state;
  winner.deviations.push({ at: AT, type: "fixture", summary: "another write won" });
  persistState(statePath, winner);
  const receipt = path.join(root, "agents/runs/fixture/receipt.json");
  assert.throws(() => persistClose(statePath, stale, [{ file: receipt, text: "stale" }]), /state changed on disk/);
  assert.equal(fs.existsSync(receipt), false);
  assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((entry) => entry.endsWith(".tmp")), []);
  persistClose(statePath, loadState(root, { slug: "fixture" }).state, [{ file: receipt, text: "current" }]);
  assert.equal(fs.readFileSync(receipt, "utf8"), "current");
});

test("event and refusal ledgers reject contradictory records", () => {
  const event = { id: 1, at: AT, kind: "verify", actor: "implementor", subject: null, summary: "one event" };
  assert.throws(() => parseImplementState(JSON.stringify(stateFixture(undefined, { events: [event, event] }))), /events.*id/);
  const verb = { id: 1, at: AT, verb: "verify", issuer: "observer", target: null, reason: "fixture", outcome: "rejected", rejection: null };
  assert.throws(() => parseImplementState(JSON.stringify(stateFixture(undefined, { verbs: [verb] }))), /rejection/);
});
