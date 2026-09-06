import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";

import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, parseImplementState, persistClose, persistState } from "../../dist/implement/store.js";

// R10: one loader, one schema. Every earlier schema is refused with the same
// sentence rather than migrated, so a v8 CLI can never half-read a v7 run.
test("v5, v6 and v7 states are refused with one explicit error, never migrated", () => {
  for (const version of ["v5", "v6", "v7"]) {
    assert.throws(() => parseImplementState(JSON.stringify({
      schema: `sasu.implement.state.${version}`,
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
      acceptanceCriteria: [],
      artifacts: [],
      verificationAttempts: [],
      retirement: null,
      completion: null,
    })), new RegExp(`unsupported implement state schema sasu\\.implement\\.state\\.${version}.*accepts only sasu\\.implement\\.state\\.v8`));
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

const SHA = "a".repeat(64);

const checkRow = (attempts, overrides = {}) => ({
  id: "B1",
  behavior: "the runner runs once",
  check: { kind: "check", command: "npm test", argv: ["npm", "test"] },
  decisionIds: [],
  status: "pending",
  attempts,
  consecutiveFailures: 0,
  parks: [],
  verdict: null,
  human: null,
  rejections: [],
  ...overrides,
});

const judgeRow = (overrides = {}) => ({
  id: "B2",
  behavior: "the summary is readable",
  check: { kind: "judge", evidence: "a capture of the summary" },
  decisionIds: [],
  status: "pending",
  attempts: [],
  consecutiveFailures: 0,
  parks: [],
  verdict: null,
  human: null,
  rejections: [],
  ...overrides,
});

const humanRow = (overrides = {}) => ({
  id: "B3",
  behavior: "the operator likes the layout",
  check: { kind: "human", confirmation: "the operator says so" },
  decisionIds: [],
  status: "OPEN",
  attempts: [],
  consecutiveFailures: 0,
  parks: [],
  verdict: null,
  human: null,
  rejections: [],
  ...overrides,
});

// v8 requires every ledger rather than defaulting a missing one: a state
// that cannot say what suite it was sealed against must fail loudly, not
// load as "no suite" (PRINCIPLES 10).
const v8Fixture = (overrides = {}) => JSON.stringify({
  schema: "sasu.implement.state.v8",
  status: "active",
  topicSlug: "fixture",
  projectRoot: "/tmp/fixture",
  worktree: null,
  runDir: "agents/runs/fixture",
  prdPath: "agents/prd/fixture/prd.md",
  prd: { sha256: "prd-sha", snapshotPath: "agents/runs/fixture/prd.md", reviewProfile: "high-risk" },
  initialSource: { head: null, digest: "source", entries: [] },
  baselineAttribution: { disposition: "clean", paths: [], baselineDigest: "source", head: null },
  rows: [checkRow([])],
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

const attempt = (overrides) => ({
  id: "A1",
  startedAt: "2026-08-29T00:00:01.000Z",
  finishedAt: "2026-08-29T00:00:02.000Z",
  durationMs: 1000,
  exitCode: 0,
  timedOut: false,
  signal: null,
  mutatedTree: false,
  outcome: "green",
  outputFingerprint: SHA,
  failureClass: null,
  tree: { all: SHA, product: SHA, bookkeeping: SHA },
  ...overrides,
});

test("a v8 state with every ledger loads and a state with no Behaviors row is malformed", () => {
  const state = parseImplementState(v8Fixture());
  assert.equal(state.schema, "sasu.implement.state.v8");
  assert.deepEqual(state.events, []);
  assert.throws(() => parseImplementState(v8Fixture({ rows: [] })), /rows must hold at least one Behaviors row/);
  const { suite, ...withoutSuite } = JSON.parse(v8Fixture());
  assert.throws(() => parseImplementState(JSON.stringify(withoutSuite)), /suite/);
});

test("a row status is re-derived from its ledger, so no writer can promote a row by editing one word", () => {
  assert.equal(parseImplementState(v8Fixture({ rows: [checkRow([attempt({})], { status: "green" })] })).rows[0].status, "green");
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [checkRow([attempt({ exitCode: 1, outcome: "failed", failureClass: SHA })], { status: "green" })] })),
    /rows\[0\]\.status green contradicts the harness-owned ledger \(expected fail\)/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [checkRow([attempt({ exitCode: 1, outcome: "failed", failureClass: SHA })], { status: "fail" })] })),
    /consecutiveFailures contradicts the harness-owned attempt ledger \(expected 1\)/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [judgeRow({ status: "PASS" })] })),
    /rows\[0\]\.status PASS contradicts the harness-owned ledger \(expected pending\)/,
  );
  assert.equal(parseImplementState(v8Fixture({ rows: [judgeRow({ status: "PASS", verdict: { attemptId: "attempt-1", verdict: "PASS", reason: "ok" } })] })).rows[0].status, "PASS");
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [humanRow({ status: "PASS" })] })),
    /rows\[0\]\.status PASS contradicts the harness-owned ledger \(expected OPEN\)/,
  );
  assert.equal(parseImplementState(v8Fixture({ rows: [humanRow({ status: "PASS", human: { confirmedAt: "2026-08-29T00:00:00.000Z", evidence: "looks right" } })] })).rows[0].status, "PASS");
});

test("a verdict that contradicts its recorded inputs is refused on read and on write, with nothing written", () => {
  const forged = attempt({ mutatedTree: true, outcome: "green" });
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [checkRow([forged], { status: "green" })] })),
    /attempts\[0\]\.outcome green contradicts the recorded process result \(expected tree-moved\)/,
  );
  // An attempt with no mutatedTree bit is not migrated any more; it is refused.
  const { mutatedTree, ...legacy } = attempt({});
  assert.throws(() => parseImplementState(v8Fixture({ rows: [checkRow([legacy], { status: "green" })] })), /mutatedTree must be boolean/);

  const root = scratchDir("sasu-store-persist-");
  try {
    const statePath = path.join(root, "agents", "runs", "fixture", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const honest = attempt({ mutatedTree: true, outcome: "tree-moved" });
    fs.writeFileSync(statePath, v8Fixture({ projectRoot: root, rows: [checkRow([honest], { status: "fail", consecutiveFailures: 1 })] }));
    const { state } = loadState(root, { slug: "fixture" });
    const before = fs.readFileSync(statePath, "utf8");
    state.rows[0].attempts[0].outcome = "green";
    state.rows[0].status = "green";
    state.rows[0].consecutiveFailures = 0;
    assert.throws(() => persistState(statePath, state), /refusing to write implement state.*attempts\[0\]\.outcome green contradicts/);
    assert.equal(fs.readFileSync(statePath, "utf8"), before, "the refused write left the file untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A close is state first, derived files after, under the run's close lock:
// the receipt on disk must always be a projection of the state on disk (risk
// finding RF1, prd-template run, 2026-09-06).
test("a close whose state write is rejected, or whose lock is held, writes no derived file", () => {
  const root = scratchDir("sasu-store-close-");
  try {
    const runDir = path.join(root, "agents", "runs", "fixture");
    const statePath = path.join(runDir, "state.json");
    fs.mkdirSync(runDir, { recursive: true });
    const honest = attempt({ mutatedTree: false, outcome: "green" });
    fs.writeFileSync(statePath, v8Fixture({ projectRoot: root, rows: [checkRow([honest], { status: "green" })] }));
    const receipt = path.join(runDir, "receipt.json");

    // Another closer replaced the record after this one loaded it.
    const { state: stale } = loadState(root, { slug: "fixture" });
    const { state: winner } = loadState(root, { slug: "fixture" });
    persistState(statePath, winner);
    assert.throws(() => persistClose(statePath, stale, [{ file: receipt, text: "stale\n" }]), /implement state changed on disk/);
    assert.equal(fs.existsSync(receipt), false, "a rejected state write leaves no derived file behind");

    // Another closer is mid-close: refused with nothing written, and the
    // refusal names the lock.
    const { state: fresh } = loadState(root, { slug: "fixture" });
    const lock = path.join(runDir, ".close.lock");
    fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: process.pid, hostname: os.hostname() }));
    const before = fs.readFileSync(statePath, "utf8");
    assert.throws(() => persistClose(statePath, fresh, [{ file: receipt, text: "held\n" }]), /another finalize or confirm is writing this run's record/);
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
    assert.equal(fs.existsSync(receipt), false);
    fs.unlinkSync(lock);

    // The ordinary close lands both and releases the lock.
    persistClose(statePath, fresh, [{ file: receipt, text: "landed\n" }]);
    assert.equal(fs.readFileSync(receipt, "utf8"), "landed\n");
    assert.equal(fs.existsSync(lock), false, "the close lock is released");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `amend` voids the proof filed against a rewritten row; the reader must draw
// the same boundary or the file amend writes is one nothing can open.
test("a green attempt earned before an amendment invalidated its row no longer counts", () => {
  const amendment = {
    id: 1, at: "2026-08-29T01:00:00.000Z", issuer: "human", scope: "behaviors", approval: "a", reason: "r", prdSha256: "p",
    snapshotPath: "s", previousSnapshotPath: "q", invalidatedRows: ["B1"], addedRows: [], unparkedRows: [], suiteSnapshotUpdated: false,
  };
  const green = attempt({});
  assert.equal(parseImplementState(v8Fixture({ amendments: [amendment], rows: [checkRow([green])] })).rows[0].status, "pending");
  assert.throws(
    () => parseImplementState(v8Fixture({ rows: [checkRow([green])] })),
    /status pending contradicts the harness-owned ledger \(expected green\)/,
    "without the amendment the same green attempt still proves the row",
  );
  const reproved = attempt({ id: "A2", startedAt: "2026-08-29T02:00:00.000Z", finishedAt: "2026-08-29T02:00:01.000Z" });
  assert.equal(parseImplementState(v8Fixture({ amendments: [amendment], rows: [checkRow([green, reproved], { status: "green" })] })).rows[0].status, "green");
});

test("a closed run's status is a function of its rows", () => {
  const proved = checkRow([attempt({})], { status: "green" });
  assert.equal(parseImplementState(v8Fixture({ status: "complete", rows: [proved] })).status, "complete");
  assert.throws(
    () => parseImplementState(v8Fixture({ status: "complete", rows: [proved, humanRow()] })),
    /status complete contradicts 1 OPEN human: row\(s\) \(expected complete-pending-human\)/,
  );
  assert.equal(parseImplementState(v8Fixture({ status: "complete-pending-human", rows: [proved, humanRow()] })).status, "complete-pending-human");
  assert.throws(
    () => parseImplementState(v8Fixture({ status: "complete", rows: [checkRow([])] })),
    /status complete with 1 unproved check:\/judge: row\(s\)/,
  );
});

test("event ids must be integers that strictly increase", () => {
  const event = (id) => ({ id, at: "2026-08-29T00:00:00.000Z", kind: "row-status", actor: "implementor", subject: "B1", summary: "s" });
  assert.throws(
    () => parseImplementState(v8Fixture({ events: [event(2), event(2)] })),
    /events\[1\]\.id must be an integer greater than the previous event id/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ events: [event(2), event(1)] })),
    /events\[1\]\.id must be an integer greater than the previous event id/,
  );
  assert.equal(parseImplementState(v8Fixture({ events: [event(1), event(7)] })).events.length, 2);
});

test("a rejected verb must name which of the three checks refused it", () => {
  const verb = (extra) => ({ id: 1, at: "2026-08-29T00:00:00.000Z", verb: "park", issuer: "observer", target: "B1", reason: "r", ...extra });
  assert.throws(
    () => parseImplementState(v8Fixture({ verbs: [verb({ outcome: "rejected", rejection: null })] })),
    /verbs\[0\]\.rejection/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ verbs: [verb({ outcome: "rejected", rejection: { check: "vibes", message: "m" } })] })),
    /rejection\.check must be arguments, authority, or transition/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ verbs: [verb({ outcome: "accepted", rejection: { check: "authority", message: "m" } })] })),
    /rejection must be null when outcome is accepted/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ verbs: [verb({ verb: "task", outcome: "accepted", rejection: null })] })),
    /verbs\[0\]\.verb must be one of/,
    "a verb the v8 vocabulary no longer has cannot be recorded",
  );
});

test("a suite exclusion without a human approval quote is malformed", () => {
  assert.throws(
    () => parseImplementState(v8Fixture({
      suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands: [], exclusions: [{ at: "x", commandId: "S1", reason: "flaky" }], results: [] },
    })),
    /suite\.exclusions\[0\]\.approval/,
  );
});

test("an observer amendment is valid only when it touched check cells alone", () => {
  const amendment = (issuer, scope) => ({
    id: 1, at: "x", issuer, scope, approval: "ok", reason: "r",
    prdSha256: "a", snapshotPath: "p", previousSnapshotPath: "q",
    invalidatedRows: [], addedRows: [], unparkedRows: [], suiteSnapshotUpdated: false,
  });
  assert.throws(
    () => parseImplementState(v8Fixture({ amendments: [amendment("observer", "behaviors")] })),
    /amendments\[0\]\.issuer must be human, or observer for a check-cells amendment/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({ amendments: [amendment("implementor", "check-cells")] })),
    /amendments\[0\]\.issuer must be human/,
  );
  assert.equal(parseImplementState(v8Fixture({ amendments: [amendment("observer", "check-cells")] })).amendments.length, 1);
  assert.equal(parseImplementState(v8Fixture({ amendments: [amendment("human", "behaviors")] })).amendments.length, 1);
});

test("a trail driven by the implementor or the solver is malformed", () => {
  for (const driverRole of ["implementor", "solver"]) {
    assert.throws(
      () => parseImplementState(v8Fixture({
        trails: [{ id: 1, at: "x", rowId: "B2", briefId: "B2-Q1-abc", driverRole, coveredStepIds: ["S1"], artifactPaths: [], status: "accepted" }],
      })),
      /driverRole must be human, observer, or qa-agent/,
    );
  }
});

test("a failed solver summon cannot claim a handoff, and a successful one must carry it", () => {
  const base = { id: 1, at: "x", target: "B1", reason: "stuck", profile: "high-risk", model: null };
  assert.throws(
    () => parseImplementState(v8Fixture({
      escalations: [{ ...base, outcome: "summon-failed", diagnosis: null, error: "boom", handoff: { prdSnapshotPath: "a", diagnosisPath: "b", checkLedgerPath: "c" } }],
    })),
    /handoff must be null when the summon failed/,
  );
  assert.throws(
    () => parseImplementState(v8Fixture({
      escalations: [{ ...base, outcome: "diagnosed", diagnosis: "d", error: null, handoff: null }],
    })),
    /escalations\[0\]\.handoff/,
  );
});

test("two qa briefs may not share a briefId", () => {
  const brief = { briefId: "B2-Q1-abc", rowId: "B2", issuedAt: "x", prdSha256: "a", steps: [{ id: "S1", text: "t" }] };
  assert.throws(
    () => parseImplementState(v8Fixture({ qaBriefs: [brief, { ...brief, rowId: "B4" }] })),
    /duplicate qa brief id B2-Q1-abc/,
  );
});
