import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runJudge } from "../../dist/judge/runner.js";
import { validateGapVerdict } from "../../dist/judge/types.js";
import { loadConfig } from "../../dist/config.js";

function withStub(responses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-stub-"));
  const stubFile = path.join(dir, "stub.json");
  fs.writeFileSync(stubFile, JSON.stringify(responses));
  const previousBackend = process.env.CHECKSHIRT_JUDGE_BACKEND;
  const previousFile = process.env.CHECKSHIRT_JUDGE_STUB_FILE;
  process.env.CHECKSHIRT_JUDGE_BACKEND = "stub";
  process.env.CHECKSHIRT_JUDGE_STUB_FILE = stubFile;
  try {
    return fn();
  } finally {
    if (previousBackend === undefined) delete process.env.CHECKSHIRT_JUDGE_BACKEND;
    else process.env.CHECKSHIRT_JUDGE_BACKEND = previousBackend;
    if (previousFile === undefined) delete process.env.CHECKSHIRT_JUDGE_STUB_FILE;
    else process.env.CHECKSHIRT_JUDGE_STUB_FILE = previousFile;
  }
}

const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-proj-")));

test("runJudge accepts a valid first reply with attempts=1", () => {
  withStub([{ verdict: "PASS", findings: [] }], () => {
    const outcome = runJudge(config, "gate:test", "frugal", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.attempts, 1);
    assert.equal(outcome.record.outcome, "ok");
  });
});

test("runJudge retries exactly once on invalid output, then succeeds", () => {
  withStub(["not json at all", { verdict: "PASS", findings: [] }], () => {
    const outcome = runJudge(config, "gate:test", "frugal", "prompt", validateGapVerdict);
    assert.equal(outcome.value.verdict, "PASS");
    assert.equal(outcome.record.attempts, 2);
  });
});

test("runJudge throws a typed error after two invalid replies", () => {
  withStub(["garbage one", "garbage two"], () => {
    assert.throws(
      () => runJudge(config, "gate:test", "frugal", "prompt", validateGapVerdict),
      (error) => error.code === "judge-invalid-output" && error.record.attempts === 2,
    );
  });
});

test("runJudge rejects schema-invalid JSON the same as non-JSON", () => {
  withStub([{ verdict: "MAYBE" }, { verdict: "BLOCK", findings: [] }], () => {
    assert.throws(
      () => runJudge(config, "gate:test", "frugal", "prompt", validateGapVerdict),
      (error) => error.code === "judge-invalid-output",
    );
  });
});
