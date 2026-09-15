import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, attemptFixture, SHA } from "../helpers/implement-state.mjs";
import { parseImplementState, persistState, loadState } from "../../dist/implement/store.js";

test("stateless state accepts deterministic attempts and a current report", () => {
  const state = stateFixture();
  state.verificationAttempts.push(attemptFixture({ phase: "complete", verdict: "PASS" }));
  state.verificationReport = { schema: "sasu.verification-report.v1", inputFingerprint: SHA, prdSha256: SHA, baseSha: null, headSha: null, sourceFingerprint: SHA, generatedAt: "2026-09-15T00:00:00.000Z", status: "PASS", jsonPath: "agents/runs/fixture/verification-report.json", markdownPath: "agents/runs/fixture/verification-report.md", reportSha256: SHA };
  assert.equal(parseImplementState(JSON.stringify(state)).verificationReport.status, "PASS");
});

test("retired receipt and reviewer state fails explicitly", () => {
  for (const field of ["completion", "findings", "riskFindings", "budgetGrants"]) {
    assert.throws(() => parseImplementState(JSON.stringify({ ...stateFixture(), [field]: field === "completion" ? null : [] })), /retired implement state field/);
  }
  const attempt = attemptFixture({ reviews: { fidelity: null, code: null } });
  assert.throws(() => parseImplementState(JSON.stringify({ ...stateFixture(), verificationAttempts: [attempt] })), /retired verification field: reviews/);
});

test("old schema has no compatibility reader", () => {
  assert.throws(() => parseImplementState(JSON.stringify({ ...stateFixture(), schema: "sasu.implement.state.v10" })), /no migration is available/);
});

test("verification history stays append-only", (t) => {
  const root = scratchDir("sasu-store-stateless-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "agents/runs/fixture/state.json");
  const state = stateFixture(root);
  persistState(file, state);
  const loaded = loadState(root, { slug: "fixture" }).state;
  loaded.verificationAttempts.push(attemptFixture());
  persistState(file, loaded);
  const rewritten = loadState(root, { slug: "fixture" }).state;
  rewritten.verificationAttempts[0].inputFingerprint = "b".repeat(64);
  assert.throws(() => persistState(file, rewritten), /immutable/);
});
