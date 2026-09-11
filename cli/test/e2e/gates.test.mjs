import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");
const PRELINT_FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");

// Prelint-clean documents: the deterministic lint runs before every judge
// call, so gate fixtures must be structurally healthy for the judge path to
// be exercised at all.
const QA_FIXTURE = fs.readFileSync(path.join(PRELINT_FIXTURES, "qa-clean.md"), "utf8");
// The clean PRD cites Q2 in its Decisions table and qa-clean.md answers Q2,
// so the pair stays clean under the kept cross-document rule
// prd-cited-question-unanswered.
const PRD_FIXTURE = fs.readFileSync(path.join(PRELINT_FIXTURES, "prd-clean.md"), "utf8");
assert.match(PRD_FIXTURE, /Q2: the user wants state to survive reload/, "the fixture's Q citation moved; keep it on an answered turn");

function gitCommitAll(dir, message, paths = ["-A"]) {
  for (const args of [["init", "-q"], ["add", ...paths], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]]) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }
}

// Verify reads the change under judgment from git itself (the --diff-file
// injection flag was removed as an agent-curated escape hatch), so verify
// fixtures are real repos: the documents are the base commit and widget.js is
// the untracked working change - the same +render()/+persist() content the
// old changes.diff fixture used to inject.
function makeProject({ config, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-e2e-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE);
  fs.writeFileSync(path.join(dir, "prd.md"), PRD_FIXTURE);
  if (git) {
    gitCommitAll(dir, "base");
    fs.writeFileSync(path.join(dir, "widget.js"), "render()\npersist()\n");
  }
  return dir;
}

function stubFile(dir, responses) {
  // Under agents/ so the stub plumbing never rides the judged git diff.
  const file = path.join(dir, "agents", "stub.json");
  fs.writeFileSync(file, JSON.stringify(responses));
  fs.rmSync(`${file}.cursor`, { force: true });
  return file;
}

function runCli(cwd, args, { stub, env: extraEnv } = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!("SASU_HERDR_ROLE" in (extraEnv ?? {}))) delete env.SASU_HERDR_ROLE;
  if (stub) {
    env.SASU_JUDGE_BACKEND = "stub";
    env.SASU_JUDGE_STUB_FILE = stub;
  } else {
    delete env.SASU_JUDGE_BACKEND;
    delete env.SASU_JUDGE_STUB_FILE;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

function gatesState(dir, topic) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "runs", topic, "gates", "gates.json"), "utf8"));
}

const BLOCK_RESPONSE = {
  verdict: "BLOCK",
  findings: [
    {
      area: "data",
      severity: "P0",
      missing: "retention period for deleted tasks undecided",
      recommendation: "ask the user for a retention decision",
      requiresHuman: true,
    },
  ],
};

test("an Implementor role refuses specification gates before setup writes, and an unmarked session recovers", () => {
  const dir = makeProject({ git: true });
  const exclude = path.join(dir, ".git", "info", "exclude");
  const beforeExclude = fs.readFileSync(exclude, "utf8");
  const args = ["gate", "gap-audit", "--slug", "role-fixture", "--qa-log", "qa-log.md", "--json"];
  const refused = runCli(dir, args, {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
    env: { SASU_HERDR_ROLE: "implementor" },
  });

  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const refusal = JSON.parse(refused.stdout);
  assert.equal(refusal.error.code, "implementor-spec-command-refused");
  assert.match(refusal.error.message, /belongs to the Spec Owner or Observer/);
  assert.equal(fs.existsSync(path.join(dir, "agents", "runs", "role-fixture")), false);
  assert.equal(fs.readFileSync(exclude, "utf8"), beforeExclude, "the refusal happens before ensureSetup");

  const recovered = runCli(dir, args, { stub: stubFile(dir, { verdict: "PASS", findings: [] }) });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status.effective, "PASS");
});

// BLOCK_RESPONSE's only finding needs a human decision, so under the open-set
// contract (PRD gate-loop R2) the gate hands it to the user as NEEDS_HUMAN
// rather than reporting a generic BLOCKED.
test("gate gap-audit stops on a human gap then PASSes when the log is complete", (t) => {
  const dir = makeProject();
  const blocked = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /NEEDS_HUMAN/);
  assert.match(blocked.stdout, /retention period/);
  assert.match(blocked.stdout, /needs human decision/);

  const passed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /PASS/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "PASS");
});

test("gate spec BLOCKs on a fidelity gap and records the artifact", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      verdict: "BLOCK",
      findings: [
        {
          area: "fidelity",
          severity: "P0",
          missing: "D-05 rejection of numeric scoring is not represented in the PRD",
          recommendation: "add the rejected option to non-goals",
          requiresHuman: false,
        },
      ],
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fidelity/);
  const state = gatesState(dir, "fixture");
  const artifact = state.gates.spec.history.at(-1).artifact;
  assert.ok(fs.existsSync(path.join(dir, artifact)), "spec gate artifact must exist");
});

test("delegated spec judges receive the later invocation and the source cannot be replaced", () => {
  const dir = makeProject();
  const invocation = "$please keep delivery local and do not commit; choose reversible defaults";
  const delegated = runCli(dir, ["gate", "delegate", "--slug", "fixture", "--evidence", invocation]);
  assert.equal(delegated.status, 0, delegated.stdout + delegated.stderr);

  const capture = path.join(dir, "agents", "capture");
  const result = runCli(dir, ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
    env: { SASU_JUDGE_STUB_CAPTURE_DIR: capture },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const prompts = fs.readdirSync(capture)
    .filter((name) => name.endsWith(".prompt.txt"))
    .map((name) => fs.readFileSync(path.join(capture, name), "utf8"));
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((prompt) => prompt.includes(invocation)));
  assert.match(gatesState(dir, "fixture").gates.spec.delegationSha256, /^[a-f0-9]{64}$/);

  const changed = runCli(dir, ["gate", "delegate", "--slug", "fixture", "--evidence", "$please changed delivery constraint"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout + changed.stderr, /already bound.*original invocation/);
  const status = runCli(dir, ["gate", "status", "--slug", "fixture", "--json"]);
  assert.equal(JSON.parse(status.stdout).spec.effective, "PASS");
  assert.equal(gatesState(dir, "fixture").delegation.evidence, invocation);
});

test("hard block: override without --reason is rejected; with reason it unblocks and records a deviation", () => {
  const dir = makeProject();
  runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  const noReason = runCli(dir, ["gate", "override", "--slug", "fixture", "--gate", "gap-audit"], {});
  assert.equal(noReason.status, 2);
  assert.match(noReason.stderr, /--reason/);

  const withReason = runCli(
    dir,
    ["gate", "override", "--slug", "fixture", "--gate", "gap-audit", "--reason", "spike run, gap accepted"],
    {},
  );
  assert.equal(withReason.status, 0);
  assert.match(withReason.stdout, /deviation/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].overridden, true);
  assert.equal(state.deviations.length, 1);
});

test("fail-closed: a missing judge binary keeps the gate blocked with cause and override path", () => {
  const dir = makeProject();
  // The node bin dir is not a safe PATH: some machines (hermes installs) put
  // claude/codex shims next to node, which un-isolates the test. Build a dir
  // holding only node so both judge binaries are genuinely absent.
  const isolatedBin = path.join(dir, "isolated-bin");
  fs.mkdirSync(isolatedBin);
  fs.symlinkSync(process.execPath, path.join(isolatedBin, "node"));
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    env: { SASU_JUDGE_BACKEND: "claude", PATH: isolatedBin },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /judge error: judge-binary-missing/);
  assert.match(result.stdout, /gate override/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "ERROR");
});

test("fail-closed: invalid judge replies surface as a blocked ERROR run naming the lanes, not a pass", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "garbage that is not json"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /judge error: judge-invalid-output/);
  assert.match(result.stdout, /lane failed \[/, "the failing lane must be named in the output");
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "ERROR");
  // Fan-out: every lane records its failed judge call for the receipt.
  assert.equal(state.judgeCalls.length, 4);
  assert.ok(state.judgeCalls.every((c) => c.outcome === "judge-invalid-output"));
});

// The measured incident (2026-08-11, project modakbul, slug
// webhook-to-modakbul-server): 4 of 10 verify attempts died as
// `judge-invalid-output`, no round ever returned a criterion FAIL, and the run
// still went BLOCKED three times because the broken judge was charged to the
// fix budget. End to end, a judge that never answers must leave the budget
// alone and must still stop the loop with its own named cause.
test("retry budget: a judge-error loop spends no budget and terminates on its own cause", () => {
  const dir = makeProject({ config: { judge: { retryBudget: 15 } } });
  const broken = () =>
    runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
      stub: stubFile(dir, "garbage that is not json"),
    });

  const first = broken();
  assert.equal(first.status, 1, "fail-closed: a judge error is never a pass");
  assert.match(first.stdout, /review cycle 1 \| open findings 0/, "the semantic cycle is untouched by a judge malfunction");
  assert.doesNotMatch(first.stdout, /failed 1 times in a row/, "one broken call is still just 're-run'");

  const second = broken();
  assert.equal(second.status, 1);
  assert.match(second.stdout, /review cycle 1 \| open findings 0/, "still nothing open: there was never a semantic verdict");
  assert.doesNotMatch(second.stdout, /RETRY BUDGET EXHAUSTED/, "the receipt must not claim a budget it did not spend");
  assert.doesNotMatch(second.stdout, /close the run out honestly as blocked/, "two identical failures remain below the backend threshold");

  const third = broken();
  assert.equal(third.status, 1);
  assert.match(third.stdout, /failed 3\/3 times in a row with the same cause \(stub\/judge-invalid-output\/missing-json\)/, "the independent loop bound names the structured cause");
  assert.match(third.stdout, /close the run out honestly as blocked/, "and names the exit instead of demanding another re-run");

  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].attempts, 0);
  assert.equal(state.gates["gap-audit"].consecutiveErrors, 3);
  assert.equal(state.gates["gap-audit"].totalAttempts, 3, "all runs are still in the honest ledger");
  assert.equal(state.gates["gap-audit"].history.length, 3);
});

test("fan-out: one blocking lane blocks the merged gate and per-lane records land in the artifact", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:ux-behavior": {
          verdict: "BLOCK",
          findings: [
            {
              area: "ux",
              severity: "P0",
              missing: "deletion error state undecided",
              recommendation: "ask the user for the error behavior",
              requiresHuman: true,
            },
          ],
        },
        default: { verdict: "PASS", findings: [] },
      },
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /deletion error state undecided/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "NEEDS_HUMAN", "the one open finding needs a human decision");
  assert.equal(state.judgeCalls.length, 4, "one judge call per gap-audit lane");
  const lanePurposes = state.judgeCalls.map((c) => c.purpose).sort();
  assert.ok(lanePurposes.every((p) => p.startsWith("gate:gap-audit:lane:")));
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, state.gates["gap-audit"].history.at(-1).artifact), "utf8"));
  assert.equal(artifact.lanes.length, 4);
  assert.equal(artifact.lanes.filter((l) => l.verdict === "BLOCK").length, 1);
  assert.equal(typeof artifact.dedupedCount, "number");
});

test("fan-out: judge.fanout=false restores the single-judge path with exactly one call", () => {
  const dir = makeProject({ config: { judge: { fanout: false } } });
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = gatesState(dir, "fixture");
  assert.equal(state.judgeCalls.length, 1);
  assert.equal(state.judgeCalls[0].purpose, "gate:gap-audit");
});

test("fan-out: spec gate runs its two review-axis lanes", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { byPurpose: { default: { verdict: "PASS", findings: [] } } }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = gatesState(dir, "fixture");
  const purposes = state.judgeCalls.map((c) => c.purpose).sort();
  assert.deepEqual(purposes, [
    "gate:spec:lane:fidelity",
    "gate:spec:lane:testability",
  ]);
});

test("fan-out rerun: a new lane finding on an unchanged document is discarded, and the resolved set seals", () => {
  const dir = makeProject();
  const round1 = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:ux-behavior": {
          verdict: "BLOCK",
          findings: [
            { area: "ux", severity: "P1", missing: "error state undecided", recommendation: "decide", requiresHuman: false },
          ],
        },
        default: { verdict: "PASS", findings: [] },
      },
    }),
  });
  assert.equal(round1.status, 1);

  // Re-run: the prior ux finding is resolved (not echoed), but the lane
  // invents a NEW P1 on a document whose decisions did not change (PRD
  // gate-loop R1: the open set can only shrink there).
  const round2 = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:ux-behavior": {
          verdict: "BLOCK",
          findings: [
            {
              area: "ux",
              severity: "P1",
              missing: "a newly invented depth-3 trim concern",
              recommendation: "trim it",
              requiresHuman: false,
            },
          ],
        },
        default: { verdict: "PASS", findings: [] },
      },
    }),
  });
  assert.equal(round2.status, 0, round2.stdout + round2.stderr);
  assert.match(round2.stderr, /new finding\(s\) from lanes whose decisions did not change were discarded/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "PASS");
  assert.deepEqual(state.gates["gap-audit"].findings, []);
  assert.deepEqual(state.gates["gap-audit"].warnings, [], "a discarded finding is not smuggled in as a warning");
  const calls = state.judgeCalls.length;
  const cached = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "poison: an unchanged sealed PASS must be cached"),
  });
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  assert.equal(gatesState(dir, "fixture").judgeCalls.length, calls, "cached PASS makes zero judge calls");
});

test("sealed PASS: input drift refuses automatic re-judgment and explicit reopen starts a fresh review", () => {
  const dir = makeProject();
  const passed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { byPurpose: { default: { verdict: "PASS", findings: [] } } }),
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);

  // A decision cell changed after the seal (PRD gate-loop R4: that, and
  // only that, is drift on a qa-log).
  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE.replace("widget renders a list", "widget renders a grid"));
  const callsBefore = gatesState(dir, "fixture").judgeCalls.length;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const rerun = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
      stub: stubFile(dir, `poison ${attempt}: a sealed cycle must not call the judge`),
    });
    assert.equal(rerun.status, 1);
    assert.match(rerun.stdout, /reopen-required/);
  }
  assert.equal(gatesState(dir, "fixture").judgeCalls.length, callsBefore, "drift refusal is a $0 decision");
  const reopened = runCli(dir, ["gate", "reopen", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "review the added answer"]);
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  const reviewed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { byPurpose: { default: { verdict: "PASS", findings: [] } } }),
  });
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
  assert.equal(gatesState(dir, "fixture").gates["gap-audit"].reviewReopens.length, 1);
  assert.match(runCli(dir, ["gate", "status", "--slug", "fixture"]).stdout, /gate:gap-audit\] PASS \| review cycle 2/);
});

test("freshness: editing the qa-log after a gap-audit PASS surfaces STALE in gate status", () => {
  const dir = makeProject();
  const passed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);

  const fresh = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(fresh.stdout, /gate:gap-audit\] PASS/);

  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE.replace("| P1 | user | resolved |", "| P0 | user | resolved |"));
  const stale = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(stale.stdout, /gate:gap-audit\] STALE/);
  assert.match(stale.stdout, /stale: qa-log\.md changed after this gate passed/);

  const refused = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "poison"),
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /reopen-required/);
  const reopened = runCli(dir, ["gate", "reopen", "--slug", "fixture", "--gate", "gap-audit", "--evidence", "the qa log changed; review it"]);
  assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
  // Re-running after the explicit reopen restores a live PASS.
  const rerun = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  const restored = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(restored.stdout, /gate:gap-audit\] PASS/);
});

test("gate status reports all three gates and the judge call count", () => {
  const dir = makeProject();
  runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  const status = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.equal(status.status, 0);
  assert.match(status.stdout, /gate:gap-audit\] PASS/);
  assert.match(status.stdout, /gate:spec\] NOT_RUN/);
  assert.match(status.stdout, /judge calls recorded: 4/, "fan-out records one judge call per lane");
});

test("prelint: a structural qa-log defect blocks at $0 - no judge call, no attempt, no state", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE.replace("## Audit History", "## Audit Trail"));
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "poison: the judge must never be consulted"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[prelint\] qa-section-missing/);
  assert.match(result.stdout, /no attempt consumed/);
  assert.equal(
    fs.existsSync(path.join(dir, "agents", "runs", "fixture", "gates", "gates.json")),
    false,
    "a prelint block must not create or mutate gate state",
  );

  // Fixing the document reaches the judge normally.
  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE);
  const fixed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /\[prelint\] ok/);
});

test("prelint: a blocked judge attempt count survives a later prelint failure untouched", () => {
  const dir = makeProject();
  const blocked = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  assert.equal(blocked.status, 1);
  const before = gatesState(dir, "fixture");
  assert.equal(before.gates["gap-audit"].attempts, 1);

  fs.writeFileSync(path.join(dir, "qa-log.md"), QA_FIXTURE.replace('status: "active"', 'status: "wip"'));
  const prelinted = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "poison"),
  });
  assert.equal(prelinted.status, 1);
  assert.match(prelinted.stdout, /\[prelint\] qa-frontmatter-enum/);
  const after = gatesState(dir, "fixture");
  assert.equal(after.gates["gap-audit"].attempts, 1, "prelint failures must not consume the retry budget");
  assert.equal(after.judgeCalls.length, before.judgeCalls.length, "prelint failures must not call the judge");
});

test("prelint: spec gate lints the PRD at its entrance", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "prd.md"), PRD_FIXTURE.replace('human_approval: "approved"', 'human_approval: "maybe"'));
  const result = runCli(dir, ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, "poison"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[prelint\] prd-frontmatter-enum/);
  assert.equal(fs.existsSync(path.join(dir, "agents", "runs", "fixture", "gates", "gates.json")), false);
});

test("prelint: an unreadable document path fails closed with a cause and no judge call (AC7)", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "no-such-file.md"], {
    stub: stubFile(dir, "poison"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /qa-log not found/);
  assert.equal(fs.existsSync(path.join(dir, "agents", "runs", "fixture", "gates", "gates.json")), false);
});

test("json contract: gate results carry contractVersion and a prelint key separate from judge findings", () => {
  const dir = makeProject();
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--json"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prelint.ok, true);
  assert.deepEqual(parsed.prelint.findings, []);
  assert.deepEqual(parsed.status.findings, [], "prelint findings must never leak into judge findings");

  const blocked = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "broken.md", "--json"], {
    stub: stubFile(dir, "poison"),
  });
  fs.writeFileSync(path.join(dir, "broken.md"), QA_FIXTURE.replace("## Raw Q&A", "## Raw Answers"));
  const blocked2 = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "broken.md", "--json"], {
    stub: stubFile(dir, "poison"),
  });
  const parsedBlock = JSON.parse(blocked2.stdout);
  assert.equal(blocked2.status, 1);
  assert.equal(parsedBlock.prelint.ok, false);
  assert.equal(parsedBlock.prelint.findings[0].rule, "qa-section-missing");
  assert.equal(blocked.status, 1, "missing file still exits 1");
});

test("json contract: doctor, status, and override all emit contractVersion-tagged JSON", () => {
  const dir = makeProject();
  const doctor = runCli(dir, ["doctor", "--json"], {});
  const doctorParsed = JSON.parse(doctor.stdout);
  assert.match(doctorParsed.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(doctorParsed.sections));

  runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  const status = runCli(dir, ["gate", "status", "--slug", "fixture", "--json"], {});
  const statusParsed = JSON.parse(status.stdout);
  assert.match(statusParsed.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(statusParsed["gap-audit"].effective, "NEEDS_HUMAN");

  const override = runCli(
    dir,
    ["gate", "override", "--slug", "fixture", "--gate", "gap-audit", "--reason", "user accepts the gap", "--json"],
    {},
  );
  assert.equal(override.status, 0);
  const overrideParsed = JSON.parse(override.stdout);
  assert.match(overrideParsed.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(overrideParsed.overridden, true);
  assert.equal(overrideParsed.status.effective, "PASS");
});

test("the duplicate PRD verify completion path is explicitly retired", () => {
  const dir = makeProject({git: true});
  const result = runCli(dir, ["gate", "verify", "--slug", "fixture", "--prd", "prd.md"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /retired|removed/i);
});

test("delegated run: --assume-human-findings converts non-P0 human findings to a recorded ledger and proceeds", () => {
  const dir = makeProject();
  const humanBlock = {
    verdict: "BLOCK",
    findings: [
      {
        area: "delivery",
        severity: "P1",
        missing: "delivery scope (receipt-only vs PR) unconfirmed",
        recommendation: "confirm the delivery scope with the user",
        requiresHuman: true,
      },
    ],
  };
  const invocation = "$please 대화한 대로 끝까지 구현해줘";
  const assumed = runCli(
    dir,
    ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--assume-human-findings", invocation],
    { stub: stubFile(dir, humanBlock) },
  );
  assert.equal(assumed.status, 0, assumed.stdout + assumed.stderr);
  assert.match(assumed.stdout, /PASS/);
  const record = gatesState(dir, "fixture").gates["gap-audit"];
  assert.equal(record.verdict, "PASS");
  assert.equal(record.humanAssumptions.length, 1);
  assert.equal(record.humanAssumptions[0].evidence, invocation, "the ledger quotes the delegating message verbatim");
  assert.equal(record.humanAssumptions[0].findings[0].missing, "delivery scope (receipt-only vs PR) unconfirmed");
  assert.equal(record.humanAssumptions[0].findings[0].severity, "P1", "the ledger keeps the judged severity");
  assert.deepEqual(record.findings, [], "nothing stays open");
  assert.equal(record.warnings[0].severity, "P2", "the recorded finding is the demoted advisory");

  // The substitution stays loud on every status read.
  const status = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(status.stdout, /ASSUMED HUMAN DECISIONS: 1 finding/);
});

test("delegated run: a stored `gate delegate` record applies without the per-call flag", () => {
  // 2026-08-20: two of three real $please runs omitted --assume-human-findings
  // (it lived only as skill prose) and burned 4+ blocked rounds on findings
  // the delegation had already answered. The stored record makes the
  // delegation run state, not agent discipline.
  const dir = makeProject();
  const humanBlock = {
    verdict: "BLOCK",
    findings: [
      {
        area: "delivery",
        severity: "P1",
        missing: "delivery scope unconfirmed",
        recommendation: "confirm with the user",
        requiresHuman: true,
      },
    ],
  };
  const invocation = "그냥 끝까지 해줘 /please";
  const delegated = runCli(dir, ["gate", "delegate", "--slug", "fixture", "--evidence", invocation], {});
  assert.equal(delegated.status, 0, delegated.stdout + delegated.stderr);

  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, humanBlock),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = gatesState(dir, "fixture").gates["gap-audit"];
  assert.equal(record.verdict, "PASS");
  assert.equal(record.humanAssumptions.length, 1);
  assert.equal(record.humanAssumptions[0].evidence, invocation, "the ledger quotes the stored delegation");

  // The stored delegation stays loud on status.
  const status = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(status.stdout, /delegated run \(recorded /);
});

test("delegated run: the stored invocation cannot be replaced by a per-call placeholder", () => {
  const dir = makeProject();
  const invocation = "$please keep this local and do not commit";
  const delegated = runCli(dir, ["gate", "delegate", "--slug", "fixture", "--evidence", invocation]);
  assert.equal(delegated.status, 0, delegated.stdout + delegated.stderr);

  const refused = runCli(
    dir,
    ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md", "--assume-human-findings", "dummy"],
    { stub: stubFile(dir, { verdict: "PASS", findings: [] }) },
  );
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /conflicts with the topic's stored delegation/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.delegation.evidence, invocation);
  assert.equal(state.judgeCalls.length, 0);
  assert.equal(state.gates.spec.verdict, null);
});

// 2026-09-10: gap-audit passed, spec asked the user one question, and the
// answer `gate answer` appended to the shared qa-log read as "qa-log.md
// changed after this gate passed" for gap-audit, which then refused
// `implement start`. An unanchored turn backs no decision yet; the seal moves
// when the answer is normalized into the register, not when it is written.
test("a sibling gate's recorded answer does not stale a sealed gate; an anchored answer still does", () => {
  const dir = makeProject();
  const passed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--json"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  const asked = runCli(dir, ["gate", "spec", "--slug", "fixture", "--prd", "prd.md", "--qa-log", "qa-log.md", "--json"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  assert.equal(JSON.parse(asked.stdout).status.effective, "NEEDS_HUMAN", asked.stdout + asked.stderr);
  const answered = runCli(dir, ["gate", "answer", "--slug", "fixture", "--gate", "spec", "--evidence", "Deleted tasks are retained for 30 days, then purged.", "--json"], {});
  assert.equal(answered.status, 0, answered.stdout + answered.stderr);
  assert.match(fs.readFileSync(path.join(dir, "qa-log.md"), "utf8"), /### Q3: spec human decision bundle[\s\S]*- decision_ids: none/, "the answer landed as an unanchored turn");

  const status = JSON.parse(runCli(dir, ["gate", "status", "--slug", "fixture", "--json"], {}).stdout);
  assert.equal(status["gap-audit"].effective, "PASS", JSON.stringify(status["gap-audit"]));
  assert.equal(status["gap-audit"].stale, false);
  assert.equal(status.spec.effective, "PASS");

  // The RF2 protection is untouched: an answer a decision rests on is pinned.
  const log = path.join(dir, "qa-log.md");
  fs.writeFileSync(log, fs.readFileSync(log, "utf8").replace("- answer: yes, render a list", "- answer: no, render a grid"));
  const edited = JSON.parse(runCli(dir, ["gate", "status", "--slug", "fixture", "--json"], {}).stdout);
  assert.equal(edited["gap-audit"].effective, "STALE");
  assert.deepEqual(edited["gap-audit"].staleInputs, [{ path: "qa-log.md", reason: "changed" }]);
});

test("delegated run: a P0 human finding still blocks under --assume-human-findings", () => {
  const dir = makeProject();
  const result = runCli(
    dir,
    ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--assume-human-findings", "$please go"],
    { stub: stubFile(dir, BLOCK_RESPONSE) }, // BLOCK_RESPONSE carries a P0 requiresHuman finding
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /NEEDS_HUMAN/, "a P0 human finding is never assumed; it goes to the user");
  const record = gatesState(dir, "fixture").gates["gap-audit"];
  assert.equal(record.verdict, "NEEDS_HUMAN");
  assert.equal(record.humanAssumptions, undefined, "nothing was assumed");
});

test("delegated run: empty --assume-human-findings evidence is refused before any judge call", () => {
  const dir = makeProject();
  const result = runCli(
    dir,
    ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--assume-human-findings", "  "],
    { stub: stubFile(dir, { verdict: "PASS", findings: [] }) },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /verbatim delegated invocation/);
});

// The auth recovery names the topology the failure record actually shows.
// 2026-08-27 modakbul gap-audit: the Codex primary failed at preflight and the
// Claude fallback terminally failed "Not logged in", but a hardcoded
// Claude-primary/Codex-fallback sentence sent the operator to repair the
// wrong backend.
test("a dual-backend auth failure's recovery is built from the failure record", () => {
  const dir = makeProject();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 99\n");
  fs.writeFileSync(
    path.join(bin, "claude"),
    "#!/bin/sh\nprintf '%s' '{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in. Please run /login.\"}'\n",
  );
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md", "--json"], {
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error.code, "judge-auth");
  assert.match(parsed.error.recovery, /The claude judge was not authenticated/);
  assert.match(parsed.error.recovery, /The codex judge was already abandoned first/);
  assert.doesNotMatch(parsed.error.recovery, /Codex fallback was unavailable/, "the topology must come from the record, never a hardcoded sentence");
  fs.rmSync(bin, { recursive: true, force: true });
});
