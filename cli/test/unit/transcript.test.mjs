import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractTranscriptTurns,
  inspectTranscript,
  latestHumanRef,
  locateTranscript,
  resolveCurrentTranscript,
} from "../../dist/interview/transcript.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sasu-transcript-"));
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

test("Codex extraction pairs only the last visible completed assistant text with the next human input", async () => {
  const dir = tempDir();
  const file = writeJsonl(path.join(dir, "codex.jsonl"), [
    { type: "session_meta", payload: { id: "codex-1" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u0", content: [{ type: "input_text", text: "begin" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a-comment", content: [{ type: "output_text", text: "잠깐 확인할게요." }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call-1" } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a1", content: [{ type: "output_text", text: "첫 질문인가요?" }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "developer", id: "d1", content: [{ type: "input_text", text: "ignore me" }] } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "첫 답입니다." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a2", content: [{ type: "output_text", text: "둘째 질문인가요?" }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u2", content: [{ type: "input_text", text: "둘째 답입니다." }] } },
  ]);
  const identity = await inspectTranscript(file);
  assert.deepEqual(identity, { runtime: "codex", sessionId: "codex-1", file });
  const turns = await extractTranscriptTurns(identity, "u0");
  assert.deepEqual(turns.map(({ asked, answer, sourceRef }) => ({ asked, answer, sourceRef })), [
    { asked: "첫 질문인가요?", answer: "첫 답입니다.", sourceRef: "codex:codex-1:u1" },
    { asked: "둘째 질문인가요?", answer: "둘째 답입니다.", sourceRef: "codex:codex-1:u2" },
  ]);
  assert.equal(await latestHumanRef(identity), "u2");
});

test("Claude extraction ignores tool results and sidechains", async () => {
  const dir = tempDir();
  const file = writeJsonl(path.join(dir, "claude.jsonl"), [
    { type: "last-prompt", sessionId: "claude-1" },
    { type: "user", uuid: "u0", isSidechain: false, message: { role: "user", content: "begin" } },
    { type: "assistant", uuid: "a-tool", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1" }] } },
    { type: "user", uuid: "tool-result", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "noise" }] } },
    { type: "assistant", uuid: "side-a", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "side question" }] } },
    { type: "system", subtype: "turn_duration", uuid: "side-done", isSidechain: true },
    { type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Claude 질문인가요?" }] } },
    { type: "system", subtype: "turn_duration", uuid: "done-1", isSidechain: false },
    { type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "Claude 답입니다." } },
  ]);
  const identity = await inspectTranscript(file);
  const turns = await extractTranscriptTurns(identity, "u0");
  assert.deepEqual(turns.map(({ asked, answer, sourceRef }) => ({ asked, answer, sourceRef })), [
    { asked: "Claude 질문인가요?", answer: "Claude 답입니다.", sourceRef: "claude:claude-1:u1" },
  ]);
});

test("Codex ignores injected user-role context when selecting boundaries and answers", async () => {
  const dir = tempDir();
  const file = writeJsonl(path.join(dir, "codex-injections.jsonl"), [
    { type: "session_meta", payload: { id: "codex-injections" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        id: "runtime-agents",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>runtime only</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context>injected</environment_context>" },
        ],
      },
    },
    { type: "response_item", payload: { type: "message", role: "user", id: "invocation", content: [{ type: "input_text", text: "실제 인터뷰 요청" }] } },
    { type: "response_item", payload: { type: "message", role: "user", id: "runtime-skill", content: [{ type: "input_text", text: "<skill>injected skill</skill>" }] } },
  ]);
  const identity = await inspectTranscript(file);
  assert.equal(await latestHumanRef(identity), "invocation");
  const later = [
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a1", content: [{ type: "output_text", text: "실제 질문인가요?" }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "runtime-env", content: [{ type: "input_text", text: "<environment_context>later injection</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", id: "answer", content: [{ type: "input_text", text: "실제 답입니다." }] } },
  ];
  fs.appendFileSync(file, `${later.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const turns = await extractTranscriptTurns(identity, "invocation");
  assert.deepEqual(turns.map(({ asked, answer, sourceRef }) => ({ asked, answer, sourceRef })), [
    { asked: "실제 질문인가요?", answer: "실제 답입니다.", sourceRef: "codex:codex-injections:answer" },
  ]);
});

test("Claude ignores compact and local-command records stored as user messages", async () => {
  const dir = tempDir();
  const file = writeJsonl(path.join(dir, "claude-synthetic.jsonl"), [
    { type: "last-prompt", sessionId: "claude-synthetic" },
    { type: "user", uuid: "u0", isSidechain: false, message: { role: "user", content: "begin" } },
    { type: "assistant", uuid: "a1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "질문인가요?" }] } },
    { type: "system", subtype: "turn_duration", uuid: "done-1", isSidechain: false },
    { type: "user", uuid: "compact", isSidechain: false, isCompactSummary: true, message: { role: "user", content: "Earlier conversation summary" } },
    { type: "user", uuid: "command", isSidechain: false, message: { role: "user", content: "<command-name>/compact</command-name>" } },
    { type: "user", uuid: "stdout", isSidechain: false, message: { role: "user", content: "<local-command-stdout>done</local-command-stdout>" } },
    { type: "user", uuid: "interrupted", isSidechain: false, message: { role: "user", content: "[Request interrupted by user for tool use]" } },
    { type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "실제 답입니다." } },
  ]);
  const identity = await inspectTranscript(file);
  assert.equal(await latestHumanRef(identity), "u1");
  const turns = await extractTranscriptTurns(identity, "u0");
  assert.deepEqual(turns.map(({ asked, answer, sourceRef }) => ({ asked, answer, sourceRef })), [
    { asked: "질문인가요?", answer: "실제 답입니다.", sourceRef: "claude:claude-synthetic:u1" },
  ]);
});

test("completed-turn marker drift fails instead of silently returning no turns", async () => {
  const dir = tempDir();
  const file = writeJsonl(path.join(dir, "codex-no-completion.jsonl"), [
    { type: "session_meta", payload: { id: "codex-no-completion" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u0", content: [{ type: "input_text", text: "begin" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", id: "a1", content: [{ type: "output_text", text: "question" }] } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "answer" }] } },
  ]);
  const identity = await inspectTranscript(file);
  await assert.rejects(() => extractTranscriptTurns(identity, "u0"), /no completed turn boundary/);
});

test("transcript discovery is exact and missing boundaries fail explicitly", async () => {
  const home = tempDir();
  const file = writeJsonl(path.join(home, ".codex", "sessions", "2026", "rollout-codex-2.jsonl"), [
    { type: "session_meta", payload: { id: "codex-2" } },
    { type: "response_item", payload: { type: "message", role: "user", id: "u0", content: [{ type: "input_text", text: "begin" }] } },
  ]);
  assert.equal((await locateTranscript("codex", "codex-2", home)).file, file);
  assert.equal((await resolveCurrentTranscript({ sessionId: "codex-2", homeDir: home })).file, file);
  await assert.rejects(
    () => resolveCurrentTranscript({ transcriptPath: file, sessionId: "different-session" }),
    /belongs to session codex-2, expected different-session/,
  );
  await assert.rejects(
    () => extractTranscriptTurns({ runtime: "codex", sessionId: "codex-2", file }, "missing"),
    /start boundary missing was not found/,
  );
});
