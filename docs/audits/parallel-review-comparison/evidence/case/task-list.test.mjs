import test from "node:test";
import assert from "node:assert/strict";
import { addItem, normalizeTitle, toggleItem, removeItem, snapshot, summary } from "../src/task-list.mjs";

test("task-list public behavior", () => {
  const source = [{ id: 4, title: "first", done: false }];
  const added = addItem(source, "  second  ");
  assert.deepEqual(added[1], { id: 5, title: "second", done: false });
  assert.deepEqual(source, [{ id: 4, title: "first", done: false }]);
  assert.throws(() => normalizeTitle("   "), /title is required/);
  assert.deepEqual(toggleItem(added, 5), [source[0], { id: 5, title: "second", done: true }]);
  assert.deepEqual(removeItem(added, 4), [{ id: 5, title: "second", done: false }]);
  const copy = snapshot(added);
  copy[0].title = "changed";
  assert.equal(added[0].title, "first");
  assert.equal(summary([]), "0 items");
  assert.equal(summary(added), "2 items");
});

