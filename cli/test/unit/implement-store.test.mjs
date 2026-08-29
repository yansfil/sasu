import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, parseImplementState } from "../../dist/implement/store.js";

test("v6 state is rejected instead of being migrated into the v7 supervision contract", () => {
  assert.throws(() => parseImplementState(JSON.stringify({
    schema: "sasu.implement.state.v6",
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
  })), /unsupported implement state schema sasu\.implement\.state\.v6.*accepts only sasu\.implement\.state\.v7/);
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

// v7 makes the six supervision ledgers required rather than
// normalized-if-missing. A state that cannot say what suite it was sealed
// against must fail loudly, not load as "no suite" (PRINCIPLES 10).
const v7Fixture = (overrides = {}) => JSON.stringify({
  schema: "sasu.implement.state.v7",
  status: "active",
  topicSlug: "fixture",
  projectRoot: "/tmp/fixture",
  worktree: null,
  runDir: "agents/runs/fixture",
  prdPath: "agents/prd/fixture/prd.md",
  prd: { sha256: "prd-sha", snapshotPath: "agents/runs/fixture/prd.md", reviewProfile: "high-risk" },
  initialSource: { head: null, digest: "source", entries: [] },
  baselineAttribution: { disposition: "clean", paths: [], baselineDigest: "source", head: null },
  tasks: [],
  requirements: [],
  acceptanceCriteria: [],
  verification: [],
  deviations: [],
  artifacts: [],
  verificationAttempts: [],
  riskFindings: [],
  events: [],
  verbs: [],
  amendments: [],
  suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands: [], exclusions: [], results: [] },
  qaBriefs: [],
  trails: [],
  escalations: [],
  retirement: null,
  completion: null,
  ...overrides,
});

test("a v7 state carrying all six supervision ledgers loads", () => {
  const state = parseImplementState(v7Fixture());
  assert.equal(state.schema, "sasu.implement.state.v7");
  assert.deepEqual(state.events, []);
  assert.equal(state.suite.sealedAt, "2026-08-29T00:00:00.000Z");
});

test("a v7 state missing the sealed suite list is malformed, not defaulted", () => {
  const { suite, ...withoutSuite } = JSON.parse(v7Fixture());
  assert.throws(() => parseImplementState(JSON.stringify(withoutSuite)), /suite/);
});

test("event ids must be integers that strictly increase", () => {
  const event = (id) => ({ id, at: "2026-08-29T00:00:00.000Z", kind: "task-status", actor: "implementor", subject: "T1", summary: "s" });
  assert.throws(
    () => parseImplementState(v7Fixture({ events: [event(2), event(2)] })),
    /events\[1\]\.id must be an integer greater than the previous event id/,
  );
  assert.throws(
    () => parseImplementState(v7Fixture({ events: [event(2), event(1)] })),
    /events\[1\]\.id must be an integer greater than the previous event id/,
  );
  assert.equal(parseImplementState(v7Fixture({ events: [event(1), event(7)] })).events.length, 2);
});

test("a rejected verb must name which of the three checks refused it", () => {
  const verb = (extra) => ({ id: 1, at: "2026-08-29T00:00:00.000Z", verb: "park", issuer: "observer", target: "AC7", reason: "r", ...extra });
  assert.throws(
    () => parseImplementState(v7Fixture({ verbs: [verb({ outcome: "rejected", rejection: null })] })),
    /verbs\[0\]\.rejection/,
  );
  assert.throws(
    () => parseImplementState(v7Fixture({ verbs: [verb({ outcome: "rejected", rejection: { check: "vibes", message: "m" } })] })),
    /rejection\.check must be arguments, authority, or transition/,
  );
  assert.throws(
    () => parseImplementState(v7Fixture({ verbs: [verb({ outcome: "accepted", rejection: { check: "authority", message: "m" } })] })),
    /rejection must be null when outcome is accepted/,
  );
});

test("a suite exclusion without a human approval quote is malformed", () => {
  assert.throws(
    () => parseImplementState(v7Fixture({
      suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands: [], exclusions: [{ at: "x", commandId: "S1", reason: "flaky" }], results: [] },
    })),
    /suite\.exclusions\[0\]\.approval/,
  );
});

test("an amendment issued by anyone but a human is malformed", () => {
  assert.throws(
    () => parseImplementState(v7Fixture({
      amendments: [{
        id: 1, at: "x", issuer: "observer", approval: "ok", reason: "r",
        prdSha256: "a", snapshotPath: "p", previousSnapshotPath: "q",
        invalidatedCriteria: [], addedCriteria: [], unparkedCriteria: [], suiteSnapshotUpdated: false,
      }],
    })),
    /amendments\[0\]\.issuer must be human/,
  );
});

test("a trail driven by the implementor or the solver is malformed", () => {
  for (const driverRole of ["implementor", "solver"]) {
    assert.throws(
      () => parseImplementState(v7Fixture({
        trails: [{ id: 1, at: "x", criterionId: "AC38", briefId: "B1", driverRole, coveredStepIds: ["S1"], artifactPaths: [], status: "accepted" }],
      })),
      /driverRole must be human, observer, or qa-agent/,
    );
  }
});

test("a failed solver summon cannot claim a handoff, and a successful one must carry it", () => {
  const base = { id: 1, at: "x", target: "T5", reason: "stuck", profile: "high-risk", model: null };
  assert.throws(
    () => parseImplementState(v7Fixture({
      escalations: [{ ...base, outcome: "summon-failed", diagnosis: null, error: "boom", handoff: { prdSnapshotPath: "a", diagnosisPath: "b", checkLedgerPath: "c" } }],
    })),
    /handoff must be null when the summon failed/,
  );
  assert.throws(
    () => parseImplementState(v7Fixture({
      escalations: [{ ...base, outcome: "diagnosed", diagnosis: "d", error: null, handoff: null }],
    })),
    /escalations\[0\]\.handoff/,
  );
});

test("two qa briefs may not share a briefId", () => {
  const brief = { briefId: "B1", criterionId: "AC38", issuedAt: "x", prdSha256: "a", steps: [{ id: "S1", text: "t" }] };
  assert.throws(
    () => parseImplementState(v7Fixture({ qaBriefs: [brief, { ...brief, criterionId: "AC47" }] })),
    /duplicate qa brief id B1/,
  );
});
