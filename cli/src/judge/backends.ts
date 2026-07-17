import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendName } from "../config";
import { JudgeError } from "./types";

export interface BackendRunResult {
  text: string;
}

export interface JudgeBackend {
  name: BackendName;
  binary: string;
  available(): boolean;
  run(prompt: string, model: string | null, timeoutMs: number): BackendRunResult;
}

function binaryOnPath(binary: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" });
  return probe.status === 0;
}

/**
 * One-shot judgment via Claude Code headless mode. Tools are disallowed and
 * MCP config is ignored so the call stays a pure completion: the judge must
 * never mutate anything (fail-closed contract, PRD R2/D-16).
 */
export class ClaudeBackend implements JudgeBackend {
  readonly name: BackendName = "claude";
  readonly binary = "claude";

  available(): boolean {
    return binaryOnPath(this.binary);
  }

  run(prompt: string, model: string | null, timeoutMs: number): BackendRunResult {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--strict-mcp-config",
      // One-shot judge: no tools at all. Without --tools "" the model keeps
      // Read/Grep/Glob and wanders the host repo for minutes (observed: 24
      // turns, 260s) instead of judging the documents already in the prompt.
      "--tools",
      "",
      "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task,TodoWrite",
    ];
    if (model) args.push("--model", model);
    const result = spawnSync(this.binary, args, {
      input: prompt,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "checkshirt-judge" },
    });
    interpretSpawnFailure(this.name, result);
    const envelope = safeParse(result.stdout);
    if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
      const rec = envelope as Record<string, unknown>;
      if (rec["is_error"] === true) {
        throw new JudgeError("judge-auth-or-runtime", this.name, String(rec["result"] ?? "claude reported an error"));
      }
      if (typeof rec["result"] === "string") return { text: rec["result"] };
    }
    // Fall back to raw stdout when the envelope shape changes across CLI versions.
    if (result.stdout.trim() !== "") return { text: result.stdout };
    throw new JudgeError("judge-invalid-output", this.name, "empty stdout from claude -p");
  }
}

/**
 * One-shot judgment via Codex CLI exec mode. The sandbox is read-only so the
 * judge cannot write; the last agent message is captured through a temp file
 * (spike-verified in T3, see context-notes).
 */
export class CodexBackend implements JudgeBackend {
  readonly name: BackendName = "codex";
  readonly binary = "codex";

  available(): boolean {
    return binaryOnPath(this.binary);
  }

  run(prompt: string, model: string | null, timeoutMs: number): BackendRunResult {
    // Spike-verified (codex-cli 0.144.1): the prompt must be a positional
    // argument; stdin via `-` hangs. argv has OS limits, so oversized prompts
    // fail fast instead of hanging the gate.
    if (prompt.length > 400_000) {
      throw new JudgeError("judge-invalid-output", this.name, "prompt exceeds codex argv budget (400k chars); reduce gate input");
    }
    const lastMessagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "checkshirt-judge-")), "last-message.txt");
    const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--output-last-message", lastMessagePath];
    if (model) args.push("--model", model);
    args.push(prompt);
    try {
      const result = spawnSync(this.binary, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      interpretSpawnFailure(this.name, result);
      if (fs.existsSync(lastMessagePath)) {
        const text = fs.readFileSync(lastMessagePath, "utf8");
        if (text.trim() !== "") return { text };
      }
      throw new JudgeError("judge-invalid-output", this.name, "codex exec produced no last message");
    } finally {
      fs.rmSync(path.dirname(lastMessagePath), { recursive: true, force: true });
    }
  }
}

/**
 * Deterministic test backend: returns canned responses from
 * CHECKSHIRT_JUDGE_STUB_FILE (a JSON array consumed in order, or a single
 * object reused for every call). Selected via CHECKSHIRT_JUDGE_BACKEND=stub.
 */
export class StubBackend implements JudgeBackend {
  readonly name: BackendName = "stub";
  readonly binary = "stub";

  available(): boolean {
    return Boolean(process.env["CHECKSHIRT_JUDGE_STUB_FILE"]);
  }

  run(_prompt: string, _model: string | null, _timeoutMs: number): BackendRunResult {
    const stubFile = process.env["CHECKSHIRT_JUDGE_STUB_FILE"];
    if (!stubFile || !fs.existsSync(stubFile)) {
      throw new JudgeError("judge-binary-missing", this.name, "CHECKSHIRT_JUDGE_STUB_FILE is not set or missing");
    }
    const raw = JSON.parse(fs.readFileSync(stubFile, "utf8")) as unknown;
    if (Array.isArray(raw)) {
      const cursorFile = `${stubFile}.cursor`;
      const cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, "utf8")) : 0;
      const item = raw[Math.min(cursor, raw.length - 1)];
      fs.writeFileSync(cursorFile, String(cursor + 1));
      return { text: typeof item === "string" ? item : JSON.stringify(item) };
    }
    return { text: typeof raw === "string" ? raw : JSON.stringify(raw) };
  }
}

interface SpawnOutcome {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string;
}

function interpretSpawnFailure(backend: BackendName, result: SpawnOutcome): void {
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new JudgeError("judge-binary-missing", backend, `binary not found on PATH`);
    }
    if (err.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      throw new JudgeError("judge-timeout", backend, "judge call timed out");
    }
    throw new JudgeError("judge-auth-or-runtime", backend, err.message);
  }
  if (result.signal === "SIGTERM") {
    throw new JudgeError("judge-timeout", backend, "judge call timed out");
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 800);
    throw new JudgeError("judge-auth-or-runtime", backend, stderr || `exit code ${String(result.status)}`);
  }
}

function safeParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function resolveBackend(preference: "auto" | BackendName): JudgeBackend {
  const envOverride = process.env["CHECKSHIRT_JUDGE_BACKEND"] as BackendName | undefined;
  const effective = envOverride ?? preference;
  const claude = new ClaudeBackend();
  const codex = new CodexBackend();
  const stub = new StubBackend();
  if (effective === "stub") return stub;
  if (effective === "claude") return claude;
  if (effective === "codex") return codex;
  if (claude.available()) return claude;
  if (codex.available()) return codex;
  throw new JudgeError(
    "judge-binary-missing",
    "claude",
    "no judge backend available: neither `claude` nor `codex` found on PATH",
  );
}
