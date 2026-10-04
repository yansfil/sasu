import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { requireRealHide } from "./hide-binary.mjs";

const helper = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(helper), "../../..");
const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// One guardian owns one server. Its inherited pipe closes even if the test
// owner is killed, so the private server cannot outlive the owner on macOS.
if (process.argv[1] === helper && process.argv[2] === "--owned-server") {
  const server = spawn(process.argv[3], ["server"], { stdio: ["ignore", "inherit", "inherit"] });
  let stopping = false, timer, failure;
  const stop = () => {
    if (stopping || exited(server)) return;
    stopping = true; server.kill("SIGTERM");
    timer = setTimeout(() => server.kill("SIGKILL"), 5000); timer.unref();
  };
  const fail = (error) => {
    if (failure) return;
    failure = error;
    console.error(error.stack ?? error);
    const finish = () => { if (!server.pid) process.exit(1); };
    if (process.connected) {
      try { process.send({ type: "failure", code: error.code, message: error.message, serverStarted: !!server.pid }, finish); }
      catch { finish(); }
    } else finish();
    stop();
  };
  const publish = (message, sent = () => {}) => {
    if (!process.send) return sent();
    try { process.send(message, (error) => error ? fail(error) : sent()); }
    catch (error) { fail(error); }
  };
  process.stdin.resume();
  process.stdin.once("end", stop); process.stdin.once("error", stop);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.once("disconnect", stop);
  server.once("spawn", () => publish({ type: "server", pid: server.pid }, () => {
    if (stopping) return;
    try {
      fs.writeFileSync(process.argv[4], JSON.stringify({ owner: process.ppid, guardian: process.pid, server: server.pid, socket: process.env.HERDR_SOCKET_PATH }) + "\n");
      publish({ type: "ready" });
    } catch (error) { fail(error); }
  }));
  server.once("error", fail);
  server.once("exit", (code) => { clearTimeout(timer); process.exit(failure ? 1 : stopping ? 0 : (code ?? 1)); });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(50); }
  throw new Error(`private Herdr fixture timed out: ${label}`);
}

/** Only the explicitly selected candidate can own a unit probe's server. */
export async function privateHerdrFixture(t) {
  const candidate = requireRealHide();
  const runRoot = path.join(repository, "agents/runs/hcoord-retire", `herdr-probe-${crypto.randomUUID()}`);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  let ipc, guardian, guardianError, serverPid, receiptReady = false, serverSpawnFailed = false;
  const owner = path.join(runRoot, "owner.json");
  t.after(async () => {
    let serverExited = !guardian?.pid || serverSpawnFailed;
    try {
      if (guardian?.pid && !exited(guardian)) {
        guardian.stdin.end();
        await waitFor(() => exited(guardian), "owned guardian exit");
      }
      if (serverPid) {
        await waitFor(() => {
          try { process.kill(serverPid, 0); return false; }
          catch (error) { if (error.code === "ESRCH") return true; throw error; }
        }, "owned server exit");
        serverExited = true;
      } else if (!serverExited) {
        throw new Error("private Herdr ownership receipt is missing; server exit cannot be confirmed");
      }
      if (ipc) fs.rmSync(ipc, { recursive: true, force: true });
    } finally {
      fs.writeFileSync(path.join(runRoot, "cleanup.json"), JSON.stringify({ guardian: guardian?.pid ?? null, guardianExitCode: guardian?.exitCode ?? null, server: serverPid ?? null, guardianExited: !guardian || exited(guardian), serverExited, socketRemoved: !ipc || !fs.existsSync(path.join(ipc, "herdr.sock")), ipcRemoved: !ipc || !fs.existsSync(ipc), processCap: 2 }) + "\n");
    }
  });
  // Ignore a harness's arbitrarily deep TMPDIR for the socket namespace.
  ipc = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "sph-")));
  const home = path.join(runRoot, "home"), config = path.join(runRoot, "herdr.toml"), socket = path.join(ipc, "herdr.sock");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(config, `[update]\nversion_check = false\nmanifest_check = false\n[ui.toast]\ndelivery = "off"\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(HERDR_|HIDE_|HCOORD_|CLAUDE_|CODEX_|SASU_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state"), XDG_CACHE_HOME: path.join(home, ".cache"), PATH: [candidate.resources, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter), HERDR_SOCKET_PATH: socket, HERDR_CONFIG_PATH: config, HERDR_SESSION: path.basename(ipc), HERDR_DISABLE_SOUND: "1" });
  const fd = fs.openSync(path.join(runRoot, "herdr.log"), "a", 0o600);
  try { guardian = spawn(process.execPath, [helper, "--owned-server", candidate.herdr, owner], { env, stdio: ["pipe", fd, fd, "ipc"] }); }
  finally { fs.closeSync(fd); }
  guardian.once("error", (error) => { guardianError = error; }); guardian.stdin?.on("error", () => {});
  guardian.on("message", (message) => {
    if (message.type === "server" && Number.isInteger(message.pid) && message.pid > 0) serverPid = message.pid;
    if (message.type === "ready") receiptReady = true;
    if (message.type === "failure") {
      guardianError = Object.assign(new Error(message.message), { code: message.code });
      serverSpawnFailed = message.serverStarted === false;
    }
  });
  await waitFor(() => {
    if (guardianError) throw guardianError;
    if (exited(guardian)) throw new Error("private Herdr fixture exited before its socket was ready; inspect its owned log");
    return !!serverPid && receiptReady && fs.existsSync(socket);
  }, "owned socket readiness");
  const call = (argv, socketPath) => spawnSync(candidate.herdr, argv, { env: { ...env, HERDR_SOCKET_PATH: socketPath }, encoding: "utf8", timeout: 15_000 });
  return { runRoot, run: (argv) => call(argv, socket), disconnected: (argv) => call(argv, path.join(ipc, "missing.sock")) };
}
