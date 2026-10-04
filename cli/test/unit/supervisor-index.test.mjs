import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APPLIED_WRITES_CAP, emptyIndex, recordRegisteredRun, INDEX_SCHEMA, MAX_INDEX_BYTES, MAX_INDEX_ENTRIES, readIndex, reconcileRunRegistration, reconcileRegistrationAuthority, updateIndex, forgetRegisteredRun } from "../../dist/supervisor/index.js";
const statePath = "/repo/agents/runs/a/state.json";
const at = "2026-10-03T00:00:00.000Z";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "index.json");
}
const entry = (runInstanceId, extra = {}) => ({ statePath, runInstanceId, at, recipientAuthorityKey: "a".repeat(64), ...extra });
test("the registry discovers exact run identities, schedules nothing and refuses old contracts", (t) => {
  const file = fixture(t); assert.deepEqual(readIndex(file), emptyIndex());
  recordRegisteredRun(file, entry("first")); recordRegisteredRun(file, entry("second"));
  const registered = readIndex(file);
  assert.equal(registered.schema, INDEX_SCHEMA);
  assert.deepEqual(registered.entries.map((item) => [item.statePath, item.runInstanceId]), [[statePath, "second"]]);
  assert.deepEqual(Object.keys(registered.entries[0]).sort(), ["addedAt", "recipientAuthorityKey", "registrationId", "runInstanceId", "statePath"]);
  const old = path.join(path.dirname(file), "old.json"); fs.writeFileSync(old, JSON.stringify({ schema: "sasu.supervisor.index.v1", entries: [] }));
  const original = fs.readFileSync(old);
  assert.throws(() => readIndex(old), /finish every v1 run.*operator must move index.json and index.json\.revision-.*even when the old index is empty.*no automatic import/);
  assert.deepEqual(fs.readFileSync(old), original);
  assert.equal(fs.readdirSync(path.dirname(old)).some((name) => name.startsWith("old.json.revision-")), false);
});
test("a registration between another writer's read and link survives", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("a"));
  let raced = false;
  updateIndex(file, (index) => { index.entries[0].addedAt = "2026-10-03T01:00:00.000Z"; }, 8, () => {
    if (raced) return; raced = true; recordRegisteredRun(file, entry("b", { statePath: "/repo/agents/runs/b/state.json" }));
  });
  assert.deepEqual(readIndex(file).entries.map((item) => item.runInstanceId), ["a", "b"]);
  assert.equal(readIndex(file).entries[0].addedAt, "2026-10-03T01:00:00.000Z");
});
test("stale recovery cannot replace or remove a newer generation", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("old")); const generation = readIndex(file).entries[0].registrationId;
  recordRegisteredRun(file, entry("new"));
  reconcileRunRegistration(file, { statePath, desired: { runInstanceId: "old", recipientAuthorityKey: "a".repeat(64) }, expectedRegistrationId: generation, at, cause: "stale recovery" });
  assert.equal(readIndex(file).entries[0].runInstanceId, "new");
  reconcileRunRegistration(file, { statePath, desired: null, expectedRegistrationId: generation, at, cause: "stale removal" });
  forgetRegisteredRun(file, statePath, "old"); assert.equal(readIndex(file).entries[0].runInstanceId, "new");
});
test("authority reconciliation rereads a handover after its snapshot", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("run"));
  let authority = { runInstanceId: "run", recipientAuthorityKey: "a".repeat(64) };
  const fixed = reconcileRegistrationAuthority(file, { statePath, at, cause: "handover", readAuthority: () => authority,
    afterAuthoritySnapshot: () => { authority = { ...authority, recipientAuthorityKey: "b".repeat(64) }; recordRegisteredRun(file, entry("run", authority)); } });
  assert.equal(fixed.index.entries[0].recipientAuthorityKey, "b".repeat(64));
});
test("a delayed writer replays after a pruned comparison slot without losing the fresh head", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("initial")); let moved = false;
  updateIndex(file, (index) => { index.entries[0].addedAt = "2026-10-03T02:00:00.000Z"; }, 8, () => {
    if (moved) return; moved = true;
    for (let n = 0; n < 8; n++) recordRegisteredRun(file, entry(`new-${n}`, { statePath: `/repo/agents/runs/${n}/state.json` }));
  });
  assert.equal(readIndex(file).entries.length, 9); assert.equal(readIndex(file).entries[0].addedAt, "2026-10-03T02:00:00.000Z");
});
test("a confirmed linked write is not replayed over its successor", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("initial")); let moved = false;
  updateIndex(file, (index) => { index.entries[0].addedAt = "2026-10-03T03:00:00.000Z"; }, 8, undefined, () => {
    if (moved) return; moved = true; recordRegisteredRun(file, entry("successor"));
  });
  assert.equal(readIndex(file).entries[0].runInstanceId, "successor");
});
test("history and byte caps refuse unbounded writes before committing", (t) => {
  const file = fixture(t); recordRegisteredRun(file, entry("initial"));
  updateIndex(file, (index) => { index.appliedWrites = Array.from({ length: APPLIED_WRITES_CAP }, (_, n) => `write-${n}`); });
  assert.equal(readIndex(file).appliedWrites.length, APPLIED_WRITES_CAP);
  assert.throws(() => updateIndex(file, (index) => { index.entries = Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, n) => ({ ...index.entries[0], statePath: `/repo/${n}`, runInstanceId: `run-${n}` })); }), /entry cap/);
  const oversized = path.join(path.dirname(file), "oversized.json"); fs.writeFileSync(oversized, "x".repeat(MAX_INDEX_BYTES + 1));
  assert.throws(() => readIndex(oversized), /above.*byte cap/); assert.equal(readIndex(file).entries.length, 1);
});
