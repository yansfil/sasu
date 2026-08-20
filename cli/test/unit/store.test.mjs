import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { freshnessHash, GateStore, gateStatus, overrideGate, recordGateResult, sha256Of } from "../../dist/gates/store.js";

const require = createRequire(import.meta.url);
const { judgedDiffSha256 } = require(
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

test("a declared gap closes the gate without spending the fix budget", () => {
  const store = makeStore();
  const state = recordGateResult(store, store.load(), "verify", {
    kind: "verdict",
    verdict: "FAIL",
    findings: [{ ...BLOCK_FINDING, area: "declared-gap" }],
    failedStage: "declared-gap",
    artifactPayload: { declaredGaps: [{ criterionId: "AC1", verificationIds: ["V1"] }] },
  }, []);
  const view = gateStatus(state, "verify", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.attempts, 0, "an already-evidenced blocker is not a failed fix attempt");
  assert.equal(view.requiresHuman, true);
  assert.equal(state.gates.verify.totalAttempts, 1, "the run remains visible in the cumulative ledger");
});

test("state machine fail-closed: judge error records ERROR and stays blocked", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge-binary-missing: no claude" }, []);
  const view = gateStatus(state, "verify", 2);
  assert.equal(view.effective, "BLOCKED");
  assert.equal(view.verdict, "ERROR");
  // Fail-closed, but on the judge's own gauge: the fix budget is untouched
  // because a broken judge produced no findings to fix.
  assert.equal(view.attempts, 0);
  assert.equal(view.consecutiveErrors, 1);
  assert.equal(view.budgetExhausted, false);
  assert.equal(view.judgeErrorLoop, false);
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
  // A judge error is a run that spent real work (fail-closed D-15): it counts
  // in the cumulative ledger, but never in the FIX budget - it produced nothing
  // to fix.
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  assert.equal(state.gates.verify.attempts, 0, "the fix budget is not spent by a judge malfunction");
  assert.equal(state.gates.verify.totalAttempts, 4, "the honest run count still moves");
  assert.equal(state.gates.verify.history.at(-1).verdict, "ERROR", "and the history row is still written");
});

// The measured incident, replayed (2026-08-11, project modakbul, slug
// webhook-to-modakbul-server): 10 verify attempts, 4 of them
// `judge-invalid-output (backend: claude): criteria missing verdicts for AC1,
// AC2, AC3`, and every round that DID answer returned 13/13 criteria PASS - the
// gate never found one real defect, yet the run went BLOCKED three times.
// Both halves of the fix are pinned here: the errors must not spend the fix
// budget, and they must still terminate.
test("a judge-error loop spends no fix budget, keeps the honest record, and still terminates", () => {
  const store = makeStore();
  const budget = 3;
  const judgeError = () => ({ kind: "error", message: "judge-invalid-output (backend: claude): criteria missing verdicts for: AC1, AC2, AC3" });
  let state = store.load();

  // One real FAIL first: this one DID hand the agent findings, so it is the one
  // thing allowed to charge the budget.
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  assert.equal(gateStatus(state, "verify", budget).attempts, 1);

  for (let i = 1; i <= budget; i += 1) {
    state = recordGateResult(store, state, "verify", judgeError(), []);
    const view = gateStatus(state, "verify", budget);
    assert.equal(view.attempts, 1, `error ${i}: the fix budget stays where the last real verdict left it`);
    assert.equal(view.consecutiveErrors, i, `error ${i}: the error streak is the gauge that moves`);
    assert.equal(view.effective, "BLOCKED", `error ${i}: ERROR is never a PASS`);
    assert.equal(view.budgetExhausted, false, `error ${i}: a receipt must never claim a budget it did not spend`);
    assert.equal(view.judgeErrorLoop, i >= budget, `error ${i}: terminal only once the streak reaches the bound`);
  }

  // Terminal, and distinguishable from the other two causes: attempts read the
  // honest 1/3, so `budgetExhausted` stays false and only `judgeErrorLoop` is
  // set. (`rerunRefused` lives in the gate commands layer and never arms on
  // ERROR - a broken judge says nothing about the tree.)
  const terminal = gateStatus(state, "verify", budget);
  assert.equal(terminal.judgeErrorLoop, true);
  assert.equal(terminal.attempts, 1);
  assert.equal(terminal.budgetExhausted, false);
  assert.equal("rerunRefused" in terminal, false);

  // Every run is still in the ledger: 1 FAIL + 3 ERRORs, none of them lost.
  const record = store.load().gates.verify;
  assert.equal(record.totalAttempts, budget + 1);
  assert.equal(record.history.length, budget + 1);
  assert.equal(record.history.filter((row) => row.verdict === "ERROR").length, budget);
  assert.ok(record.history.at(-1).error.includes("judge-invalid-output"));

  // A judge that answers again clears the streak - including with a FAIL, since
  // what the streak counts is whether the question got answered at all. The
  // next fix round then charges the budget normally.
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  const recovered = gateStatus(state, "verify", budget);
  assert.equal(recovered.consecutiveErrors, 0);
  assert.equal(recovered.judgeErrorLoop, false);
  assert.equal(recovered.attempts, 2, "the fix budget resumes from where the real verdicts left it");
});

test("a legacy record with no error-streak field is never terminal on the judge-error cause", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  delete state.gates.verify.consecutiveErrors; // a gates.json written before the field existed
  const view = gateStatus(state, "verify", 1, store.projectRoot);
  assert.equal(view.consecutiveErrors, 0);
  assert.equal(view.judgeErrorLoop, false, "no streak recorded, no terminal claim");
  assert.equal(view.effective, "BLOCKED", "still fail-closed on the ERROR verdict itself");
});

test("a stale error streak under a later real verdict cannot fake a judge-error loop", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  // Simulates a mixed-dist write: an older recordGateResult rewrote the verdict
  // without knowing the streak field, stranding it under a verdict it does not
  // describe. Same defensive posture as the short-circuit's stamp-consistency
  // check - the terminal claim needs the verdict to agree.
  state.gates.verify.consecutiveErrors = 9;
  assert.equal(gateStatus(state, "verify", 2).judgeErrorLoop, false);
});

test("a verdict's history row names the diff it was earned on", () => {
  const store = makeStore();
  let state = store.load();
  const judged = "b7f1c0de".repeat(8);
  state = recordGateResult(
    store,
    state,
    "verify",
    { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {}, judgedDiffSha256: judged },
    [],
  );
  assert.equal(state.gates.verify.judgedDiffSha256, judged);
  // On the row too, so the FAIL-side short-circuit can compare against the
  // latest attempt across PASS-reset cycles.
  assert.equal(state.gates.verify.history.at(-1).judgedDiffSha256, judged);

  // A round that produced no diff records null rather than a stale neighbour's
  // pin: no pin means no comparison, which means one honest re-run.
  state = recordGateResult(store, state, "verify", { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {} }, []);
  assert.equal(state.gates.verify.judgedDiffSha256, null);
});

test("failedStage and diffSource ride the record and history row; PASS and ERROR clear the stage", () => {
  const store = makeStore();
  let state = store.load();
  const fail = { kind: "verdict", verdict: "FAIL", findings: [], artifactPayload: {}, failedStage: "semantic", diffSource: "git:HEAD" };
  state = recordGateResult(store, state, "verify", fail, []);
  assert.equal(state.gates.verify.failedStage, "semantic");
  assert.equal(state.gates.verify.diffSource, "git:HEAD");
  assert.equal(state.gates.verify.history.at(-1).failedStage, "semantic");
  assert.equal(state.gates.verify.history.at(-1).diffSource, "git:HEAD");

  // A PASS never carries a failedStage, even if a caller passes one: a
  // lingering "semantic" under a later record would let the rerun
  // short-circuit refuse on a stage that did not produce it.
  state = recordGateResult(
    store,
    state,
    "verify",
    { kind: "verdict", verdict: "PASS", findings: [], artifactPayload: {}, failedStage: "semantic", diffSource: "git:HEAD" },
    [],
  );
  assert.equal(state.gates.verify.failedStage, undefined);
  assert.equal(state.gates.verify.diffSource, "git:HEAD", "diffSource is provenance, kept on PASS too");
  assert.equal(state.gates.verify.history.at(-1).failedStage, undefined);

  // ERROR is a fact about the judge, not a stage or a diff: both stamps clear.
  state = recordGateResult(store, state, "verify", fail, []);
  state = recordGateResult(store, state, "verify", { kind: "error", message: "judge broke" }, []);
  assert.equal(state.gates.verify.failedStage, undefined);
  assert.equal(state.gates.verify.diffSource, undefined);

  // Round-trip through disk: a rerun in a later process reads the same stamps.
  state = recordGateResult(store, state, "verify", fail, []);
  const reloaded = store.load();
  assert.equal(reloaded.gates.verify.failedStage, "semantic");
  assert.equal(reloaded.gates.verify.diffSource, "git:HEAD");
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
    profile: "routine",
    effort: "xhigh",
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

test("receipt fields: gate artifacts are written under agents/runs/<topic>/gates/artifacts", () => {
  const store = makeStore();
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const artifact = state.gates["gap-audit"].history.at(-1).artifact;
  assert.ok(artifact && artifact.includes(path.join("agents", "runs", "topic-a", "gates", "artifacts")));
  assert.ok(fs.existsSync(path.join(store.projectRoot, artifact)));
});

test("a legacy agents/gates/<topic> record keeps loading and writing in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-store-legacy-"));
  const legacyDir = path.join(dir, "agents", "gates", "topic-a");
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyState = new GateStore(dir, "topic-a"); // no gates.json anywhere yet: unified wins
  assert.ok(legacyState.dir.includes(path.join("agents", "runs", "topic-a", "gates")));
  fs.writeFileSync(
    path.join(legacyDir, "gates.json"),
    JSON.stringify({ schema: 1, topic: "topic-a", gates: {}, deviations: [], judgeCalls: [] }),
  );
  const store = new GateStore(dir, "topic-a");
  assert.equal(store.dir, legacyDir, "an existing legacy record must resolve to its own directory");
  let state = store.load();
  state = recordGateResult(store, state, "gap-audit", blockOutcome(), []);
  const artifact = state.gates["gap-audit"].history.at(-1).artifact;
  assert.ok(artifact && artifact.includes(path.join("agents", "gates", "topic-a", "artifacts")), "legacy runs keep writing in place");
  fs.rmSync(dir, { recursive: true, force: true });
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

// --- verify-gate judged-diff freshness (cli/lib/git.js judgedDiffSha256) ---

function makeGitStore() {
  const store = makeStore();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render()\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  return store;
}

// Mirrors the real verdict flow: the doc input exists, then the diff the judge
// was shown is pinned, then the verdict is recorded (the gate's own gates.json
// and artifact writes land after the pin, exactly as in runVerifyGate).
function passWithJudgedDiff(store, judgedDiffSha256Override) {
  fs.writeFileSync(path.join(store.projectRoot, "prd.md"), "# PRD v1\n");
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: store.projectRoot, encoding: "utf8" }).stdout.trim();
  return recordGateResult(
    store,
    store.load(),
    "verify",
    {
      kind: "verdict",
      verdict: "PASS",
      findings: [],
      inputs: [{ path: "prd.md", sha256: freshnessHash("# PRD v1\n") }],
      diffSource: `git:${base}`,
      judgedDiffSha256:
        judgedDiffSha256Override === undefined ? judgedDiffSha256(store.projectRoot, base) : judgedDiffSha256Override,
      artifactPayload: {},
    },
    [],
  );
}

test("judged-diff freshness: a verify PASS stays live on the unchanged tree and survives a commit of that tree", () => {
  const store = makeGitStore();
  // An untracked file plus an edit to a tracked one, so the commit below has to
  // survive BOTH things a commit does to the assembled diff: it folds the
  // untracked add-diff into git's own output (dropping the joining newline) and
  // it re-sorts the sections by path. `new-module.js` sorts before `app.js`, so
  // the pre-commit order is the reverse of the post-commit order.
  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); persist()\n");
  fs.writeFileSync(path.join(store.projectRoot, "Zmodule.js"), "export const z = 1\n");
  const state = passWithJudgedDiff(store);
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");

  // Committing the exact content the PASS was earned on must not stale it. This
  // is the property the vouched fingerprint had and the pin must keep: losing it
  // resurrects the materialize-in-HEAD rescue machinery it deleted.
  const git = (...args) => spawnSync("git", args, { cwd: store.projectRoot, encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "land");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
});

test("judged-diff freshness: editing code after the PASS turns it STALE; gate bookkeeping does not", () => {
  const store = makeGitStore();
  const state = passWithJudgedDiff(store);

  // The gate's own artifact/state writes (this store's dir) are bookkeeping.
  fs.mkdirSync(path.join(store.projectRoot, "agents", "gates", store.topic), { recursive: true });
  fs.writeFileSync(path.join(store.projectRoot, "agents", "gates", store.topic, "extra.json"), "{}");
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS",
    "gate bookkeeping must never stale the gate (circular invalidation)");

  // A lockfile is the pin's one accepted blind spot, named in judgedDiffSha256:
  // the judge never saw it, and finalize re-runs command-backed verification on
  // the final tree, which is where a lockfile change would actually surface.
  fs.writeFileSync(path.join(store.projectRoot, "package-lock.json"), '{"lockfileVersion":3}');
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");

  fs.writeFileSync(path.join(store.projectRoot, "app.js"), "render(); editedAfterPass()\n");
  const view = gateStatus(state, "verify", 2, store.projectRoot);
  assert.equal(view.effective, "STALE");
  assert.ok(view.staleInputs.some((input) => input.path === "<judged-diff>" && input.reason === "changed"));
});

test("judged-diff freshness: a pin that cannot be compared never silently passes or crashes", () => {
  // A pin that does not match what the tree produces now reads as STALE. That
  // covers the legacy case by construction: a pre-field gates.json carries a
  // tree-fingerprint OBJECT where a sha256 string belongs, and any shape that is
  // not the current diff's hash earns one honest re-run.
  for (const stale of [
    "deadbeef".repeat(8),
    { headSha: "abc123", statusHash: "deadbeef" }, // pre-consolidation shape
    {},
  ]) {
    const store = makeGitStore();
    const state = passWithJudgedDiff(store, stale);
    const view = gateStatus(state, "verify", 2, store.projectRoot);
    assert.equal(view.effective, "STALE", `${JSON.stringify(stale)} must downgrade to STALE`);
  }

  // No pin at all (non-git project at record time, or a round that never
  // produced a diff) skips the comparison rather than inventing a verdict.
  for (const absent of [null, undefined, ""]) {
    const store = makeGitStore();
    const state = passWithJudgedDiff(store, absent);
    assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");
  }

  // A pin with no git base cannot be reproduced either: the injected-diff test
  // seam has no provenance, so it must not be treated as drift.
  const store = makeGitStore();
  const state = passWithJudgedDiff(store, "deadbeef".repeat(8));
  state.gates.verify.diffSource = "injected";
  assert.equal(gateStatus(state, "verify", 2, store.projectRoot).effective, "PASS");

  // The real pre-migration shape, which no fixture above covers: a PASS with the
  // retired tree fingerprint and NO diffSource at all. Gating the migration read
  // on a git base let exactly these records read as live (found 2026-08-11 by
  // running gateStatus over this repo's own agents/gates/tetris-game and
  // saju-reading, both of which reported PASS on a legacy pin).
  const legacyStore = makeGitStore();
  const legacy = passWithJudgedDiff(legacyStore, undefined);
  delete legacy.gates.verify.judgedDiffSha256;
  delete legacy.gates.verify.diffSource;
  legacy.gates.verify.treeFingerprint = { vouched: "45644585", entryCount: 535, mode: "fallback" };
  const legacyView = gateStatus(legacy, "verify", 2, legacyStore.projectRoot);
  assert.equal(legacyView.effective, "STALE", "a pre-migration PASS earns one honest re-run");
  assert.ok(legacyView.staleInputs.some((input) => input.path === "<judged-diff>" && input.reason === "unverifiable"));
});
