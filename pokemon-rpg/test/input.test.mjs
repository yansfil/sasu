import { test } from "node:test";
import assert from "node:assert/strict";
import { actionForKey, DIRECTION_ACTIONS } from "../src/ui/input.js";

test("[R20] arrow keys and WASD (both cases) map to the 4 directions", () => {
  assert.equal(actionForKey("ArrowUp"), "up");
  assert.equal(actionForKey("ArrowDown"), "down");
  assert.equal(actionForKey("ArrowLeft"), "left");
  assert.equal(actionForKey("ArrowRight"), "right");
  assert.equal(actionForKey("w"), "up");
  assert.equal(actionForKey("W"), "up");
  assert.equal(actionForKey("a"), "left");
  assert.equal(actionForKey("s"), "down");
  assert.equal(actionForKey("d"), "right");
  for (const dir of ["up", "down", "left", "right"]) assert.ok(DIRECTION_ACTIONS.has(dir));
});

test("[R20] Z/Enter confirm, X/Escape cancel", () => {
  assert.equal(actionForKey("z"), "confirm");
  assert.equal(actionForKey("Z"), "confirm");
  assert.equal(actionForKey("Enter"), "confirm");
  assert.equal(actionForKey("x"), "cancel");
  assert.equal(actionForKey("X"), "cancel");
  assert.equal(actionForKey("Escape"), "cancel");
});

test("[R20] an unmapped key returns null", () => {
  assert.equal(actionForKey("q"), null);
  assert.equal(actionForKey("Tab"), null);
});
