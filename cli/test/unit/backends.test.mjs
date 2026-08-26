// Backend hardening contracts (PRD judge-fanout R7/AC7): the codex judge
// runs in a scoped evidence workspace because codex CLI cannot disable its
// shell. These tests pin the argv, prompt boundary, and command audit so a
// refactor cannot silently broaden judge activity.
import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_ISOLATED_READ_PREAMBLE, CODEX_NO_TOOLS_PREAMBLE, claudePrintArgs, codexActivityProblem, codexBackendAdvisories, codexExecArgs, codexLineAuditor, processSpawnOptions } from "../../dist/judge/backends.js";

test("agentic Claude judge is isolated and can only read or grep", () => {
  const args = claudePrintArgs({ model: "claude-sonnet-5", effort: "low", agentic: true });
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--disable-slash-commands"));
  const tools = args.indexOf("--tools");
  assert.equal(args[tools + 1], "Read,Grep");
  const denied = args.indexOf("--disallowedTools");
  assert.match(args[denied + 1], /Bash/);
  assert.match(args[denied + 1], /Write/);
  assert.doesNotMatch(args[tools + 1], /Glob|Bash|Write/);
});

test("codex judge argv carries the full isolation set", () => {
  const args = codexExecArgs("gpt-5.6-luna", "xhigh", "/tmp/work-root", "/tmp/work-root/last.txt");
  assert.ok(args.includes("--ephemeral"), "must not persist judge sessions");
  assert.ok(args.includes("--ignore-user-config"), "must not load user config into the judge");
  const cdIndex = args.indexOf("-C");
  assert.ok(cdIndex >= 0 && args[cdIndex + 1] === "/tmp/work-root", "work root must be the empty temp dir, not the host repo");
  const sandboxIndex = args.indexOf("--sandbox");
  assert.equal(args[sandboxIndex + 1], "read-only", "sandbox must stay read-only (no writes/exfiltration)");
  assert.ok(args.includes("--ignore-rules"), "project rules must not alter a judge session");
  assert.ok(args.includes("--json"), "command activity must be observable");
  assert.deepEqual(args.slice(-4), ["--model", "gpt-5.6-luna", "--config", 'model_reasoning_effort="xhigh"']);
});

test("codex judge argv omits --model when the profile model is null", () => {
  const args = codexExecArgs(null, "xhigh", "/tmp/w", "/tmp/w/last.txt");
  assert.ok(!args.includes("--model"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
});

test("codex no-tools preamble forbids shell, file access, and tools", () => {
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /Do NOT run shell commands/);
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /do NOT read or list any files/);
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /already included in this prompt/);
});

test("codex scoped-read preamble bounds shell exploration", () => {
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /scoped evidence workspace/);
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /join sed or rg reads with &&, \|\|, ;, \|, or newlines/);
  assert.doesNotMatch(CODEX_ISOLATED_READ_PREAMBLE, /at most three commands/);
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /Do not list directories/);
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /Never execute project code/);
});

test("codex activity audit accepts quoted regex metacharacters from real judge commands", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const commands = [
    "/bin/zsh -lc 'rg -n -i \"dirty|uncommitted|disposition|changed path|changedPaths|working tree|start\" cli/src/implement/commands.ts'",
    "/bin/zsh -lc 'rg -n -i \"retir|isolat|worktree|status|occup|ghost|candidate\" cli/src/doctor.ts cli/src/implement/commands.ts cli/test/e2e/implement.test.mjs'",
    "/bin/zsh -lc \"sed -n '1,80p' cli/src/doctor.ts\"",
    "/bin/zsh -lc 'rg -n \"literal;&|><\" cli/src/doctor.ts'",
  ];
  for (const command of commands) {
    assert.equal(codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["cli/src/doctor.ts", "cli/src/implement/commands.ts", "cli/test/e2e/implement.test.mjs"],
    }), null, command);
  }
});

test("codex activity audit splits safe shell connections and audits every segment", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const cases = [
    {
      command: "/bin/zsh -lc \"sed -n '1,220p' a/piece.json && sed -n '1,220p' a/threads.md\"",
      evidencePaths: ["a/piece.json", "a/threads.md"],
    },
    {
      command: "/bin/zsh -lc \"sed -n '1,240p' x.mjs\nsed -n '1,220p' y.md\"",
      evidencePaths: ["x.mjs", "y.md"],
    },
    {
      command: "/bin/zsh -lc 'rg -n \"a|b\" listed.md'",
      evidencePaths: ["listed.md"],
    },
    {
      command: "sed -n '1,10p' a.md || rg -n x b.md; sed -n '2,20p' c.md | rg -F y d.md",
      evidencePaths: ["a.md", "b.md", "c.md", "d.md"],
    },
  ];
  for (const { command, evidencePaths } of cases) {
    assert.equal(codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths,
    }), null, command);
  }
});

test("codex backend error items are advisories, not command-audit failures", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const stdout = event({ type: "error", message: "Skill descriptions were shortened to fit the skills context budget." });
  assert.equal(codexActivityProblem(stdout, { agentic: true, evidencePaths: [] }), null);
  assert.deepEqual(codexBackendAdvisories(stdout), [{
    code: "judge-backend-advisory",
    backend: "codex",
    message: "Skill descriptions were shortened to fit the skills context budget.",
  }]);
});

test("codex command audit rejects unsafe shell syntax, expansion, and non-read segments", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  assert.match(
    codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -lc \"sed -n '1p' src/status.ts\ncat secret\"" }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    }).detail,
    /non-read command.*cat secret/,
  );
  for (const command of [
    "/bin/zsh -lc 'rg $(cat /etc/passwd) src/status.ts'",
    "/bin/zsh -lc 'rg $HOME src/status.ts'",
    "/bin/zsh -lc 'rg needle src/*.ts'",
    "rg . $'\\x2d\\x2dpre' $'cat /etc/passwd' README.md",
    "/bin/zsh -lc 'rg needle =rg src/status.ts'",
    "/bin/zsh -lc 'rg needle src/status.ts",
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    });
    assert.equal(problem.reason, "shell-composition", command);
  }
  for (const command of [
    "sed -n '1,10p' a.md > out.txt",
    "sed -n '1,10p' a.md >> out.txt",
    "sed -n '1,10p' $(echo a.md)",
    "sed -n '1,10p' `echo a.md`",
    "sed -n '1,10p' a.md < input.txt",
    "(sed -n '1,10p' a.md)",
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["a.md"],
    });
    assert.equal(problem.reason, "shell-composition", command);
  }
  for (const command of [
    "/bin/zsh -lc 'cat /etc/passwd'",
    "/bin/zsh -lc 'rg needle src/status.ts | cat'",
    "sed -n '1,10p' a.md && rm b.md",
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["src/status.ts", "a.md", "b.md"],
    });
    assert.equal(problem.reason, "non-read-command", command);
  }
  for (const command of [
    "/bin/zsh -lc 'sed -n 1p /etc/passwd'",
    "/bin/zsh -lc 'rg needle ../secret.txt src/status.ts'",
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    });
    assert.equal(problem.reason, "out-of-workspace", command);
  }
});

test("codex activity audit fail-closes sed and rg flags while admitting bounded reads", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  for (const command of [
    "/bin/zsh -lc 'rg -n -A2 \"pat\" a.md b.md'",
    "/bin/zsh -lc 'rg --files-with-matches --count --only-matching --smart-case --multiline --type md -m 2 -B1 -C0 \"pat\" a.md b.md'",
    "/bin/zsh -lc 'rg -l -c -o -S -U -t md -e \"-dash|/etc/passwd\" a.md b.md'",
    "/bin/zsh -lc \"sed -n '12,80p' a.md\"",
  ]) {
    assert.equal(codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["a.md", "b.md"],
    }), null, command);
  }

  for (const [command, token] of [
    ["rg --pre=/bin/sh -n \"x\" listed.md", "--pre=/bin/sh"],
    ["rg --hostname-bin=x -n \"y\" listed.md", "--hostname-bin=x"],
    ["rg -f /etc/passwd -n \"x\" listed.md", "-f"],
    ["rg --ignore-file /etc/hosts -n \"x\" listed.md", "--ignore-file"],
    ["rg --file listed.md \"x\" listed.md", "--file"],
    ["rg --pre \"cat /etc/passwd\" \"x\" listed.md", "--pre"],
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["listed.md", "/etc/passwd", "/etc/hosts", "cat /etc/passwd"],
    });
    assert.equal(problem.reason, "non-read-command", command);
    assert.ok(problem.detail.includes(`disallowed flag: ${token}`), problem.detail);
  }

  for (const [command, script] of [
    ["sed -n '1e echo hi' listed.md", "1e echo hi"],
    ["sed -n 's/a/b/e' listed.md", "s/a/b/e"],
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["listed.md"],
    });
    assert.equal(problem.reason, "non-read-command", command);
    assert.ok(problem.detail.includes(`disallowed script: ${script}`), problem.detail);
  }

  for (const command of [
    "/bin/zsh -lc 'rg -n needle src/status.ts src/other.ts'",
    "/bin/zsh -lc 'sed -n -f src/status.ts src/status.ts'",
    "/bin/zsh -lc 'sed -n 1p README.md -f secret'",
  ]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command }), {
      agentic: true,
      evidencePaths: ["src/status.ts", "README.md", "-f", "secret"],
    });
    assert.equal(problem.reason, "non-read-command", command);
  }
  assert.equal(
    codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -lc 'rg needle src/other.ts'" }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    }).reason,
    "missing-allowlisted-path",
  );
});

test("codex activity audit preserves prompt-only isolation without a read-command count budget", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const one = event({ type: "command_execution", command: "/bin/zsh -lc 'sed -n 1p src/status.ts'" });
  assert.equal(codexActivityProblem(one, { agentic: false, evidencePaths: ["src/status.ts"] }).reason, "prompt-only-shell");
  const four = [one, one, one, one].join("\n");
  assert.equal(codexActivityProblem(four, { agentic: true, evidencePaths: ["src/status.ts"] }), null);
});

// Agentic judges resolve repo-relative evidence paths in a harness-owned
// workspace, so the backend must be able to thread that selected cwd through
// spawn. The stub backend never spawns, so this helper pins the contract.
test("judge spawn options carry the selected workspace cwd, and omit it when absent", () => {
  const withCwd = processSpawnOptions({ cwd: "/repo/root" });
  assert.equal(withCwd.cwd, "/repo/root", "the provided project root must reach the spawned judge");
  const without = processSpawnOptions({});
  assert.ok(!("cwd" in without), "no cwd provided must leave the inherited working directory untouched");
});

// The streaming auditor exists so a violating command kills the codex call
// instead of being discovered after it finishes (2026-08-27: 565s and 646s of
// design-lane judge time discarded whole). Two audits over one allowlist can
// drift apart, so parity with the whole-stdout backstop is the contract.
test("codex line auditor matches the whole-stdout audit on the same trace", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const options = { agentic: true, evidencePaths: ["src/status.ts"] };
  const cases = [
    { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,10p' src/status.ts\"" },
    { type: "command_execution", command: "/bin/zsh -lc 'cat /etc/passwd'" },
    { type: "command_execution", command: "/bin/zsh -lc 'rg $HOME src/status.ts'" },
    { type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,10p' /etc/hosts\"" },
    { type: "error", message: "code mode host missing" },
  ];
  const audit = codexLineAuditor(options);
  for (const item of cases) {
    const line = event(item);
    const streamed = audit(line);
    const batched = codexActivityProblem(line, options);
    assert.deepEqual(streamed, batched, JSON.stringify(item));
  }
});

test("codex line auditor ignores non-trace lines instead of aborting on them", () => {
  const audit = codexLineAuditor({ agentic: true, evidencePaths: [] });
  for (const line of ["", "   ", "not json", JSON.stringify({ type: "turn.started" }), JSON.stringify({ type: "item.completed" })]) {
    assert.equal(audit(line), null, line);
  }
});

test("codex line auditor reports the first violating item in trace order", () => {
  const audit = codexLineAuditor({ agentic: true, evidencePaths: ["a.md"] });
  const ok = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,5p' a.md" } });
  const bad = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rm -rf a.md" } });
  assert.equal(audit(ok), null);
  assert.equal(audit(bad).reason, "non-read-command");
});
