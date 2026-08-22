#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const AGENT_START_RETRY_LIMIT = 50;
const AGENT_START_RETRY_MS = 100;
const IMPLEMENTOR_WAIT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const IMPLEMENTOR_WAIT_POLL_MS = 250;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const IMPLEMENTOR_ROUTING_CONTRACT = `

RUNTIME ROUTING CONTRACT (injected by the Observer dispatcher):
You are not the user-facing session. Never invoke AskUserQuestion, request_user_input, or any interactive question UI, and never ask the user directly.
When a decision or failure prevents progress, output the structured OBSERVER_BLOCK packet from the Observer reference as final text and end the turn so the Observer lifecycle monitor can settle and respond.
`;

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

function runHerdr(args, options = {}) {
  const result = spawnSync("herdr", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no diagnostic").trim();
    throw new Error(`herdr ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  const output = result.stdout.trim();
  if (output === "") return null;
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON output`);
  }
}

function startAgentWhenShellIsReady(name, agentKind, paneId, cwd) {
  // A fresh Herdr pane is observable before its shell accepts agent start.
  // The 2026-08-23 live /please drive hit this race on every immediate start;
  // retry the same pane for at most five seconds instead of allocating more panes.
  for (let attempt = 1; attempt <= AGENT_START_RETRY_LIMIT; attempt += 1) {
    try {
      return runHerdr(["agent", "start", name, "--kind", agentKind, "--pane", paneId], { cwd });
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

function dispatch(flags, handoff) {
  if (typeof handoff !== "string" || handoff.trim() === "") {
    throw new Error("dispatch requires the lossless Implementor handoff on stdin");
  }
  const role = currentRole();
  if (role.mode === "inline") throw new Error("Observer dispatch requires a Herdr-managed pane");
  if (role.mode === "implementor") {
    throw new Error("recursive dispatch refused: the current pane is already marked as the Implementor");
  }

  const name = requireName(flags.name);
  const cwd = flags.cwd ?? process.cwd();
  const agentKind = flags.kind ?? role.agentKind;
  if (typeof agentKind !== "string" || agentKind === "") {
    throw new Error("--kind is required when the Observer pane has no detected agent kind");
  }

  const split = runHerdr([
    "pane", "split", "--current", "--direction", "right", "--cwd", cwd,
    "--env", "SASU_HERDR_ROLE=implementor", "--no-focus",
  ], { cwd });
  const paneId = split?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error("herdr pane split did not return the new pane ID");
  }

  try {
    startAgentWhenShellIsReady(name, agentKind, paneId, cwd);
  } catch (error) {
    try {
      runHerdr(["pane", "close", paneId], { cwd });
    } catch {
      // The original startup failure remains the useful diagnostic.
    }
    throw error;
  }

  const submittedHandoff = `${handoff.trim()}${IMPLEMENTOR_ROUTING_CONTRACT}`;
  try {
    runHerdr(["agent", "prompt", name, submittedHandoff], { cwd });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Implementor ${name} started in ${paneId}, but handoff submission failed: ${detail}. `
      + `Do not dispatch another pane; retry only 'herdr agent prompt ${name} <handoff>'.`,
    );
  }

  return { mode: "observer", implementor: { name, paneId, agentKind, cwd, handoffSubmitted: true } };
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
  throw new Error("usage: herdr_observer.js role | dispatch --name <name> [--kind <kind>] [--cwd <path>] < handoff.txt | wait --name <name> [--cwd <path>]");
}

try {
  process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
