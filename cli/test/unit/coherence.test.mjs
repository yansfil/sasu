import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coherencePrompt, runIntakeCoherence } from "../../dist/intake/coherence.js";
import { runIntakeDecision, runIntakeInit, qaLogPathFor } from "../../dist/intake/commands.js";
import { loadConfig } from "../../dist/config.js";

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-coherence-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function seedDecisions(dir, slug, n, status = "resolved") {
  runIntakeInit(dir, { slug, topic: "widget", where: "greenfield", packs: "ux", understanding: ["a widget"] });
  for (let i = 1; i <= n; i += 1) {
    runIntakeDecision(dir, {
      slug,
      id: `D-${String(i).padStart(2, "0")}`,
      kind: "decision",
      area: "ux",
      text: `decision ${i}`,
      priority: "P1",
      source: "user",
      status,
    });
  }
}

function withStub(dir, response, fn) {
  const stub = path.join(dir, "stub.json");
  fs.writeFileSync(stub, JSON.stringify(response));
  fs.rmSync(`${stub}.cursor`, { force: true });
  const prev = { backend: process.env.CHECKSHIRT_JUDGE_BACKEND, file: process.env.CHECKSHIRT_JUDGE_STUB_FILE };
  process.env.CHECKSHIRT_JUDGE_BACKEND = "stub";
  process.env.CHECKSHIRT_JUDGE_STUB_FILE = stub;
  return fn().finally(() => {
    if (prev.backend === undefined) delete process.env.CHECKSHIRT_JUDGE_BACKEND;
    else process.env.CHECKSHIRT_JUDGE_BACKEND = prev.backend;
    if (prev.file === undefined) delete process.env.CHECKSHIRT_JUDGE_STUB_FILE;
    else process.env.CHECKSHIRT_JUDGE_STUB_FILE = prev.file;
  });
}

test("coherencePrompt judges only decided rows and forbids incompleteness findings", () => {
  const prompt = coherencePrompt(
    "task app",
    "- a task app",
    [{ id: "D-01", area: "scope", text: "single user", priority: "P0", source: "user", kind: "decision", status: "resolved", mapping: "" }],
  );
  assert.match(prompt, /DIRECTION check, not a completeness check/);
  assert.match(prompt, /Never report a missing decision/);
  assert.match(prompt, /D-01 \[scope\] single user/);
});

test("coherence skips below the minimum resolved-decision threshold without a judge call", async () => {
  const dir = makeProject();
  seedDecisions(dir, "few", 2);
  const result = await runIntakeCoherence(dir, loadConfig(dir), { slug: "few", minDecisions: 3 });
  assert.equal(result.skipped, true);
  assert.equal(result.judge, null);
  assert.equal(result.durationMs, null);
  assert.match(result.reason, /only 2 resolved/);
});

test("coherence counts only resolved decisions toward the threshold", async () => {
  const dir = makeProject();
  seedDecisions(dir, "open-heavy", 4, "open");
  const result = await runIntakeCoherence(dir, loadConfig(dir), { slug: "open-heavy", minDecisions: 3 });
  assert.equal(result.skipped, true);
  assert.equal(result.resolvedCount, 0);
});

test("coherence returns judge findings and a duration without touching gate state", async () => {
  const dir = makeProject();
  seedDecisions(dir, "drifted", 3);
  const response = {
    verdict: "BLOCK",
    findings: [
      {
        area: "scope",
        severity: "P0",
        missing: "D-02 assumes multi-tenant but D-01 fixed single-user scope",
        recommendation: "ask whether the product is single- or multi-user",
        requiresHuman: true,
      },
    ],
  };
  const result = await withStub(dir, response, () =>
    runIntakeCoherence(dir, loadConfig(dir), { slug: "drifted", minDecisions: 3 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.verdict, "BLOCK");
  assert.equal(result.findings.length, 1);
  assert.equal(result.resolvedCount, 3);
  assert.equal(typeof result.durationMs, "number");
  // advisory: no gate state is written for the topic
  assert.equal(fs.existsSync(path.join(dir, "agents", "gates", "drifted")), false);
  // the qa-log itself is untouched (read-only judge)
  assert.match(fs.readFileSync(qaLogPathFor(dir, "drifted"), "utf8"), /question_count: 0/);
});

test("a coherent interview returns PASS with no findings", async () => {
  const dir = makeProject();
  seedDecisions(dir, "clean", 3);
  const result = await withStub(dir, { verdict: "PASS", findings: [] }, () =>
    runIntakeCoherence(dir, loadConfig(dir), { slug: "clean", minDecisions: 3 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.findings, []);
});

test("a judge failure is advisory: ok false, error surfaced, interview not blocked", async () => {
  const dir = makeProject();
  seedDecisions(dir, "boom", 3);
  const result = await withStub(dir, "not json at all", () =>
    runIntakeCoherence(dir, loadConfig(dir), { slug: "boom", minDecisions: 3 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "judge-invalid-output");
  assert.match(result.error.recovery, /advisory/);
});
