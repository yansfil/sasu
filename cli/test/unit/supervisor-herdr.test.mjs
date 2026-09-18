import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { getAgent, guardedPromptSupport, promptAgent } from "../../dist/implement/herdr.js";

// The shapes below are herdr 0.9.1's answers as measured 2026-09-18, and
// the guarded shapes are the fork's (modakbul-gongbang/herdr#3), the same
// ones Task Factory's adapter was written against.
const INFO = JSON.stringify({ id: "cli:agent:get", result: { type: "agent_info", agent: {
  agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "d8a008dd-2af7-4791-8dfd-1184746de089" },
  agent_status: "idle", pane_id: "w8D:p1", revision: 113, state_change_seq: 67, terminal_id: "term_65bba8f3ff55f24", tokens: { activity: "1789706907560", elapsed: "1m" }, workspace_id: "w8D",
} } });
const NOT_FOUND = JSON.stringify({ error: { code: "agent_not_found", message: "agent target w99:p99 not found" }, id: "cli:agent:get" });

test("agent get is parsed into identity, lifecycle and the epoch activity herdr sends as a string", () => {
  const looked = getAgent("w8D:p1", { run: () => ({ status: 0, stdout: INFO, stderr: "" }) });
  assert.equal(looked.kind, "found");
  assert.deepEqual(looked.agent, { paneId: "w8D:p1", name: null, kind: "claude", sessionId: "d8a008dd-2af7-4791-8dfd-1184746de089", terminalId: "term_65bba8f3ff55f24", status: "idle", activityAt: 1789706907560, stateChangeSeq: 67, inputGuard: null });
});

test("agent get distinguishes an empty target from a herdr that is not answering", () => {
  const asked = [];
  const absent = getAgent("w99:p99", { run: (args) => { asked.push(args); return { status: 1, stdout: "", stderr: NOT_FOUND }; } });
  assert.equal(absent.kind, "absent");
  assert.deepEqual(asked, [["agent", "get", "w99:p99"]]);
  const down = getAgent("w99:p99", { run: () => ({ status: 1, stdout: "", stderr: "error: failed to connect" }) });
  assert.equal(down.kind, "unavailable");
  const spawnFailed = getAgent("w99:p99", { run: () => ({ status: null, stdout: "", stderr: "ENOENT" }) });
  assert.equal(spawnFailed.kind, "unavailable");
  const garbage = getAgent("w8D:p1", { run: () => ({ status: 0, stdout: "{}", stderr: "" }) });
  assert.equal(garbage.kind, "unavailable", "a success without an agent_info record proves nothing");
  const unknownStatus = getAgent("w8D:p1", { run: () => ({ status: 0, stdout: INFO.replace('"idle"', '"resting"'), stderr: "" }) });
  assert.equal(unknownStatus.agent.status, "unknown", "a status outside herdr's enum is unknown, never a guess");
});

test("agent get does not need HERDR_ENV: the tick runs under launchd with no herdr variables", () => {
  const looked = getAgent("w8D:p1", { env: {}, run: () => ({ status: 0, stdout: INFO, stderr: "" }) });
  assert.equal(looked.kind, "found");
});

test("a plain wake is accepted on exit 0 and reported rejected on herdr's pre-input refusals", () => {
  const asked = [];
  const sent = promptAgent({ target: "w8D:p1", text: "SASU_WAKE", expectedInputGuard: null }, { run: (args) => { asked.push(args); return { status: 0, stdout: "{}", stderr: "" }; } });
  assert.deepEqual(asked, [["agent", "prompt", "w8D:p1", "SASU_WAKE"]]);
  assert.deepEqual(sent, { outcome: "accepted", path: "session-match", code: "submitted", detail: "herdr submitted the wake" });
  for (const code of ["agent_not_found", "agent_blocked", "agent_not_ready"]) {
    const refused = promptAgent({ target: "w8D:p1", text: "x", expectedInputGuard: null }, { run: () => ({ status: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: code } }) }) });
    assert.equal(refused.outcome, "rejected", code);
    assert.equal(refused.code, code);
  }
  const timedOut = promptAgent({ target: "w8D:p1", text: "x", expectedInputGuard: null }, { run: () => ({ status: null, stdout: "", stderr: "timeout" }) });
  assert.equal(timedOut.outcome, "unknown", "a timeout may have delivered bytes");
  assert.equal(timedOut.code, "herdr_prompt_timeout");
});

test("B11: a guarded wake carries the guard, needs the submitted acknowledgement, and never falls back to the plain path", () => {
  const asked = [];
  const guarded = promptAgent({ target: "w8D:p1", text: "SASU_WAKE", expectedInputGuard: "g-77" }, { run: (args) => { asked.push(args); return { status: 0, stdout: JSON.stringify({ result: { outcome: "submitted" } }), stderr: "" }; } });
  assert.deepEqual(asked, [["agent", "prompt", "w8D:p1", "SASU_WAKE", "--expected-input-guard", "g-77"]]);
  assert.equal(guarded.outcome, "accepted");
  assert.equal(guarded.path, "guarded");

  const mismatch = promptAgent({ target: "w8D:p1", text: "x", expectedInputGuard: "g-77" }, { run: () => ({ status: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_input_guard_mismatch", message: "guard changed" } }) }) });
  assert.deepEqual({ outcome: mismatch.outcome, code: mismatch.code, path: mismatch.path }, { outcome: "rejected", code: "agent_input_guard_mismatch", path: "guarded" });

  // herdr 0.9.1 exactly: exit 2, "unknown option", nothing sent (measured 2026-09-18).
  const calls = [];
  const unsupported = promptAgent({ target: "w8D:p1", text: "x", expectedInputGuard: "g-77" }, { run: (args) => { calls.push(args); return { status: 2, stdout: "", stderr: "unknown option: --expected-input-guard\n" }; } });
  assert.deepEqual({ outcome: unsupported.outcome, code: unsupported.code }, { outcome: "rejected", code: "guarded_prompt_unsupported" });
  assert.match(unsupported.detail, /none will be sent unguarded/);
  assert.equal(calls.length, 1, "no second, unguarded attempt");

  const noAck = promptAgent({ target: "w8D:p1", text: "x", expectedInputGuard: "g-77" }, { run: () => ({ status: 0, stdout: "{}", stderr: "" }) });
  assert.equal(noAck.outcome, "unknown");
});

test("guarded prompt support is read from herdr's own help", () => {
  assert.deepEqual(guardedPromptSupport({ run: () => ({ status: 0, stdout: "Options:\n  --expected-input-guard <G>\n", stderr: "" }) }), { supported: true, detail: null });
  assert.deepEqual(guardedPromptSupport({ run: () => ({ status: 0, stdout: "Options:\n  --wait\n", stderr: "" }) }), { supported: false, detail: null });
  assert.equal(guardedPromptSupport({ run: () => ({ status: 1, stdout: "", stderr: "down" }) }).supported, null);
});

const binaryProbe = spawnSync("herdr", ["--version"], { encoding: "utf8", timeout: 15_000 });
const noHerdr = binaryProbe.error?.code === "ENOENT";

// Read-only against the installed herdr: a target nobody owns answers the
// measured `agent_not_found` shape, and no live pane is addressed.
test("the installed herdr answers agent get on an unowned target with the shape this adapter parses", { skip: noHerdr ? "herdr is not installed" : false }, () => {
  const looked = getAgent("w99:p99");
  assert.ok(looked.kind === "absent" || looked.kind === "unavailable", looked.detail ?? "");
  if (looked.kind === "absent") assert.match(looked.detail, /no agent at w99:p99/);
  const help = spawnSync("herdr", ["agent", "prompt", "--help"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("<TEXT>"), "agent prompt still takes the text as a positional argument");
});
