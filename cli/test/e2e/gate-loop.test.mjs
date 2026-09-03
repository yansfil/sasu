// PRD gate-loop: the PRD gates keep an open findings set instead of a round
// budget. Every test here drives the built CLI the way an agent does and
// asserts what `sasu gate ...` returns and what lands on disk (gates.json,
// the qa-log), never the module internals. Judge replies are stubbed per
// lane; the three real sessions that motivated the PRD are replayed
// separately (cli/scripts/gate_loop_replay.mjs, AC16).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "..", "..", "dist", "cli.js");
const QA_FIXTURE = fs.readFileSync(path.resolve(HERE, "..", "fixtures", "gate-loop", "qa-log.md"), "utf8");
const PRD_FIXTURE = fs.readFileSync(path.resolve(HERE, "..", "fixtures", "prelint", "prd-clean.md"), "utf8");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gate-loop-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE);
  fs.writeFileSync(path.join(dir, "prd.md"), PRD_FIXTURE);
  return dir;
}

function stubFile(dir, responses) {
  const file = path.join(dir, "agents", "stub.json");
  fs.writeFileSync(file, JSON.stringify(responses));
  fs.rmSync(`${file}.cursor`, { force: true });
  return file;
}

function runCli(cwd, args, { stub } = {}) {
  const env = { ...process.env };
  delete env.SASU_HERDR_ROLE;
  if (stub) {
    env.SASU_JUDGE_BACKEND = "stub";
    env.SASU_JUDGE_STUB_FILE = stub;
  } else {
    delete env.SASU_JUDGE_BACKEND;
    delete env.SASU_JUDGE_STUB_FILE;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

function gapAudit(dir, responses) {
  return runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--json"], {
    stub: stubFile(dir, responses),
  });
}

function statusJson(dir) {
  const result = runCli(dir, ["gate", "status", "--slug", "fixture", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function gatesState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "runs", "fixture", "gates", "gates.json"), "utf8"));
}

function lastArtifact(dir) {
  const record = gatesState(dir).gates["gap-audit"];
  return JSON.parse(fs.readFileSync(path.join(dir, record.history.at(-1).artifact), "utf8"));
}

const PASS = { verdict: "PASS", findings: [] };

function finding(area, severity, missing, requiresHuman, extra = {}) {
  return { area, severity, missing, recommendation: `decide: ${missing}`, requiresHuman, ...extra };
}

// Round 1 of every rerun test: three open findings, two agent-fixable in the
// ux lane and one human decision in the risk lane, so the verdict is BLOCK
// (mixed set) and the harness hands out F1, F2, F3 in lane order.
const THREE_OPEN = {
  byPurpose: {
    "lane:ux-behavior": {
      verdict: "BLOCK",
      findings: [
        finding("ux", "P1", "empty list state undecided", false),
        finding("ux", "P1", "undo after delete undecided", false),
      ],
    },
    "lane:risk-ops-verification": {
      verdict: "BLOCK",
      findings: [finding("risk", "P0", "no proof named for the delete confirmation", true)],
    },
    default: PASS,
  },
};

function seedThreeOpen(dir) {
  const first = gapAudit(dir, THREE_OPEN);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.status.effective, "BLOCKED");
  assert.deepEqual(parsed.status.findings.map((f) => f.id), ["F1", "F2", "F3"], "the harness assigns ids in lane order");
  return parsed;
}

test("AC1: a rerun on an unchanged document returns a subset of the open findings and no new id", () => {
  const dir = makeProject();
  seedThreeOpen(dir);
  const callsBefore = gatesState(dir).judgeCalls.length;

  // The ux lane says F1 is still open, F2 is resolved, and tries to raise a
  // brand-new concern; the risk lane keeps F3 open.
  const rerun = gapAudit(dir, {
    byPurpose: {
      "lane:ux-behavior": {
        verdict: "BLOCK",
        findings: [
          finding("ux", "P1", "empty list state still undecided", false, { id: "F1" }),
          finding("ux", "P1", "a newly invented sort-order concern", false),
        ],
      },
      "lane:risk-ops-verification": {
        verdict: "BLOCK",
        findings: [finding("risk", "P0", "no proof named for the delete confirmation", true, { id: "F3" })],
      },
      default: PASS,
    },
  });
  assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
  const status = JSON.parse(rerun.stdout).status;
  assert.deepEqual(status.findings.map((f) => f.id), ["F1", "F3"], "output ids are a subset of the three open ones");
  assert.equal(status.effective, "BLOCKED", "F1 is agent-fixable, so the gate still blocks rather than asking the user");
  assert.equal(gatesState(dir).judgeCalls.length, callsBefore + 4, "a rerun is one fan-out round");
  const artifact = lastArtifact(dir);
  assert.equal(artifact.rerun, true);
  assert.deepEqual(artifact.resolvedFindings.map((f) => f.id), ["F2"], "the finding no lane echoed is recorded as resolved");
  assert.equal(artifact.droppedFindings.length, 1, "the new finding from an unchanged lane is recorded, not admitted");
  assert.match(artifact.droppedFindings[0].missing, /sort-order/);
  assert.match(rerun.stderr, /1 new finding\(s\) from lanes whose decisions did not change were discarded/);
  assert.equal(gatesState(dir).gates["gap-audit"].findingSeq, 3, "no new id was minted");
});

test("AC2: a lane whose Decision Register rows changed may add a finding; an unchanged lane may not", () => {
  const dir = makeProject();
  seedThreeOpen(dir);
  // The agent revises the ux decision (D-02 is routed to the ux-behavior
  // lane by its area); the risk decision (D-04) is untouched.
  const qaLog = path.join(dir, "qa-log.md");
  fs.writeFileSync(
    qaLog,
    fs.readFileSync(qaLog, "utf8").replace(
      "deleting a task asks for confirmation first",
      "deleting a task asks for confirmation first and offers a five second undo",
    ),
  );
  const rerun = gapAudit(dir, {
    byPurpose: {
      "lane:ux-behavior": {
        verdict: "BLOCK",
        findings: [
          finding("ux", "P1", "empty list state undecided", false, { id: "F1" }),
          finding("ux", "P1", "what the undo restores when the list was edited meanwhile", false),
        ],
      },
      "lane:risk-ops-verification": {
        verdict: "BLOCK",
        findings: [
          finding("risk", "P0", "no proof named for the delete confirmation", true, { id: "F3" }),
          finding("risk", "P1", "a new operational worry from an unchanged lane", false),
        ],
      },
      default: PASS,
    },
  });
  assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
  const status = JSON.parse(rerun.stdout).status;
  const ids = status.findings.map((f) => f.id);
  assert.deepEqual(ids, ["F1", "F4", "F3"]);
  const added = status.findings.find((f) => f.id === "F4");
  assert.equal(added.area, "ux", "only the lane whose decisions changed minted a new id");
  const artifact = lastArtifact(dir);
  assert.deepEqual(artifact.droppedFindings.map((f) => f.area), ["risk"], "the unchanged lane's new finding was discarded");
  const changed = artifact.lanes.filter((lane) => lane.decisionsChanged).map((lane) => lane.laneId);
  assert.deepEqual(changed, ["ux-behavior"], "the artifact names which lane's decisions changed");
});

test("AC3: a state file written by this CLI carries no round counter and no review phase", () => {
  const dir = makeProject();
  seedThreeOpen(dir);
  const raw = fs.readFileSync(path.join(dir, "agents", "runs", "fixture", "gates", "gates.json"), "utf8");
  for (const retired of ["closure-blocked", "closureExhausted", "judgedRounds", "reviewRound", "\"review\":", "\"phase\":"]) {
    assert.ok(!raw.includes(retired), `gates.json must not contain ${retired}`);
  }
  const record = gatesState(dir).gates["gap-audit"];
  assert.equal(record.review, undefined);
  assert.equal(statusJson(dir)["gap-audit"].reviewCycle, 1, "the cycle is derived from the reopen ledger, not stored");
});

test("AC3: a legacy state file carrying the retired review lifecycle fails loudly instead of being coerced", () => {
  const dir = makeProject();
  seedThreeOpen(dir);
  const file = path.join(dir, "agents", "runs", "fixture", "gates", "gates.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.gates["gap-audit"].review = { cycle: 1, phase: "closure-blocked", judgedRounds: 2, openedAt: "x", openedBy: "initial" };
  fs.writeFileSync(file, JSON.stringify(state));
  const status = runCli(dir, ["gate", "status", "--slug", "fixture"]);
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /retired bounded-review state on gate gap-audit/);
  assert.match(status.stderr, /Move the file aside/);
  const rerun = gapAudit(dir, THREE_OPEN);
  assert.notEqual(rerun.status, 0, "no judge runs over a record the loader refuses");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).judgeCalls.length, state.judgeCalls.length);
});

test("AC4: two open requiresHuman findings become one NEEDS_HUMAN bundle, and the user's answer seals PASS with no judge call", () => {
  const dir = makeProject();
  const first = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:ux-behavior": {
          verdict: "BLOCK",
          findings: [
            finding("ux", "P1", "should the empty list show a hint", true),
            finding("ux", "P1", "should delete offer undo", true),
          ],
        },
        default: PASS,
      },
    }),
  });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stdout, /\[gate:gap-audit\] NEEDS_HUMAN/);
  assert.match(first.stdout, /NEEDS HUMAN: every open finding needs a human decision; ask the user the 2 question\(s\) below as one bundle/);
  assert.match(first.stdout, /sasu gate answer --slug fixture --gate gap-audit --evidence/);
  assert.match(first.stdout, /F1 P1 ux: should the empty list show a hint \[needs human decision\]/);
  assert.match(first.stdout, /F2 P1 ux: should delete offer undo \[needs human decision\]/);
  const status = statusJson(dir)["gap-audit"];
  assert.equal(status.verdict, "NEEDS_HUMAN");
  assert.equal(status.effective, "NEEDS_HUMAN");
  assert.equal(status.findings.length, 2);
  assert.equal(status.sealed, false);

  const callsBefore = gatesState(dir).judgeCalls.length;
  const qaBefore = fs.readFileSync(path.join(dir, "qa-log.md"), "utf8");
  const answer = runCli(dir, ["gate", "answer", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "1. show a hint / 2. no undo, confirmation is enough"], {
    stub: stubFile(dir, "poison: an answer must not consult the judge"),
  });
  assert.equal(answer.status, 0, answer.stdout + answer.stderr);
  assert.match(answer.stdout, /sealed PASS without another judge call/);
  assert.match(answer.stdout, /\[gate:gap-audit\] PASS/);
  assert.equal(gatesState(dir).judgeCalls.length, callsBefore, "zero judge calls");
  const sealed = statusJson(dir)["gap-audit"];
  assert.equal(sealed.effective, "PASS");
  assert.equal(sealed.sealed, true);
  assert.deepEqual(sealed.findings, []);
  const record = gatesState(dir).gates["gap-audit"];
  assert.equal(record.humanAnswers.length, 1);
  assert.equal(record.humanAnswers[0].evidence, "1. show a hint / 2. no undo, confirmation is enough");
  assert.deepEqual(record.humanAnswers[0].findings.map((f) => f.id), ["F1", "F2"], "the seal names the bundle a person answered");
  const qaAfter = fs.readFileSync(path.join(dir, "qa-log.md"), "utf8");
  assert.notEqual(qaAfter, qaBefore);
  assert.match(qaAfter, /### Q4: gap-audit human decision bundle \(F1, F2\)/);
  assert.match(qaAfter, /- answer: 1\. show a hint \/ 2\. no undo, confirmation is enough/);
  assert.match(qaAfter, /- asked: F1 \[P1\/ux\] should the empty list show a hint/);

  // The seal pinned the qa-log as it stood after the answer landed.
  const cached = gapAudit(dir, "poison: a sealed PASS is cached");
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  assert.equal(JSON.parse(cached.stdout).zeroJudgeCalls, true);

  const again = runCli(dir, ["gate", "answer", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "again"]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /is PASS, not NEEDS_HUMAN/);
});

test("AC4: a mixed open set blocks instead of asking the user; the human question waits for the agent-fixable one", () => {
  const dir = makeProject();
  const parsed = seedThreeOpen(dir);
  assert.equal(parsed.status.effective, "BLOCKED");
  const answer = runCli(dir, ["gate", "answer", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "premature"]);
  assert.notEqual(answer.status, 0);
  assert.match(answer.stderr, /is BLOCK, not NEEDS_HUMAN/);
});

test("AC5: a goal-scope lane P1 with every other lane empty is a PASS with the finding in warnings", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:goal-scope": { verdict: "BLOCK", findings: [finding("scope", "P1", "non-goals do not name multi-user sync", false)] },
        default: PASS,
      },
    }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[gate:gap-audit\] PASS/);
  assert.match(result.stdout, /warning: F1 P1 scope: non-goals do not name multi-user sync/);
  const status = statusJson(dir)["gap-audit"];
  assert.equal(status.verdict, "PASS");
  assert.deepEqual(status.findings, []);
  assert.equal(status.warnings.length, 1);
  assert.equal(status.warnings[0].missing, "non-goals do not name multi-user sync");
  assert.equal(status.sealed, true);
});

test("AC6: a data-tech lane requiresHuman finding joins the human bundle and is not a PASS", () => {
  const dir = makeProject();
  const result = gapAudit(dir, {
    byPurpose: {
      "lane:data-tech": { verdict: "BLOCK", findings: [finding("data", "P1", "retention of deleted tasks undecided", true)] },
      default: PASS,
    },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const status = JSON.parse(result.stdout).status;
  assert.equal(status.verdict, "NEEDS_HUMAN");
  assert.equal(status.findings.length, 1);
  assert.equal(status.findings[0].requiresHuman, true);
  assert.deepEqual(status.warnings, []);
});

test("AC6: a data-tech lane P2 marked requiresHuman is promoted into the bundle rather than warned away", () => {
  const dir = makeProject();
  const result = gapAudit(dir, {
    byPurpose: {
      "lane:data-tech": { verdict: "PASS", findings: [finding("data", "P2", "which storage key namespace", true)] },
      default: PASS,
    },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const status = JSON.parse(result.stdout).status;
  assert.equal(status.verdict, "NEEDS_HUMAN");
  assert.equal(status.findings[0].severity, "P1");
});

function sealPass(dir) {
  const passed = gapAudit(dir, { byPurpose: { default: PASS } });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(statusJson(dir)["gap-audit"].sealed, true);
}

function writeQaLog(dir, content) {
  fs.writeFileSync(path.join(dir, "qa-log.md"), content);
}

test("AC7: after a sealed PASS, a Q anchor line, an Audit History block, and the status value do not make the gate STALE", () => {
  const dir = makeProject();
  sealPass(dir);
  const edits = [
    ["Q anchor", QA_FIXTURE.replace("- decision_ids: D-01", "- decision_ids: D-01, D-03")],
    ["Audit History block", `${QA_FIXTURE}\n### Audit 1\n- type: gap-audit-gate\n- result: pass\n`],
    ["status value", QA_FIXTURE.replace('status: "active"', 'status: "complete"')],
    ["all three at once", `${QA_FIXTURE.replace("- decision_ids: D-01", "- decision_ids: D-01, D-03").replace('status: "active"', 'status: "complete"')}\n### Audit 1\n- result: pass\n`],
  ];
  for (const [label, content] of edits) {
    writeQaLog(dir, content);
    const view = statusJson(dir)["gap-audit"];
    assert.equal(view.effective, "PASS", `${label} must leave the seal live`);
    assert.deepEqual(view.staleInputs, [], label);
    const text = runCli(dir, ["gate", "status", "--slug", "fixture"]);
    assert.match(text.stdout, /\[gate:gap-audit\] PASS \|/, label);
    assert.doesNotMatch(text.stdout, /STALE|stale:/, label);
  }
  // And the sealed PASS is still cached at $0 on the edited log.
  const cached = gapAudit(dir, "poison: a live seal must not call the judge");
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
});

test("AC8: after a sealed PASS, one changed Decision Register decision cell makes the gate STALE", () => {
  const dir = makeProject();
  sealPass(dir);
  writeQaLog(dir, QA_FIXTURE.replace("deleting a task asks for confirmation first", "deleting a task never asks"));
  const view = statusJson(dir)["gap-audit"];
  assert.equal(view.effective, "STALE");
  assert.deepEqual(view.staleInputs, [{ path: "qa-log.md", reason: "changed" }]);
  assert.equal(view.reopenRequired, true);
  const text = runCli(dir, ["gate", "status", "--slug", "fixture"]);
  assert.match(text.stdout, /\[gate:gap-audit\] STALE/);
  assert.match(text.stdout, /REOPEN REQUIRED/);
  const refused = gapAudit(dir, "poison: a stale seal is not re-judged on the agent's initiative");
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "reopen-required");
});

test("AC11: gate reopen on a complete, sealed qa-log exits 0 and appends the evidence as a new Raw Q&A turn", () => {
  const dir = makeProject();
  sealPass(dir);
  writeQaLog(dir, QA_FIXTURE.replace('status: "active"', 'status: "complete"'));
  assert.equal(statusJson(dir)["gap-audit"].sealed, true, "the seal is live on the completed log");

  const evidence = "삭제 확인 대신 5초 undo로 가자";
  const reopened = runCli(dir, ["gate", "reopen", "--slug", "fixture", "--gate", "gap-audit", "--evidence", evidence]);
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  assert.match(reopened.stdout, /gap-audit review reopened with recorded user evidence/);
  assert.match(reopened.stdout, /\[gate:gap-audit\] NOT_RUN \| review cycle 2/);

  const qaLog = fs.readFileSync(path.join(dir, "qa-log.md"), "utf8");
  const rawQa = qaLog.slice(qaLog.indexOf("## Raw Q&A"), qaLog.indexOf("## Checkpoint And Sweep History"));
  const lastTurn = rawQa.slice(rawQa.lastIndexOf("### Q"));
  assert.match(lastTurn, /^### Q4: gap-audit reopen/);
  assert.match(lastTurn, new RegExp(`- answer: ${evidence}`));
  assert.match(lastTurn, /- source_ref: gate:gap-audit:reopen:/);
  assert.match(lastTurn, /- needs_normalization: true/);
  assert.match(qaLog, /^status: "active"$/m, "a reopened log is active again so sync and normalization can continue");
  assert.match(qaLog, /^question_count: 4$/m);
  const record = gatesState(dir).gates["gap-audit"];
  assert.equal(record.reviewReopens.length, 1);
  assert.equal(record.reviewReopens[0].evidence, evidence);
  assert.equal(record.reviewReopens[0].verdictBefore, "PASS");

  // The next round runs as a delta review and can seal again.
  const resealed = gapAudit(dir, { byPurpose: { default: PASS } });
  assert.equal(resealed.status, 0, resealed.stdout + resealed.stderr);
  assert.equal(statusJson(dir)["gap-audit"].reviewCycle, 2);
});

test("AC11: gate reopen is refused before any verdict and records nothing", () => {
  const dir = makeProject();
  const refused = runCli(dir, ["gate", "reopen", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "premature"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no judged verdict to reopen/);
  assert.equal(fs.readFileSync(path.join(dir, "qa-log.md"), "utf8"), QA_FIXTURE);
});
