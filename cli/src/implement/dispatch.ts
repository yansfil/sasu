import fs from "node:fs";
import { spawnImplementor } from "./herdr";
import { normalizeProjectPath } from "./store";

const { parseFrontmatterBlock } = require("../../lib/prd_parser.js") as {
  parseFrontmatterBlock(markdown: string): { entries: { key: string; value: string; line: number }[]; body: string } | null;
};

/**
 * Start exactly one Implementor beside the supervisor.
 *
 * This verb exists because its absence was a lie the documentation told. The
 * Observer reference described a "deterministic helper" with preconditions,
 * marker injection and a JSON return, and then printed a raw `herdr agent new`
 * command carrying `--env` and `--prompt` - two flags herdr has never had.
 * Nothing implemented the helper, so every dispatch was hand-typed from prose
 * against a CLI contract nobody was checking, and it drifted (2026-09-07: a
 * live run could not dispatch at all). A rule that lives only in a skill
 * document is a request for discipline, not a guard (AGENTS.md Review Guide
 * 7); this is the guard, and the prose command block leaves with it.
 *
 * The preconditions are ordered so nothing is created before every refusal has
 * had its say: a refused dispatch costs a message, a half-made one costs a
 * stray pane and a confused supervisor.
 */
export interface DispatchInput {
  name: string;
  prdPath: string;
  handoff: string;
  cwd: string;
  kind?: string;
  model?: string;
  effort?: string;
}

export interface DispatchRefusal {
  reason: string;
}

export class DispatchRejected extends Error {}

const ROLE_ENV_KEY = "SASU_HERDR_ROLE";

/**
 * The recursion guard, and the reason the marker is an environment value
 * rather than a line in the handoff: an Implementor that dispatches an
 * Implementor forks the run's authority in a way no later record can undo.
 * This reads the marker on the *dispatching* process, so it refuses before
 * herdr is touched at all.
 */
export function assertNotImplementor(env: NodeJS.ProcessEnv = process.env): void {
  if (env[ROLE_ENV_KEY]?.trim() === "implementor") {
    throw new DispatchRejected(
      `this pane is marked ${ROLE_ENV_KEY}=implementor; an implementor executes its handed-off PRD and never dispatches another implementor`,
    );
  }
}

function frontmatterValue(text: string, key: string): string | null {
  const block = parseFrontmatterBlock(text);
  if (block === null) return null;
  for (const entry of block.entries) if (entry.key === key) return entry.value;
  return null;
}

/**
 * A dispatch hands over a PRD the supervisor has already sealed. Checking the
 * document here rather than at `implement start` means the failure lands in
 * the pane that can still fix it, instead of in a freshly spawned agent that
 * cannot.
 */
export function assertDispatchablePrd(projectRoot: string, prdPath: string): { relative: string; status: string } {
  const resolved = normalizeProjectPath(projectRoot, prdPath);
  if (!fs.existsSync(resolved.absolute)) {
    throw new DispatchRejected(`PRD not found: ${resolved.relative}; dispatch hands over a sealed document, it does not create one`);
  }
  const status = frontmatterValue(fs.readFileSync(resolved.absolute, "utf8"), "status")?.trim() ?? "";
  if (status !== "ready" && status !== "approved") {
    throw new DispatchRejected(
      `${resolved.relative} is \`status: ${status === "" ? "(unset)" : status}\`; run \`sasu prd ready --prd ${resolved.relative}\` before dispatching`,
    );
  }
  return { relative: resolved.relative, status };
}

/**
 * The handoff is the only context the Implementor gets, so an empty one is
 * refused rather than sent: a started agent with no packet is worse than no
 * agent, because it looks like a working dispatch.
 */
export function assertHandoff(handoff: string): string {
  const text = handoff.trim();
  if (text === "") {
    throw new DispatchRejected("the handoff packet is empty; send it on stdin (ROLE, PIPELINE, ORIGINAL INVOCATION, GOAL AND CONTEXT, AUTHORITY, SOURCE, RETURN CONTRACT)");
  }
  return text;
}

export interface DispatchResult {
  paneId: string;
  agent: string;
  kind: string;
  prd: string;
  /**
   * herdr 0.8.2 cannot inject the role marker and record agent lineage in one
   * call, and the marker wins. Reported rather than hidden so a supervisor
   * looking for its child in the agent tree knows why it is not there.
   */
  parentLineage: "unavailable";
}

export function dispatchImplementor(
  projectRoot: string,
  input: DispatchInput,
  env: NodeJS.ProcessEnv = process.env,
): DispatchResult {
  assertNotImplementor(env);
  const name = input.name.trim();
  if (name === "") throw new DispatchRejected("dispatch requires --name <unique-agent-name>");
  const handoff = assertHandoff(input.handoff);
  const prd = assertDispatchablePrd(projectRoot, input.prdPath);

  const spawned = spawnImplementor(
    { name, cwd: input.cwd, prompt: handoff, kind: input.kind, model: input.model, effort: input.effort },
    { env },
  );
  if (!spawned.ok || spawned.value === null) throw new DispatchRejected(spawned.problem ?? "dispatch failed for an unreported reason");

  return { paneId: spawned.value.paneId, agent: spawned.value.name, kind: spawned.value.kind, prd: prd.relative, parentLineage: "unavailable" };
}
