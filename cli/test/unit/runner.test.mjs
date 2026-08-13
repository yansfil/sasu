import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runJudge } from "../../dist/judge/runner.js";
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

test("runJudge falls back from a Claude timeout to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
  fs.writeFileSync(
    fakeCodex,
    '#!/bin/sh\nlast=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi\ndone\nprintf \'{"verdict":"PASS","findings":[]}\' > "$last"\n',
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const fastConfig = { ...config, judge: { ...config.judge, timeoutMs: 1000 } };
  try {
    const outcome = await runJudge(fastConfig, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.equal(outcome.record.fallback?.backend, "claude");
    assert.equal(outcome.record.fallback?.outcome, "judge-timeout");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("an agentic Claude failure falls back to Codex with only allowlisted evidence", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(path.join(binDir, "allowed.txt"), "READY\n");
  fs.writeFileSync(path.join(binDir, "decoy.txt"), "MUST NOT COPY\n");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\n/bin/sleep 5\n");
  fs.writeFileSync(fakeCodex, [
    "#!/bin/sh",
    'last=""',
    'root=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2',
    '  elif [ "$1" = "-C" ]; then root="$2"; shift 2',
    '  else shift; fi',
    "done",
    'test -f "$root/allowed.txt" || exit 41',
    'test ! -e "$root/decoy.txt" || exit 42',
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc sed -n 1p allowed.txt"}}'`,
    `printf '%s' '{"verdict":"PASS","findings":[]}' > "$last"`,
    "",
  ].join("\n"));
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const fastConfig = { ...config, judge: { ...config.judge, timeoutMs: 1000 } };
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

test("runJudge falls back from repeated invalid Claude output to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nprintf 'not json\\n'\n");
  fs.writeFileSync(
    fakeCodex,
    '#!/bin/sh\nlast=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi\ndone\nprintf \'{"verdict":"PASS","findings":[]}\' > "$last"\n',
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
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

test("runJudge falls back from Claude authentication failure to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"Not logged in. Please run /login."}\'\n');
  fs.writeFileSync(
    fakeCodex,
    '#!/bin/sh\nlast=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi\ndone\nprintf \'{"verdict":"PASS","findings":[]}\' > "$last"\n',
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.ok(outcome.record.fallback);
    assert.equal(outcome.record.fallback.backend, "claude");
    assert.equal(outcome.record.fallback.model, "claude-sonnet-5");
    assert.equal(outcome.record.fallback.outcome, "judge-auth");
    assert.equal(typeof outcome.record.fallback.durationMs, "number");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("runJudge falls back from a Claude runtime failure to Codex", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-fakebin-"));
  const fakeClaude = path.join(binDir, "claude");
  const fakeCodex = path.join(binDir, "codex");
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf \'{"is_error":true,"result":"upstream service unavailable"}\'\n');
  fs.writeFileSync(
    fakeCodex,
    '#!/bin/sh\nlast=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output-last-message" ]; then last="$2"; shift 2; else shift; fi\ndone\nprintf \'{"verdict":"PASS","findings":[]}\' > "$last"\n',
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  const previousBackend = process.env.SASU_JUDGE_BACKEND;
  const previousPath = process.env.PATH;
  process.env.SASU_JUDGE_BACKEND = "claude";
  process.env.PATH = `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  try {
    const outcome = await runJudge(config, "gate:test", "routine", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.backend, "codex");
    assert.equal(outcome.record.attempts, 1);
    assert.ok(outcome.record.fallback);
    assert.equal(outcome.record.fallback.backend, "claude");
    assert.equal(outcome.record.fallback.outcome, "judge-auth-or-runtime");
    assert.equal(typeof outcome.record.fallback.durationMs, "number");
  } finally {
    if (previousBackend === undefined) delete process.env.SASU_JUDGE_BACKEND;
    else process.env.SASU_JUDGE_BACKEND = previousBackend;
    process.env.PATH = previousPath;
  }
});

test("runJudge falls back from a Codex runtime failure to Claude", async () => {
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
  process.env.SASU_JUDGE_BACKEND = "codex";
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
