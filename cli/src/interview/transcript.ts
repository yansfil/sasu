import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { currentSessionId } from "../runs/session";

export type TranscriptRuntime = "claude" | "codex";

export interface TranscriptIdentity {
  runtime: TranscriptRuntime;
  sessionId: string;
  file: string;
}

export interface TranscriptBinding {
  runtime: TranscriptRuntime;
  sessionId: string;
  startRef: string;
}

export interface TranscriptTurn {
  asked: string;
  answer: string;
  sourceRef: string;
}

export interface ResolveTranscriptOptions {
  transcriptPath?: string;
  sessionId?: string | null;
  homeDir?: string;
}

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

async function* jsonRecords(file: string): AsyncGenerator<JsonRecord> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`transcript JSON is invalid at ${path.basename(file)}:${lineNumber}`);
      }
      const record = objectValue(parsed);
      if (record === null) {
        throw new Error(`transcript record is not an object at ${path.basename(file)}:${lineNumber}`);
      }
      yield record;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function firstJsonRecord(file: string): Promise<JsonRecord> {
  for await (const record of jsonRecords(file)) return record;
  throw new Error(`transcript is empty: ${file}`);
}

export async function inspectTranscript(file: string): Promise<TranscriptIdentity> {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`transcript not found: ${resolved}`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`transcript is not a file: ${resolved}`);
  const first = await firstJsonRecord(resolved);
  if (first["type"] === "session_meta") {
    const payload = objectValue(first["payload"]);
    const sessionId = stringValue(payload?.["id"] ?? payload?.["session_id"]);
    if (sessionId === null) throw new Error(`Codex transcript is missing its session id: ${resolved}`);
    return { runtime: "codex", sessionId, file: resolved };
  }
  const sessionId = stringValue(first["sessionId"]);
  if (sessionId !== null) return { runtime: "claude", sessionId, file: resolved };
  throw new Error(`unsupported transcript format: ${resolved}`);
}

function findMatchingFiles(root: string, matches: (name: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "subagents") pending.push(full);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

export async function locateTranscript(
  runtime: TranscriptRuntime,
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<TranscriptIdentity> {
  const root = runtime === "codex"
    ? path.join(homeDir, ".codex", "sessions")
    : path.join(homeDir, ".claude", "projects");
  const matches = runtime === "codex"
    ? findMatchingFiles(root, (name) => name.endsWith(`-${sessionId}.jsonl`))
    : findMatchingFiles(root, (name) => name === `${sessionId}.jsonl`);
  if (matches.length === 0) {
    throw new Error(`${runtime} transcript not found for session ${sessionId}`);
  }
  if (matches.length > 1) {
    throw new Error(`${runtime} transcript is ambiguous for session ${sessionId}: ${matches.length} files matched`);
  }
  const identity = await inspectTranscript(matches[0]!);
  if (identity.runtime !== runtime || identity.sessionId !== sessionId) {
    throw new Error(`transcript identity mismatch for session ${sessionId}`);
  }
  return identity;
}

export async function resolveCurrentTranscript(options: ResolveTranscriptOptions = {}): Promise<TranscriptIdentity | null> {
  if (options.transcriptPath !== undefined) {
    return inspectTranscript(options.transcriptPath);
  }
  const expectedSessionId = options.sessionId === undefined ? currentSessionId() : options.sessionId;
  if (expectedSessionId === null) return null;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: TranscriptIdentity[] = [];
  for (const runtime of ["codex", "claude"] as const) {
    try {
      candidates.push(await locateTranscript(runtime, expectedSessionId, homeDir));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("transcript not found")) throw error;
    }
  }
  if (candidates.length === 0) throw new Error(`transcript not found for current session ${expectedSessionId}`);
  if (candidates.length > 1) throw new Error(`transcript runtime is ambiguous for current session ${expectedSessionId}`);
  return candidates[0]!;
}

/**
 * Codex currently serializes runtime context injections as role=user messages
 * without a dedicated synthetic-message bit. Keep that unstable boundary in
 * one predicate so transcript pairing never mistakes an injected instruction
 * block for the human invocation or answer.
 */
function isSyntheticCodexUserText(text: string): boolean {
  const trimmed = text.trimStart();
  if (/^# AGENTS\.md instructions(?:\s+for\b|\s*$)/u.test(trimmed)) return true;
  return ["skill", "environment_context", "user_instructions"].some(
    (tag) => trimmed.startsWith(`<${tag}>`) && trimmed.includes(`</${tag}>`),
  );
}

/** Claude also stores local slash-command plumbing as ordinary user records. */
function isSyntheticClaudeUserMessage(record: JsonRecord, text: string): boolean {
  if (record["isCompactSummary"] === true) return true;
  const trimmed = text.trimStart();
  if (/^\[Request interrupted\b/iu.test(trimmed)) return true;
  return /^(?:<command-name>|<local-command-(?:stdout|caveat)>|<task-notification>)/u.test(trimmed);
}

function isClaudeTaskNotification(record: JsonRecord): boolean {
  if (record["type"] !== "user" || record["isSidechain"] === true || record["isMeta"] === true) {
    return false;
  }
  const message = objectValue(record["message"]);
  return message?.["role"] === "user"
    && typeof message["content"] === "string"
    && message["content"].trimStart().startsWith("<task-notification>");
}

function codexMessage(record: JsonRecord, role: "assistant" | "user"): { ref: string; text: string } | null {
  if (record["type"] !== "response_item") return null;
  const payload = objectValue(record["payload"]);
  if (payload?.["type"] !== "message" || payload["role"] !== role) return null;
  const content = Array.isArray(payload["content"]) ? payload["content"] : [];
  const wanted = role === "assistant" ? "output_text" : "input_text";
  const text = content
    .map(objectValue)
    .filter((part): part is JsonRecord => part !== null && part["type"] === wanted)
    .map((part) => stringValue(part["text"]) ?? "")
    .filter((part) => part !== "")
    .join("\n")
    .trim();
  if (text === "") return null;
  if (role === "user" && isSyntheticCodexUserText(text)) return null;
  const ref = stringValue(payload["id"]);
  return ref === null ? null : { ref, text };
}

function claudeMessage(record: JsonRecord, role: "assistant" | "user"): { ref: string; text: string } | null {
  if (record["type"] !== role || record["isSidechain"] === true || record["isMeta"] === true) return null;
  const message = objectValue(record["message"]);
  if (message?.["role"] !== role) return null;
  if (role === "assistant" && (record["error"] != null || message["model"] === "<synthetic>")) return null;
  const content = message["content"];
  let text = "";
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    const parts = content.map(objectValue);
    if (parts.some((part) => part?.["type"] === "tool_result")) return null;
    text = parts
      .filter((part): part is JsonRecord => part !== null && part["type"] === "text")
      .map((part) => stringValue(part["text"]) ?? "")
      .filter((part) => part !== "")
      .join("\n")
      .trim();
  }
  if (role === "user" && isSyntheticClaudeUserMessage(record, text)) return null;
  const ref = stringValue(record["uuid"]);
  return text === "" || ref === null ? null : { ref, text };
}

function messageFor(
  runtime: TranscriptRuntime,
  record: JsonRecord,
  role: "assistant" | "user",
): { ref: string; text: string } | null {
  return runtime === "codex" ? codexMessage(record, role) : claudeMessage(record, role);
}

function isTurnComplete(runtime: TranscriptRuntime, record: JsonRecord): boolean {
  if (runtime === "codex") {
    const payload = objectValue(record["payload"]);
    return record["type"] === "event_msg" && payload?.["type"] === "task_complete";
  }
  return record["type"] === "system" && record["subtype"] === "turn_duration" && record["isSidechain"] !== true;
}

interface QuestionToolAnswer {
  ref: string;
  turns: TranscriptTurn[];
}

/** Only a known question call can make a tool result human-authored evidence. */
function questionToolEvents(
  identity: TranscriptIdentity,
  record: JsonRecord,
  pending: Map<string, unknown>,
): { hasCall: boolean; answers: QuestionToolAnswer[] } {
  const { runtime, sessionId } = identity;
  let calls: JsonRecord[] = [];
  let results: JsonRecord[] = [];
  if (runtime === "codex") {
    const payload = objectValue(record["payload"]);
    if (record["type"] === "response_item" && payload !== null) {
      if (payload["type"] === "function_call" && payload["name"] === "request_user_input") calls = [payload];
      if (payload["type"] === "function_call_output") results = [payload];
    }
  } else if (record["isSidechain"] !== true && record["isMeta"] !== true && record["isCompactSummary"] !== true) {
    const message = objectValue(record["message"]);
    const parts = Array.isArray(message?.["content"])
      ? message["content"].map(objectValue).filter((part): part is JsonRecord => part !== null)
      : [];
    if (record["type"] === "assistant" && message?.["role"] === "assistant"
      && record["error"] == null && message["model"] !== "<synthetic>") {
      calls = parts.filter((part) => part["type"] === "tool_use" && part["name"] === "AskUserQuestion");
    }
    if (record["type"] === "user" && message?.["role"] === "user") {
      results = parts.filter((part) => part["type"] === "tool_result");
    }
  }
  for (const call of calls) {
    const id = stringValue(call[runtime === "codex" ? "call_id" : "id"]);
    if (id === null) throw new Error("transcript question tool call is missing its ID");
    // Completed requests are removed below; bound unresolved requests in a damaged log.
    if (!pending.has(id) && pending.size >= 64) throw new Error("transcript has more than 64 unresolved question tool calls");
    pending.set(id, call[runtime === "codex" ? "arguments" : "input"]);
  }
  const answers: QuestionToolAnswer[] = [];
  for (const result of results) {
    const id = stringValue(result[runtime === "codex" ? "call_id" : "tool_use_id"]);
    if (id === null || !pending.has(id)) continue;
    const input = pending.get(id);
    pending.delete(id);
    if (result["is_error"] === true) continue;
    let response: JsonRecord | null;
    if (runtime === "claude") {
      response = objectValue(record["toolUseResult"]);
    } else {
      // Unavailable/cancelled calls return diagnostic text, not a human response.
      try { response = objectValue(JSON.parse(String(result["output"]))); }
      catch { continue; }
    }
    const byQuestion = objectValue(response?.["answers"]);
    if (byQuestion === null) continue;
    let request: JsonRecord | null;
    try { request = objectValue(runtime === "codex" ? JSON.parse(String(input)) : input); }
    catch { throw new Error(`transcript question request ${id} has invalid JSON`); }
    if (!Array.isArray(request?.["questions"])) throw new Error(`transcript question request ${id} is missing its questions`);
    const ref = `tool:${id}`;
    const turns: TranscriptTurn[] = [];
    const keys = new Set<string>();
    for (const [index, value] of request["questions"].entries()) {
      const question = objectValue(value);
      const text = stringValue(question?.["question"]);
      const key = runtime === "codex" ? stringValue(question?.["id"]) : text;
      if (text === null || key === null || keys.has(key)) throw new Error(`transcript question request ${id} has invalid or duplicate questions`);
      keys.add(key);
      const options = question?.["options"];
      if (options !== undefined && !Array.isArray(options)) throw new Error(`transcript question request ${id} has invalid options`);
      const descriptions = (options ?? []).map((value: unknown) => {
        const option = objectValue(value);
        const label = stringValue(option?.["label"]);
        const description = option?.["description"];
        if (label === null || typeof description !== "string") throw new Error(`transcript question request ${id} has invalid options`);
        return `- ${label}: ${description}`;
      });
      if (!Object.hasOwn(byQuestion, key)) continue;
      const answer = runtime === "claude" ? byQuestion[key] : objectValue(byQuestion[key])?.["answers"];
      let answerText: string;
      if (runtime === "claude" && typeof answer === "string") answerText = answer;
      else if (runtime === "codex" && Array.isArray(answer) && answer.every((part) => typeof part === "string")) answerText = answer.join("\n");
      else throw new Error(`transcript question response ${id} has an unsupported answer format`);
      if (answerText.trim() === "") continue;
      turns.push({
        asked: text + (descriptions.length === 0 ? "" : `\n\nOptions:\n${descriptions.join("\n")}`),
        answer: answerText,
        // The call and original question position survive result reordering and retries.
        sourceRef: `${runtime}:${sessionId}:${ref}:${index}`,
      });
    }
    if (turns.length > 0) answers.push({ ref, turns });
  }
  return { hasCall: calls.length > 0, answers };
}

export async function latestHumanRef(identity: TranscriptIdentity): Promise<string> {
  let latest: string | null = null;
  const pending = new Map<string, unknown>();
  for await (const record of jsonRecords(identity.file)) {
    const message = messageFor(identity.runtime, record, "user");
    if (message !== null) latest = message.ref;
    for (const answer of questionToolEvents(identity, record, pending).answers) latest = answer.ref;
  }
  if (latest === null) throw new Error(`transcript has no human message to use as a start boundary: ${identity.file}`);
  return latest;
}

export async function extractTranscriptTurns(
  identity: TranscriptIdentity,
  startRef: string,
): Promise<TranscriptTurn[]> {
  let started = false;
  let sawStart = false;
  let assistantCandidate: { ref: string; text: string } | null = null;
  let pendingQuestion: { ref: string; text: string } | null = null;
  let sawVisibleAssistant = false;
  let sawVisibleHuman = false;
  let completionMarkers = 0;
  const turns: TranscriptTurn[] = [];
  const questionTools = new Map<string, unknown>();

  for await (const record of jsonRecords(identity.file)) {
    if (identity.runtime === "claude" && isClaudeTaskNotification(record)) {
      assistantCandidate = null;
      pendingQuestion = null;
      continue;
    }
    const human = messageFor(identity.runtime, record, "user");
    const tool = questionToolEvents(identity, record, questionTools);
    if (!started) {
      if (human?.ref === startRef || tool.answers.some((answer) => answer.ref === startRef)) {
        started = true;
        sawStart = true;
        assistantCandidate = null;
        pendingQuestion = null;
        questionTools.clear();
      }
      continue;
    }

    const assistant = messageFor(identity.runtime, record, "assistant");
    if (assistant !== null && !tool.hasCall) {
      assistantCandidate = assistant;
      sawVisibleAssistant = true;
    }

    if (tool.hasCall || tool.answers.length > 0) {
      // A question tool owns its answer boundary, even while the assistant turn runs.
      // Its narration must not become a second question for a later human message.
      assistantCandidate = null;
      pendingQuestion = null;
      for (const answer of tool.answers) turns.push(...answer.turns);
    }

    if (isTurnComplete(identity.runtime, record)) {
      completionMarkers += 1;
      if (assistantCandidate !== null) pendingQuestion = assistantCandidate;
      assistantCandidate = null;
      continue;
    }

    if (human !== null && pendingQuestion !== null) {
      sawVisibleHuman = true;
      turns.push({
        asked: pendingQuestion.text,
        answer: human.text,
        sourceRef: `${identity.runtime}:${identity.sessionId}:${human.ref}`,
      });
      pendingQuestion = null;
    } else if (human !== null) {
      sawVisibleHuman = true;
    }
  }

  if (!sawStart) {
    throw new Error(`transcript start boundary ${startRef} was not found in session ${identity.sessionId}`);
  }
  if (sawVisibleAssistant && sawVisibleHuman && completionMarkers === 0) {
    throw new Error(
      `transcript has visible assistant and human messages after ${startRef}, but no completed turn boundary; ${identity.runtime} transcript format may have changed`,
    );
  }
  return turns;
}
