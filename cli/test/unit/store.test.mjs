import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { freshnessHash, GateStore, gateStatus, overrideGate, recordGateResult, sha256Of } from "../../dist/gates/store.js";

const require = createRequire(import.meta.url);
const { vouchedTreeFingerprint } = require(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "lib", "git.js"),
);

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-store-"));
  return new GateStore(dir, "topic-a");
}

const BLOCK_FINDING = {
  area: "data",
  severity: "P0",
  missing: "retention undecided",
  recommendation: "decide retention",
  requiresHuman: true,
};

function blockOutcome() {
  return { kind: "verdict", verdict: "BLOCK", findings: [BLOCK_FINDING], artifactPayload: { findings: [BLOCK_FINDING] } };
}

test("state machine: BLOCK increments attempts and stays blocked", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.attempts, 1);
  assert.equal(view.budgetExhausted, false);
  assert.equal(view.requiresHuman, true);
});

test("state machine: retry budget exhaustion is flagged after budget BLOCKs", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.budgetExhausted, true);
});

test("state machine: PASS resets attempts and closes the gate", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "spec", blockOutcome(), []);
  state = recordGateResult(store, state, "spec", { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} }, []);
  const view = gateStatus(state, "spec", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.attempts, 0);
});

test("state machine fail-closed: judge error records ERROR and stays blocked", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge-binary-missing: no claude" }, []);
  const view = gateStatus(state, "verify", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.verdict, "ERROR");
  assert.equal(view.attempts, 1);
});

test("totalAttempts accumulates across every run while the budget gauge resets on PASS", () => {
  const store = makeStore();
  let state = store.load();
  const fail = () => ({ kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} });
  state = recordGateResult(store, state, "verify", fail(), []);
  state = recordGateResult(store, state, "verify", fail(), []);
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} }, []);
  assert.equal(state.gates.verify.attempts, 0, "the retry-budget gauge still resets on PASS");
  assert.equal(state.gates.verify.totalAttempts, 3, "every real run counts, the PASS included");
  // A judge error is a run that spent real work (fail-closed D-15): it counts.
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  assert.equal(state.gates.verify.attempts, 1);
  assert.equal(state.gates.verify.totalAttempts, 4);
});

test("a verdict's history row names the tree it was earned on", () => {
  const store = makeStore();
  let state = store.load();
  const fingerprint = { vouched: "abc123", entryCount: 2, mode: "fallback" };
  state = recordGateResult(
    store,
    state,
    "verify",
    { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {}, treeFingerprint: fingerprint },
    [],
  );
  assert.deepEqual(state.gates.verify.history.at(-1).treeFingerprint, fingerprint);
});

test("override requires a non-empty reason", () => {
  const store = makeStore();
  const state = store.load();
  assert.throws(() => overrideGate(store, state, "gap-audit", "   "), /reason/);
});

test("override unblocks the gate and records a user deviation", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "accepting the retention gap for a spike");
  const view = gateStatus(state, "gap-audit", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.overridden, true);
  assert.equal(state.deviations.length, 1);
  assert.equal(state.deviations[0].by, "user");
  assert.match(state.deviations[0].reason, /retention/);
});

test("a new BLOCK supersedes an earlier override", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "temporary user exception");
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const view = gateStatus(state, "gap-audit", 3);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.overridden, false);
  assert.equal(state.deviations.length, 1, "the historical deviation remains recorded");
});

test("a new judge ERROR supersedes an earlier override", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  state = overrideGate(store, state, "gap-audit", "temporary user exception");
  state = recordGateResult(store, state, "gap-audit", { kind: "error", message: "judge-timeout" }, []);
  const view = gateStatus(state, "gap-audit", 3);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.verdict, "ERROR");
  assert.equal(view.overridden, false);
});

test("receipt fields: judge calls persist with backend, model, and attempts", () => {
  const store = makeStore();
  let state = store.load();
  const record = {
    at: new Date().toISOString(),
    backend: "stub",
    model: null,
    tier: "frugal",
    purpose: "gate:gap-audit",
    durationMs: 5,
    attempts: 1,
    outcome: "ok",
  };
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), [record]);
  const reloaded = store.load();
  assert.equal(reloaded.judgeCalls.length, 1);
  assert.equal(reloaded.judgeCalls[0].backend, "stub");
  assert.equal(reloaded.judgeCalls[0].attempts, 1);
  assert.equal(reloaded.judgeCalls[0].purpose, "gate:gap-audit");
});

test("receipt fields: gate artifacts are written under agents/gates/<topic>/artifacts", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const artifact = state.gates["gap-audit"].history.at(-1).artifact;
  assert.ok(artifact && artifact.includes(path.join("agents", "gates", "topic-a", "artifacts")));
  assert.ok(fs.existsSync(path.join(store.projectRoot, artifact)));
});

test("GateStore rejects non-kebab-case topic slugs", () => {
  assert.throws(() => new GateStore(os.tmpdir(), "Bad Slug"), /kebab-case/);
});

function passWithInput(store, docName, content) {
  fs.writeFileSync(path.join(store.projectRoot, docName), content);
  return recordGateResult(
    store,
    store.load(),
    "spec",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: docName, sha256: freshnessHash(content) }],
      artifactPayload: {},
    },
    [],
  );
}

test("freshness: a PASS stays PASS while the input document is unchanged", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
  assert.deepEqual(view.staleInputs, []);
});

test("freshness: a PASS recorded under the previous input contract becomes STALE", () => {
  const store = makeStore();
  const content = "# PRD v1\n";
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), content);
  const state = recordGateResult(
    store,
    store.load(),
    "spec",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: "prd.md", sha256: sha256Of(content.trim()) }],
      artifactPayload: {},
    },
    [],
  );
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
});

test("freshness: editing the input document after a PASS turns the gate STALE", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), "# PRD v2 (edited after the gate)\n");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.equal(view.stale, true);
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
});

test("freshness: a deleted input document is reported as missing", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.rmSync(path.join(store.projectRoot, "prd.md"));
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "missing" }]);
});

test("freshness: an overridden gate is a user deviation, never STALE", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "spec", blockOutcome(), []);
  state = overrideGate(store, state, "spec", "user accepts the gap");
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: legacy PASS records without input hashes are STALE and unverifiable", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(
    store,
    state,
    "spec",
    { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {} },
    [],
  );
  delete state.gates.spec.inputs; // simulate a state file written before freshness existed
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.equal(view.stale, true);
  assert.deepEqual(view.staleInputs, [{ path: "<unrecorded>", reason: "unverifiable" }]);
});

test("freshness: frontmatter lifecycle flips do not stale the gate", () => {
  const store = makeStore();
  const v1 = '---\nstatus: "draft"\nhuman_approval: "pending"\n---\n\n# PRD: demo\n\n- R1. behavior\n';
  const state = passWithInput(store, "prd.md", v1);
  const v2 = '---\nstatus: "ready"\nhuman_approval: "approved"\n---\n\n# PRD: demo\n\n- R1. behavior\n';
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: recording the gate's own Audit History entry does not stale the gate", () => {
  const store = makeStore();
  const v1 = "# Interview Log: demo\n\n## Raw Q&A\n\n### Q1: x\n- answer: yes\n\n## Audit History\n\n### Audit 1\n- result: pass\n";
  const state = passWithInput(store, "qa-log.md", v1);
  const v2 = `${v1}\n### Audit 2\n- type: gap-audit-gate\n- result: pass\n`;
  fs.writeFileSync(path.join(store.projectRoot, "qa-log.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

test("freshness: substance edits still stale the gate even with frontmatter present", () => {
  const store = makeStore();
  const v1 = '---\nstatus: "draft"\n---\n\n# PRD: demo\n\n- R1. old behavior\n\n## Audit History\n\n- none\n';
  const state = passWithInput(store, "prd.md", v1);
  const v2 = '---\nstatus: "draft"\n---\n\n# PRD: demo\n\n- R1. NEW behavior\n\n## Audit History\n\n- none\n';
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), v2);
  const view = gateStatus(state, "spec", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "prd.md", reason: "changed" }]);
});

test("freshness: Audit History stripping stops at the next section", () => {
  const audit = "## Audit History\n\n### Audit 1\n- result: pass\n\n## Checkpoint And Sweep History\n\n- checkpoint 1\n";
  const withExtraAudit = "## Audit History\n\n### Audit 1\n- result: pass\n\n### Audit 2\n- result: pass\n\n## Checkpoint And Sweep History\n\n- checkpoint 1\n";
  assert.equal(freshnessHash(audit), freshnessHash(withExtraAudit));
  const changedNeighbor = audit.replace("checkpoint 1", "checkpoint 2");
  assert.notEqual(freshnessHash(audit), freshnessHash(changedNeighbor));
});

test("freshness: omitting projectRoot skips the staleness check (in-memory callers)", () => {
  const store = makeStore();
  const state = passWithInput(store, "prd.md", "# PRD v1\n");
  fs.rmSync(path.join(store.projectRoot, "prd.md"));
  const view = gateStatus(state, "spec", 2);
  assert.equal(view.effective, "PASS");
  assert.equal(view.stale, false);
});

// --- verify-gate tree fingerprint freshness (vouchedTreeFingerprint) ---

function makeGitStore() {
  const store = makeStore();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render()\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return store;
}

// Mirrors the real verdict flow: the doc input exists, then the fingerprint
// pins the tree, then the verdict is recorded (the gate's own gates.json and
// artifact writes land after the fingerprint, exactly as in runVerifyGate).
function passWithTreeFingerprint(store, treeFingerprint) {
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), "# PRD v1\n");
  return recordGateResult(
    store,
    store.load(),
    "verify",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: "prd.md", sha256: freshnessHash("# PRD v1\n") }],
      treeFingerprint:
        treeFingerprint === undefined
          ? vouchedTreeFingerprint({ projectRoot: store.projectRoot, slug: store.topic })
          : treeFingerprint,
      artifactPayload: {},
    },
    [],
  );
}

test("tree freshness: a verify PASS stays live on the unchanged tree and survives a commit of that tree", () => {
  const store = makeGitStore();
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); persist()\n");
  const state = passWithTreeFingerprint(store);
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");

  // A benign commit of the exact content the PASS was earned on must not
  // stale it: the fingerprint is content-based, not HEAD-based.
  const git = (...args) => spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "land");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
});

test("tree freshness: editing code after the PASS turns it STALE; gate bookkeeping does not", () => {
  const store = makeGitStore();
  const state = passWithTreeFingerprint(store);

  // The gate's own artifact/state writes (this store's dir) are bookkeeping.
  fs.mkdirSync(path.join(store.projectRoot, "agents", "gates", store.topic), { recursive: true });
  fs.writeFileSync(path.join(store.projectRoot, "agents", "gates", store.topic, "extra.json"), "{}");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS",
    "gate bookkeeping must never stale the gate (circular invalidation)");

  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); editedAfterPass()\n");
  const view = gateStatus(state, "verify", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.ok(view.staleInputs.some((input) => input.path === "<worktree>" && input.reason === "changed"));
});

test("tree freshness: legacy and malformed recorded fingerprints read as STALE, never crash, never PASS", () => {
  for (const legacy of [
    { headSha: "abc123", statusHash: "deadbeef" }, // pre-consolidation shape
    { headSha: null, statusHash: "deadbeef" },
    {},
    "garbage-string",
  ]) {
    const store = makeGitStore();
    const state = passWithTreeFingerprint(store);
    state.gates.verify.treeFingerprint = legacy; // simulate an already-written old gates.json
    const view = gateStatus(state, "verify", 2, store.projectRoot);
    assert.equal(view.effective, "STALE", `${JSON.stringify(legacy)} must downgrade to STALE`);
  }
  // A null fingerprint (non-git project at record time) still skips the check.
  const store = makeGitStore();
  const state = passWithTreeFingerprint(store, null);
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
});
