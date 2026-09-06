import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadState, persistState } from "../../dist/implement/store.js";

// --- R16: the three defects the 2026-08-29 live run exposed -----------------
//
// Each of these is a rule that was written without its exception. The
// supervisor was meant to be read-only and nothing enforced or recorded it;
// the blocked close asked whether the judge budget was spent instead of
// whether another round could change anything; and `status` answered a
// question in 491 lines of JSON. Proof here is the exit code, the record, and
// the bytes actually printed - never a claim about the code.

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const SESSION_KEYS = ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

/** `checkCommand` is B1's sealed check: cell; the default shares the suite's own command. */
function prd(checkCommand = "npm test") {
  return `---
topic: "implement defects fixture"
status: "ready"
human_approval: "approved"
review_profile: "high-risk"
review_rationale: "R16 defect fixture"
source_intake: "current conversation"
---

# PRD: implement defects fixture

## Goal

A run that cannot converge has to be able to close honestly.

## Non-goals

Nothing beyond the R16 defect paths.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | the supervisor is read-only over implementation | self-restraint is not a guard |

## Behaviors

| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |
| --- | --- | --- | --- |
| B1 | The runner executes each command once. | check: \`${checkCommand}\` | D-01 |

## Technical structure

No fixture structure change.

## Risks

None.
`;
}

function run(root, args, env = {}) {
  const merged = { ...process.env, ...env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  const executed = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", env: merged });
  let json;
  try {
    json = JSON.parse(executed.stdout);
  } catch {
    json = { stdout: executed.stdout, stderr: executed.stderr };
  }
  return { ...executed, json };
}

/** The same spawn without `--json`: AC47 is about what a person actually sees. */
function runPlain(root, args) {
  const merged = { ...process.env };
  for (const key of SESSION_KEYS) delete merged[key];
  delete merged.SASU_HERDR_ROLE;
  delete merged.HERDR_ENV;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", env: merged });
}

function makeProject({ checkCommand } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-implement-defects-e2e-"));
  fs.mkdirSync(path.join(root, "agents", "prd", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "prd", "fixture", "prd.md"), prd(checkCommand));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('fixture suite green')\"" } }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "remote.sh"), "#!/bin/sh\necho remote\n");
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
  ]) {
    const executed = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
  }
  const started = run(root, ["implement", "start", "--prd", "agents/prd/fixture/prd.md"]);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  fs.writeFileSync(path.join(root, "implementation.txt"), "run-owned fixture implementation\n");
  return root;
}

const STATE_REL = path.join("agents", "runs", "fixture", "state.json");
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));

/** `findings` is what the risk lane will report on the NEXT verify. */
function stubEnv(root, findings = []) {
  const file = path.join(root, "agents", "judge.json");
  const capture = path.join(root, "agents", "captures");
  fs.writeFileSync(file, JSON.stringify({
    byPurpose: {
      "implement:fidelity": {
        verdict: "PASS",
        checks: ["F1", "F2", "F3", "F4", "F5"].map((id) => ({ id, verdict: "PASS", reason: "preserved", evidence: "fixture PRD" })),
      },
      "implement:design": { comments: [] },
      "implement:risk": { verdict: findings.length === 0 ? "PASS" : "FAIL", findings },
    },
  }));
  return { SASU_JUDGE_BACKEND: "stub", SASU_JUDGE_STUB_FILE: file, SASU_JUDGE_STUB_CAPTURE_DIR: capture };
}

/** Prove the one check: row on the current tree, so verify has nothing to refuse. */
function prove(root) {
  const checked = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
}

// --- R16 ②/AC45: the supervisor is read-only, in code and in the record -----

test("AC45: a supervisor-labelled state change is refused and recorded as an authority violation", () => {
  const root = makeProject();
  stubEnv(root);

  // Running a row's check is the exact move that used to rest on self-restraint.
  const refused = run(root, ["implement", "check", "--issuer", "observer", "--row", "B1"]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.json.message, /observer may not issue `sasu implement check`/);
  assert.match(refused.json.message, /not authenticated/, "the message must not claim to be a security boundary");
  assert.equal(refused.json.detail.rejectedCheck, "authority");
  assert.equal(state(root).rows.find((entry) => entry.id === "B1").status, "pending", "the refusal changed nothing");
  assert.deepEqual(state(root).rows.find((entry) => entry.id === "B1").attempts, []);

  // The refusal is IN the run's history. Without this the gate knew it had
  // refused and the record said nothing was ever attempted.
  const recorded = state(root).verbs.at(-1);
  assert.equal(recorded.verb, "check");
  assert.equal(recorded.issuer, "observer");
  assert.equal(recorded.outcome, "rejected");
  assert.equal(recorded.rejection.check, "authority");
  assert.equal(recorded.target, "B1");

  // Every implementation command, not just the one that hurt.
  for (const argv of [
    ["implement", "artifact", "--issuer", "observer", "--row", "B1", "--kind", "log", "--path", "lib/remote.sh", "--description", "x"],
    ["implement", "finalize", "--issuer", "observer"],
    ["implement", "verify", "--issuer", "observer"],
    ["implement", "confirm", "--issuer", "observer", "--row", "B1", "--evidence", "x"],
  ]) {
    const each = run(root, argv);
    assert.equal(each.status, 2, `${argv[1]} must refuse an observer: ${each.stdout}`);
    assert.equal(each.json.detail.rejectedCheck, "authority");
  }
  const history = state(root).verbs;
  assert.deepEqual(
    history.filter((entry) => entry.outcome === "rejected").map((entry) => entry.verb),
    ["check", "artifact", "finalize", "verify", "confirm"],
    "every refusal lands, in order",
  );
  // Read-only surfaces are not in the table, so anyone may look.
  assert.equal(run(root, ["implement", "status", "--issuer", "observer"]).status, 0);
});

// --- R16 ③/AC46: closing honestly without burning rounds that cannot help ---

test("AC46: a non-convergent finding closes the run blocked, and the receipt says who declared it", () => {
  const root = makeProject();
  const env = stubEnv(root, [{ severity: "blocking", text: "the fixture pins a platform the harness cannot install" }]);
  prove(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  // A blocking finding does not fail the unified verdict; it blocks the
  // COMPLETE close, which is the state this test is about.
  assert.equal(state(root).riskFindings[0].id, "RF1");
  assert.equal(state(root).riskFindings[0].status, "open");

  // Before the declaration: blocked is refused because a round could still
  // run, and the refusal names the way out rather than just saying no.
  const early = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(early.status, 2);
  assert.match(early.json.message, /verification can still run/);
  assert.match(early.json.message, /undeclared: RF1/);

  // Only a human may declare it, and only with a quote and a reason.
  const byObserver = run(root, ["implement", "risk", "--non-convergent", "--issuer", "observer", "--id", "RF1",
    "--approval", "go ahead", "--reason", "no round can install it"]);
  assert.equal(byObserver.status, 2, byObserver.stdout);
  assert.match(byObserver.json.message, /limited to human/);
  const bare = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1", "--reason", "x"]);
  assert.equal(bare.status, 2);
  assert.match(bare.json.message, /missing required --approval/);

  const declared = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1",
    "--approval", "맞다 이건 이 저장소에서 못 고친다, blocked로 닫자",
    "--reason", "the platform binary is unavailable on any runner this harness can reach"]);
  assert.equal(declared.status, 0, declared.stderr + declared.stdout);
  assert.equal(declared.json.detail.finding.status, "open", "declaring it terminal does not resolve it");
  assert.equal(declared.json.detail.finding.nonConvergence.declaredBy, "human");
  assert.equal(typeof declared.json.detail.finding.nonConvergence.roundsUnchanged, "number");

  // It still refuses a COMPLETE close: nothing about it got fixed.
  const complete = run(root, ["implement", "finalize"]);
  assert.equal(complete.status, 2);
  assert.match(complete.json.message, /risk finding RF1 \(blocking\) is open/);

  const blocked = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(blocked.status, 0, blocked.stderr + blocked.stdout);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, blocked.json.detail.completion.receiptPath), "utf8"));
  assert.equal(receipt.terminalReason, "non-convergent-findings");
  assert.equal(receipt.verificationBudget.budgetExhausted ?? false, false, "the budget was never spent to get here");
  assert.equal(receipt.nonConvergentFindings.length, 1);
  assert.equal(receipt.nonConvergentFindings[0].id, "RF1");
  assert.match(receipt.nonConvergentFindings[0].approval, /blocked로 닫자/);
  assert.equal(receipt.nonConvergentFindings[0].declaredBy, "human");
  const report = fs.readFileSync(path.join(root, blocked.json.detail.completion.implementationResultPath), "utf8");
  assert.match(report, /Non-convergent: declared by human/);
  assert.match(report, /the platform binary is unavailable/);
});

test("AC46: one undeclared finding is enough to keep the run non-terminal", () => {
  const root = makeProject();
  const env = stubEnv(root, [
    { severity: "blocking", text: "the fixture pins an unavailable platform" },
    { severity: "blocking", text: "the second finding is an ordinary fixable bug" },
  ]);
  prove(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);

  assert.equal(run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF1",
    "--approval", "yes", "--reason", "structural"]).status, 0);
  // RF2 could still be fixed by another round, so the run is not terminal:
  // the escape hatch is all-or-nothing on purpose.
  const refused = run(root, ["implement", "finalize", "--status", "blocked"]);
  assert.equal(refused.status, 2);
  assert.match(refused.json.message, /undeclared: RF2/);

  // An already-accepted finding cannot also be declared terminal - the two
  // dispositions mean opposite things about the same defect.
  assert.equal(run(root, ["implement", "risk", "--accept", "--id", "RF2", "--evidence", "user says ship it"]).status, 0);
  const doubled = run(root, ["implement", "risk", "--non-convergent", "--issuer", "human", "--id", "RF2",
    "--approval", "yes", "--reason", "changed my mind"]);
  assert.equal(doubled.status, 2);
  assert.match(doubled.json.message, /is accepted, not open/);
});

// --- R16/AC47: the answer above the record ----------------------------------

test("AC47: status answers in a summary, and the JSON record is one flag away", () => {
  const root = makeProject({ checkCommand: "node --test test/red.test.mjs" });
  stubEnv(root);
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "red.test.mjs"), "import test from 'node:test';\ntest('red', () => { throw new Error('the fixture binary is missing'); });\n");
  // Fail it a few times, then park it with the human's words - the exact
  // state whose reason went missing in 491 lines.
  for (let i = 0; i < 3; i += 1) assert.notEqual(run(root, ["implement", "check", "--row", "B1"]).status, 0);
  const parked = run(root, ["implement", "park", "--issuer", "observer", "--row", "B1",
    "--approval", "TEST-FIXTURE-APPROVAL: not a real human quote",
    "--reason", "the fixture binary is missing on this runner"]);
  assert.equal(parked.status, 0, parked.stdout);

  const human = runPlain(root, ["implement", "status"]);
  assert.equal(human.status, 0, human.stderr + human.stdout);
  const printed = human.stdout;
  assert.doesNotMatch(printed, /"verificationAttempts"/, "the machine record must not be dumped on top of the answer");
  assert.ok(printed.split("\n").length < 40, `the summary must stay readable, got ${printed.split("\n").length} lines`);
  // The three things a person opens status for.
  assert.match(printed, /기계·판사: \d+\/\d+ PASS/);
  assert.match(printed, /parked \(1\)/);
  assert.match(printed, /B1 the fixture binary is missing on this runner/);
  assert.match(printed, /full record: re-run with --json/);

  // Nothing was taken away: --json still carries the whole record.
  const machine = run(root, ["implement", "status", "--json"]);
  assert.equal(machine.status, 0);
  assert.equal(machine.json.detail.parked.length, 1);
  assert.equal(machine.json.detail.rows.length, 1);
  assert.equal(machine.json.detail.rows[0].attempts, 3);
  assert.ok(machine.json.summary.length > 0, "the summary travels in the JSON too, for a caller that wants it");
});

// --- R15/AC40-AC43: what happens after a rejection --------------------------
//
// Every rejection rule in this PRD said what gets refused and stopped there.
// The move a person actually makes next is to replace the evidence and try
// again, and these pin what the record says when they do.

test("AC40: replacing a row's evidence records what became of the old, and reopens verification", () => {
  const root = makeProject();
  const env = stubEnv(root);
  prove(root);
  // The capture lives under agents/, outside the judged tree: this test is
  // about the evidence ledger reopening verification, not about the tree
  // moving, and a capture in the product tree would move it.
  fs.mkdirSync(path.join(root, "agents", "evidence"), { recursive: true });
  const capture = path.join(root, "agents", "evidence", "run.txt");
  fs.writeFileSync(capture, "the first capture\n");
  const first = run(root, ["implement", "artifact", "--row", "B1", "--kind", "log",
    "--path", "agents/evidence/run.txt", "--description", "first capture"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const verified = run(root, ["implement", "verify"], env);
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  const sealed = state(root).verificationAttempts.at(-1).inputFingerprint;
  assert.deepEqual(state(root).evidenceReplacements, [], "a first registration replaces nothing");

  // Re-registering identical bytes is not a resubmission: nothing was replaced.
  const same = run(root, ["implement", "artifact", "--row", "B1", "--kind", "log",
    "--path", "agents/evidence/run.txt", "--description", "first capture"]);
  assert.equal(same.status, 0);
  assert.equal(same.json.detail.unchanged, true);
  assert.deepEqual(state(root).evidenceReplacements, []);

  // Replacing the capture IS. The old vouch is invalidated - the file no
  // longer holds those bytes, so keeping it would be keeping a false record.
  fs.writeFileSync(capture, "the corrected capture\n");
  const replaced = run(root, ["implement", "artifact", "--row", "B1", "--kind", "log",
    "--path", "agents/evidence/run.txt", "--description", "corrected capture"]);
  assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
  const record = state(root).evidenceReplacements;
  assert.equal(record.length, 1);
  assert.equal(record[0].rowId, "B1");
  assert.equal(record[0].kind, "artifact");
  assert.equal(record[0].priorDisposition, "invalidated");
  assert.match(record[0].previous, /agents\/evidence\/run\.txt @ [0-9a-f]{64}/);
  assert.equal(state(root).artifacts.filter((entry) => entry.path === "agents/evidence/run.txt").length, 1, "one current vouch, not two");

  // AC40: the row is back in front of verification - the sealed fingerprint
  // no longer matches, so the old verdict cannot be reused.
  const refused = run(root, ["implement", "finalize"]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.json.message, /fingerprint no longer matches/);
  const reverified = run(root, ["implement", "verify"], env);
  assert.equal(reverified.status, 0, reverified.stderr + reverified.stdout);
  assert.notEqual(state(root).verificationAttempts.at(-1).inputFingerprint, sealed, "a fresh attempt, not the old verdict");
  const finalized = run(root, ["implement", "finalize"]);
  assert.equal(finalized.status, 0, finalized.stderr + finalized.stdout);
});

// --- RF1: a write built on a stale read is refused, never silently applied -

test("RF1: a stale write is refused and the retry keeps both sessions' history", () => {
  const root = makeProject();

  // Session A reads the record. Everything it decides from here - including
  // the next event id - is derived from these bytes.
  const held = loadState(root, { slug: "fixture" });
  const before = held.state.events.map((entry) => entry.id);

  // Session B is a real second process, writing in the same window. This is
  // the concurrency the workflow intends, not a pathological case.
  const other = run(root, ["implement", "check", "--row", "B1"]);
  assert.equal(other.status, 0, other.stderr + other.stdout);
  const landed = state(root).events;
  assert.ok(landed.length > before.length, "the other session's write appended to the log");

  // Session A now writes what it decided against bytes that are gone. Before
  // the check, this rename discarded session B's append and the record looked
  // complete anyway (RF1).
  held.state.events.push({
    id: Math.max(0, ...before) + 1,
    at: new Date().toISOString(),
    kind: "note",
    actor: "implementor",
    subject: null,
    summary: "a write built on the stale read",
  });
  assert.throws(() => persistState(held.statePath, held.state), /changed on disk since this command read it/);
  assert.deepEqual(
    state(root).events.map((entry) => `${entry.id}:${entry.summary}`),
    landed.map((entry) => `${entry.id}:${entry.summary}`),
    "the refused write left the record exactly as the other session wrote it",
  );

  // The recovery is the one the message names: reload, re-apply, write.
  const reloaded = loadState(root, { slug: "fixture" });
  reloaded.state.events.push({
    id: Math.max(0, ...reloaded.state.events.map((entry) => entry.id)) + 1,
    at: new Date().toISOString(),
    kind: "note",
    actor: "implementor",
    subject: null,
    summary: "a write built on the stale read",
  });
  persistState(reloaded.statePath, reloaded.state);

  const merged = state(root).events;
  assert.equal(merged.at(-1).summary, "a write built on the stale read", "session A's record survives the retry");
  for (const entry of landed) {
    assert.ok(merged.some((event) => event.id === entry.id && event.summary === entry.summary),
      `session B's event ${entry.id} survives`);
  }
  assert.equal(new Set(merged.map((entry) => entry.id)).size, merged.length, "no id was minted twice");
  assert.equal(run(root, ["implement", "status"]).status, 0, "the merged record still parses");
});

// --- RF2: registration is the last place a path can still be refused -------

test("RF2: an artifact whose real target leaves the project is refused before its bytes are read", () => {
  const root = makeProject();
  prove(root);

  // The escape is a project-relative path all the way to the judge prompt:
  // lexical normalization sees `secrets/leak.txt`, and only realpath sees the
  // file it actually points at.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-outside-"));
  const secret = path.join(outside, "credentials.txt");
  fs.writeFileSync(secret, "AKIA_FIXTURE_SECRET\n");
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.symlinkSync(secret, path.join(root, "secrets", "leak.txt"));

  const refused = run(root, ["implement", "artifact", "--row", "B1", "--kind", "log",
    "--path", "secrets/leak.txt", "--description", "runtime capture"]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.json.message, /resolves outside the project/);
  assert.match(refused.json.message, /secrets\/leak\.txt/);
  assert.deepEqual(state(root).artifacts.filter((entry) => entry.command === undefined), [],
    "a refused registration leaves no hash-pinned record behind");

  // A symlink is not the offence; leaving the project is. An alias to a file
  // inside the project stays registrable, or the guard would break the
  // worktree layouts that use links.
  fs.writeFileSync(path.join(root, "capture.txt"), "an honest capture\n");
  fs.symlinkSync(path.join(root, "capture.txt"), path.join(root, "secrets", "inside.txt"));
  const accepted = run(root, ["implement", "artifact", "--row", "B1", "--kind", "log",
    "--path", "secrets/inside.txt", "--description", "runtime capture"]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);

  fs.rmSync(outside, { recursive: true, force: true });
});

test("AC42: an amendment drops a suite command, and the record says what became of its result", () => {
  const root = makeProject();
  const env = stubEnv(root);
  prove(root);
  assert.equal(run(root, ["implement", "verify"], env).status, 0);
  const sealedCommands = state(root).suite.commands.map((entry) => entry.id);
  assert.ok(sealedCommands.length > 0, "the fixture sealed at least one suite command");
  const victim = sealedCommands[0];

  // No approval, no exclusion: the sealed list cannot shrink on judgement.
  const bare = run(root, ["implement", "amend", "--issuer", "human", "--exclude-suite", victim, "--reason", "flaky"]);
  assert.equal(bare.status, 2, bare.stdout);
  assert.match(bare.json.message, /--approval/);
  const unknown = run(root, ["implement", "amend", "--issuer", "human", "--exclude-suite", "S99",
    "--approval", "yes", "--reason", "not ours"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.json.message, /unknown suite command: S99/);
  assert.deepEqual(state(root).suite.exclusions, [], "a refused exclusion leaves no trace");

  // Exclusion changes what the run is measured against, so the observer may
  // not issue it: the sealed list shrinks on the human's words alone.
  const byObserver = run(root, ["implement", "amend", "--issuer", "observer", "--exclude-suite", victim,
    "--approval", "yes", "--reason", "not ours"]);
  assert.equal(byObserver.status, 2, byObserver.stdout);
  assert.match(byObserver.json.message, /amend refused for observer/);

  const priorResult = state(root).suite.results.find((entry) => entry.commandId === victim)?.status ?? "none";
  const amended = run(root, ["implement", "amend", "--issuer", "human", "--exclude-suite", victim,
    "--approval", "그 명령은 이 저장소 것이 아니다, 빼자", "--reason", "the command belongs to a vendored tree this run does not own"]);
  assert.equal(amended.status, 0, amended.stderr + amended.stdout);

  const record = state(root).amendments.at(-1);
  assert.equal(record.suiteSnapshotUpdated, true);
  assert.equal(record.scope, "check-cells", "no Behaviors row moved");
  assert.deepEqual(record.excludedSuiteCommands.map((entry) => entry.commandId), [victim]);
  assert.equal(record.excludedSuiteCommands[0].priorResult, priorResult, "the record names what the result WAS");
  assert.equal(state(root).suite.exclusions.at(-1).commandId, victim);
  assert.match(state(root).suite.exclusions.at(-1).approval, /빼자/);

  // The command's last result is PRESERVED as history and stops being scored:
  // deleting it would erase something the run really saw. The sealed list
  // minus its exclusions is the scoring authority.
  assert.ok(state(root).suite.results.some((entry) => entry.commandId === victim), "the result stays in the ledger");
  assert.ok(state(root).suite.commands.some((entry) => entry.id === victim), "and so does the sealed command");
  const summary = runPlain(root, ["implement", "status"]).stdout;
  assert.match(summary, /suite commands excluded by amendment \(1\)/);
  assert.match(summary, /no longer scored, their last result kept as history/);
  // The axis now measures only what remains on the sealed list.
  assert.ok(summary.includes(`/${sealedCommands.length - 1} GREEN`), `suite axis after exclusion:\n${summary}`);
});
