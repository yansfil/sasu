import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist", "cli.js");

const PRD_FIXTURE = `# PRD: fixture

## 7. Acceptance Criteria

- AC1. the widget renders
- AC2. the widget persists its state
`;

function makeProject({ config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-e2e-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, "qa-log.md"), "# Interview Log: fixture\n\n(Q&A here)\n");
  fs.writeFileSync(path.join(dir, "prd.md"), PRD_FIXTURE);
  fs.writeFileSync(path.join(dir, "changes.diff"), "diff --git a/widget.js b/widget.js\n+render()\n+persist()\n");
  return dir;
}

function stubFile(dir, responses) {
  const file = path.join(dir, "stub.json");
  fs.writeFileSync(file, JSON.stringify(responses));
  fs.rmSync(`${file}.cursor`, { force: true });
  return file;
}

function runCli(cwd, args, { stub, env: extraEnv } = {}) {
  const env = { ...process.env, ...extraEnv };
  if (stub) {
    env.CHECKSHIRT_JUDGE_BACKEND = "stub";
    env.CHECKSHIRT_JUDGE_STUB_FILE = stub;
  } else {
    delete env.CHECKSHIRT_JUDGE_BACKEND;
    delete env.CHECKSHIRT_JUDGE_STUB_FILE;
  }
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
}

function gatesState(dir, topic) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents", "gates", topic, "gates.json"), "utf8"));
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

test("gate gap-audit BLOCKs on gaps then PASSes when the log is complete", (t) => {
  const dir = makeProject();
  const blocked = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, BLOCK_RESPONSE),
  });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /BLOCKED/);
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

test("verify FAILs mechanically without calling the judge", () => {
  const dir = makeProject({
    config: { verify: { commands: { test: "node -e \"console.error('unit exploded'); process.exit(2)\"" } } },
  });
  // Poison stub: any judge call would return an invalid reply and surface as ERROR.
  const result = runCli(dir, ["verify", "--slug", "fixture", "--prd", "prd.md", "--diff-file", "changes.diff"], {
    stub: stubFile(dir, "should never be consumed"),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /mechanical:test.*FAIL/);
  assert.match(result.stdout, /unit exploded/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates.verify.verdict, "FAIL");
  assert.equal(state.judgeCalls.length, 0, "semantic judge must not run after mechanical failure");
});

test("verify FAILs semantically with per-criterion reasons after mechanical passes", () => {
  const dir = makeProject({
    config: { verify: { commands: { test: "node -e \"process.exit(0)\"" } } },
  });
  const result = runCli(dir, ["verify", "--slug", "fixture", "--prd", "prd.md", "--diff-file", "changes.diff"], {
    stub: stubFile(dir, {
      verdict: "FAIL",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "render() added in widget.js" },
        { id: "AC2", verdict: "FAIL", reason: "no persistence code in the diff" },
      ],
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /mechanical:test.*ok/);
  assert.match(result.stdout, /AC2: no persistence code/);
});

test("verify PASSes end to end and records judge usage for the receipt", () => {
  const dir = makeProject({
    config: { verify: { commands: { test: "node -e \"process.exit(0)\"" } } },
  });
  const result = runCli(dir, ["verify", "--slug", "fixture", "--prd", "prd.md", "--diff-file", "changes.diff"], {
    stub: stubFile(dir, {
      verdict: "PASS",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "render() added" },
        { id: "AC2", verdict: "PASS", reason: "persist() added" },
      ],
    }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates.verify.verdict, "PASS");
  assert.equal(state.judgeCalls.length, 1);
  assert.equal(state.judgeCalls[0].backend, "stub");
  assert.equal(state.judgeCalls[0].tier, "standard");
});

test("verify auto-detects commands from package.json and suggests pinning them", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const result = runCli(dir, ["verify", "--slug", "fixture", "--prd", "prd.md", "--diff-file", "changes.diff"], {
    stub: stubFile(dir, {
      verdict: "PASS",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "ok" },
        { id: "AC2", verdict: "PASS", reason: "ok" },
      ],
    }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /auto-detected.*verify\.commands/s);
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
  const nodeDir = path.dirname(process.execPath);
  const result = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    env: { CHECKSHIRT_JUDGE_BACKEND: "claude", PATH: nodeDir },
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

test("retry budget: repeated BLOCKs exhaust the configured budget and tell the agent to stop", () => {
  const dir = makeProject({ config: { judge: { retryBudget: 2 } } });
  const block = () =>
    runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
      stub: stubFile(dir, BLOCK_RESPONSE),
    });
  block();
  const second = block();
  assert.equal(second.status, 1);
  assert.match(second.stdout, /RETRY BUDGET EXHAUSTED/);
  assert.match(second.stdout, /user-instructed re-run may continue/, "exhaustion must read as advisory, not a lock");
  // Advisory semantics: a further (user-instructed) run is still executable.
  const third = block();
  assert.equal(third.status, 1, "third run executes instead of being locked out");
});

test("verify PASS prints a per-criterion semantic summary", () => {
  const dir = makeProject({
    config: { verify: { commands: { test: "node -e \"process.exit(0)\"" } } },
  });
  const result = runCli(dir, ["verify", "--slug", "fixture", "--prd", "prd.md", "--diff-file", "changes.diff"], {
    stub: stubFile(dir, {
      verdict: "PASS",
      criteria: [
        { id: "AC1", verdict: "PASS", reason: "render() added" },
        { id: "AC2", verdict: "PASS", reason: "persist() added" },
      ],
    }),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[semantic\] AC1 PASS - render\(\) added/);
  assert.match(result.stdout, /\[semantic\] AC2 PASS - persist\(\) added/);
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
  assert.equal(state.gates["gap-audit"].verdict, "BLOCK");
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

test("fan-out: spec gate runs its three review-axis lanes", () => {
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
    "gate:spec:lane:verification-completeness",
  ]);
});

test("fan-out rerun: convergence demotes a new non-P0 lane finding instead of blocking", () => {
  const dir = makeProject();
  const round1 = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, {
      byPurpose: {
        "lane:data-tech": {
          verdict: "BLOCK",
          findings: [
            { area: "data", severity: "P1", missing: "retention undecided", recommendation: "decide", requiresHuman: false },
          ],
        },
        default: { verdict: "PASS", findings: [] },
      },
    }),
  });
  assert.equal(round1.status, 1);

  // Re-run: the prior data finding is resolved, but a lane invents a NEW P1.
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
              origin: "new",
            },
          ],
        },
        default: { verdict: "PASS", findings: [] },
      },
    }),
  });
  assert.equal(round2.status, 0, "new non-P0 findings on a re-run cannot hold the gate");
  assert.match(round2.stdout, /auto-demoted/);
  const state = gatesState(dir, "fixture");
  assert.equal(state.gates["gap-audit"].verdict, "PASS");
  assert.equal(state.gates["gap-audit"].findings[0].severity, "P2");
});

test("freshness: editing the qa-log after a gap-audit PASS surfaces STALE in gate status", () => {
  const dir = makeProject();
  const passed = runCli(dir, ["gate", "gap-audit", "--slug", "fixture", "--qa-log", "qa-log.md"], {
    stub: stubFile(dir, { verdict: "PASS", findings: [] }),
  });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);

  const fresh = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(fresh.stdout, /gate:gap-audit\] PASS/);

  fs.appendFileSync(path.join(dir, "qa-log.md"), "\n### Q9: new answer added after the gate passed\n");
  const stale = runCli(dir, ["gate", "status", "--slug", "fixture"], {});
  assert.match(stale.stdout, /gate:gap-audit\] STALE/);
  assert.match(stale.stdout, /stale: qa-log\.md changed after this gate passed/);

  // Re-running the gate on the edited document restores a live PASS.
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
