import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { resetJudgeHealth, runJudge } from "../../dist/judge/runner.js";
import { AGENTIC_READ_MAX_ROUNDS } from "../../dist/judge/backends.js";
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
    assert.equal(fs.existsSync(claudeMarker), false, "visual evidence must never be delivered to Claude through Read");
  } finally {
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

test("without an override, runJudge falls back from a Claude timeout to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
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
  const fastConfig = { ...claudePrimaryConfig, judge: { ...claudePrimaryConfig.judge, timeoutMs: 1000 } };
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
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
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
  const fastConfig = { ...claudePrimaryConfig, judge: { ...claudePrimaryConfig.judge, timeoutMs: 1000 } };
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
    assert.deepEqual(seen, { commands: [], toolRounds: 2 }, "num_turns 3 = two tool rounds");

    fs.writeFileSync(envelopeFile, envelope({}));
    await runJudge(config, "gate:test", "routine", "prompt", (value, activity) => {
      seen = activity;
      return validateGapVerdict(value);
    });
    assert.equal(seen.toolRounds, null, "a missing num_turns must stay unknown, never zero");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
    delete process.env.CLAUDE_FAKE_ENVELOPE;
  }
});
