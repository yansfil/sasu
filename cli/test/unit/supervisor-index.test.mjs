import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyIndex, enrollRun, INDEX_SCHEMA, readIndex, REMOVED_HISTORY_CAP, updateIndex } from "../../dist/supervisor/index.js";

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

  fs.writeFileSync(index, "{not json");
  assert.throws(() => readIndex(index), /malformed supervisor index JSON/);
  fs.writeFileSync(index, JSON.stringify({ schema: "other", entries: [] }));
  assert.throws(() => readIndex(index), /unsupported supervisor index schema other/);
  fs.writeFileSync(index, JSON.stringify({ schema: INDEX_SCHEMA, entries: [{ statePath: "relative/state.json", runInstanceId: "x", missingTicks: 0 }] }));
  assert.throws(() => readIndex(index), /no absolute statePath/);
  fs.writeFileSync(index, JSON.stringify({ schema: INDEX_SCHEMA, entries: [{ statePath: "/repo/agents/runs/a/state.json", runInstanceId: "x", missingTicks: 0 }] }));
  assert.throws(() => readIndex(index), /has no recoveryOwner/, "D-15: an entry that does not say who owns recovery is refused, not defaulted");
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

test("engineering 15: removal history is capped", () => {
  const index = file();
  updateIndex(index, (held) => { for (let i = 0; i < REMOVED_HISTORY_CAP + 25; i += 1) held.removed.push({ at: "t", statePath: `/r/${i}`, cause: "c" }); });
  const read = readIndex(index);
  assert.equal(read.removed.length, REMOVED_HISTORY_CAP);
  assert.equal(read.removed[0].statePath, "/r/25", "the oldest fall off the front");
});
