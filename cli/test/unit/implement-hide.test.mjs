import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { HIDE_MISSING, HideCallFailed, assertNotImplementor, assertObserverForRun, listParticipants, runHide } from "../../dist/implement/hide.js";
import { DispatchRejected, buildImplementorPrompt, buildSpawnInstruction } from "../../dist/implement/dispatch.js";
import { installFakeHide } from "../helpers/hide-binary.mjs";

const projectRoot = "/fixture/project";
const observer = { id: "observer", name: "observer", machine: "local", hostScope: "/fixture/herdr.sock", pane: "w1:p1", parent: "lead", project: projectRoot, runtime: "running", registered: true };
const child = { ...observer, id: "child", name: "fixture-worker", pane: "w1:p2", parent: observer.id };
const role = { implementorName: child.name, projectRoot };
const gate = [role, { implementorName: "fixture-advisor", projectRoot }];
function fixture(t, items = [observer, child]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hide-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hide = installFakeHide(root);
  fs.writeFileSync(hide.state, JSON.stringify({ seq: 0, participants: Object.fromEntries(items.map((p) => [p.id, p])), spawns: {} }));
  return { ...hide, root, env: { ...hide.env, HERDR_ENV: "1", HERDR_PANE_ID: observer.pane, HERDR_SOCKET_PATH: observer.hostScope } };
}
function response(t, answer) {
  const hide = fixture(t);
  fs.writeFileSync(path.join(hide.bin, "hide"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(hide.log)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.stdout.write(${JSON.stringify(JSON.stringify(answer))});\n`, { mode: 0o755 });
  return hide;
}
const refusal = (code) => (error) => error instanceof HideCallFailed && error.code === code;

test("missing Hide refuses without falling back to another executable", (t) => {
  const { root } = fixture(t);
  assert.throws(() => runHide(["agent", "list"], { PATH: root }), (error) => refusal("not_installed")(error) && error.message === HIDE_MISSING);
});
test("every Hide call bootstraps authority and preserves the caller environment", (t) => {
  const { env } = fixture(t);
  env.HIDE_CAP_REF = "expired-fixture-credential";
  assert.equal(listParticipants(env).length, 2);
  assert.equal(env.HIDE_CAP_REF, "expired-fixture-credential");
});
test("a lead-parented Observer retains run authority across native session changes", (t) => {
  const { env, argv } = fixture(t, [{ ...observer, session: "new-session", instance: "new-terminal" }, child]);
  assert.doesNotThrow(() => assertObserverForRun(role, env));
  assert.doesNotThrow(() => assertNotImplementor(gate, { ...env, SASU_HERDR_ROLE: "implementor" }));
  assert.deepEqual(argv(), [["agent", "show", "here"], ["agent", "list"], ["agent", "show", "here"]]);
});
test("caller roles work without a renderer and never query workspace info", (t) => {
  const { env } = fixture(t);
  const headless = { ...env, HIDE_FAKE_RENDERER_DOWN: "1" };
  assert.doesNotThrow(() => assertObserverForRun(role, headless));
  assert.throws(() => assertNotImplementor(gate, { ...headless, HERDR_PANE_ID: child.pane }), refusal("observer_required"));
});
test("role checks consume the caller answer independently of display environment", (t) => {
  const { env } = fixture(t);
  assert.throws(() => assertNotImplementor(gate, { ...env, HIDE_FAKE_CALLER_ID: child.id }), refusal("observer_required"));
  assert.doesNotThrow(() => assertObserverForRun(role, { ...env, HIDE_FAKE_CALLER_ID: observer.id, HERDR_PANE_ID: "old-pane", HERDR_SOCKET_PATH: undefined }));
  for (const code of ["participant_unavailable", "participant_ended", "ambiguous_participant"]) {
    assert.throws(() => assertObserverForRun(role, { ...env, HIDE_FAKE_CALLER_ERROR: code }), refusal(code));
  }
});
test("run children and advisors cannot invoke Observer commands regardless of old role markers", (t) => {
  const advisor = { ...child, id: "advisor", name: "fixture-advisor", pane: "w1:p3" };
  const { env } = fixture(t, [observer, child, advisor]);
  assert.throws(() => assertObserverForRun(role, { ...env, HERDR_PANE_ID: child.pane, SASU_HERDR_ROLE: "observer" }), refusal("observer_required"));
  for (const pane of [child.pane, advisor.pane]) assert.throws(() => assertNotImplementor(gate, { ...env, HERDR_PANE_ID: pane }), refusal("observer_required"));
});
test("a matching name in another project does not identify this run child", (t) => {
  const { env, root, state } = fixture(t);
  const another = path.join(root, "another-project");
  fs.mkdirSync(another);
  fs.writeFileSync(state, JSON.stringify({ participants: { observer: { ...observer, name: child.name, project: another } } }));
  assert.doesNotThrow(() => assertNotImplementor([{ implementorName: child.name, projectRoot: root }], env));
});
test("a symlink checkout cannot hide a run child's role", (t) => {
  const { env, root, state } = fixture(t);
  const actual = path.join(root, "actual"), alias = path.join(root, "alias");
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias);
  fs.writeFileSync(state, JSON.stringify({ participants: { child: { ...child, project: actual } } }));
  assert.throws(() => assertNotImplementor([{ implementorName: child.name, projectRoot: alias }], { ...env, HERDR_PANE_ID: child.pane }), refusal("observer_required"));
  fs.unlinkSync(alias);
  assert.throws(() => assertNotImplementor([{ implementorName: child.name, projectRoot: alias }], { ...env, HERDR_PANE_ID: child.pane }), refusal("project_identity_required"));
});
test("connected-device roles use Hide caller context rather than a guessed socket scope", (t) => {
  const device = "mini";
  const remoteObserver = { ...observer, machine: device, hostScope: device };
  const remoteChild = { ...child, machine: device, hostScope: device };
  const { env } = fixture(t, [remoteObserver, remoteChild, { ...observer, id: "foreign-observer", hostScope: device }]);
  const remoteEnv = { ...env, HIDE_FAKE_DEVICE: device, HERDR_SOCKET_PATH: "/remote/native/herdr.sock" };
  assert.doesNotThrow(() => assertObserverForRun(role, remoteEnv));
  assert.throws(() => assertNotImplementor(gate, { ...remoteEnv, HERDR_PANE_ID: child.pane }), refusal("observer_required"));
});
test("cross-device pane and socket collisions require attestation and cannot select a local Observer", (t) => {
  const device = "mini";
  const remoteChild = { ...child, machine: device, hostScope: device };
  const { env } = fixture(t, [{ ...observer, pane: child.pane }, remoteChild]);
  const remoteEnv = { ...env, HERDR_PANE_ID: child.pane, HIDE_FAKE_DEVICE: device };
  assert.throws(() => assertNotImplementor(gate, remoteEnv), refusal("observer_required"));
  assert.throws(() => assertNotImplementor(gate, { ...remoteEnv, HIDE_FAKE_RENDERER_DOWN: "1" }), refusal("observer_required"));
  assert.doesNotThrow(() => assertNotImplementor(gate, { ...remoteEnv, HIDE_FAKE_DEVICE: "local" }));
});
test("an absent or inactive remote registration cannot borrow a colliding local row or inherited session", (t) => {
  const device = "mini";
  const local = { ...observer, session: "inherited-parent-session" };
  const remote = { ...observer, id: "remote-observer", machine: device, hostScope: device, session: "current-remote-session" };
  const { env, state } = fixture(t, [local]);
  const remoteEnv = { ...env, HIDE_FAKE_DEVICE: device, CODEX_THREAD_ID: local.session, CLAUDE_SESSION_ID: remote.session };
  for (const inactive of [[], [{ ...remote, registered: false }], [{ ...remote, runtime: "ended" }]]) {
    const items = [local, ...inactive];
    fs.writeFileSync(state, JSON.stringify({ participants: Object.fromEntries(items.map((p) => [p.id, p])) }));
    assert.throws(() => assertNotImplementor(gate, remoteEnv), refusal("native_identity_required"));
    assert.throws(() => assertObserverForRun(role, { ...remoteEnv, HIDE_FAKE_RENDERER_DOWN: "1" }), refusal("native_identity_required"));
  }
});
test("a connected-device caller response works without a local socket or renderer", (t) => {
  const device = "mini";
  const { env } = fixture(t, [{ ...observer, machine: device, hostScope: device }]);
  assert.doesNotThrow(() => assertObserverForRun({ projectRoot }, { ...env, HIDE_FAKE_DEVICE: device, HIDE_FAKE_RENDERER_DOWN: "1" }));
  assert.doesNotThrow(() => assertObserverForRun({ projectRoot }, { ...env, HIDE_FAKE_DEVICE: device, HERDR_SOCKET_PATH: undefined }));
});
test("another parent cannot dispatch into an existing run child", (t) => {
  const { env } = fixture(t, [observer, { ...child, parent: "another-observer" }]);
  assert.throws(() => assertObserverForRun(role, env), refusal("observer_required"));
});
test("same-name children on other devices or host scopes cannot block local lineage", (t) => {
  for (const project of [projectRoot, "/remote/path/that/is/not/local"]) {
    const foreign = { ...child, id: "foreign", machine: "mini", hostScope: "mini", parent: "remote-observer", project };
    const otherHost = { ...foreign, id: "other-host", machine: "local", hostScope: "/other/herdr.sock" };
    const { env } = fixture(t, [observer, child, foreign, otherHost]);
    assert.doesNotThrow(() => assertObserverForRun(role, env));
  }
  const { env } = fixture(t, [observer, child, { ...child, id: "duplicate" }]);
  assert.throws(() => assertObserverForRun(role, env), refusal("parent_identity_required"));
});
test("pane identity is scoped by host and ambiguous live registrations fail closed", (t) => {
  const { env, state } = fixture(t, [{ ...observer, hostScope: "/other-machine/herdr.sock" }]);
  assert.throws(() => assertObserverForRun(role, env), refusal("native_identity_required"));
  fs.writeFileSync(state, JSON.stringify({ participants: { one: observer, two: { ...observer, id: "other-registration" } } }));
  assert.throws(() => assertNotImplementor(gate, env), refusal("native_identity_required"));
});
test("missing, ended and unregistered managed callers cannot grant authority", (t) => {
  const { env, state } = fixture(t);
  for (const items of [[], [{ ...observer, registered: false }], [{ ...observer, runtime: "ended" }]]) {
    fs.writeFileSync(state, JSON.stringify({ participants: Object.fromEntries(items.map((p) => [p.id, p])) }));
    assert.throws(() => assertNotImplementor(gate, env), refusal("native_identity_required"));
  }
  assert.throws(() => assertObserverForRun(role, { ...env, HERDR_SOCKET_PATH: undefined }), refusal("native_identity_required"));
});
test("unmanaged gates remain deterministic while dispatch requires managed authority", (t) => {
  const { env, argv } = fixture(t);
  const unmanaged = { ...env, HERDR_ENV: undefined, HERDR_PANE_ID: undefined };
  assert.doesNotThrow(() => assertNotImplementor(gate, unmanaged));
  assert.equal(argv().length, 0);
  assert.throws(() => assertObserverForRun(role, unmanaged), refusal("native_identity_required"));
});
test("an inactive positive caller answer is refused before consulting other participants", (t) => {
  for (const value of [{ ...observer, runtime: "ended" }, { ...observer, registered: false }]) {
    const { env, argv } = response(t, { ok: true, value });
    assert.throws(() => assertObserverForRun(role, env), refusal("caller_identity_required"));
    assert.deepEqual(argv(), [["agent", "show", "here"]]);
  }
});
test("malformed positive public responses never grant authority", (t) => {
  const hide = response(t, { ok: true, value: { items: [{ id: "observer", name: "observer" }] } });
  assert.throws(() => assertObserverForRun(role, hide.env), refusal("invalid_response"));
});
test("Hide refusals remain actionable and retain the public failure code", (t) => {
  const { env } = fixture(t);
  assert.throws(() => assertObserverForRun(role, { ...env, HIDE_FAKE_DOWN: "1" }), (error) => refusal("delivery_unavailable")(error) && /retry from the current agent pane/.test(error.message));
});

const launch = { intent: "sasu:fixture:implementor", name: child.name, repo: projectRoot, branch: "work/fixture", path: projectRoot, promptPath: `${projectRoot}/agents/runs/fixture/implementor-prompt.md` };
test("dispatch only generates a stable command with a short native first prompt and high default effort", (t) => {
  const { argv } = fixture(t);
  const first = buildSpawnInstruction(launch), retry = buildSpawnInstruction(launch);
  assert.deepEqual(first, retry);
  assert.deepEqual(argv(), [], "generating instructions cannot create a child or register a participant");
  assert.equal(first.effort, "high");
  assert.match(first.command, /^env -u HIDE_CAP_REF hide /);
  assert.deepEqual(first.argv.slice(0, 4), ["agent", "spawn", "--parent", "here"]);
  assert.deepEqual(first.argv.slice(-4), ["--effort", "high", "--", first.prompt]);
  assert.equal(first.prompt, `Read ${JSON.stringify(launch.promptPath)} and carry out the assigned work.`);
  const codex = buildSpawnInstruction({ ...launch, kind: "codex", model: "chosen-model", effort: "xhigh" });
  assert.deepEqual(codex.argv.slice(-6), ["--model", "chosen-model", "--config", 'model_reasoning_effort="xhigh"', "--", codex.prompt]);
});
test("executing the printed shell command preserves literal inputs and retries the same child", (t) => {
  const hide = fixture(t, [observer]);
  const marker = path.join(hide.root, "must-not-exist");
  const special = `${projectRoot}/it's literal $(touch ${marker}) \`touch ${marker}\``;
  const instruction = buildSpawnInstruction({ ...launch, promptPath: `${special}/prompt.md`, path: special, model: "a'model" });
  const execute = () => spawnSync("/bin/sh", ["-c", instruction.command], { encoding: "utf8", env: { ...hide.env, HIDE_CAP_REF: "expired-fixture-credential" } });
  const first = execute(), retry = execute();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(first.stdout).value.id, JSON.parse(retry.stdout).value.id);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(hide.argv(), [instruction.argv, instruction.argv]);
  const conflict = buildSpawnInstruction({ ...launch, path: special, promptPath: `${special}/changed.md`, model: "a'model" });
  const refused = spawnSync("/bin/sh", ["-c", conflict.command], { encoding: "utf8", env: hide.env });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "intent_conflict");
});
test("fixed handoff guidance preserves the complete packet outside native launch arguments", () => {
  const handoff = "AUTHORITY: implement the approved behavior\n" + "complete original context\n".repeat(1000);
  const prompt = buildImplementorPrompt({ slug: "fixture", prdPath: "/fixture/approved.md", statePath: "/fixture/agents/runs/fixture/state.json", handoff });
  assert.ok(prompt.includes(handoff.trim()));
  assert.match(prompt, /Run: fixture/);
  assert.match(prompt, /Approved PRD: \/fixture\/approved\.md/);
  assert.match(prompt, /Do not spawn an Implementor or advisor/);
  assert.match(prompt, /hide request send --kind block/);
  assert.match(prompt, /hide request send --kind report/);
  assert.match(prompt, /sasu implement verify on the final committed head/);
  assert.throws(() => buildImplementorPrompt({ slug: "fixture", prdPath: "/fixture/approved.md", statePath: "/fixture/state.json", handoff: "  " }), DispatchRejected);
});
test("invalid launch input is refused before producing a command", () => {
  for (const change of [{ name: "" }, { intent: "bad\nintent" }, { promptPath: "relative.md" }, { kind: "unsupported" }, { effort: "" }]) {
    assert.throws(() => buildSpawnInstruction({ ...launch, ...change }), DispatchRejected);
  }
});
