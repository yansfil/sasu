import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendName } from "../config";
import { JudgeError } from "./types";

export interface BackendRunResult {
  text: string;
}

export interface BackendRunOptions {
  model: string | null;
  timeoutMs: number;
  /** Telemetry, plus the stub backend's lane selector. */
  purpose?: string;
  /** Caps the model's reasoning budget where the backend supports it (claude `--effort`). */
  effort?: string;
  /** Image paths attached to the prompt; only meaningful when `attachments` is true. */
  images?: string[];
}

export interface JudgeBackend {
  name: BackendName;
  binary: string;
  /**
   * Whether the backend can put an image in front of the judge. Attaching an
   * image is not the same as giving the judge a tool: an attachment is inert
   * input material, so it does not reopen the agency problem that made the
   * judge tool-less. A backend without it cannot judge screenshot evidence at
   * all, and the verify flow hands those criteria to a human instead.
   */
  attachments: boolean;
  available(): boolean;
  /** One-shot judge call. */
  run(prompt: string, options: BackendRunOptions): Promise<BackendRunResult>;
}

function binaryOnPath(binary: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" });
  return probe.status === 0;
}

const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

interface ProcessOutcome {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Async spawn so lane-parallel fan-out can run judges concurrently. Semantics
 * mirror the previous spawnSync usage: per-call timeout (SIGTERM), bounded
 * output, and the same failure shape for interpretSpawnFailure.
 */
function runProcess(
  binary: string,
  args: string[],
  options: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const settle = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.on("error", (error) => settle({ error, stdout, stderr }));
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      settle({ status: code, signal: timedOut ? "SIGTERM" : signal, stdout, stderr });
    });
    // `close` waits for stdio to drain, and an orphaned grandchild can hold
    // the pipes open past a SIGTERM. Settle from `exit` (with a short drain
    // grace) so a timed-out judge call cannot outlive its timeout.
    child.on("exit", (code, signal) => {
      const grace = setTimeout(
        () => settle({ status: code, signal: timedOut ? "SIGTERM" : signal, stdout, stderr }),
        timedOut ? 0 : 1000,
      );
      grace.unref?.();
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/**
 * One-shot judgment via Claude Code headless mode. Tools are disallowed and
 * MCP config is ignored so the call stays a pure completion: the judge must
 * never mutate anything (fail-closed contract, PRD R2/D-16).
 */
export class ClaudeBackend implements JudgeBackend {
  readonly name: BackendName = "claude";
  readonly binary = "claude";
  // `claude -p` has no local-image flag (--file takes remote file ids), and
  // the only path to an image would be the Read tool, which the no-tools
  // contract above forbids. Verified against the CLI help, 2026-08-08.
  readonly attachments = false;

  available(): boolean {
    return binaryOnPath(this.binary);
  }

  async run(prompt: string, options: BackendRunOptions): Promise<BackendRunResult> {
    const { model, timeoutMs, effort } = options;
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
    // Calibration (2026-07-17): judge wall time is dominated by a flat
    // reasoning budget, not scope - a full-effort lane call costs as much as
    // the exhaustive single judge (~52s), while a low-effort scoped lane
    // answered in ~13s with the same mine detection. Effort is therefore the
    // fan-out speed lever.
    if (effort) args.push("--effort", effort);
    const result = await runProcess(this.binary, args, {
      input: prompt,
      timeoutMs,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sasu-judge" },
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
 * Best-effort isolation for the codex judge (PRD judge-fanout R7/AC7): codex
 * CLI cannot disable its shell tool, so a fully mechanical read block is
 * impossible (live-verified 2026-07-17: sandbox_permissions=[], tools.shell,
 * deny-all .rules, approval_policy=untrusted all failed to block reads). The
 * judge instead runs from an empty ephemeral work root, ignores user config,
 * and carries an explicit no-tools instruction; the residual risk is judgment
 * bias only (the sandbox stays read-only, so no writes or exfiltration).
 */
export function codexExecArgs(model: string | null, workRoot: string, lastMessagePath: string, images: string[] = []): string[] {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "-C",
    workRoot,
    "--output-last-message",
    lastMessagePath,
  ];
  for (const image of images) args.push("--image", image);
  if (model) args.push("--model", model);
  return args;
}

export const CODEX_NO_TOOLS_PREAMBLE =
  "You are a one-shot judge. Do NOT run shell commands, do NOT read or list any files, and do NOT use any tools. Every document you need is already included in this prompt; answer directly from it.\n\n";

/**
 * One-shot judgment via Codex CLI exec mode. The sandbox is read-only so the
 * judge cannot write; the last agent message is captured through a temp file
 * (spike-verified in T3, see context-notes).
 */
export class CodexBackend implements JudgeBackend {
  readonly name: BackendName = "codex";
  readonly binary = "codex";
  // `codex exec -i/--image <FILE>...` attaches local images to the prompt.
  readonly attachments = true;

  available(): boolean {
    return binaryOnPath(this.binary);
  }

  async run(prompt: string, options: BackendRunOptions): Promise<BackendRunResult> {
    const { model, timeoutMs, images = [] } = options;
    // Spike-verified (codex-cli 0.144.1): the prompt must be a positional
    // argument; stdin via `-` hangs. argv has OS limits, so oversized prompts
    // fail fast instead of hanging the gate.
    if (prompt.length > 400_000) {
      throw new JudgeError("judge-invalid-output", this.name, "prompt exceeds codex argv budget (400k chars); reduce gate input");
    }
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-judge-"));
    const lastMessagePath = path.join(workRoot, "last-message.txt");
    const args = codexExecArgs(model, workRoot, lastMessagePath, images);
    args.push(CODEX_NO_TOOLS_PREAMBLE + prompt);
    try {
      const result = await runProcess(this.binary, args, { timeoutMs });
      interpretSpawnFailure(this.name, result);
      if (fs.existsSync(lastMessagePath)) {
        const text = fs.readFileSync(lastMessagePath, "utf8");
        if (text.trim() !== "") return { text };
      }
      throw new JudgeError("judge-invalid-output", this.name, "codex exec produced no last message");
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Deterministic test backend: returns canned responses from
 * SASU_JUDGE_STUB_FILE. Supported shapes:
 * - a single object/string reused for every call
 * - a JSON array consumed in order via a .cursor side file (sequential runs)
 * - `{ "byPurpose": { "<substring>": <response>, "default": <response> } }`
 *   matched against the call's purpose - required for parallel lanes, where
 *   a shared cursor would race.
 */
export class StubBackend implements JudgeBackend {
  readonly name: BackendName = "stub";
  readonly binary = "stub";
  // Tests must be able to exercise the attachment path without a real judge;
  // SASU_JUDGE_STUB_NO_ATTACHMENTS flips it to rehearse the human-lane
  // fallback a claude-backed run takes.
  get attachments(): boolean {
    return process.env["SASU_JUDGE_STUB_NO_ATTACHMENTS"] !== "1";
  }

  available(): boolean {
    return Boolean(process.env["SASU_JUDGE_STUB_FILE"]);
  }

  async run(_prompt: string, options: BackendRunOptions): Promise<BackendRunResult> {
    const { purpose } = options;
    const stubFile = process.env["SASU_JUDGE_STUB_FILE"];
    if (!stubFile || !fs.existsSync(stubFile)) {
      throw new JudgeError("judge-binary-missing", this.name, "SASU_JUDGE_STUB_FILE is not set or missing");
    }
    const raw = JSON.parse(fs.readFileSync(stubFile, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "byPurpose" in (raw as Record<string, unknown>)) {
      const byPurpose = (raw as { byPurpose: Record<string, unknown> }).byPurpose;
      const keys = Object.keys(byPurpose).filter((k) => k !== "default");
      const match = keys.find((k) => (purpose ?? "").includes(k));
      const item = match !== undefined ? byPurpose[match] : byPurpose["default"];
      if (item === undefined) {
        throw new JudgeError("judge-invalid-output", this.name, `stub byPurpose has no match for: ${purpose ?? "(none)"}`);
      }
      return { text: typeof item === "string" ? item : JSON.stringify(item) };
    }
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
  const envOverride = process.env["SASU_JUDGE_BACKEND"] as BackendName | undefined;
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
