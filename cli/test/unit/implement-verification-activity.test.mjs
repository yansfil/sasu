import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { scratchDir } from "../scratch.mjs";
import { stateFixture, attemptFixture } from "../helpers/implement-state.mjs";
import { beginVerification, finishVerification, progressVerification } from "../../dist/implement/verification-activity.js";
import { loadState, persistState } from "../../dist/implement/store.js";

function fixture(t) {
  const root = scratchDir("sasu-verification-activity-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "agents/runs/fixture/state.json");
  const state = stateFixture(root);
  persistState(statePath, state);
  return { root, statePath, state, reload: () => loadState(root, { slug: "fixture" }).state };
}

test("one verification lease owns the whole deterministic execution", (t) => {
  const f = fixture(t);
  beginVerification(f.statePath, f.state, attemptFixture());
  assert.throws(() => beginVerification(f.statePath, f.reload(), attemptFixture({ id: "V2" })), /verification still active/);
  progressVerification(f.statePath, f.state, fresh => { fresh.verificationAttempts[0].phase = "mechanical"; });
  finishVerification(f.statePath, f.state, fresh => { fresh.verificationAttempts[0].phase = "complete"; fresh.verificationAttempts[0].verdict = "PASS"; });
  assert.equal(f.reload().activeVerification, undefined);
  assert.equal(f.reload().verificationAttempts[0].verdict, "PASS");
});

test("the lease stays on disk through derived verification report publication", (t) => {
  const f = fixture(t);
  const reportPath = path.join(f.root, "agents/runs/fixture/verification-report.md");
  beginVerification(f.statePath, f.state, attemptFixture());
  let diskHeldLeaseWhileReportWasBuilt = false;
  let diskHeldLeaseWhenReportBecameVisible = false;
  const renameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    renameSync(from, to);
    if (to === reportPath) diskHeldLeaseWhenReportBecameVisible = f.reload().activeVerification !== undefined;
  };
  try {
    finishVerification(
      f.statePath,
      f.state,
      fresh => {
        fresh.verificationAttempts[0].phase = "complete";
        fresh.verificationAttempts[0].verdict = "PASS";
      },
      () => {
        diskHeldLeaseWhileReportWasBuilt = f.reload().activeVerification !== undefined;
        return [{ file: reportPath, text: "current report\n" }];
      },
    );
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(diskHeldLeaseWhileReportWasBuilt, true);
  assert.equal(diskHeldLeaseWhenReportBecameVisible, true);
  assert.equal(f.reload().activeVerification, undefined);
  assert.equal(fs.readFileSync(reportPath, "utf8"), "current report\n");
});

test("a verification cannot pin a different PRD", (t) => {
  const f = fixture(t);
  assert.throws(() => beginVerification(f.statePath, f.state, attemptFixture({ prdSha256: "b".repeat(64) })), /PRD identity/);
});
