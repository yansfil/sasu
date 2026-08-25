#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const { stripFrontmatter } = require("../../../cli/lib/prd_parser.js");

const AGENT_START_RETRY_LIMIT = 50;
const AGENT_START_RETRY_MS = 100;
const IMPLEMENTOR_WAIT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const IMPLEMENTOR_WAIT_POLL_MS = 250;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
function implementorRoutingContract(prdPath, dirtyAttribution) {
  return `

RUNTIME ROUTING CONTRACT (injected by the Observer dispatcher):
You are not the user-facing session. Never invoke AskUserQuestion, request_user_input, or any interactive question UI, and never ask the user directly.
Your sole specification source is the ready PRD at ${prdPath}. Execute implementation and conditional delivery only; never author or edit the qa-log or PRD.
${dirtyAttribution === undefined
    ? "The specification-owning session found no dirty disposition to pass. Start normally and fail closed if the tree changed before start."
    : `The user already chose the dirty disposition '${dirtyAttribution}'. Pass --dirty-attribution ${dirtyAttribution} to sasu implement start exactly once and never ask the question again.`}
When a decision or failure prevents progress, output the structured OBSERVER_BLOCK packet from the Observer reference as final text and end the turn so the Observer lifecycle monitor can settle and respond.
`;
}

const HERDR_RUNTIME_ENV = Object.freeze({
  HERDR_ENV: {
    requirement: "optional",
    shape: value => value === undefined || value === "" || value === "1",
    fallback: undefined,
    note: "Herdr injects 1 in managed panes; without it Observer isolation is unavailable.",
  },
  SASU_HERDR_ROLE: {
    requirement: "optional",
    shape: value => value === undefined || value === "" || value === "implementor",
    fallback: undefined,
    note: "The Observer injects implementor while creating the child pane; an unmarked Herdr pane is the Observer.",
  },
});

function runtimeEnv(name) {
  const contract = HERDR_RUNTIME_ENV[name];
  if (contract === undefined) throw new Error(`unregistered runtime environment key: ${name}`);
  const value = process.env[name];
  if (!contract.shape(value)) throw new Error(`${name} has an invalid shape`);
  return value === "" ? contract.fallback : (value ?? contract.fallback);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith("--")) throw new Error(`unexpected argument: ${current}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${current} requires a value`);
    flags[current.slice(2)] = value;
    index += 1;
  }
  return { command, flags };
}

function herdrDiagnostic(args) {
  if (args[0] === "agent" && args[1] === "prompt") {
    return {
      command: `herdr agent prompt ${args[2] ?? "<unknown>"} <redacted handoff>`,
      retainOutput: false,
    };
  }
  return { command: `herdr ${args.join(" ")}`, retainOutput: true };
}

function runHerdr(args, options = {}) {
  const diagnostic = herdrDiagnostic(args);
  const result = spawnSync("herdr", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // `agent prompt` carries the complete handoff as one argv entry. Herdr or
    // a wrapper may echo argv on failure, so retaining its output would write
    // the user's verbatim invocation and operational context into Observer
    // logs. Status plus the redacted command is sufficient for recovery.
    const detail = diagnostic.retainOutput
      ? (result.stderr || result.stdout || "no diagnostic").trim()
      : "handoff diagnostic redacted";
    throw new Error(`${diagnostic.command} failed (${result.status}): ${detail}`);
  }
  const output = result.stdout.trim();
  if (output === "") return null;
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${diagnostic.command} returned non-JSON output`);
  }
}

function startAgentWhenShellIsReady(name, agentKind, paneId, cwd, nativeArgs = []) {
  // A fresh Herdr pane is observable before its shell accepts agent start.
  // The 2026-08-23 live /please drive hit this race on every immediate start;
  // retry the same pane for at most five seconds instead of allocating more panes.
  for (let attempt = 1; attempt <= AGENT_START_RETRY_LIMIT; attempt += 1) {
    try {
      return runHerdr([
        "agent", "start", name, "--kind", agentKind, "--pane", paneId,
        ...(nativeArgs.length === 0 ? [] : ["--", ...nativeArgs]),
      ], { cwd });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shellIsStarting = detail.includes("agent_pane_busy");
      if (!shellIsStarting || attempt === AGENT_START_RETRY_LIMIT) throw error;
      Atomics.wait(waitBuffer, 0, 0, AGENT_START_RETRY_MS);
    }
  }
  throw new Error("unreachable: agent start retry loop exhausted without a result");
}

function currentRole() {
  if (runtimeEnv("HERDR_ENV") !== "1") {
    return { mode: "inline", reason: "not-herdr" };
  }

  const response = runHerdr(["pane", "current", "--current"]);
  const pane = response?.result?.pane;
  if (pane === undefined || typeof pane.pane_id !== "string") {
    throw new Error("herdr pane current did not return a pane");
  }
  const marker = runtimeEnv("SASU_HERDR_ROLE");
  return {
    mode: marker === "implementor" ? "implementor" : "observer",
    paneId: pane.pane_id,
    agentKind: typeof pane.agent === "string" ? pane.agent : null,
  };
}

function requireName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error("--name must match [a-z][a-z0-9_-]{0,31}");
  }
  return value;
}

function nativeAgentArgs(agentKind, flags) {
  const model = flags.model;
  const effort = flags.effort;
  if (model !== undefined && model.trim() === "") throw new Error("--model must be non-empty");
  const efforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
  if (effort !== undefined && !efforts.has(effort)) {
    throw new Error("--effort must be one of: low, medium, high, xhigh, max, ultra");
  }
  if (model === undefined && effort === undefined) return [];
  if (agentKind === "codex") {
    return [
      ...(model === undefined ? [] : ["--model", model]),
      ...(effort === undefined ? [] : ["--config", `model_reasoning_effort="${effort}"`]),
    ];
  }
  if (agentKind === "claude") {
    return [
      ...(model === undefined ? [] : ["--model", model]),
      ...(effort === undefined ? [] : ["--effort", effort]),
    ];
  }
  throw new Error(`--model/--effort are supported only for codex or claude agents, got ${agentKind}`);
}

function requireImplementationPipeline(handoff) {
  const pipelineLines = handoff.split(/\r?\n/).filter(line => line.startsWith("PIPELINE:"));
  if (pipelineLines.length !== 1 || !/^PIPELINE:\s*implement(?:\s|$)/.test(pipelineLines[0])) {
    throw new Error("dispatch requires exactly one 'PIPELINE: implement' handoff field; specification work stays in the main session");
  }
}

function requireReadyPrd(value, cwd) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("dispatch requires --prd <ready-prd-path>");
  }
  const resolved = path.resolve(cwd, value);
  const relative = path.relative(cwd, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("--prd must resolve to a file inside --cwd");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`ready PRD not found: ${relative}`);
  }
  const { frontmatter } = stripFrontmatter(fs.readFileSync(resolved, "utf8"));
  if (frontmatter.status !== "ready") {
    throw new Error(`PRD status must be ready before dispatch, got ${frontmatter.status ?? "missing"}: ${relative}`);
  }
  return relative.split(path.sep).join("/");
}

function optionalDirtyAttribution(value) {
  if (value === undefined) return undefined;
  if (value !== "pre-existing" && value !== "run-owned") {
    throw new Error("--dirty-attribution must be pre-existing or run-owned; commit-first is resolved before dispatch by committing and re-running intake");
  }
  return value;
}

function dispatch(flags, handoff) {
  if (typeof handoff !== "string" || handoff.trim() === "") {
    throw new Error("dispatch requires the lossless Implementor handoff on stdin");
  }
  requireImplementationPipeline(handoff);
  const cwd = flags.cwd ?? process.cwd();
  const prdPath = requireReadyPrd(flags.prd, cwd);
  const dirtyAttribution = optionalDirtyAttribution(flags["dirty-attribution"]);
  const role = currentRole();
  if (role.mode === "inline") throw new Error("Observer dispatch requires a Herdr-managed pane");
  if (role.mode === "implementor") {
    throw new Error("recursive dispatch refused: the current pane is already marked as the Implementor");
  }

  const name = requireName(flags.name);
  const agentKind = flags.kind ?? role.agentKind;
  if (typeof agentKind !== "string" || agentKind === "") {
    throw new Error("--kind is required when the Observer pane has no detected agent kind");
  }
  const launchArgs = nativeAgentArgs(agentKind, flags);

  const split = runHerdr([
    "pane", "split", "--current", "--direction", "right", "--cwd", cwd,
    "--env", "SASU_HERDR_ROLE=implementor", "--no-focus",
  ], { cwd });
  const paneId = split?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error("herdr pane split did not return the new pane ID");
  }

  try {
    startAgentWhenShellIsReady(name, agentKind, paneId, cwd, launchArgs);
  } catch (error) {
    try {
      runHerdr(["pane", "close", paneId], { cwd });
    } catch {
      // The original startup failure remains the useful diagnostic.
    }
    throw error;
  }

  const dispositionField = dirtyAttribution === undefined ? "" : `\nDIRTY ATTRIBUTION: ${dirtyAttribution}`;
  const submittedHandoff = `${handoff.trim()}${dispositionField}${implementorRoutingContract(prdPath, dirtyAttribution)}`;
  try {
    runHerdr(["agent", "prompt", name, submittedHandoff], { cwd });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Implementor ${name} started in ${paneId}, but handoff submission failed: ${detail}. `
      + `Do not dispatch another pane; retry only 'herdr agent prompt ${name} <handoff>'.`,
    );
  }

  return {
    mode: "observer",
    implementor: {
      name,
      paneId,
      agentKind,
      cwd,
      handoffSubmitted: true,
      ...(dirtyAttribution !== undefined ? { dirtyAttribution } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.effort !== undefined ? { effort: flags.effort } : {}),
    },
  };
}

function implementorSnapshot(name, cwd) {
  const response = runHerdr(["agent", "list"], { cwd });
  const agents = response?.result?.agents;
  if (!Array.isArray(agents)) throw new Error("herdr agent list did not return an agents array");
  const agent = agents.find(candidate => candidate?.name === name);
  if (agent === undefined) {
    return { name, status: "unknown", paneId: null, agentKind: null, cwd: null, interactiveReady: false };
  }
  return {
    name,
    status: typeof agent.agent_status === "string" ? agent.agent_status : "unknown",
    paneId: typeof agent.pane_id === "string" ? agent.pane_id : null,
    agentKind: typeof agent.agent === "string" ? agent.agent : null,
    cwd: typeof agent.cwd === "string" ? agent.cwd : null,
    interactiveReady: agent.interactive_ready === true,
  };
}

function waitForImplementor(flags) {
  const role = currentRole();
  if (role.mode === "inline") throw new Error("Observer wait requires a Herdr-managed pane");
  if (role.mode === "implementor") throw new Error("Implementor panes cannot own the Observer lifecycle wait");
  const name = requireName(flags.name);
  const cwd = flags.cwd ?? process.cwd();
  const startedAt = Date.now();
  while (Date.now() - startedAt < IMPLEMENTOR_WAIT_TIMEOUT_MS) {
    const implementor = implementorSnapshot(name, cwd);
    if (implementor.status !== "working") {
      return { mode: "observer", implementor, elapsedMs: Date.now() - startedAt };
    }
    Atomics.wait(waitBuffer, 0, 0, IMPLEMENTOR_WAIT_POLL_MS);
  }
  throw new Error(
    `Implementor ${name} remained working for ${IMPLEMENTOR_WAIT_TIMEOUT_MS}ms; inspect its pane and Sasu state`,
  );
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "role") return currentRole();
  if (command === "dispatch") return dispatch(flags, fs.readFileSync(0, "utf8"));
  if (command === "wait") return waitForImplementor(flags);
  throw new Error("usage: herdr_observer.js role | dispatch --name <name> --prd <ready-prd-path> [--dirty-attribution <pre-existing|run-owned>] [--kind <kind>] [--model <model>] [--effort <low|medium|high|xhigh|max|ultra>] [--cwd <path>] < handoff.txt | wait --name <name> [--cwd <path>]");
}

try {
  process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
