import fs from "node:fs";
import path from "node:path";
import { normalizeProjectPath } from "./store";

const { parseFrontmatterBlock } = require("../../lib/prd_parser.js") as {
  parseFrontmatterBlock(markdown: string): { entries: { key: string; value: string; line: number }[]; body: string } | null;
};

export class DispatchRejected extends Error {}

export function assertDispatchablePrd(projectRoot: string, prdPath: string): { relative: string; status: string } {
  const resolved = normalizeProjectPath(projectRoot, prdPath);
  if (!fs.existsSync(resolved.absolute)) throw new DispatchRejected(`PRD not found: ${resolved.relative}; dispatch requires the approved document`);
  const block = parseFrontmatterBlock(fs.readFileSync(resolved.absolute, "utf8"));
  const status = block?.entries.find((entry) => entry.key === "status")?.value.trim() ?? "";
  if (status !== "ready") throw new DispatchRejected(`${resolved.relative} is \`status: ${status || "(unset)"}\`; run \`sasu prd ready --prd ${resolved.relative}\` before dispatching`);
  return { relative: resolved.relative, status };
}

export function assertHandoff(handoff: string): string {
  const text = handoff.trim();
  if (text === "") throw new DispatchRejected("the handoff packet is empty; send the goal, approved contract and authority on stdin");
  return text;
}

export function buildImplementorPrompt(input: { slug: string; prdPath: string; handoff: string }): string {
  return [
    "You are the Implementor for an approved Sasu run.",
    `Run: ${input.slug}`,
    `Approved PRD: ${input.prdPath}`,
    "Read the approved PRD and repository instructions before editing. Implement the complete approved contract and preserve peers' work.",
    "The Observer owns dispatch and escalation. Do not spawn an Implementor or advisor, invoke gates, or change the approved contract without recorded human approval.",
    "Write a concise execution plan answering what must change, how the result will be observed, what can go wrong, and what is outside scope. Send it directly to your Hide parent with hide request send before the first source edit.",
    "Use hide agent list to find your live registration and its parent. Use hide inbox and hide request reply for coordination. Send missing decisions or blockers to that parent with hide request send --kind block and end your turn; do not use interactive user-question tools.",
    "Commit coherent work, request native Fidelity and Code review on the committed candidate, fix current-scope defects, then run sasu implement verify on the final committed head. Report unavailable checks honestly.",
    "Before your final response, send your Hide parent a report with hide request send --kind report, including changed files, verification evidence and unresolved items. Letters do not authorize changes to the approved PRD.",
    "",
    "Handoff from the Observer:",
    assertHandoff(input.handoff),
    "",
  ].join("\n");
}

export interface SpawnInstructionInput {
  intent: string;
  name: string;
  kind?: string;
  model?: string;
  effort?: string;
  repo: string;
  branch: string;
  path: string;
  promptPath: string;
}
export interface SpawnInstruction {
  command: string;
  /** Arguments to hide, excluding the environment bootstrap prefix. */
  argv: string[];
  prompt: string;
  kind: string;
  effort: string;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Generate the public command only. The Observer executes it directly. */
export function buildSpawnInstruction(input: SpawnInstructionInput): SpawnInstruction {
  for (const field of ["intent", "name", "repo", "branch", "path", "promptPath"] as const) {
    if (input[field].trim() === "" || /[\x00-\x1f\x7f]/.test(input[field])) throw new DispatchRejected(`dispatch requires a nonempty ${field} without control characters`);
  }
  if (!path.isAbsolute(input.repo) || !path.isAbsolute(input.path) || !path.isAbsolute(input.promptPath)) throw new DispatchRejected("dispatch repo, checkout and prompt paths must be absolute");
  const kind = input.kind ?? "claude";
  if (kind !== "claude" && kind !== "codex") throw new DispatchRejected(`unsupported agent kind: ${kind}; use claude or codex`);
  const effort = input.effort ?? "high";
  if (!/^[a-z]+$/.test(effort)) throw new DispatchRejected("effort must be a native reasoning effort name");
  if (input.model !== undefined && (input.model.trim() === "" || /[\x00-\x1f\x7f]/.test(input.model))) throw new DispatchRejected("model must be nonempty and contain no control characters");
  // A live 2026-10-07 launch truncated a long pasted command. Keep the first
  // native prompt short; the caller preserves the full immutable handoff file.
  const prompt = `Read ${JSON.stringify(input.promptPath)} and carry out the assigned work.`;
  const native = input.model === undefined ? [] : ["--model", input.model];
  if (kind === "codex") native.push("--config", `model_reasoning_effort="${effort}"`);
  else native.push("--effort", effort);
  native.push("--", prompt);
  const argv = ["agent", "spawn", "--parent", "here", "--name", input.name, "--intent", input.intent, "--kind", kind,
    "--repo", input.repo, "--branch", input.branch, "--path", input.path, "--", ...native];
  return { command: `env -u HIDE_CAP_REF hide ${argv.map(shellQuote).join(" ")}`, argv, prompt, kind, effort };
}
