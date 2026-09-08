import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { parseImplementContract, suiteCommands } from "../../dist/implement/contract.js";
import { prd, makeProject } from "../helpers/implement-fixture.mjs";

test("the complete six-section contract retains thirty requirements and decisions without proof methods", () => {
  const contract = parseImplementContract(prd({ count: 30 }));
  assert.equal(contract.rows.length, 30);
  for (let index = 0; index < 30; index++) {
    assert.equal(contract.rows[index].id, `B${index + 1}`);
    assert.equal(contract.rows[index].behavior, `Requirement ${index + 1}: the public command preserves value ${index + 1}.`);
    assert.deepEqual(contract.rows[index].decisionIds, ["D-01"]);
    assert.deepEqual(Object.keys(contract.rows[index]).sort(), ["behavior", "decisionIds", "id", "line"]);
  }
  assert.equal(contract.decisions[0].decision, "Preserve every value in the approved request.");
  assert.match(contract.goal, /every requested value/);
  assert.match(contract.nonGoals, /No network/);
  assert.match(contract.technicalStructure, /implementation.txt/);
});

test("retired four-column contracts name the old contract and last supporting commit", () => {
  const legacy = prd().replace("| # | 사용자가 관찰하는 행동 | 결정 |", "| # | 사용자가 관찰하는 행동 | 검사 방법 | 결정 |").replace("| --- | --- | --- |\n| B1", "| --- | --- | --- | --- |\n| B1").replace(/(\| B\d+ \|[^\n]+) \| D-01 \|/g, "$1 | check: `npm test` | D-01 |");
  assert.throws(() => parseImplementContract(legacy), /488d3cc/);
});

test("missing sections, empty behaviors, duplicate references, and unknown decisions fail closed", () => {
  assert.throws(() => parseImplementContract(prd().replace("## Risks\nNone.\n", "")), /Risks/);
  assert.throws(() => parseImplementContract(prd({ count: 0 })), /no table rows|empty/);
  assert.throws(() => parseImplementContract(prd().replace("| B2 |", "| B1 |")), /duplicate|duplicat/i);
  assert.throws(() => parseImplementContract(prd().replace(/\| D-01 \|\n/g, "| D-99 |\n")), /D-99/);
  assert.throws(() => parseImplementContract(prd().replace("Requirement 1: the public command preserves value 1.", "")), /empty|behavior|행동/);
});

test("a behavior may naturally mention check without creating a method contract", () => {
  const source = prd().replace("Requirement 1: the public command preserves value 1.", "check: appears literally in the diagnostic output.");
  assert.equal(parseImplementContract(source).rows[0].behavior, "check: appears literally in the diagnostic output.");
});

test("suite sealing deduplicates actual argv and cwd while retaining lint and distinct execution roots", () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ verify: { commands: { test: "npm test", build: "npm   test", lint: "npm run lint" } } }));
  assert.deepEqual(suiteCommands(root, root).map(({ command, cwd }) => ({ command, cwd })), [{ command: "npm test", cwd: "." }, { command: "npm run lint", cwd: "." }]);
  fs.rmSync(path.join(root, "agents/config.json"));
  fs.mkdirSync(path.join(root, "cli"));
  fs.writeFileSync(path.join(root, "cli/package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "node lint.cjs" } }));
  const suite = suiteCommands(root, root);
  assert.ok(suite.some((entry) => entry.command === "npm test" && entry.cwd === "."));
  assert.ok(suite.some((entry) => entry.command === "npm test" && entry.cwd === "cli"));
  assert.ok(suite.some((entry) => entry.command === "npm run lint" && entry.cwd === "cli"));
  fs.rmSync(root, { recursive: true, force: true });
});
