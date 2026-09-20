// A herdr CLI stand-in for tests that drive the real sasu binary.
//
// It answers the argv the harness sends with the shapes herdr 0.9.1 answers
// them (measured 2026-09-18), records every call, and reads the agents it
// reports from a JSON file the test edits between calls. No test may reach a
// live pane (B20): a fake on PATH is the only herdr a spawned CLI can find.
//
// Environment:
//   HERDR_FAKE_LOG           append one JSON argv per line
//   HERDR_FAKE_AGENTS_FILE   JSON object of agents keyed by pane id
//   HERDR_FAKE_GUARD_SUPPORT "1" makes `agent prompt` accept --expected-input-guard
//   HERDR_FAKE_DOWN          "1" makes every call fail like a dead socket
//   HERDR_FAKE_REQUIRED_SOCKET_PATH fails calls routed to any other socket
import fs from "node:fs";
import path from "node:path";

export const FAKE_HERDR_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.HERDR_FAKE_LOG) fs.appendFileSync(process.env.HERDR_FAKE_LOG, JSON.stringify(argv) + "\\n");
const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const refuse = (code, message, status = 1) => { process.stderr.write(JSON.stringify({ error: { code, message }, id: "cli:fake" })); process.exit(status); };
if (process.env.HERDR_FAKE_DOWN === "1") { process.stderr.write("error: failed to connect to the herdr socket\\n"); process.exit(1); }
if (process.env.HERDR_FAKE_REQUIRED_SOCKET_PATH && process.env.HERDR_SOCKET_PATH !== process.env.HERDR_FAKE_REQUIRED_SOCKET_PATH) refuse("wrong_socket", "call reached the wrong herdr socket");
const agents = () => {
  const file = process.env.HERDR_FAKE_AGENTS_FILE;
  const scripted = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return { "w4G:p12": { agent: "claude", agent_status: "working", pane_id: "w4G:p12", terminal_id: "term_observer", agent_session: { value: "observer-session" }, tokens: { activity: "1000" }, state_change_seq: 1 }, ...scripted };
};
const key = argv.slice(0, 2).join(" ");
if (argv[0] === "--version") { process.stdout.write("herdr fake 0.9.1\\n"); process.exit(0); }
if (key === "agent list") answer({ result: { type: "agent_list", agents: Object.values(agents()) } });
if (key === "agent get") {
  const target = argv[2];
  if (process.env.HERDR_FAKE_FAIL_GET_TARGET === target) refuse("scripted_get_failure", "scripted agent get failure");
  const found = Object.values(agents()).find((agent) => agent.pane_id === target || agent.name === target);
  if (!found) refuse("agent_not_found", "agent target " + target + " not found");
  answer({ result: { type: "agent_info", agent: found } });
}
if (key === "agent start") {
  const name = argv[2];
  const pane = argv[argv.indexOf("--pane") + 1];
  const kind = argv[argv.indexOf("--kind") + 1];
  const file = process.env.HERDR_FAKE_AGENTS_FILE;
  const current = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  current[pane] = { name, agent: kind, agent_status: "working", pane_id: pane, terminal_id: "term_impl", agent_session: { value: "impl-session" }, tokens: { activity: String(Date.now()) }, state_change_seq: 1 };
  if (file) fs.writeFileSync(file, JSON.stringify(current));
  answer({ result: { type: "agent_started" } });
}
if (key === "agent prompt") {
  if (argv[2] === "--help") { process.stdout.write("Submit a prompt to an agent\\n" + (process.env.HERDR_FAKE_GUARD_SUPPORT === "1" ? "  --expected-input-guard <GUARD>\\n" : "")); process.exit(0); }
  const target = argv[2];
  const guardIndex = argv.indexOf("--expected-input-guard");
  if (guardIndex !== -1 && process.env.HERDR_FAKE_GUARD_SUPPORT !== "1") { process.stderr.write("unknown option: --expected-input-guard\\n"); process.exit(2); }
  const found = Object.values(agents()).find((agent) => agent.pane_id === target || agent.name === target);
  // A pane id nobody scripted is an empty pane; a bare name is an agent this
  // fake was asked to start earlier and accepts input for.
  if (!found && target.includes(":")) refuse("agent_not_found", "agent target " + target + " not found");
  if (found && found.agent_status === "blocked") refuse("agent_blocked", "agent is blocked");
  if (found && guardIndex !== -1 && argv[guardIndex + 1] !== found.input_guard) refuse("agent_input_guard_mismatch", "input guard mismatch");
  if (process.env.HERDR_FAKE_PROMPT_FAIL === "1") { process.stderr.write("scripted prompt failure\\n"); process.exit(1); }
  if (process.env.HERDR_FAKE_PROMPT_LOG) fs.appendFileSync(process.env.HERDR_FAKE_PROMPT_LOG, JSON.stringify({ target, text: argv[3], guard: guardIndex === -1 ? null : argv[guardIndex + 1] }) + "\\n");
  // E2E kill tests stop the whole spawned process group after the observable
  // prompt effect but before the wrapper can report success. The barrier
  // makes that failure boundary exact instead of relying on scheduler timing.
  if (process.env.HERDR_FAKE_PROMPT_BARRIER_READY) {
    fs.writeFileSync(process.env.HERDR_FAKE_PROMPT_BARRIER_READY, "ready\\n");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!process.env.HERDR_FAKE_PROMPT_BARRIER_RELEASE || !fs.existsSync(process.env.HERDR_FAKE_PROMPT_BARRIER_RELEASE)) Atomics.wait(wait, 0, 0, 25);
  }
  answer({ result: { type: "agent_prompt", outcome: "submitted" } });
}
if (key === "workspace create") answer({ result: { type: "workspace_created", workspace: { workspace_id: "w7Z" }, tab: { tab_id: "w7Z:t1" }, root_pane: { pane_id: "w7Z:p1" } } });
if (key === "tab create") answer({ result: { type: "tab_created", tab: { tab_id: "w4G:t9" }, root_pane: { pane_id: "w4G:p13" } } });
answer({ result: {} });
`;

/** Install the fake into `<root>/fake-bin` and return the env a spawned CLI needs to find and script it. */
export function installFakeHerdr(root) {
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "herdr"), FAKE_HERDR_SOURCE, { mode: 0o755 });
  const log = path.join(root, "herdr-argv.log");
  const agentsFile = path.join(root, "herdr-agents.json");
  const promptLog = path.join(root, "herdr-prompts.log");
  return {
    bin,
    log,
    agentsFile,
    promptLog,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HERDR_FAKE_LOG: log, HERDR_FAKE_AGENTS_FILE: agentsFile, HERDR_FAKE_PROMPT_LOG: promptLog },
    /** Replace the scripted agents wholesale. */
    setAgents(agents) { fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2)); },
    /** Merge fields into one scripted agent. */
    patchAgent(paneId, fields) {
      const current = fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, "utf8")) : {};
      current[paneId] = { ...(current[paneId] ?? {}), ...fields };
      fs.writeFileSync(agentsFile, JSON.stringify(current, null, 2));
    },
    argv() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; },
    prompts() { return fs.existsSync(promptLog) ? fs.readFileSync(promptLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; },
  };
}

/** A launchctl that records argv and answers from a state file, so no test touches the real launchd domain. */
export const FAKE_LAUNCHCTL_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.LAUNCHCTL_FAKE_LOG) fs.appendFileSync(process.env.LAUNCHCTL_FAKE_LOG, JSON.stringify(argv) + "\\n");
const stateFile = process.env.LAUNCHCTL_FAKE_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { loaded: {} };
const save = () => stateFile && fs.writeFileSync(stateFile, JSON.stringify(state));
const label = (target) => String(target).split("/").pop();
if (argv[0] === "print") {
  if (state.loaded[label(argv[1])]) { process.stdout.write("service loaded"); process.exit(0); }
  process.stderr.write("Could not find service \\"" + label(argv[1]) + "\\" in domain for user gui\\n"); process.exit(113);
}
if (argv[0] === "bootstrap") { const plist = argv[2]; if (!fs.existsSync(plist)) { process.stderr.write("Bootstrap failed: 5: Input/output error\\n"); process.exit(5); } state.loaded[require("node:path").basename(plist, ".plist")] = plist; save(); process.exit(0); }
if (argv[0] === "bootout") { delete state.loaded[label(argv[1])]; save(); process.exit(0); }
if (argv[0] === "kickstart") { if (!state.loaded[label(argv[1])]) { process.stderr.write("Could not find service\\n"); process.exit(113); } state.kicked = (state.kicked ?? 0) + 1; save(); process.exit(0); }
process.stderr.write("Usage: launchctl <subcommand>\\n"); process.exit(64);
`;

export function installFakeLaunchctl(root) {
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "launchctl"), FAKE_LAUNCHCTL_SOURCE, { mode: 0o755 });
  const log = path.join(root, "launchctl-argv.log");
  const stateFile = path.join(root, "launchctl-state.json");
  return {
    bin,
    log,
    stateFile,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, LAUNCHCTL_FAKE_LOG: log, LAUNCHCTL_FAKE_STATE: stateFile },
    argv() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; },
    state() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { loaded: {} }; },
  };
}
