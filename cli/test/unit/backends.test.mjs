// Backend hardening contracts (PRD judge-fanout R7/AC7): the codex judge
// runs in a scoped evidence workspace because codex CLI cannot disable its
// shell. These tests pin the argv, prompt boundary, and command audit so a
// refactor cannot silently broaden judge activity.
import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_ISOLATED_READ_PREAMBLE, CODEX_NO_TOOLS_PREAMBLE, claudePrintArgs, codexActivityProblem, codexExecArgs, processSpawnOptions } from "../../dist/judge/backends.js";

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
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /at most three commands/);
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /Do not list directories/);
  assert.match(CODEX_ISOLATED_READ_PREAMBLE, /Never execute project code/);
});

test("codex activity audit accepts narrow reads and rejects scope escape or tool failure", () => {
  const event = (item) => JSON.stringify({ type: "item.completed", item });
  assert.equal(
    codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -lc \"sed -n '1,80p' src/status.ts\"" }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    }),
    null,
  );
  assert.match(
    codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -lc 'cat /etc/passwd'" }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    }),
    /non-read command|out-of-workspace/,
  );
  assert.match(
    codexActivityProblem(event({ type: "error", message: "code mode host missing" }), { agentic: true, evidencePaths: [] }),
    /tool surface failed/,
  );
  assert.match(
    codexActivityProblem(event({ type: "command_execution", command: "/bin/zsh -lc \"sed -n '1p' src/status.ts\ncat secret\"" }), {
      agentic: true,
      evidencePaths: ["src/status.ts"],
    }),
    /composition or expansion/,
  );
});

// The agentic judge resolves the diff-stat's repo-relative paths against its
// working directory, so the verify gate threads the project root through
// BackendRunOptions.cwd - `sasu verify` from a subdirectory used to hand the
// judge the caller's cwd and every Read/Grep missed. The stub backend never
// spawns, so the contract is pinned at the spawn-options builder (mirrors the
// codexExecArgs tests above).
test("judge spawn options carry the caller-threaded cwd, and omit it when absent", () => {
  const withCwd = processSpawnOptions({ cwd: "/repo/root" });
  assert.equal(withCwd.cwd, "/repo/root", "the provided project root must reach the spawned judge");
  const without = processSpawnOptions({});
  assert.ok(!("cwd" in without), "no cwd provided must leave the inherited working directory untouched");
});
