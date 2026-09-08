import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { validateCase } = require("../skills/benchmark-implement/scripts/lib/case_contract.js");
const pokemon = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/pokemon-rpg/benchmark.json"), "utf8"));

test("the executable case uses whole-run stages and Logscan remains a PRD workload", () => {
  assert.equal(validateCase(pokemon).schema, "sasu.benchmark-case.v4");
  assert.deepEqual(pokemon.expected.requiredStages, ["start", "verification", "mechanical", "review", "finalize"]);
  assert.equal(fs.existsSync(path.join(root, "benchmarks/logscan/benchmark.json")), false);
});

test("retired case schemas are rejected before any payload field is consumed", () => {
  for (const schema of ["sasu.benchmark-case.v2", "sasu.benchmark-case.v3", undefined]) {
    assert.throws(() => validateCase({ schema }), /received schema .*expected sasu.benchmark-case.v4; last supported commit 488d3cc/);
  }
});

test("fresh environment, honest completion, and executable stage declarations are enforced", () => {
  for (const [change, error] of [
    [value => { value.environment.mustBeAbsent = ["../foreign"]; }, /must stay inside/],
    [value => { value.expected.falseCompleteAllowed = true; }, /falseCompleteAllowed must be false/],
    [value => { value.expected.requiredStages = ["requirements-fidelity"]; }, /unknown expected stage/],
    [value => { value.expected.terminalStatuses = ["partial"]; }, /unknown expected terminal status/],
  ]) {
    const value = structuredClone(pokemon);
    change(value);
    assert.throws(() => validateCase(value), error);
  }
});

test("both workloads preserve requirements in the current three-column PRD format", () => {
  const { parseBehaviorRows } = require("../cli/lib/prd_parser.js");
  for (const [name, count] of [["pokemon-rpg", 54], ["logscan", 30]]) {
    const text = fs.readFileSync(path.join(root, "benchmarks", name, "prd.md"), "utf8");
    const { rows } = parseBehaviorRows(text);
    assert.equal(rows.length, count, `${name}: all original product requirements and detailed criteria retained`);
    assert.ok(rows.every(row => !row.defects.length));
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(match => match[1]), ["Goal", "Non-goals", "Decisions", "Behaviors", "Technical structure", "Risks"]);
  }
});
