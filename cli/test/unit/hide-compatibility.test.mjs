import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareHideContract, inspectHideCompatibility } from "../../dist/hide-compatibility.js";
import { runDoctor } from "../../dist/doctor.js";
import { scratchDir } from "../scratch.mjs";

// Projection of the public export at 72c2113f29b74d60897e62c33031f32a977c6118:
// unrelated commands/answers are omitted; its original digest is retained.
// This fixture deliberately preserves the published missing guarantees.
const legacy = JSON.parse(fs.readFileSync(new URL("../fixtures/hide-contract/published-0.1.0.json", import.meta.url), "utf8"));
const legacyVersion = { version: "0.1.0", commit: "72c2113f29b74d60897e62c33031f32a977c6118", contract: legacy.digest };
const published = JSON.parse(fs.readFileSync(new URL("../fixtures/hide-contract/published-caller.json", import.meta.url), "utf8"));
const provenance = JSON.parse(fs.readFileSync(new URL("../fixtures/hide-contract/published-caller.provenance.json", import.meta.url), "utf8"));
const version = { version: "0.1.0", commit: provenance.sourceCommit, contract: published.digest };
const baselineIssues = [
  "missing or malformed command: agent show here",
  "missing or unsupported answer schema: agent",
  "missing or unsupported answer schema: agent_list",
];

test("old public export fails and published caller contract with guaranteed fields passes", () => {
  const report = compareHideContract(legacyVersion, legacy);
  assert.equal(report.compatible, false);
  assert.equal(report.code, "HIDE_CONTRACT_UNSUPPORTED");
  assert.deepEqual(report.installed, legacyVersion);
  assert.deepEqual(report.issues, baselineIssues);
  const supported = compareHideContract(version, published);
  assert.equal(supported.compatible, true);
  assert.equal(supported.code, "HIDE_COMPATIBLE");
  assert.deepEqual(supported.issues, []);
  assert.deepEqual(supported.installed, version);
});

test("additional commands, optional inputs, response fields and refusal codes remain compatible", () => {
  const contract = structuredClone(published);
  contract.commands.push({ command: "future command" });
  contract.commands.find((entry) => entry.command === "agent spawn").options.push({ name: "--future", value: null, required: false, requires: [] });
  contract.answers.agent.properties.future = { type: "string" };
  contract.commands.find((entry) => entry.command === "agent show here").refusals.push("future_refusal");
  assert.equal(compareHideContract({ ...version, version: "2.3.4" }, contract).compatible, true);
  // Narrowing a response is safe; omitting a required nullable field is not.
  contract.answers.agent.properties.parent.type = "string";
  assert.equal(compareHideContract(version, contract).compatible, true);
  const missingField = structuredClone(contract);
  missingField.answers.agent.required = missingField.answers.agent.required.filter((name) => name !== "parent");
  assert.ok(compareHideContract(version, missingField).issues.includes(baselineIssues[1]));
  contract.answers.agent.definitions.Runtime.enum.push("unknown-runtime");
  assert.ok(compareHideContract(version, contract).issues.includes(baselineIssues[1]));
});

test("breaking signatures, envelopes and answer fields are reported structurally", () => {
  for (const [mutate, issue] of [
    [(c) => c.commands.find((v) => v.command === "agent spawn").options.find((v) => v.name === "--path").value.type = "unsigned", "unsupported command signature: agent spawn"],
    [(c) => c.commands.find((v) => v.command === "agent list").options.push({ name: "--new-required", value: { type: "text" }, required: true, requires: [] }), "unsupported command signature: agent list"],
    [(c) => c.commands.find((v) => v.command === "request send").options.find((v) => v.name === "--kind").value.values = ["request"], "unsupported command signature: request send"],
    [(c) => c.commands.find((v) => v.command === "request reply").arguments.push({ name: "extra", value: { type: "key" } }), "unsupported command signature: request reply"],
    [(c) => c.commands.find((v) => v.command === "agent show here").arguments.push({ name: "caller", value: { type: "text" } }), "unsupported command signature: agent show here"],
    [(c) => c.commands.find((v) => v.command === "agent show here").answers = ["agent_list"], "unsupported command signature: agent show here"],
    [(c) => delete c.commands.find((v) => v.command === "agent show here").refusals, "missing or unsupported refusals: agent show here"],
    [(c) => c.commands.find((v) => v.command === "agent show here").refusals = ["new_refusal"], "missing or unsupported refusals: agent show here"],
    [(c) => c.answers.agent_list.definitions.Runtime.enum.push("new-runtime"), "missing or unsupported answer schema: agent_list"],
    [(c) => c.envelopes.agent.answer = "result", "unsupported response envelope: agent"],
    [(c) => c.answers.letter.type = "array", "missing or unsupported answer schema: letter"],
    [(c) => c.answers.inbox = { $ref: "#/definitions/Loop", definitions: { Loop: { $ref: "#/definitions/Loop" } } }, "missing or unsupported answer schema: inbox"],
  ]) {
    const contract = structuredClone(published);
    mutate(contract);
    const report = compareHideContract(version, contract);
    assert.equal(report.compatible, false, issue);
    assert.ok(report.issues.includes(issue), issue);
  }
  for (const code of published.commands.find((entry) => entry.command === "agent show here").refusals) {
    const contract = structuredClone(published);
    const caller = contract.commands.find((entry) => entry.command === "agent show here");
    caller.refusals = caller.refusals.filter((value) => value !== code);
    const report = compareHideContract(version, contract);
    assert.equal(report.compatible, false, `required refusal ${code} cannot disappear`);
    assert.ok(report.issues.includes("missing or unsupported refusals: agent show here"));
  }
});

test("missing provenance, unknown format and mixed version/contract builds fail explicitly", () => {
  assert.equal(compareHideContract({ version: "0.1.0" }, published).code, "HIDE_VERSION_INVALID");
  assert.equal(compareHideContract(version, { ...published, format: 2 }).code, "HIDE_CONTRACT_UNSUPPORTED");
  assert.equal(compareHideContract(version, { ...published, digest: `sha256:${"b".repeat(64)}` }).code, "HIDE_CONTRACT_INVALID");
  assert.equal(compareHideContract(version, null).code, "HIDE_CONTRACT_INVALID");
});

test("doctor reports installed build and compatibility using only a private executable", (t) => {
  const root = scratchDir("sasu-hide-contract-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "hide");
  fs.writeFileSync(binary, `#!${process.execPath}\nif (process.env.HIDE_CAP_REF) process.exit(9);\nconsole.log(JSON.stringify(process.argv[2] === "version" ? ${JSON.stringify(version)} : ${JSON.stringify(published)}));\n`, { mode: 0o755 });
  const report = inspectHideCompatibility({ binary, env: { ...process.env, HIDE_CAP_REF: "private-test-value" } });
  assert.equal(report.compatible, true);
  const section = runDoctor(root, { hideBinary: binary, home: root }).sections.find((s) => s.section === "contract");
  assert.equal(section.ok, true);
  assert.deepEqual(section.hide.installed, version);
  assert.match(section.lines.join("\n"), /Hide compatibility: HIDE_COMPATIBLE/);
  assert.match(section.lines.join("\n"), new RegExp(version.commit));
  assert.equal(inspectHideCompatibility({ binary: path.join(root, "missing") }).code, "HIDE_MISSING");
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.error("private-test-value"); process.exit(2);\n`);
  const failed = inspectHideCompatibility({ binary });
  assert.equal(failed.code, "HIDE_QUERY_FAILED");
  assert.equal(JSON.stringify(failed).includes("private-test-value"), false);
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log("not JSON");\n`);
  assert.equal(inspectHideCompatibility({ binary }).code, "HIDE_VERSION_INVALID");
});
