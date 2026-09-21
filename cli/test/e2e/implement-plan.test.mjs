// The plan verb through the real CLI: one `plan` event per registration, and
// the refusals a mistyped path or an empty file must get.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeProject, run, PRD_PATH } from "../helpers/implement-fixture.mjs";

test("plan registers the execution plan as one event per registration and refuses a missing or empty file", (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, ["implement", "start", "--prd", PRD_PATH, "--allow-unapproved-prd"]).status, 0);

  const missing = run(root, ["implement", "plan", "--path", "agents/runs/nope/plan.md"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /plan file not found/);

  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes/plan.md"), "\n");
  const empty = run(root, ["implement", "plan", "--path", "notes/plan.md"]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stdout + empty.stderr, /plan file is empty/);

  fs.writeFileSync(path.join(root, "notes/plan.md"), "READ: a\nSLICES: 1. B1\n");
  const first = run(root, ["implement", "plan", "--path", "notes/plan.md", "--json"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.json.detail.event.kind, "plan");
  assert.equal(first.json.detail.event.subject, "notes/plan.md");

  fs.writeFileSync(path.join(root, "notes/plan.md"), "READ: a\nSLICES: 1. B1\n2. B2\n");
  const second = run(root, ["implement", "plan", "--path", "notes/plan.md", "--json"]);
  assert.equal(second.status, 0);
  assert.ok(second.json.detail.event.id > first.json.detail.event.id, "a rewritten plan is a new event, so the tick wakes again");

  // The tick reads state.json, so the record is what proves the wake input.
  const pointer = JSON.parse(fs.readFileSync(path.join(root, "agents/runs/.prd-implement-active.json"), "utf8"));
  const state = JSON.parse(fs.readFileSync(path.join(root, pointer.statePath), "utf8"));
  const planEvents = state.events.filter((event) => event.kind === "plan");
  assert.deepEqual(planEvents.map((event) => event.subject), ["notes/plan.md", "notes/plan.md"]);
});
