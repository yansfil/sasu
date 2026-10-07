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
const published = JSON.parse(fs.readFileSync(new URL("../fixtures/hide-contract/published-0.1.0.json", import.meta.url), "utf8"));
const version = { version: "0.1.0", commit: "72c2113f29b74d60897e62c33031f32a977c6118", contract: published.digest };
const baselineIssues = [
  "caller contract unpublished: agent show here",
  "missing or unsupported answer schema: agent",
  "missing or unsupported answer schema: agent_list",
];

test("published Hide contract discloses the missing caller, nullable-field and runtime-enum guarantees", () => {
  const report = compareHideContract(version, published);
  assert.equal(report.compatible, false);
  assert.equal(report.code, "HIDE_CONTRACT_UNSUPPORTED");
  assert.deepEqual(report.installed, version);
  assert.deepEqual(report.issues, baselineIssues);
});

test("compatible additions and version changes add no new incompatibility", () => {
  const contract = structuredClone(published);
  contract.commands.push({ command: "future command" });
  contract.commands.find((entry) => entry.command === "agent spawn").options.push({ name: "--future", value: null, required: false, requires: [] });
  contract.answers.agent.properties.future = { type: "string" };
  assert.deepEqual(compareHideContract({ ...version, version: "2.3.4" }, contract).issues, baselineIssues);
  // The exporter may narrow a nullable field to string, but it must guarantee
  // the field's presence because the current consumer rejects undefined.
  for (const schema of [contract.answers.agent, contract.answers.agent_list.definitions.AgentView]) {
    schema.required.push("parent", "project");
    schema.properties.runtime.enum = ["running", "ended"];
  }
  assert.deepEqual(compareHideContract(version, contract).issues, [baselineIssues[0]]);
  const missingField = structuredClone(contract);
  missingField.answers.agent.required = missingField.answers.agent.required.filter((name) => name !== "parent");
  assert.ok(compareHideContract(version, missingField).issues.includes(baselineIssues[1]));
  contract.answers.agent.properties.runtime.enum.push("unknown-runtime");
  assert.ok(compareHideContract(version, contract).issues.includes(baselineIssues[1]));
});

test("breaking signatures, envelopes and answer fields are reported structurally", () => {
  for (const [mutate, issue] of [
    [(c) => c.commands.find((v) => v.command === "agent spawn").options.find((v) => v.name === "--path").value.type = "unsigned", "unsupported command signature: agent spawn"],
    [(c) => c.commands.find((v) => v.command === "agent list").options.push({ name: "--new-required", value: { type: "text" }, required: true, requires: [] }), "unsupported command signature: agent list"],
    [(c) => c.commands.find((v) => v.command === "request send").options.find((v) => v.name === "--kind").value.values = ["request"], "unsupported command signature: request send"],
    [(c) => c.commands.find((v) => v.command === "request reply").arguments.push({ name: "extra", value: { type: "key" } }), "unsupported command signature: request reply"],
    [(c) => c.envelopes.agent.answer = "result", "unsupported response envelope: agent"],
    [(c) => c.answers.letter.type = "array", "missing or unsupported answer schema: letter"],
    [(c) => c.answers.inbox = { $ref: "#/definitions/Loop", definitions: { Loop: { $ref: "#/definitions/Loop" } } }, "missing or unsupported answer schema: inbox"],
  ]) {
    const contract = structuredClone(published);
    mutate(contract);
    assert.ok(compareHideContract(version, contract).issues.includes(issue), issue);
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
  assert.deepEqual(report.issues, baselineIssues);
  const section = runDoctor(root, { hideBinary: binary, home: root }).sections.find((s) => s.section === "contract");
  assert.equal(section.ok, false);
  assert.deepEqual(section.hide.installed, version);
  assert.match(section.lines.join("\n"), /Hide compatibility: HIDE_CONTRACT_UNSUPPORTED/);
  assert.match(section.lines.join("\n"), new RegExp(version.commit));
  assert.equal(inspectHideCompatibility({ binary: path.join(root, "missing") }).code, "HIDE_MISSING");
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.error("private-test-value"); process.exit(2);\n`);
  const failed = inspectHideCompatibility({ binary });
  assert.equal(failed.code, "HIDE_QUERY_FAILED");
  assert.equal(JSON.stringify(failed).includes("private-test-value"), false);
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log("not JSON");\n`);
  assert.equal(inspectHideCompatibility({ binary }).code, "HIDE_VERSION_INVALID");
});
