// Live acceptance-judge behavior probe. This is intentionally outside the
// default unit/E2E suites because it spends real judge tokens. It exercises
// the production prompt and Claude permission argv while stream-json exposes
// the exact Read/Grep trace for the assertions below.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { acceptancePrompt } from "../../dist/implement/prompts.js";
import { claudePrintArgs, JUDGE_SUBPROCESS_ENV } from "../../dist/judge/backends.js";
import { extractJsonObject, validateSemanticVerdict } from "../../dist/judge/types.js";

function promptFor(root, { criterion, checks = [], evidence = [], readableArtifacts = [], files = [] }) {
  const changedFiles = files.length === 0
    ? "- none"
    : files.map((relative) => `- ${relative} [text, ${fs.statSync(path.join(root, relative)).size} bytes]`).join("\n");
  return acceptancePrompt(
    {
      requirements: [{ id: "R1", text: criterion.text }],
      verification: [{ id: "V1", covers: [criterion.id], passIntent: `prove ${criterion.text}` }],
    },
    { ...criterion, requirements: ["R1"] },
    { changedFiles, checks, evidence, readableArtifacts },
  );
}

function runTraced(prompt, cwd, criterionId) {
  const args = claudePrintArgs({ model: "claude-sonnet-5", effort: "xhigh", agentic: true });
  const format = args.indexOf("json");
  assert.ok(format >= 0);
  args[format] = "stream-json";
  args.push("--verbose", prompt);
  const run = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sasu-judge-smoke", [JUDGE_SUBPROCESS_ENV]: "1" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const tools = events.flatMap((event) =>
    event.type === "assistant"
      ? event.message.content.filter((item) => item.type === "tool_use").map((item) => ({ name: item.name, input: item.input }))
      : [],
  );
  const result = events.findLast((event) => event.type === "result");
  const parsed = extractJsonObject(result?.result ?? "");
  const verdict = validateSemanticVerdict(parsed, [criterionId]);
  assert.notEqual(typeof verdict, "string", String(verdict));
  for (const call of tools) assert.ok(call.name === "Read" || call.name === "Grep", `unexpected tool: ${call.name}`);
  return { verdict, tools, durationMs: result.duration_ms, turns: result.num_turns };
}

test("live acceptance judge stays within the criterion evidence and changed-file allowlist", { timeout: 720_000 }, () => {
  const results = [];

  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-evidence-"));
  fs.mkdirSync(path.join(evidenceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, "src", "unrelated.ts"), "export const unrelated = true;\n");
  const evidencePrompt = promptFor(evidenceRoot, {
    criterion: { id: "AC1", text: "the status command prints READY" },
    files: ["src/unrelated.ts"],
    checks: [{ criterionId: "AC1", command: "node test/status.mjs", exitCode: 0, tail: "status=READY\nassertion passed" }],
  });
  const evidenceResult = runTraced(evidencePrompt, evidenceRoot, "AC1");
  console.log("mechanical trace", JSON.stringify(evidenceResult));
  assert.equal(evidenceResult.verdict.verdict, "PASS");
  assert.deepEqual(evidenceResult.tools, [], "direct mechanical proof should not trigger repository exploration");
  results.push({ case: "mechanical", ...evidenceResult });

  const passRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-code-pass-"));
  fs.mkdirSync(path.join(passRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(passRoot, "src", "status.ts"), 'export function getStatus() { return "READY"; }\n');
  fs.writeFileSync(path.join(passRoot, "src", "unrelated.ts"), 'export const unrelated = "IGNORE";\n');
  const passPrompt = promptFor(passRoot, {
    criterion: { id: "AC2", text: "getStatus returns READY" },
    files: ["src/status.ts", "src/unrelated.ts"],
  });
  const passResult = runTraced(passPrompt, passRoot, "AC2");
  console.log("code-pass trace", JSON.stringify(passResult));
  assert.equal(passResult.verdict.verdict, "PASS");
  assert.ok(passResult.tools.some((call) => call.name === "Read" && call.input.file_path.endsWith("/src/status.ts")));
  assert.ok(passResult.tools.length <= 3, `narrow code check wandered across ${passResult.tools.length} tool calls`);
  results.push({ case: "code-pass", ...passResult });

  const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-code-fail-"));
  fs.mkdirSync(path.join(failRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(failRoot, "src", "status.ts"), 'export function getStatus() { return "BROKEN"; }\n');
  fs.writeFileSync(path.join(failRoot, "src", "unrelated.ts"), 'export const unrelated = "IGNORE";\n');
  const failPrompt = promptFor(failRoot, {
    criterion: { id: "AC3", text: "getStatus returns READY" },
    files: ["src/status.ts", "src/unrelated.ts"],
  });
  const failResult = runTraced(failPrompt, failRoot, "AC3");
  console.log("code-fail trace", JSON.stringify(failResult));
  assert.equal(failResult.verdict.verdict, "FAIL");
  assert.ok(failResult.tools.some((call) => call.name === "Read" && call.input.file_path.endsWith("/src/status.ts")));
  assert.ok(failResult.tools.length <= 3, `narrow code check wandered across ${failResult.tools.length} tool calls`);
  results.push({ case: "code-fail", ...failResult });

  const noisyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-code-noisy-"));
  fs.mkdirSync(path.join(noisyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(noisyRoot, "src", "status.ts"), 'export function getStatus() { return "READY"; }\n');
  const noisyFiles = ["src/status.ts"];
  for (let index = 0; index < 20; index += 1) {
    const relative = `src/noise-${String(index).padStart(2, "0")}.ts`;
    fs.writeFileSync(path.join(noisyRoot, relative), `export const noise${index} = ${index};\n`);
    noisyFiles.push(relative);
  }
  const noisyPrompt = promptFor(noisyRoot, {
    criterion: { id: "AC5", text: "getStatus returns READY" },
    files: noisyFiles,
  });
  const noisyResult = runTraced(noisyPrompt, noisyRoot, "AC5");
  console.log("code-noisy trace", JSON.stringify(noisyResult));
  assert.equal(noisyResult.verdict.verdict, "PASS");
  assert.ok(noisyResult.tools.some((call) => call.name === "Read" && call.input.file_path.endsWith("/src/status.ts")));
  assert.ok(noisyResult.tools.length <= 3, `21-file allowlist caused ${noisyResult.tools.length} tool calls`);
  results.push({ case: "code-noisy", ...noisyResult });

  const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-live-image-"));
  const imagePath = path.join(imageRoot, "visual.png");
  fs.copyFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../assets/mascot.png"), imagePath);
  const imagePrompt = promptFor(imageRoot, {
    criterion: { id: "AC4", text: "the visual shows a person with glasses wearing a red plaid shirt with a red marker visible in the shirt pocket" },
    readableArtifacts: [{
      path: "visual.png",
      kind: "screenshot",
      sha256: "fixture-sha",
      bytes: fs.statSync(imagePath).size,
      description: "rendered visual",
      registeredAt: "2026-08-25T00:00:00.000Z",
    }],
  });
  const imageResult = runTraced(imagePrompt, imageRoot, "AC4");
  console.log("image trace", JSON.stringify(imageResult));
  assert.equal(imageResult.verdict.verdict, "PASS");
  assert.ok(imageResult.tools.some((call) => call.name === "Read" && call.input.file_path.endsWith("visual.png")));
  results.push({ case: "image", ...imageResult });

  console.log(JSON.stringify(results.map((entry) => ({
    case: entry.case,
    verdict: entry.verdict.verdict,
    tools: entry.tools,
    durationMs: entry.durationMs,
    turns: entry.turns,
  })), null, 2));
});
