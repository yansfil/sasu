import assert from "node:assert/strict";
import { command } from "./src/public.mjs";
assert.equal(command(1), 1);
console.log("Actual required suite: command(1) returned 1. This suite did not execute the other requirements.");
