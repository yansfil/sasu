// Backend hardening contracts (PRD judge-fanout R7/AC7): the codex judge
// runs in a scoped evidence workspace because codex CLI cannot disable its
// shell. These tests pin the argv, prompt boundary, and command audit so a
// refactor cannot silently broaden judge activity.
import assert from "node:assert/strict";
import test from "node:test";
import { newJudgeActivity, readEvidence } from "../../dist/judge/types.js";
import { AGENTIC_READ_MAX_ROUNDS, AGENTIC_READ_MAX_OUTPUT_CHARS, CLAUDE_EXPLORATION_PREAMBLE, CLAUDE_ISOLATED_READ_PREAMBLE, CLAUDE_MAX_API_TURNS, CODEX_EXPLORATION_PREAMBLE, CODEX_ISOLATED_READ_PREAMBLE, CODEX_NO_TOOLS_PREAMBLE, claudePrintArgs, claudeReadChars, claudeUsage, codexActivityProblem, codexBackendAdvisories, codexExecArgs, codexLineAuditor, processSpawnOptions } from "../../dist/judge/backends.js";

test("agentic Claude judge is isolated and can only read or grep", () => {
  const args = claudePrintArgs({ model: "claude-sonnet-5", effort: "low", agentic: true });
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--restricted"), "customization isolation alone does not restrict native file reads");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--disable-slash-commands"));
  const tools = args.indexOf("--tools");
  assert.equal(args[tools + 1], "Read,Grep");
  const denied = args.indexOf("--disallowedTools");
  assert.match(args[denied + 1], /Bash/);
  assert.match(args[denied + 1], /Write/);
  assert.doesNotMatch(args[tools + 1], /Glob|Bash|Write/);
  // Bounded in flight: the read budget plus the answering turn. A judge that
  // needs a 17th read is stopped there rather than after it finishes.
  const cap = args.indexOf("--max-turns");
  assert.ok(cap >= 0, "agentic calls must carry a turn cap");
  assert.equal(args[cap + 1], String(AGENTIC_READ_MAX_ROUNDS + 1));
});

// Three bounds hold an agentic claude call and the non-exploring one was told
// none of them: it had no preamble at all, while the codex call on the same
// footing gets CODEX_ISOLATED_READ_PREAMBLE. The numbers must come from the
// constants, not be retyped, or the message drifts from the check silently.
test("a non-exploring agentic claude call is told every bound it runs under", () => {
  const preamble = CLAUDE_ISOLATED_READ_PREAMBLE;
  assert.match(preamble, new RegExp(String(AGENTIC_READ_MAX_ROUNDS)), "the round budget");
  assert.match(preamble, new RegExp(String(AGENTIC_READ_MAX_OUTPUT_CHARS)), "the char budget");
  assert.match(preamble, new RegExp(String(CLAUDE_MAX_API_TURNS)), "the turn cap");
  // What this call may use is pinned by the argv test above, not by matching
  // prose here - the preamble names Glob and the path index in order to rule
  // them out, and a regex looking for the words cannot tell "do not use Glob"
  // from "use Glob" without keying on how one sentence happens to be phrased
  // (PRINCIPLES item 11).
});

// Guidance and check pointing the same way, asserted through the function the
// check actually uses rather than through either one's prose. Both isolated
// preambles go to one call site, the agentic whole-contract gate, whose
// validator rejects `readEvidence(...) === "none-observed"`. An observation
// with counters at zero is exactly that, so a preamble that invites reading
// nothing describes a path to a rejection.
test("the isolated preambles ask for the reading their only caller requires", () => {
  const readNothing = { commands: [], readRounds: 0, modelTurns: null, readOutputChars: 0, msToLastRead: null };
  assert.equal(readEvidence(readNothing), "none-observed",
    "reading nothing is a rejection at that gate, not a shortcut");
  for (const preamble of [CLAUDE_ISOLATED_READ_PREAMBLE, CODEX_ISOLATED_READ_PREAMBLE]) {
    assert.match(preamble, /Read the paths the prompt names/,
      "stated, and scoped to what exists: that caller's evidence list is empty for a purely deleting change");
    assert.doesNotMatch(preamble, /read nothing|use no command/,
      "an invitation to read nothing would name the one behavior this call is rejected for");
  }
});

// The exploring call keeps its own two, and must not be told the round budget
// it is exempt from.
test("an exploring claude call is told the budgets that actually hold it", () => {
  assert.match(CLAUDE_EXPLORATION_PREAMBLE, new RegExp(String(AGENTIC_READ_MAX_OUTPUT_CHARS)));
  assert.match(CLAUDE_EXPLORATION_PREAMBLE, new RegExp(String(CLAUDE_MAX_API_TURNS)));
  assert.doesNotMatch(CLAUDE_EXPLORATION_PREAMBLE, new RegExp(`at most ${AGENTIC_READ_MAX_ROUNDS}`),
    "exploration lifts the round budget; stating it would be asking for something the harness does not check");
});

// The metering unit, stated as the path it walks rather than as a list of what
// it skips. An exclusion list never closes: two implementations that both
// "skip tool_use_result" were measured at 103% and 128% of the same budget on
// the same trace, because they serialised different amounts of what was left.
// Naming the path makes everything else a consequence.
//
// The three numbers below are one production trace (shard3, 2026-09-10) under
// three definitions, and they decide opposite things about the same call:
//   A  message.content tool_result text        202,549   52.7%   accepted
//   B  A plus the CLI's tool_use_result copy   >384,000  >100%   rejected
//   C  B counting image payloads too         >1,920,000  >500%   rejected
// A is pinned exactly; B and C are asserted as lower bounds, because "naive"
// is a family rather than a number and a test that pins one of them would
// break with the wrong explanation when an implementation picked another.
test("claude read chars count tool_result text, and nothing that merely repeats it", () => {
  // The payload is deliberately shorter than the read text so the two bounds
  // below discriminate: an implementation that counts images lands under the
  // duplicate bound and fails only the image one. Real payloads are far larger
  // - the production figures are in claudeReadChars' own comment - and that
  // size is not what either bound is testing.
  const imageData = "A".repeat(300);
  const text = "x".repeat(500);
  const line = (content, extra = {}) => JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t", content }] },
    ...extra,
  });
  const trace = [
    // A read: text in the block, and the CLI's duplicate of the same body
    // hanging off the record's top level.
    line([{ type: "text", text }], { tool_use_result: { file: { content: text } } }),
    // An image: the read text is empty and the payload is not read output.
    line([{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } }],
      { tool_use_result: { file: { content: imageData } } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "{}" }),
  ].join("\n");
  // The two wrong answers come first, and deliberately: the exact assertion
  // below is strictly stronger, so it would catch either drift on its own and
  // report only that the number is off. These name which definition it drifted
  // to. (An earlier version of these lines compared the fixture's own length
  // instead of the result, and so could not fail for any implementation.)
  assert.ok(claudeReadChars(trace) < text.length * 2,
    "counting the CLI's tool_use_result copy would put every read in twice");
  assert.ok(claudeReadChars(trace) < text.length + imageData.length,
    "counting image payloads would add a base64 body that was never read text");
  assert.equal(claudeReadChars(trace), text.length, "one read's text, counted once, with the image contributing nothing");
});

// The other way this meter can be wrong is downward, and nothing here catches
// that: a trace cut by the 16 MiB transport limit would meter only the part
// that arrived. What stops it is that the cut is detected first and the call
// never reaches metering - one branch, guarded by
// "a claude trace cut by the transport limit says so instead of looking like
// no reply" in runner.test.mjs. If that branch is ever relaxed, this meter
// starts under-reporting silently.
test("claude read chars ignore a trace with no reads instead of guessing", () => {
  const noReads = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answering" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "{}" }),
  ].join("\n");
  assert.equal(claudeReadChars(noReads), 0, "a trace that read nothing observed zero, which is not the same as unmetered");
});

// stream-json is what makes a claude read countable at all: the trace carries
// one user.tool_result block per assistant.tool_use, and the block body is the
// same quantity codex meters as aggregated_output. Under --print the CLI
// refuses the format without --verbose - measured 2026-09-11 on claude 2.1.268,
// exit 1 with "When using --print, --output-format=stream-json requires
// --verbose" and empty stdout - so the two flags are one decision, not two.
test("Claude judge streams its trace, which the CLI only allows with verbose", () => {
  const args = claudePrintArgs({ model: "claude-sonnet-5", effort: "low", agentic: true });
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"), "the CLI exits 1 on stream-json under --print without it");
});

test("prompt-only Claude judge has no tools and therefore no turn cap", () => {
  const args = claudePrintArgs({ model: "claude-sonnet-5", effort: "low" });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(!args.includes("--max-turns"), "a one-shot reply is one turn; a cap would only add a way to fail");
});

test("codex judge argv carries the full isolation set", () => {
  const args = codexExecArgs("gpt-5.6-luna", "xhigh", "/tmp/work-root", "/tmp/work-root/last.txt");
  assert.ok(args.includes("--ephemeral"), "must not persist judge sessions");
  assert.ok(args.includes("--ignore-user-config"), "must not load user config into the judge");
  const cdIndex = args.indexOf("-C");
  assert.ok(cdIndex >= 0 && args[cdIndex + 1] === "/tmp/work-root", "work root must be the empty temp dir, not the host repo");
  assert.ok(!args.includes("--sandbox"), "generic read-only permits outside source reads and must not override the scoped profile");
  assert.ok(args.includes("--strict-config"), "unsupported CLIs must refuse the boundary instead of ignoring it");
  assert.ok(args.includes('default_permissions="review-evidence"'));
  assert.ok(args.includes('permissions.review-evidence.filesystem={":minimal"="read","/tmp/work-root"="read"}'), "only the fixed source root, not a tool-selected cwd, gets product file access");
  assert.ok(args.includes("permissions.review-evidence.network.enabled=false"));
  assert.ok(args.includes('approval_policy="never"'));
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

// 2026-08-28 modakbul acceptance lane: a judge wrapped three safe sed reads in
// `/bin/zsh -c` (newline-joined) and the `-lc`-only wrapper check voided the
// verdict, costing a full verify attempt. `-c` audits identically to `-lc`;
// any other wrapper spelling still fails closed.
test("codex activity audit accepts /bin/zsh -c as the -lc wrapper's equivalent", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  const command = "/bin/zsh -c \"sed -n '1,240p' a/types.ts\nsed -n '1,280p' a/schemas.ts\nsed -n '1,280p' a/result.tsx\"";
  assert.equal(codexActivityProblem(event({ type: "command_execution", command }), {
    agentic: true,
    evidencePaths: ["a/types.ts", "a/schemas.ts", "a/result.tsx"],
  }), null, command);
  const unsafeInner = codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -c 'cat /etc/passwd'" }), {
    agentic: true,
    evidencePaths: [],
  });
  assert.equal(unsafeInner.reason, "non-read-command", "-c must not weaken the inner audit");
  for (const wrapper of ["/bin/zsh -x -c 'sed -n 1p a.md'", "/bin/zsh -ic 'sed -n 1p a.md'", "/bin/zsh 'sed -n 1p a.md'"]) {
    const problem = codexActivityProblem(event({ type: "command_execution", command: wrapper }), {
      agentic: true,
      evidencePaths: ["a.md"],
    });
    assert.equal(problem.reason, "shell-composition", wrapper);
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

// Three shapes, not two. The old "is it zero" test could not tell an
// unmetered call from a call that read nothing, which is the same conflation
// that left failed judge calls with no record at all.
test("read evidence separates a metered zero from an unmetered call from a positive observation", () => {
  const shape = (overrides) => ({ commands: null, readRounds: null, modelTurns: null, readOutputChars: null, msToLastRead: null, ...overrides });
  assert.equal(readEvidence(newJudgeActivity()), "unmetered");
  assert.equal(readEvidence(shape({})), "unmetered");
  assert.equal(readEvidence(shape({ commands: [], readRounds: 0, readOutputChars: 0 })), "none-observed");
  assert.equal(readEvidence(shape({ readRounds: 0 })), "none-observed",
    "a backend that attests zero read rounds has metered this call, even with no command trace");
  assert.equal(readEvidence(shape({ commands: ["sed -n '1,5p' a.md"], readRounds: 1, readOutputChars: 12, msToLastRead: 4 })), "observed");
  assert.equal(readEvidence(shape({ commands: [], readRounds: 0, readOutputChars: 900, msToLastRead: 7 })), "observed",
    "metered read output cannot be reported as nothing read");
  // Turns are a different question and never answer this one. The API backend
  // reports exactly one turn having read nothing at all, which is why counting
  // turns here would let a call with no read surface look like a reader.
  assert.equal(readEvidence(shape({ modelTurns: 1 })), "unmetered",
    "a turn count says nothing about reading, so a call that reports only turns remains unverified");
  assert.equal(readEvidence(shape({ modelTurns: 9, readRounds: 8 })), "observed",
    "the read count is what answers, and it rides beside the raw turn count rather than replacing it");
  assert.equal(readEvidence(shape({ modelTurns: 1, readRounds: 0 })), "none-observed",
    "one turn and a metered zero is a call that read nothing, not a call nobody measured");
});

// The budget and the gate ask different questions, and 2026-09-10 they were
// asking them of one number. A read budget compared against claude's
// num_turns - 1 discarded a valid 537.3s review at "41 tool rounds against a
// limit of 29" while that same call ran under --max-turns 30 and answered.
test("read rounds and model turns are separate numbers with separate meanings", () => {
  const activity = newJudgeActivity();
  assert.equal(activity.readRounds, null);
  assert.equal(activity.modelTurns, null);
  assert.equal("toolRounds" in activity, false, "one field cannot answer both a read budget and a turn cap");
});

// The stream is the only place a codex read is ever counted, so it is also
// where the observation is written; the budget must read the same numbers.
test("the streaming audit meters the observation it enforces, including the command that fails it", () => {
  const observation = newJudgeActivity();
  const audit = codexLineAuditor({ agentic: true, evidencePaths: ["a.md"], explore: true }, observation);
  const event = (command, output) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: output } });
  assert.deepEqual(observation, { commands: null, readRounds: null, modelTurns: null, readOutputChars: null, msToLastRead: null },
    "before any trace record arrives nothing has been observed; a call that dies here is unmetered, not zero");
  assert.equal(audit("this is not a trace record"), null);
  assert.equal(observation.commands, null, "an unparseable line attests nothing about reading");
  assert.equal(audit(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "thinking" } })), null);
  assert.deepEqual(observation, { commands: [], readRounds: 0, modelTurns: null, readOutputChars: 0, msToLastRead: null },
    "once the trace channel works, zero reads is an observed zero");
  assert.equal(audit(event("sed -n '1,5p' a.md", "one")), null);
  assert.equal(audit(event("rg -n value a.md", "two")), null);
  assert.deepEqual(observation.commands, ["sed -n '1,5p' a.md", "rg -n value a.md"]);
  assert.equal(observation.readRounds, 2);
  assert.equal(observation.readOutputChars, 6);
  assert.ok(observation.msToLastRead !== null && observation.msToLastRead >= 0);
  const rejected = audit(event("rm -rf a.md", "gone"));
  assert.equal(rejected.reason, "non-read-command");
  assert.deepEqual(observation.commands.at(-1), "rm -rf a.md", "the command that killed the call must be in its record");
  assert.equal(observation.readRounds, 3);
});

test("the read-output budget aborts on metered volume and the observation carries what it read", () => {
  const observation = newJudgeActivity();
  const audit = codexLineAuditor({ agentic: true, evidencePaths: ["a.md"], explore: true }, observation);
  const event = (output) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,20000p' a.md", aggregated_output: output } });
  assert.equal(audit(event("x".repeat(AGENTIC_READ_MAX_OUTPUT_CHARS - 1))), null);
  const problem = audit(event("xx"));
  assert.equal(problem.reason, "read-budget-exceeded");
  assert.equal(observation.readOutputChars, AGENTIC_READ_MAX_OUTPUT_CHARS + 1, "the enforced number and the recorded number are one number");
  assert.equal(observation.readRounds, 2);
});

test("codex line auditor reports the first violating item in trace order", () => {
  const audit = codexLineAuditor({ agentic: true, evidencePaths: ["a.md"] });
  const ok = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sed -n '1,5p' a.md" } });
  const bad = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rm -rf a.md" } });
  assert.equal(audit(ok), null);
  assert.equal(audit(bad).reason, "non-read-command");
});

test("exploration can discover and search only the staged source tree", () => {
  const options = { agentic: true, explore: true, evidencePaths: ["src/api/save.ts", "src/view.tsx", "README.md"] };
  const audit = (command, overrides = {}) => codexActivityProblem(JSON.stringify({
    type: "item.completed", item: { type: "command_execution", command },
  }), { ...options, ...overrides });
  for (const command of [
    "rg --files", "rg --files --hidden --no-ignore", "rg --files src", "rg --files -g '*.ts' .", "rg --files --glob='src/**'",
    "rg --files missing", "rg save last-message.txt", "rg --files --hidden --no-ignore src agents/benchmarks/missing",
    "rg -n 'save'", "rg -n -g '*.tsx' save src", "rg -n save ./src/api/", "sed -n '1,30p' ./src/api/save.ts",
  ]) assert.equal(audit(command), null, command);
  for (const command of [
    "rg --files /etc", "rg save ..", "rg --files src/../../etc", "rg --files --glob '../*'",
    "rg --files --glob='/etc/*'", "sed -n '1,30p' src", "sed -n '1,30p' missing",
    "rg --pre sh save src", "rg -f README.md src", "rg --ignore-file README.md save src", "rg --files --follow",
    'rg save "$HOME"', 'rg --files $(pwd)', "rg --files; cat /etc/passwd",
  ]) assert.notEqual(audit(command), null, command);
  assert.notEqual(audit("rg --files", { explore: false }), null, "exact-path callers retain their narrower contract");
  assert.equal(audit("rg --files", { agentic: false }).reason, "prompt-only-shell");
});

test("exploration filters only an approved pipeline's stdout with bounded sed or rg", () => {
  const options = { agentic: true, explore: true, evidencePaths: ["src/item.ts"] };
  const event = (command) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } });
  const audit = (command, overrides = {}) => codexActivityProblem(event(command), { ...options, ...overrides });
  for (const command of [
    "rg -n save app components lib | sed -n '1,220p'",
    "rg --files | rg -n 'item' | sed -n '1,20p'",
    "sed -n '1,100p' src/item.ts | rg -F -e save | sed -n '2p'",
    "rg --files |\nsed -n '1,20p'",
    "/bin/zsh -lc \"rg --files | sed -n '1,20p'\"",
    "rg --files | /bin/zsh -c \"sed -n '1,20p'\"",
    "rg --files | sed -n '1p'; rg save src | sed -n '2p'",
  ]) {
    assert.equal(audit(command), null, command);
    assert.equal(codexLineAuditor(options)(event(command)), null, `streaming: ${command}`);
  }
  for (const command of [
    "sed -n '1p'",
    "rg --files; sed -n '1p'", "rg --files && sed -n '1p'", "rg --files || sed -n '1p'",
    "rg --files\nsed -n '1p'", "rg --files | sed -n '1p'; sed -n '2p'",
    "rg --files | /bin/zsh -c \"sed -n '1p'; sed -n '2p'\"",
    "rg --files | sed -n '1p' /etc/passwd", "rg --files | sed -n '1p' missing",
    "rg --files | sed -n -f src/item.ts", "rg --files | sed -n '1e id'",
    "rg --files | rg -f src/item.ts", "rg --files | rg --pre sh value",
    "rg --files | rg value ../outside", "rg --files | rg value /etc",
    "cat src/item.ts | sed -n '1p'", "rg --files /etc | sed -n '1p'",
    "rg --files | sed -n '1p' > output", "rg --files | sed -n '1p' < src/item.ts",
    "rg --files | sed -n '1p' |", "rg --files |; sed -n '1p'",
    "rg -n 'literal | pipe' src/item.ts; sed -n '1p'",
  ]) {
    assert.notEqual(audit(command), null, command);
    assert.notEqual(codexLineAuditor(options)(event(command)), null, `streaming: ${command}`);
  }
  assert.notEqual(audit("sed -n '1p' src/item.ts | sed -n '2p'", { explore: false }), null);
  assert.notEqual(audit("sed -n '1p' src/item.ts | rg value", { explore: false }), null);
  assert.equal(audit("rg value"), null, "standalone exploration rg retains default workspace search");
});

// The supplied path index already names every readable file, so instructing a
// whole-tree inventory only buys the same listing again on every call. The
// audited command boundary is unchanged: a listing stays admissible, it is
// simply no longer what the reviewer is told to start from.
test("exploration policies start from the supplied path index instead of a whole-tree inventory", () => {
  for (const preamble of [CODEX_EXPLORATION_PREAMBLE, CLAUDE_EXPLORATION_PREAMBLE]) {
    assert.match(preamble, /path index document listing every file/);
    assert.doesNotMatch(preamble, /rg --files|--hidden|--no-ignore/);
  }
  // Targeted search and range reads inside named directories remain the way
  // an unchanged caller or error path is found.
  assert.match(CODEX_EXPLORATION_PREAMBLE, /rg with quoted patterns and optional -g\/--glob filters to search the relevant directories/);
  assert.match(CODEX_EXPLORATION_PREAMBLE, /sed -n 'START,ENDp' on exact paths/);
  assert.match(CLAUDE_EXPLORATION_PREAMBLE, /Use Grep and Read on the relative source and evidence paths/);
  assert.match(CLAUDE_EXPLORATION_PREAMBLE, /Glob only for a narrow pattern inside a directory the index names/);
  const audit = (command) => codexActivityProblem(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } }),
    { agentic: true, explore: true, evidencePaths: ["src/item.ts"] });
  assert.equal(audit("rg --files --hidden --no-ignore"), null, "the read boundary must not narrow with the instruction");
  assert.equal(audit("rg -n 'save' src"), null);
});

test("Claude exploration grants discovery only when agentic access is requested", () => {
  assert.equal(claudePrintArgs({ model: null, agentic: true, explore: true })[claudePrintArgs({ model: null, agentic: true, explore: true }).indexOf("--tools") + 1], "Read,Grep,Glob");
  const promptOnly = claudePrintArgs({ model: null, explore: true });
  assert.equal(promptOnly[promptOnly.indexOf("--tools") + 1], "");
});


test("Codex exploration bounds actual read volume without rejecting many small reads", () => {
  const options = { agentic: true, explore: true, evidencePaths: ["src/item.ts"] };
  const event = (output) => JSON.stringify({ type: "item.completed", item: {
    type: "command_execution", command: "rg -n value src/item.ts", aggregated_output: output,
  } });
  const audit = codexLineAuditor(options);
  for (let index = 0; index < AGENTIC_READ_MAX_ROUNDS + 1; index += 1) {
    assert.equal(audit(event("x")), null, "30 small reads remain within the volume budget");
  }
  assert.equal(audit(event("x".repeat(AGENTIC_READ_MAX_OUTPUT_CHARS - AGENTIC_READ_MAX_ROUNDS - 1))), null);
  assert.equal(codexActivityProblem(event("x".repeat(AGENTIC_READ_MAX_OUTPUT_CHARS)), options), null);
  assert.equal(codexActivityProblem(event("x".repeat(AGENTIC_READ_MAX_OUTPUT_CHARS + 1)), options).reason,
    "read-budget-exceeded", "an unterminated final trace event cannot bypass the output cap");
  const overflow = audit(event("x"));
  assert.equal(overflow.reason, "read-budget-exceeded");
  assert.match(overflow.detail, /chars of read output/);
  const exactPaths = codexLineAuditor({ ...options, explore: false });
  for (let index = 0; index < AGENTIC_READ_MAX_ROUNDS; index += 1) assert.equal(exactPaths(event("x")), null);
  assert.equal(exactPaths(event("x")).reason, "read-budget-exceeded", "ordinary exact-path callers retain their existing limit");
});

// Reasoning tokens are the field that says where a slow call went: measured
// 2026-09-10 over five uncensored reviews, output tokens order wall-clock at a
// near-constant 10.56-11.69 ms each, and 81-86% of them are thinking. This
// envelope nests them one level down, which is why the flat read that finds
// codex's counter found nothing here and the record kept no answer.
test("claude usage carries nested thinking tokens, and reports nothing rather than zero when they are absent", () => {
  const full = claudeUsage({ usage: { input_tokens: 34, output_tokens: 46_880, cache_read_input_tokens: 2_550_113, output_tokens_details: { thinking_tokens: 37_897 } } });
  assert.deepEqual(full, { inputTokens: 34, outputTokens: 46_880, cachedInputTokens: 2_550_113, reasoningOutputTokens: 37_897 });

  for (const details of [undefined, null, {}, { thinking_tokens: "many" }, []]) {
    const partial = claudeUsage({ usage: { input_tokens: 1, output_tokens: 2, ...(details === undefined ? {} : { output_tokens_details: details }) } });
    assert.deepEqual(partial, { inputTokens: 1, outputTokens: 2 },
      "an unreported reasoning count stays unreported; zero would claim the call did no thinking");
  }
  assert.equal(claudeUsage({}), undefined, "no usage block at all is still no usage");
});
