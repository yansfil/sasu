import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { APPLIED_WRITES_CAP, emptyIndex, enrollRun, INDEX_SCHEMA, MAX_INDEX_BYTES, MAX_INDEX_ENTRIES, readIndex, reconcileRunEnrollment, REMOVED_HISTORY_CAP, updateIndex } from "../../dist/supervisor/index.js";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-index-")), "index.json");

test("D-05: a missing index is empty, a malformed one is an error the operator sees, and enrolling replaces by state path", () => {
  const index = file();
  assert.deepEqual(readIndex(index), emptyIndex());
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-1", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  enrollRun(index, { statePath: "/repo/agents/runs/b/state.json", runInstanceId: "i-2", recoveryOwner: "supervisor", at: "2026-09-18T00:00:01.000Z" });
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-3", recoveryOwner: "supervisor", at: "2026-09-18T00:00:02.000Z" });
  const read = readIndex(index);
  assert.equal(read.schema, INDEX_SCHEMA);
  assert.deepEqual(read.entries.map((entry) => [entry.statePath, entry.runInstanceId, entry.missingTicks, entry.lastWake]), [["/repo/agents/runs/b/state.json", "i-2", 0, null], ["/repo/agents/runs/a/state.json", "i-3", 0, null]]);

  const malformed = file();
  fs.writeFileSync(malformed, "{not json");
  assert.throws(() => readIndex(malformed), /malformed supervisor index JSON/);
  const schema = file();
  fs.writeFileSync(schema, JSON.stringify({ schema: "other", entries: [] }));
  assert.throws(() => readIndex(schema), /unsupported supervisor index schema other/);
  const relative = file();
  fs.writeFileSync(relative, JSON.stringify({ schema: INDEX_SCHEMA, entries: [{ statePath: "relative/state.json", runInstanceId: "x", missingTicks: 0 }] }));
  assert.throws(() => readIndex(relative), /no valid absolute statePath/);
  const ownerless = file();
  fs.writeFileSync(ownerless, JSON.stringify({ schema: INDEX_SCHEMA, entries: [{ statePath: "/repo/agents/runs/a/state.json", runInstanceId: "x", missingTicks: 0 }] }));
  assert.throws(() => readIndex(ownerless), /has no recoveryOwner/, "D-15: an entry that does not say who owns recovery is refused, not defaulted");
});

test("two writers never lose each other's entry: a write against moved bytes is re-applied on the fresh read", () => {
  const index = file();
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-1", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  let interleaved = false;
  updateIndex(index, (held) => {
    held.lastTickAt = "2026-09-18T00:01:00.000Z";
    if (!interleaved) {
      interleaved = true;
      // Another process (an Observer's dispatch) lands between this read and its write.
      enrollRun(index, { statePath: "/repo/agents/runs/b/state.json", runInstanceId: "i-2", recoveryOwner: "supervisor", at: "2026-09-18T00:00:30.000Z" });
    }
  });
  const read = readIndex(index);
  assert.equal(read.lastTickAt, "2026-09-18T00:01:00.000Z");
  assert.deepEqual(read.entries.map((entry) => entry.runInstanceId), ["i-1", "i-2"], "the interleaved enrollment survived the tick's write");
});

test("two writers never lose an enrollment that lands after comparison and before commit", () => {
  const index = file();
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-1", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  let released = false;
  updateIndex(index, (held) => { held.lastTickAt = "2026-09-18T00:01:00.000Z"; }, 5, () => {
    if (released) return;
    released = true;
    enrollRun(index, { statePath: "/repo/agents/runs/b/state.json", runInstanceId: "i-2", recoveryOwner: "supervisor", at: "2026-09-18T00:00:30.000Z" });
  });
  assert.equal(released, true, "the barrier ran in the post-comparison window");
  const read = readIndex(index);
  assert.equal(read.lastTickAt, "2026-09-18T00:01:00.000Z");
  assert.deepEqual(read.entries.map((entry) => entry.runInstanceId), ["i-1", "i-2"]);
});

test("engineering 11: stale reconciliation cannot replace a newer enrollment generation", () => {
  const index = file();
  const statePath = "/repo/agents/runs/a/state.json";
  enrollRun(index, { statePath, runInstanceId: "instance-old", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  const expectedEnrollmentId = readIndex(index).entries[0].enrollmentId;
  const originalLink = fs.linkSync;
  let replaced = false;
  fs.linkSync = (...args) => {
    if (!replaced && String(args[1]).includes(".revision-")) {
      replaced = true;
      enrollRun(index, { statePath, runInstanceId: "instance-new", recoveryOwner: "supervisor", at: "2026-09-18T00:00:30.000Z" });
    }
    return originalLink(...args);
  };
  try {
    reconcileRunEnrollment(index, {
      statePath,
      desired: { runInstanceId: "instance-old", recoveryOwner: "supervisor" },
      expectedEnrollmentId,
      at: "2026-09-18T00:01:00.000Z",
      cause: "stale prerequisite repair",
    });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(replaced, true);
  assert.equal(readIndex(index).entries[0].runInstanceId, "instance-new", "a refused stale repair leaves the replacement supervision intact");
});

test("a delayed writer cannot recreate a pruned old revision and mistake it for a committed update", () => {
  const index = file();
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-1", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  let advanced = false;
  updateIndex(index, (held) => { held.lastTickAt = "2026-09-18T00:30:00.000Z"; }, 8, () => {
    if (advanced) return;
    advanced = true;
    for (let i = 0; i < 6; i += 1) updateIndex(index, (current) => { current.lastHerdr = { available: true, detail: `writer-${i}` }; });
  });
  const read = readIndex(index);
  assert.equal(read.lastTickAt, "2026-09-18T00:30:00.000Z", "the delayed mutation is replayed on the current chain");
  assert.equal(read.lastHerdr.detail, "writer-5", "the intervening writes survive the replay");
});

test("engineering 14/15: a reader whose selected revision is pruned retries from the fresh head", () => {
  const index = file();
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "i-1", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  const originalOpen = fs.openSync;
  let advanced = false;
  fs.openSync = function patchedOpen(target, ...args) {
    if (!advanced && String(target).includes(".revision-")) {
      advanced = true;
      for (let i = 0; i < 5; i += 1) updateIndex(index, (held) => { held.lastHerdr = { available: true, detail: `pruner-${i}` }; });
    }
    return originalOpen.call(fs, target, ...args);
  };
  try {
    const read = readIndex(index);
    assert.equal(advanced, true, "the deterministic barrier advanced beyond the retained revision window");
    assert.equal(read.lastHerdr.detail, "pruner-4");
  } finally {
    fs.openSync = originalOpen;
  }
});

test("engineering 14/15: the next successful write removes crash-orphaned index temp files", () => {
  const index = file();
  const orphan = `${index}.99999.00000000-0000-4000-8000-000000000000.tmp`;
  fs.writeFileSync(orphan, "partial\n");
  updateIndex(index, (held) => { held.lastTickAt = "2026-09-18T00:01:00.000Z"; });
  assert.equal(fs.existsSync(orphan), false);
});

test("a successful write is not replayed when a successor lands after its link", () => {
  const index = file();
  let mutations = 0;
  let successor = false;
  updateIndex(index, (held) => {
    mutations += 1;
    held.lastTickAt = "2026-09-18T00:01:00.000Z";
  }, 8, undefined, () => {
    if (successor) return;
    successor = true;
    updateIndex(index, (held) => { held.lastHerdr = { available: true, detail: "successor" }; });
  });
  const read = readIndex(index);
  assert.equal(mutations, 1, "the already committed intent is recognized under the successor revision");
  assert.equal(read.lastTickAt, "2026-09-18T00:01:00.000Z");
  assert.equal(read.lastHerdr.detail, "successor");
});

test("a successful write fails closed instead of replaying after its operation identity ages out", () => {
  const index = file();
  enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "seed", recoveryOwner: "supervisor", at: "2026-09-18T00:00:00.000Z" });
  let advanced = false;
  assert.throws(() => updateIndex(index, (held) => {
    held.entries[0].runInstanceId = "old";
  }, 2, undefined, () => {
    if (advanced) return;
    advanced = true;
    enrollRun(index, { statePath: "/repo/agents/runs/a/state.json", runInstanceId: "new", recoveryOwner: "supervisor", at: "2026-09-18T00:01:00.000Z" });
    for (let i = 0; i < APPLIED_WRITES_CAP - 1; i += 1) {
      updateIndex(index, (held) => { held.lastTickAt = new Date(Date.parse("2026-09-18T00:01:00.000Z") + i).toISOString(); });
    }
  }), /operation history before confirmation.*refusing to replay/);
  assert.equal(readIndex(index).entries[0].runInstanceId, "new", "the current enrollment survives the ambiguous old writer");
});

test("engineering 15: removal history is capped", () => {
  const index = file();
  updateIndex(index, (held) => { for (let i = 0; i < REMOVED_HISTORY_CAP + 25; i += 1) held.removed.push({ at: "t", statePath: `/r/${i}`, cause: "c" }); });
  const read = readIndex(index);
  assert.equal(read.removed.length, REMOVED_HISTORY_CAP);
  assert.equal(read.removed[0].statePath, "/r/25", "the oldest fall off the front");
});

test("engineering 15: committed operation history is capped", () => {
  const index = file();
  updateIndex(index, (held) => { held.appliedWrites = Array.from({ length: APPLIED_WRITES_CAP + 25 }, (_, i) => `old-${i}`); });
  const read = readIndex(index);
  assert.equal(read.appliedWrites.length, APPLIED_WRITES_CAP);
  assert.equal(read.appliedWrites[0], "old-26", "the newest prior ids and this update's id are retained");
});

test("engineering 15: enrollment and immutable revision history have explicit caps", () => {
  const index = file();
  const full = emptyIndex();
  full.entries = Array.from({ length: MAX_INDEX_ENTRIES }, (_, i) => ({
    statePath: `/repo/agents/runs/${i}/state.json`, runInstanceId: `instance-${i}`, enrollmentId: `enrollment-${i}`,
    recoveryOwner: "supervisor", addedAt: "2026-09-18T00:00:00.000Z", missingTicks: 0,
    lastWake: null, acknowledgements: {}, lastAcknowledgedAt: null, pendingWake: null, lastFailure: null, lastObservation: null, terminalFailureTicks: 0,
  }));
  fs.writeFileSync(index, `${JSON.stringify(full)}\n`);
  assert.throws(
    () => enrollRun(index, { statePath: "/repo/agents/runs/overflow/state.json", runInstanceId: "overflow", recoveryOwner: "supervisor", at: "2026-09-18T00:01:00.000Z" }),
    new RegExp(`entry cap ${MAX_INDEX_ENTRIES} reached`),
  );
  assert.doesNotThrow(() => enrollRun(index, { statePath: "/repo/agents/runs/0/state.json", runInstanceId: "replacement", recoveryOwner: "supervisor", at: "2026-09-18T00:01:00.000Z" }), "replacement does not grow the resource");
  for (let i = 0; i < 8; i += 1) updateIndex(index, (held) => { held.lastTickAt = `2026-09-18T00:0${i}:00.000Z`; });
  const revisions = fs.readdirSync(path.dirname(index)).filter((name) => name.startsWith(`${path.basename(index)}.revision-`));
  assert.equal(revisions.length, 4, "old immutable revisions are pruned");
});

test("engineering 15: an oversized index is refused before parsing", () => {
  const index = file();
  fs.writeFileSync(index, Buffer.alloc(MAX_INDEX_BYTES + 1, 32));
  assert.throws(() => readIndex(index), new RegExp(`above the ${MAX_INDEX_BYTES} byte cap`));
});
