import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, PRD_PATH, git, isolatedEnv, makeProject, readState, start } from "./implement-fixture.mjs";
import { installFakeHide } from "./hide-binary.mjs";

export const HANDOFF = "ROLE: Implementor\nGOAL: preserve the approved values\nAUTHORITY: implement only this PRD";

/** #21 boundary fixture: a lead parents the Observer, never a copied Sasu identity. */
export function runtimeFixture(t, { linked = false } = {}) {
  const mainRoot = fs.realpathSync(makeProject({ count: 1 }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-runtime-fixture-")));
  t.after(() => { fs.rmSync(mainRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const root = linked ? path.join(outside, "checkout") : mainRoot;
  if (linked) {
    git(mainRoot, ["worktree", "add", "-b", "work/linked", root]);
    fs.mkdirSync(path.dirname(path.join(root, PRD_PATH)), { recursive: true });
    fs.copyFileSync(path.join(mainRoot, PRD_PATH), path.join(root, PRD_PATH));
  }
  const hide = installFakeHide(outside);
  const observer = { id: "observer", name: "observer", machine: "local", hostScope: path.join(outside, "herdr.sock"), pane: "fixture:p0", parent: "lead", project: root, runtime: "running", registered: true };
  const home = path.join(outside, "home");
  fs.mkdirSync(home);
  const env = { ...hide.env, HOME: home, HERDR_ENV: "1", HERDR_PANE_ID: observer.pane, HERDR_SOCKET_PATH: observer.hostScope, CODEX_SESSION_ID: "original-session" };
  const runtime = () => JSON.parse(fs.readFileSync(hide.state, "utf8"));
  const writeRuntime = (value) => fs.writeFileSync(hide.state, JSON.stringify(value));
  writeRuntime({ seq: 0, participants: { observer }, spawns: {} });
  start(root, { env });
  function cli(args, { input = "", env: overrides = {} } = {}) {
    const result = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8", input, env: isolatedEnv({ ...env, ...overrides }), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    let json;
    try { json = JSON.parse(result.stdout); } catch { json = { stdout: result.stdout, stderr: result.stderr }; }
    return { ...result, json, text: result.stderr + result.stdout };
  }
  function execute(instruction) {
    const result = spawnSync("/bin/sh", ["-c", instruction.command], { cwd: root, encoding: "utf8", env: isolatedEnv(env), timeout: 30_000 });
    return { ...result, json: JSON.parse(result.stdout) };
  }
  const dispatch = (flags = [], options = {}) => cli(["implement", "dispatch", "--name", "impl", ...flags], { input: HANDOFF, ...options });
  return { root, mainRoot, outside, observer, env, hide, runtime, writeRuntime, cli, dispatch, execute, state: () => readState(root) };
}
