// Backend hardening contracts (PRD judge-fanout R7/AC7): the codex judge
// runs with best-effort isolation because codex CLI cannot disable its shell
// (live-verified 2026-07-17); these tests pin the isolation argv and the
// no-tools preamble so a refactor cannot silently drop them.
import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_NO_TOOLS_PREAMBLE, codexExecArgs } from "../../dist/judge/backends.js";

test("codex judge argv carries the full isolation set", () => {
  const args = codexExecArgs("gpt-5.2", "/tmp/work-root", "/tmp/work-root/last.txt");
  assert.ok(args.includes("--ephemeral"), "must not persist judge sessions");
  assert.ok(args.includes("--ignore-user-config"), "must not load user config into the judge");
  const cdIndex = args.indexOf("-C");
  assert.ok(cdIndex >= 0 && args[cdIndex + 1] === "/tmp/work-root", "work root must be the empty temp dir, not the host repo");
  const sandboxIndex = args.indexOf("--sandbox");
  assert.equal(args[sandboxIndex + 1], "read-only", "sandbox must stay read-only (no writes/exfiltration)");
  assert.deepEqual(args.slice(-2), ["--model", "gpt-5.2"]);
});

test("codex judge argv omits --model when the tier model is null", () => {
  const args = codexExecArgs(null, "/tmp/w", "/tmp/w/last.txt");
  assert.ok(!args.includes("--model"));
});

test("codex no-tools preamble forbids shell, file access, and tools", () => {
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /Do NOT run shell commands/);
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /do NOT read or list any files/);
  assert.match(CODEX_NO_TOOLS_PREAMBLE, /already included in this prompt/);
});
