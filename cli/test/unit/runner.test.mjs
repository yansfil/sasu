import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { resetJudgeHealth, runJudge } from "../../dist/judge/runner.js";
import { AGENTIC_READ_MAX_ROUNDS, AGENTIC_READ_MAX_OUTPUT_CHARS } from "../../dist/judge/backends.js";
import { validateGapVerdict } from "../../dist/judge/types.js";
import { loadConfig } from "../../dist/config.js";

async function withStub(responses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-stub-"));
  const stubFile = path.join(dir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify(responses));
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousFile = process.env.SASU_JUDGE_STUB_FILE;
  process.env.SASU_JUDGE_BACKEND = "stub";
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  try {
    return await fn();
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    if (previousFile === undefined) delete process.env.SASU_JUDGE_STUB_FILE;
    else process.env.SASU_JUDGE_STUB_FILE = previousFile;
  }
}

const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-proj-")));
const claudePrimaryConfig = {
  ...config,
  judge: {
    ...config.judge,
    profiles: {
      ...config.judge.profiles,
      routine: {
        primary: config.judge.profiles.routine.fallback,
        fallback: config.judge.profiles.routine.primary,
      },
    },
  },
};

// The backend health ledger is process-scoped, which in production means
// run-scoped: one `sasu` invocation is one process. A test file is not - it
// runs many independent "runs" back to back, and each of these asserts a
// first-failure contract, so every test starts from a healthy process.
beforeEach(resetJudgeHealth);

function fakeCodexProgram(mainLines, options = {}) {
  const preflightLines = options.preflightLines ?? [
    `printf '%s' 'OK' > "$last"`,
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    "exit 0",
  ];
  const countLines = options.countFile === undefined
    ? []
    : [
        `count_file=${JSON.stringify(options.countFile)}`,
        "count=0",
        `test ! -f "$count_file" || count=$(cat "$count_file")`,
        "count=$((count + 1))",
        `printf '%s' "$count" > "$count_file"`,
      ];
  return [
    "#!/bin/sh",
    ...countLines,
    'last=""',
    'prompt=""',
    'root=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2',
    '  elif [ "$1" = "-C" ]; then root="$2"; shift 2',
    '  else prompt="$1"; shift; fi',
    "done",
    'case "$prompt" in',
    '  *"Reply with exactly: OK"*)',
    ...preflightLines,
    "  ;;",
    "esac",
    ...mainLines,
    "",
  ].join("\n");
}

async function withFakeCodex(program, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fake-codex-"));
  const fakeCodex = path.join(binDir, "codex");
  const unexpectedClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeCodex, program);
  // Keep the configured fallback available so negative Codex cases prove the
  // override is pinned even on machines without Claude beside the Node binary.
  fs.writeFileSync(unexpectedClaude, "#!/bin/sh\nprintf 'unexpected Claude fallback' >&2\nexit 99\n");
  fs.chmodSync(fakeCodex, 0o755);
  fs.chmodSync(unexpectedClaude, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "codex";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    return await fn(binDir);
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
}

test("Codex advisory plus turn.completed and a valid verdict is a recorded PASS", async () => {
  const message = "Skill descriptions were shortened to fit the skills context budget.";
  const program = fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '${JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message } })}'`,
    `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]);
  await withFakeCodex(program, async () => {
    let warnings = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk) => {
      warnings += String(chunk);
      return true;
    });
    try {
      const outcome = await runJudge(config, "gate:advisory", "routine", "prompt", validateGapVerdict);
      assert.equal(outcome.value.verdict, "PASS");
      assert.equal(outcome.record.outcome, "ok");
      assert.equal(outcome.record.attempts, 1);
      assert.deepEqual(outcome.record.advisories, [{ code: "judge-backend-advisory", backend: "codex", message }]);
      assert.match(warnings, /judge-backend-advisory \(codex, gate:advisory\)/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test("Codex turn.completed without a last message remains a hard failure", async () => {
  const program = fakeCodexProgram([
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]);
  await withFakeCodex(program, async () => {
    await assert.rejects(
      () => runJudge(config, "gate:no-message", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-invalid-output"
        && error.reason === "empty-response"
        && error.record.attempts === 2,
    );
  });
});

test("Codex turn.failed rejects a last message that looks like a valid verdict", async () => {
  const program = fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.failed","error":{"message":"backend unavailable"}}'`,
  ]);
  await withFakeCodex(program, async () => {
    await assert.rejects(
      () => runJudge(config, "gate:failed-turn", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-auth-or-runtime"
        && error.reason === "turn-failed"
        && error.record.attempts === 1,
    );
  });
});

test("Codex requires turn.completed even when a valid last message exists", async () => {
  const program = fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
  ]);
  await withFakeCodex(program, async () => {
    await assert.rejects(
      () => runJudge(config, "gate:missing-terminal", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-auth-or-runtime"
        && error.reason === "missing-turn-completed"
        && error.record.attempts === 1,
    );
  });
});

test("Codex command-audit violation rejects a completed turn with a valid verdict", async () => {
  const program = fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"rm allowed.txt"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]);
  await withFakeCodex(program, async (binDir) => {
    fs.writeFileSync(path.join(binDir, "allowed.txt"), "evidence\n");
    await assert.rejects(
      () => runJudge(config, "gate:unsafe-command", "routine", "prompt", validateGapVerdict, {
        agentic: true,
        cwd: binDir,
        evidencePaths: ["allowed.txt"],
      }),
      (error) => error.code === "judge-invalid-output"
        && error.reason === "non-read-command"
        && error.record.attempts === 2,
    );
  });
});

test("Codex preflight fails before the first full judge attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-preflight-count-"));
  const countFile = path.join(dir, "count");
  const program = fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ], {
    countFile,
    preflightLines: [
      `printf '%s\\n' '{"type":"turn.failed","error":{"message":"preflight failed"}}'`,
      "exit 0",
    ],
  });
  await withFakeCodex(program, async () => {
    await assert.rejects(
      () => runJudge(config, "gate:preflight", "routine", "EXPENSIVE-PROMPT", validateGapVerdict),
      (error) => error.reason === "turn-failed" && error.record.attempts === 0,
    );
    assert.equal(fs.readFileSync(countFile, "utf8"), "1", "the expensive judge turn must never start");
  });
});

test("SASU_JUDGE_BACKEND pins Claude without returning to configured Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-pinned-claude-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"forced Claude failure"}\'\n');
  fs.writeFileSync(fakeCodex, fakeCodexProgram([
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]));
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    await assert.rejects(
      () => runJudge(config, "gate:pinned-claude", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-auth-or-runtime"
        && error.backend === "claude"
        && error.record.backend === "claude"
        && error.record.fallback === undefined,
    );
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("runJudge accepts a valid first reply with attempts=1", async () => {
  await withStub([{ verdict: "PASS", findings: [] }], async () => {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.attempts, 1);
    assert.equal(outcome.record.outcome, "ok");
  });
});

test("runJudge retries exactly once on invalid output, then succeeds", async () => {
  await withStub(["not json at all", { verdict: "PASS", findings: [] }], async () => {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.attempts, 2);
  });
});

test("runJudge throws a typed error after two invalid replies", async () => {
  await withStub(["garbage one", "garbage two"], async () => {
    await assert.rejects(
      () => runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-invalid-output" && error.record.attempts === 2,
    );
  });
});

test("runJudge rejects schema-invalid JSON the same as non-JSON", async () => {
  await withStub([{ verdict: "MAYBE" }, { verdict: "BLOCK", findings: [] }], async () => {
    await assert.rejects(
      () => runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-invalid-output",
    );
  });
});

test("runJudge byPurpose stub selects the matching lane response", async () => {
  await withStub(
    {
      byPurpose: {
        "lane:ux-behavior": { verdict: "BLOCK", findings: [{ area: "ux", severity: "P0", missing: "error state undecided", recommendation: "ask", requiresHuman: true }] },
        default: { verdict: "PASS", findings: [] },
      },
    },
    async () => {
      const ux = await runJudge(config, "gate:gap-audit:lane:ux-behavior", "routine", "prompt", validateGapVerdict);
      assert.equal(ux.value.verdict, "BLOCK");
      const other = await runJudge(config, "gate:gap-audit:lane:data-tech", "routine", "prompt", validateGapVerdict);
      assert.equal(other.value.verdict, "PASS");
    },
  );
});

// Per-call timeout regression (PRD judge-fanout D-13/AC4): the async spawn
// refactor must keep enforcing judge.timeoutMs per call. A fake `claude`
// binary that sleeps past the timeout must surface as judge-timeout.
test("runJudge enforces judge.timeoutMs per call after the async refactor", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
  fs.chmodSync(fakeClaude, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  const fastConfig = { ...config, judge: { ...config.judge, timeoutMs: 300 } };
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => runJudge(fastConfig, "gate:test", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-timeout",
    );
    assert.ok(Date.now() - startedAt < 4000, "timeout must fire well before the fake binary exits");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("Claude JSON context overflow on exit 1 preserves its detail and is not classified as auth", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"Prompt is too long","subtype":"success"}\\n\'\nexit 1\n');
  fs.chmodSync(fakeClaude, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  try {
    await assert.rejects(
      () => runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict),
      (error) => error.code === "judge-context-overflow"
        && error.detail === "Prompt is too long"
        && !error.message.includes("exit code 1"),
    );
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("agentic Claude receives a disposable evidence workspace instead of the project tree", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-"));
  const marker = path.join(binDir, "cwd.txt");
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(path.join(source, "allowed.txt"), "allowed evidence\n");
  const response = JSON.stringify({ result: JSON.stringify({ verdict: "PASS", findings: [] }), num_turns: 1 });
  fs.writeFileSync(fakeClaude, `#!/bin/sh\npwd > ${JSON.stringify(marker)}\nprintf '%s\\n' '${response}'\n`);
  fs.chmodSync(fakeClaude, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict, {
      agentic: true,
      cwd: source,
      evidencePaths: ["allowed.txt"],
    });
    assert.equal(outcome.value.verdict, "PASS");
    const workspace = fs.readFileSync(marker, "utf8").trim();
    assert.notEqual(workspace, source, "Claude must not receive the complete project tree as cwd");
    assert.match(workspace, /sasu-claude-evidence-/);
    assert.equal(fs.existsSync(workspace), false, "the disposable evidence workspace must be removed after the call");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("visual evidence routes a Claude-primary profile to its attachment-capable fallback", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const claudeMarker = path.join(binDir, "claude-ran");
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${JSON.stringify(claudeMarker)}\nexit 1\n`);
  fs.writeFileSync(
    fakeCodex,
    fakeCodexProgram([
      `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    ]),
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  try {
    const outcome = await runJudge(claudePrimaryConfig, "gate:test", "routine", "prompt", validateGapVerdict, { images: [path.join(binDir, "proof.png")] });
    assert.equal(outcome.record.backend, "codex");
    assert.equal(fs.existsSync(claudeMarker), false, "the first choice for visual evidence is the attachment guarantee, not reachability");
    assert.deepEqual(outcome.record.visualEvidence, { images: 1, delivery: "attached", verifiedSeen: true });
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

function fakeClaudeVerdict(binDir, markerName = "claude-ran") {
  const marker = path.join(binDir, markerName);
  const response = JSON.stringify({ result: JSON.stringify({ verdict: "PASS", findings: [] }), num_turns: 2 });
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '%s\\n' '${response}'\n`);
  fs.chmodSync(fakeClaude, 0o755);
  return marker;
}

/** A visual lane whose primary fails: the pictures must survive the crossing. */
test("a failed visual judge crosses to a fallback that can only reach images in its workspace", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-"));
  fs.writeFileSync(path.join(source, "allowed.txt"), "allowed evidence\n");
  fs.writeFileSync(path.join(source, "proof.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const claudeMarker = fakeClaudeVerdict(binDir);
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict, {
      agentic: true,
      cwd: source,
      evidencePaths: ["allowed.txt"],
      images: [path.join(source, "proof.png")],
    });
    assert.equal(outcome.record.backend, "claude");
    assert.equal(fs.existsSync(claudeMarker), true, "the fallback must actually run the visual call");
    assert.deepEqual(outcome.record.visualEvidence, { images: 1, delivery: "workspace-readable", verifiedSeen: false });
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

/**
 * The same eligibility, decided before the first attempt. Without it a visual
 * call whose primary is already condemned still pays that primary's latency.
 */
test("a visual call whose primary is already unhealthy pre-selects the reachability-only fallback", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-"));
  fs.writeFileSync(path.join(source, "proof.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fakeClaudeVerdict(binDir);
  const countFile = path.join(binDir, "codex-calls");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, fakeCodexProgram(["exit 1"], { countFile }));
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const call = () => runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict, {
    agentic: true,
    cwd: source,
    evidencePaths: [],
    images: [path.join(source, "proof.png")],
  });
  try {
    // Two runtime strikes condemn the primary; the third call must not dial it.
    await call();
    await call();
    const before = fs.readFileSync(countFile, "utf8");
    const outcome = await call();
    assert.equal(fs.readFileSync(countFile, "utf8"), before, "a condemned primary must not be dialled again for a visual call");
    assert.equal(outcome.record.backend, "claude");
    assert.equal(outcome.record.fallback?.backend, "codex");
    assert.equal(outcome.record.fallback?.attempts, 0);
    assert.equal(outcome.record.visualEvidence?.delivery, "workspace-readable");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

/** Neither capability is still a refusal: reachability widened one door, not the wall. */
test("a fallback that can neither attach nor open an image never receives the visual call", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-source-"));
  fs.writeFileSync(path.join(source, "proof.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const stubFile = path.join(binDir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify([JSON.stringify({ verdict: "PASS", findings: [] })]));
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(fakeCodex, 0o755);
  const stubFallback = {
    ...config,
    judge: {
      ...config.judge,
      profiles: { ...config.judge.profiles, routine: { primary: config.judge.profiles.routine.primary, fallback: { backend: "stub", model: null, effort: "xhigh" } } },
    },
  };
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.SASU_JUDGE_STUB_FILE = stubFile;
  process.env.SASU_JUDGE_STUB_NO_ATTACHMENTS = "1";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    await assert.rejects(
      () => runJudge(stubFallback, "gate:test", "routine", "prompt", validateGapVerdict, {
        agentic: true,
        cwd: source,
        evidencePaths: [],
        images: [path.join(source, "proof.png")],
      }),
      (error) => error.code === "judge-auth-or-runtime" && error.backend === "codex",
    );
  } finally {
    delete process.env.SASU_JUDGE_STUB_FILE;
    delete process.env.SASU_JUDGE_STUB_NO_ATTACHMENTS;
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("a failed visual judge does not fall back to Claude without image attachments", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const claudeMarker = path.join(binDir, "claude-ran");
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${JSON.stringify(claudeMarker)}\nexit 1\n`);
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}`;
  try {
    await assert.rejects(
      () => runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict, { images: [path.join(binDir, "proof.png")] }),
      (error) => error.code === "judge-auth-or-runtime",
    );
    assert.equal(fs.existsSync(claudeMarker), false, "a fallback without image attachments cannot judge the same evidence");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

// The fallback tests below run the fake `codex` twice under the same
// judge.timeoutMs as the primary: once for its preflight, once for the call.
// At 1000ms that budget lost to parallel suite load about one run in five
// (2026-09-04, measured: the fallback timed out too and the lane surfaced
// judge-timeout after ~2.3s), so the budget is sized for two shell spawns
// under load, and the fake `claude` sleeps well past it either way.
const FALLBACK_TIMEOUT_MS = 3000;

test("without an override, runJudge falls back from a Claude timeout to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 30\n");
  fs.writeFileSync(
    fakeCodex,
    fakeCodexProgram([
      `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    ]),
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const fastConfig = { ...claudePrimaryConfig, judge: { ...claudePrimaryConfig.judge, timeoutMs: FALLBACK_TIMEOUT_MS } };
  try {
    const outcome = await runJudge(fastConfig, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.equal(outcome.record.fallback?.backend, "claude");
    assert.equal(outcome.record.fallback?.outcome, "judge-timeout");
    assert.equal(outcome.record.fallback?.reason, "primary judge timed out");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("without an override, an agentic Claude failure falls back to Codex with only allowlisted evidence", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(path.join(binDir, "allowed.txt"), "READY\n");
  fs.writeFileSync(path.join(binDir, "decoy.txt"), "MUST NOT COPY\n");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 30\n");
  fs.writeFileSync(fakeCodex, fakeCodexProgram([
    'test -f "$root/allowed.txt" || exit 41',
    'test ! -e "$root/decoy.txt" || exit 42',
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc sed -n 1p allowed.txt"}}'`,
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]));
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const fastConfig = { ...claudePrimaryConfig, judge: { ...claudePrimaryConfig.judge, timeoutMs: FALLBACK_TIMEOUT_MS } };
  try {
    const outcome = await runJudge(
      fastConfig,
      "gate:test",
      "routine",
      "prompt",
      validateGapVerdict,
      { agentic: true, cwd: binDir, evidencePaths: ["allowed.txt"] },
    );
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.fallback?.backend, "claude");
    assert.deepEqual(outcome.record.activity?.commands, ["/bin/zsh -lc sed -n 1p allowed.txt"]);
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("without an override, runJudge falls back from repeated invalid Claude output to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nprintf 'not json\\n'\n");
  fs.writeFileSync(
    fakeCodex,
    fakeCodexProgram([
      `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    ]),
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(claudePrimaryConfig, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.equal(outcome.record.fallback?.backend, "claude");
    assert.equal(outcome.record.fallback?.outcome, "judge-invalid-output");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("backend audit rejection gets one reasoned retry before fallback and records the cause", async () => {
  // The production x-twitter records had this exact shape 27 times: Codex was
  // rejected as judge-invalid-output after one attempt and the record retained
  // no reason. The second prompt and the fallback record are the observable
  // contract that prevents another silent 24-minute discard class.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeCodex = path.join(binDir, "codex");
  const fakeClaude = path.join(binDir, "claude");
  const countFile = path.join(binDir, "codex-count");
  fs.writeFileSync(path.join(binDir, "allowed.txt"), "evidence\n");
  fs.writeFileSync(fakeCodex, fakeCodexProgram([
    'printf "%s" "$prompt" > "$count_file.prompt.$count"',
    `printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc sed -n 1p allowed.txt && rm credential-token"}}'`,
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ], { countFile }));
  fs.writeFileSync(
    fakeClaude,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"result":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}"}\'\n',
  );
  fs.chmodSync(fakeCodex, 0o755);
  fs.chmodSync(fakeClaude, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(
      config,
      "gate:test",
      "routine",
      "ORIGINAL-PROMPT",
      validateGapVerdict,
      { agentic: true, cwd: binDir, evidencePaths: ["allowed.txt"] },
    );
    assert.equal(fs.readFileSync(countFile, "utf8"), "3", "one preflight plus two rejected primary attempts must run before fallback");
    assert.match(
      fs.readFileSync(`${countFile}.prompt.3`, "utf8"),
      /previous attempt was rejected: isolated codex judge used a non-read command.*rm credential-token.*Correct that specific problem, then reply with only the JSON object/,
    );
    assert.equal(outcome.record.backend, "claude");
    assert.equal(outcome.record.fallback?.backend, "codex");
    assert.equal(outcome.record.fallback?.attempts, 2);
    assert.equal(outcome.record.fallback?.outcome, "judge-invalid-output");
    assert.equal(outcome.record.fallback?.reason, "command-audit: isolated judge used a non-read command");
    assert.doesNotMatch(outcome.record.fallback?.reason ?? "", /credential|token/);
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("without an override, runJudge falls back from Claude authentication failure to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"Not logged in. Please run /login."}\'\n');
  fs.writeFileSync(
    fakeCodex,
    fakeCodexProgram([
      `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    ]),
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(claudePrimaryConfig, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.ok(outcome.record.fallback);
    assert.equal(outcome.record.fallback.backend, "claude");
    assert.equal(outcome.record.fallback.model, "claude-sonnet-5");
    assert.equal(outcome.record.fallback.outcome, "judge-auth");
    assert.equal(typeof outcome.record.fallback.durationMs, "number");
    assert.equal(outcome.record.fallback.reason, "primary judge authentication failed");
    assert.doesNotMatch(outcome.record.fallback.reason, /login/i);
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("without an override, runJudge falls back from a Claude runtime failure to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"upstream service unavailable"}\'\n');
  fs.writeFileSync(
    fakeCodex,
    fakeCodexProgram([
      `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
      `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
    ]),
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(claudePrimaryConfig, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.ok(outcome.record.fallback);
    assert.equal(outcome.record.fallback.backend, "claude");
    assert.equal(outcome.record.fallback.outcome, "judge-auth-or-runtime");
    assert.equal(typeof outcome.record.fallback.durationMs, "number");
    assert.equal(outcome.record.fallback.reason, "primary judge authentication or runtime failed");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("without an override, runJudge falls back from a Codex runtime failure to Claude", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(
    fakeClaude,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"result":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}"}\'\n',
  );
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 99\n");
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "claude");
    assert.equal(outcome.record.attempts, 1);
    assert.ok(outcome.record.fallback);
    assert.equal(outcome.record.fallback.backend, "codex");
    assert.equal(outcome.record.fallback.outcome, "judge-auth-or-runtime");
    assert.equal(typeof outcome.record.fallback.durationMs, "number");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

// The turn cap is what makes over-reading cheap; this pins what the harness
// does with the call it cut. The envelope is the one measured 2026-09-04 on
// claude 2.1.260: exit 1, subtype error_max_turns, no result field.
test("an agentic claude call stopped by the turn cap is retried as a read-budget overrun, not crossed to the fallback", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-capped-proj-"));
  fs.writeFileSync(path.join(project, "evidence.md"), "evidence");
  const capped = JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: AGENTIC_READ_MAX_ROUNDS + 2,
    errors: [`Reached maximum number of turns (${AGENTIC_READ_MAX_ROUNDS + 1})`],
  });
  const answered = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: JSON.stringify({ verdict: "PASS", findings: [] }) });
  const callCount = path.join(binDir, "calls");
  const argvLog = path.join(binDir, "argv");
  // First call: capped, exit 1. Second call: answers. The argv of each call
  // is recorded so the test can see the cap travelled and the retry preamble
  // named the overrun.
  fs.writeFileSync(path.join(binDir, "claude"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    `count=0; test ! -f ${JSON.stringify(callCount)} || count=$(cat ${JSON.stringify(callCount)})`,
    `count=$((count + 1)); printf '%s' "$count" > ${JSON.stringify(callCount)}`,
    `if [ "$count" = "1" ]; then printf '%s' '${capped}'; exit 1; fi`,
    `cat > ${JSON.stringify(path.join(binDir, "retry-prompt"))}`,
    `printf '%s' '${answered}'`,
    "",
  ].join("\n"));
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  const previousPath = process.env.PATH;
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  // Claude primary with a fallback declared, so a wrong classification would
  // be visible as a crossing rather than masked by having nowhere to go.
  const cappedConfig = {
    ...config,
    judge: {
      ...config.judge,
      profiles: {
        ...config.judge.profiles,
        routine: {
          primary: { backend: "claude", model: null, effort: "high" },
          fallback: { backend: "codex", model: null, effort: "high" },
        },
      },
    },
  };
  try {
    const outcome = await runJudge(cappedConfig, "regression:turn-cap", "routine", "prompt", validateGapVerdict, {
      agentic: true,
      cwd: project,
      evidencePaths: ["evidence.md"],
    });
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "claude");
    assert.equal(outcome.record.attempts, 2, "the capped attempt is retried in place");
    assert.equal(outcome.record.fallback, undefined, "an over-read is not a backend failure; no crossing");
    assert.equal(outcome.record.retries.length, 1);
    assert.equal(outcome.record.retries[0].code, "judge-invalid-output");
    assert.equal(outcome.record.retries[0].reason, "read-budget-exceeded");
    assert.match(outcome.record.retries[0].detail, new RegExp(`${AGENTIC_READ_MAX_ROUNDS + 1}-turn cap`));
    const argv = fs.readFileSync(argvLog, "utf8");
    assert.match(argv, new RegExp(`--max-turns ${AGENTIC_READ_MAX_ROUNDS + 1}`));
    const retryPrompt = fs.readFileSync(path.join(binDir, "retry-prompt"), "utf8");
    assert.match(retryPrompt, new RegExp(`^Your previous attempt was rejected: judge hit the ${AGENTIC_READ_MAX_ROUNDS + 1}-turn cap`), "the retry names the overrun so attempt 2 reads selectively");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("claude num_turns rides into validator activity; a missing field stays unknown", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const verdict = JSON.stringify({ verdict: "PASS", findings: [] });
  const envelope = (extra) => JSON.stringify({ type: "result", is_error: false, result: verdict, ...extra });
  const fakeClaude = path.join(binDir, "claude");
  fs.chmodSync(fs.writeFileSync(fakeClaude, `#!/bin/sh\ncat "$CLAUDE_FAKE_ENVELOPE"\n`) ?? fakeClaude, 0o755);
  const envelopeFile = path.join(binDir, "envelope.json");
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:/usr/bin:/bin`;
  process.env.CLAUDE_FAKE_ENVELOPE = envelopeFile;
  try {
    fs.writeFileSync(envelopeFile, envelope({ num_turns: 3 }));
    let seen = null;
    await runJudge(config, "gate:test", "routine", "prompt", (value, activity) => {
      seen = activity;
      return validateGapVerdict(value);
    });
    assert.deepEqual(seen, { commands: null, toolRounds: 2, readOutputChars: null, msToLastRead: null },
      "num_turns 3 = two tool rounds, and claude exposes no command trace or metered read volume");

    fs.writeFileSync(envelopeFile, envelope({}));
    await runJudge(config, "gate:test", "routine", "prompt", (value, activity) => {
      seen = activity;
      return validateGapVerdict(value);
    });
    assert.equal(seen.toolRounds, null, "a missing num_turns must stay unknown, never zero");
    assert.equal(seen.commands, null, "and an absent trace must stay absent rather than become an observed empty list");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
    delete process.env.CLAUDE_FAKE_ENVELOPE;
  }
});

// The 2026-09-10 verify-timeout benchmark could not tell a read-volume abort
// from a model that never answered, because every failing call recorded an
// empty trace and the diagnosis needed a temporary PATH shim. Each failure
// path below must leave the observation the harness actually made.
test("every failed judge call records what it was observed reading", async () => {
  const event = (command, output, exit_code = 0) => JSON.stringify({
    type: "item.completed", item: { type: "command_execution", command, aggregated_output: output, exit_code },
  });
  const reads = [
    `printf '%s\\n' '${event("rg -n value src/allowed.txt", "1:value")}'`,
    `printf '%s\\n' '${event("sed -n '1,40p' src/allowed.txt", "value")}'`,
  ];
  const timedOut = { ...config, judge: { ...config.judge, timeoutMs: 900 } };

  // 1. Timeout after real reads: the record must show reads that ended early,
  //    which is what separates this from a call killed by read volume.
  await withFakeCodex(fakeCodexProgram([...reads, "/bin/sleep 5"]), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
    await assert.rejects(runJudge(timedOut, "observed:timeout", "routine", "review", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    }), (error) => {
      assert.equal(error.code, "judge-timeout");
      const activity = error.record.activity;
      assert.deepEqual(activity.commands, ["rg -n value src/allowed.txt", "sed -n 1,40p src/allowed.txt"]);
      assert.equal(activity.toolRounds, 2);
      assert.equal(activity.readOutputChars, 12);
      assert.ok(activity.msToLastRead < error.record.retries[0].durationMs,
        "a call that stopped reading long before it died must be readable as exactly that");
      assert.deepEqual(error.record.retries[0].observation, activity);
      return true;
    });
  });

  // 2. Read-volume abort: the streamed audit kills the call, and the record
  //    must carry the volume that did it.
  await withFakeCodex(fakeCodexProgram([
    `printf '%s\\n' '${event("sed -n '1,200000p' src/allowed.txt", "x".repeat(1_000))}'`,
    `printf '%s\\n' '${event("sed -n '1,200000p' src/allowed.txt", "y".repeat(AGENTIC_READ_MAX_OUTPUT_CHARS))}'`,
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
    await assert.rejects(runJudge(config, "observed:read-budget", "routine", "review", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    }), (error) => {
      assert.equal(error.reason, "read-budget-exceeded");
      assert.equal(error.record.activity.toolRounds, 2);
      assert.ok(error.record.activity.readOutputChars > AGENTIC_READ_MAX_OUTPUT_CHARS);
      assert.equal(error.record.activity.commands.length, 2);
      return true;
    });
  });

  // 3. Command-audit rejection: the offending command is the whole point of
  //    the record.
  await withFakeCodex(fakeCodexProgram([
    ...reads,
    `printf '%s\\n' '${event("cat /etc/passwd", "root:x:0:0")}'`,
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
  ]), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
    await assert.rejects(runJudge(config, "observed:audit", "routine", "review", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    }), (error) => {
      assert.equal(error.reason, "non-read-command");
      assert.deepEqual(error.record.activity.commands.at(-1), "cat /etc/passwd");
      assert.equal(error.record.activity.toolRounds, 3);
      return true;
    });
  });

  // 4. A backend that dies before streaming anything must record unmetered,
  //    never an observed zero: claiming zero reads for a call nobody watched
  //    is the same false certainty this observation removes.
  await withFakeCodex(fakeCodexProgram(["exit 7"]), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
    await assert.rejects(runJudge(config, "observed:silent", "routine", "review", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    }), (error) => {
      assert.deepEqual(error.record.activity, { commands: null, toolRounds: null, readOutputChars: null, msToLastRead: null });
      return true;
    });
  });

  // 5. Invalid output twice: each rejected attempt keeps its own observation
  //    instead of one summed trace, so "attempt 1 read, attempt 2 did not"
  //    survives in the record.
  // A per-test counter path: the codex work root is fresh per attempt, so a
  // relative sibling would be shared with every other run on this machine.
  const attemptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-observed-attempts-")), "attempts");
  await withFakeCodex(fakeCodexProgram([
    `attempt_file=${JSON.stringify(attemptFile)}`,
    "attempt=0",
    'test ! -f "$attempt_file" || attempt=$(cat "$attempt_file")',
    "attempt=$((attempt + 1))",
    'printf %s "$attempt" > "$attempt_file"',
    'if [ "$attempt" = "1" ]; then',
    ...reads,
    "fi",
    `printf '%s' 'not json at all' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
    await assert.rejects(runJudge(config, "observed:invalid", "routine", "review", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    }), (error) => {
      assert.equal(error.record.attempts, 2);
      assert.equal(error.record.retries.length, 2);
      assert.equal(error.record.retries[0].observation.toolRounds, 2);
      assert.equal(error.record.retries[1].observation.toolRounds, 0);
      assert.deepEqual(error.record.retries[1].observation.commands, [],
        "an attempt that read nothing records an observed zero, not a missing observation");
      assert.deepEqual(error.record.activity, error.record.retries[1].observation,
        "the call-level observation is the fatal attempt's, never a sum of attempts");
      return true;
    });
  });
});

// Crossing vendors must not erase what the primary was observed doing: the
// benchmark's failing lane crossed after a read-heavy attempt, and the reads
// that caused the crossing are the diagnosis.
test("a fallback crossing keeps the primary's observed reads and attests its own", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-observed-fallback-"));
  const event = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg -n value src/allowed.txt", aggregated_output: "1:value" } });
  fs.writeFileSync(path.join(binDir, "codex"), fakeCodexProgram([
    `printf '%s\\n' '${event}'`,
    `printf '%s' 'not json' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]));
  const envelope = path.join(binDir, "envelope.json");
  fs.writeFileSync(envelope, JSON.stringify({ type: "result", is_error: false, num_turns: 4, result: JSON.stringify({ verdict: "PASS", findings: [] }) }));
  fs.writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\ncat ${JSON.stringify(envelope)}\n`);
  fs.chmodSync(path.join(binDir, "codex"), 0o755);
  fs.chmodSync(path.join(binDir, "claude"), 0o755);
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-observed-source-"));
  fs.mkdirSync(path.join(source, "src"));
  fs.writeFileSync(path.join(source, "src/allowed.txt"), "value\n");
  const crossing = {
    ...config,
    judge: {
      ...config.judge,
      profiles: {
        ...config.judge.profiles,
        routine: { primary: { backend: "codex", model: null, effort: "high" }, fallback: { backend: "claude", model: null, effort: "high" } },
      },
    },
  };
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  delete process.env.SASU_JUDGE_BACKEND;
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(crossing, "observed:crossing", "routine", "review", validateGapVerdict, {
      agentic: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    });
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "claude");
    assert.equal(outcome.record.fallback.backend, "codex");
    assert.deepEqual(outcome.record.retries.map((retry) => retry.observation.commands), [["rg -n value src/allowed.txt"], ["rg -n value src/allowed.txt"]],
      "the crossed-out primary's reads stay in the record");
    assert.deepEqual(outcome.record.activity, { commands: null, toolRounds: 3, readOutputChars: null, msToLastRead: null },
      "the answering backend attests rounds and exposes no command trace; an empty list would claim it ran nothing");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("a prompt-only backend that attests nothing records no observation instead of a zero", async () => {
  await withStub({ verdict: "PASS", findings: [] }, async () => {
    process.env.SASU_JUDGE_STUB_TOOL_ROUNDS = "unmetered";
    try {
      const outcome = await runJudge(config, "observed:unmetered", "routine", "prompt", validateGapVerdict);
      assert.deepEqual(outcome.record.activity, { commands: null, toolRounds: null, readOutputChars: null, msToLastRead: null });
    } finally {
      delete process.env.SASU_JUDGE_STUB_TOOL_ROUNDS;
    }
  });
});

test("oversized immutable input fails before even a canary, including UTF-8 and correction reserve", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-input-admission-")), "calls");
  await withFakeCodex(fakeCodexProgram([], { countFile: marker }), async () => {
    for (const prompt of ["x".repeat(400_001), "한".repeat(140_000), "x".repeat(396_000)]) {
      await assert.rejects(runJudge(config, "input-admission", "routine", prompt, validateGapVerdict), error => {
        assert.equal(error.code, "judge-context-overflow");
        assert.equal(error.reason, "input-too-large");
        assert.equal(error.record.attempts, 0);
        assert.equal(error.record.fallback, undefined);
        assert.match(error.detail, /UTF-8 bytes/);
        return true;
      });
    }
    assert.equal(fs.existsSync(marker), false, "invalid fixed input cannot spend a canary or correction attempt");
  });
});

test("exploration sees only copied evidence and cannot enumerate adapter output", async () => {
  const response = JSON.stringify({ verdict: "PASS", findings: [] });
  const command = "rg --files";
  const event = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: "src/allowed.txt" } });
  const program = fakeCodexProgram([
    'test ! -f "$root/last-message.txt" || exit 80',
    'test -f "$root/src/allowed.txt" || exit 81',
    'test ! -f "$root/secret.txt" || exit 82',
    'case "$last" in "$root"/*) exit 83 ;; esac',
    `printf '%s' '${response}' > "$last"`,
    `printf '%s\\n' '${event}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ]);
  await withFakeCodex(program, async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "source");
    fs.writeFileSync(path.join(source, "secret.txt"), "excluded");
    const result = await runJudge(config, "explore", "routine", "review the source", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    });
    assert.equal(result.value.verdict, "PASS");
  });
});

test("missing evidence and a parent symlink outside the snapshot cannot produce a verdict", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-outside-evidence-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "host secret");
  await withFakeCodex(fakeCodexProgram(['exit 90']), async (source) => {
    fs.symlinkSync(outside, path.join(source, "linked"));
    for (const evidencePath of ["missing.txt", "linked/secret.txt"]) {
      await assert.rejects(runJudge(config, "invalid-evidence", "routine", "review", validateGapVerdict, {
        agentic: true, explore: true, cwd: source, evidencePaths: [evidencePath],
      }), error => error.reason === "evidence-access");
    }
  });
});


test("Codex exploration recovers from a missing path and accepts more than 29 bounded reads", async () => {
  const event = (command, aggregated_output, exit_code = 0) => JSON.stringify({
    type: "item.completed", item: { type: "command_execution", command, aggregated_output, exit_code },
  });
  const lines = [
    `printf '%s\\n' '${event("rg --files src missing", "src/allowed.txt\nrg: missing: No such file or directory", 2)}'`,
    ...Array.from({ length: AGENTIC_READ_MAX_ROUNDS }, () =>
      `printf '%s\\n' '${event("rg -n value src/allowed.txt", "1:value")}'`),
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`,
  ];
  await withFakeCodex(fakeCodexProgram(lines), async (source) => {
    fs.mkdirSync(path.join(source, "src"));
    fs.writeFileSync(path.join(source, "src/allowed.txt"), "value");
    const result = await runJudge(config, "bounded-exploration", "routine", "review the source", validateGapVerdict, {
      agentic: true, explore: true, cwd: source, evidencePaths: ["src/allowed.txt"],
    });
    assert.equal(result.value.verdict, "PASS");
    assert.equal(result.record.attempts, 1, "a missing relative search path does not restart the reviewer");
    assert.equal(result.record.activity.commands.length, AGENTIC_READ_MAX_ROUNDS + 1);
  });
});
