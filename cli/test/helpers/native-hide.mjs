import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CLI, makeProject } from "./implement-fixture.mjs";
import { requireRealHide } from "./hide-binary.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const commandRunner = fileURLToPath(new URL("./native-agent-command.cjs", import.meta.url));
async function waitFor(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout; let observed;
  while (Date.now() < deadline) { observed = await predicate(); if (observed) return observed; await delay(50); }
  throw new Error(`native fixture timed out: ${label}`);
}
function childExited(child) { return child.exitCode !== null || child.signalCode !== null; }
async function endChild(child, label) {
  if (!child || childExited(child)) return;
  child.kill("SIGTERM");
  try { await waitFor(() => childExited(child), `${label} SIGTERM exit`, 5000); }
  catch { child.kill("SIGKILL"); await waitFor(() => childExited(child), `${label} SIGKILL exit`, 5000); }
}

/** Unix native provider, the same process-based attestation boundary as Hide's fixture. */
const provider = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>
#include <termios.h>
#include <time.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <fcntl.h>
static volatile sig_atomic_t stopping = 0;
static void stop_runner(int value) { stopping = value; }
static long long now_ms(void) { struct timespec t; if(clock_gettime(CLOCK_MONOTONIC,&t)) exit(1); return (long long)t.tv_sec*1000+t.tv_nsec/1000000; }
static int run_child(char *const args[]) {
  pid_t child=fork(); if(child<0) return 1;
  if(!child) { if(setpgid(0,0)) _exit(1); execv(args[0],args); _exit(1); }
  long long deadline=now_ms()+20000; int status=0,killed=0;
  for(;;) {
    pid_t waited=waitpid(child,&status,WNOHANG);
    if(waited==child) break;
    if(waited<0 && errno!=EINTR) { kill(-child,SIGKILL); kill(child,SIGKILL); exit(1); }
    if((!killed && stopping) || now_ms()>=deadline) { if(killed) exit(1); kill(-child,SIGKILL); kill(child,SIGKILL); killed=1; deadline=now_ms()+5000; }
    struct timespec pause={0,10000000}; nanosleep(&pause,NULL);
  }
  kill(-child,SIGKILL);
  return !killed && WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
`;

export async function nativeHideFixture(t) {
  const candidate = requireRealHide();
  const runRoot = path.join(repository, "agents/runs/hcoord-retire", `native-${crypto.randomUUID()}`);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  // Only IPC files need the operating system's short socket namespace.
  const ipc = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snh-")));
  const home = path.join(runRoot, "home"), bin = path.join(runRoot, "bin"), commands = path.join(runRoot, "commands");
  for (const directory of [home, bin, commands]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(makeProject());
  fs.writeFileSync(path.join(root, "agents/config.json"), JSON.stringify({ worktree: { enabled: false } }));
  const socket = path.join(ipc, "herdr.sock"), config = path.join(runRoot, "herdr.toml");
  fs.writeFileSync(config, `[terminal]\ndefault_shell = "/bin/zsh"\n[update]\nversion_check = false\nmanifest_check = false\n[ui.toast]\ndelivery = "off"\n`);
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='fixture %# '\n");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(HERDR_|HIDE_|HCOORD_|CLAUDE_|CODEX_|SASU_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state"), XDG_CACHE_HOME: path.join(home, ".cache"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"), SHELL: "/bin/zsh", PATH: [bin, candidate.resources, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter), HERDR_SOCKET_PATH: socket, HERDR_CONFIG_PATH: config, HERDR_SESSION: `sasu-test-${path.basename(ipc)}`, HERDR_BIN_PATH: candidate.herdr, HERDR_DISABLE_SOUND: "1", skip_global_compinit: "1", HIDE_STATE_DIR: path.join(ipc, "hide"), HIDE_PORT: "0", HIDE_KEEP_ALIVE: "1", HIDE_OPEN_COMMAND: "/usr/bin/true" });
  const source = path.join(runRoot, "provider.c");
  fs.writeFileSync(source, `${provider}\nstatic const char *herdr=${JSON.stringify(candidate.herdr)}, *node=${JSON.stringify(process.execPath)}, *runner=${JSON.stringify(commandRunner)}, *directory=${JSON.stringify(commands)};
int main(int argc,char **argv) {
  if(argc>1 && !strcmp(argv[1],"--version")) { puts("fixture"); return 0; }
  if(argc>1 && !strcmp(argv[1],"auth")) { puts("{\\"loggedIn\\":true}"); return 0; }
  for(int i=1;i<argc;i++) if(!strcmp(argv[i],"--json-schema")) return 1;
  signal(SIGTERM,stop_runner); signal(SIGHUP,stop_runner); signal(SIGINT,stop_runner);
  const char *pane=getenv("HERDR_PANE_ID"); if(!pane || !*pane) return 1;
  char args_path[4096]; snprintf(args_path,sizeof args_path,"%s/%s.argv",directory,pane);
  int args_log=open(args_path,O_WRONLY|O_CREAT|O_TRUNC,0600); if(args_log<0) return 1;
  for(int i=1;i<argc;i++) if(write(args_log,argv[i],strlen(argv[i])+1)!=(ssize_t)(strlen(argv[i])+1)) return 1;
  close(args_log);
  char session[80]; snprintf(session,sizeof session,"fixture-%d",getpid()); setenv("CLAUDE_SESSION_ID",session,1);
  char *report[]={(char*)herdr,"pane","report-agent-session",(char*)pane,"--source","herdr:claude","--agent","claude","--agent-session-id",session,"--seq","1",NULL};
  if(run_child(report)) return 1;
  struct termios raw; if(tcgetattr(0,&raw)) return 1; raw.c_lflag &= ~(ICANON|ECHO|IEXTEN); raw.c_cc[VMIN]=1; raw.c_cc[VTIME]=0; if(tcsetattr(0,TCSANOW,&raw)) return 1;
  char request[4096], log_path[4096]; snprintf(request,sizeof request,"%s/%s.json",directory,pane); snprintf(log_path,sizeof log_path,"%s/%s.pty",directory,pane);
  int log=open(log_path,O_WRONLY|O_CREAT|O_APPEND,0600); if(log<0) return 1;
  printf("\\r\\nClaude Code fixture\\r\\nclaude fixture ready\\r\\n❯ "); fflush(stdout);
  while(!stopping) {
    if(access(request,F_OK)==0) { char *command[]={(char*)node,(char*)runner,request,NULL}; run_child(command); unlink(request); printf("\\r\\n❯ "); fflush(stdout); }
    fd_set input; FD_ZERO(&input); FD_SET(0,&input); struct timeval timeout={0,50000};
    int ready=select(1,&input,NULL,NULL,&timeout); if(ready<0 && errno!=EINTR) return 1;
    if(ready>0) { char bytes[16384]; ssize_t n=read(0,bytes,sizeof bytes); if(n<=0) break; if(write(log,bytes,(size_t)n)!=n) return 1; }
  }
  close(log); return 0;
}
`);
  let server = null, daemon = null;
  const providerPids = new Set();
  const log = (name) => fs.openSync(path.join(runRoot, name), "a", 0o600);
  const herdr = (argv) => {
    const run = spawnSync(candidate.herdr, argv, { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, `${argv.join(" ")}: ${run.stderr}`);
    const result = JSON.parse(run.stdout);
    if (argv[0] === "agent" && argv[1] === "get") {
      const session = result.result.agent.agent_session?.value;
      if (typeof session === "string" && /^fixture-\d+$/.test(session)) providerPids.add(Number(session.slice("fixture-".length)));
    }
    return result;
  };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    await endChild(daemon, "private hided");
    if (server && !childExited(server)) spawnSync(candidate.herdr, ["server", "stop"], { env, encoding: "utf8", timeout: 10_000 });
    await endChild(server, "private Herdr");
    assert.ok(!daemon || childExited(daemon)); assert.ok(!server || childExited(server));
    await waitFor(() => [...providerPids].every((pid) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }), "owned native provider exits", 5000);
    fs.rmSync(ipc, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(socket), false);
    fs.writeFileSync(path.join(runRoot, "cleanup.json"), JSON.stringify({ daemonExited: true, serverExited: true, providerPidsExited: true, providerCount: providerPids.size, socketRemoved: true }) + "\n");
  };
  t.after(cleanup);
  const compiled = spawnSync("cc", ["-O2", source, "-o", path.join(bin, "claude")], { encoding: "utf8", timeout: 20_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const start = (binary, name) => {
    const fd = log(name); const child = spawn(binary, binary === candidate.herdr ? ["server"] : [], { env, stdio: ["ignore", fd, fd] }); fs.closeSync(fd);
    child.once("error", () => {}); return child;
  };
  server = start(candidate.herdr, "herdr.log");
  await waitFor(() => !childExited(server) && fs.existsSync(socket), "private Herdr socket");
  herdr(["api", "snapshot"]);
  daemon = start(candidate.hided, "hided.log");
  await waitFor(async () => {
    if (childExited(daemon)) throw new Error("private hided exited; inspect its owned log");
    try { const state = JSON.parse(fs.readFileSync(path.join(env.HIDE_STATE_DIR, "hided.json"), "utf8")); return (await fetch(`http://127.0.0.1:${state.port}/health`)).ok; } catch { return false; }
  }, "private hided health");
  const startObserver = async (name) => {
    const created = herdr(["workspace", "create", "--cwd", root, "--label", name, "--env", `PATH=${env.PATH}`, "--no-focus"]).result;
    const pane = created.root_pane.pane_id;
    await waitFor(() => { const info = herdr(["pane", "process-info", "--pane", pane]).result.process_info; return info.shell_pid > 1 && info.foreground_process_group_id === info.shell_pid && info.foreground_processes.every((process) => process.pid === info.shell_pid); }, "Observer shell foreground");
    herdr(["agent", "start", name, "--kind", "claude", "--pane", pane, "--timeout", "10000"]);
    const native = await waitFor(() => {
      const agent = herdr(["agent", "get", pane]).result.agent;
      return agent.agent_session?.value ? agent : null;
    }, "native Observer session");
    const registration = await command(pane, candidate.hide, ["agent", "register", "--host-scope", socket,
      "--session", native.agent_session.value, "--instance", native.terminal_id, "--name", name, "--pane", pane, "--project", root]);
    assert.equal(registration.status, 0, registration.text);
    return pane;
  };
  const command = async (pane, binary, argv, options = {}) => {
    const native = herdr(["agent", "get", pane]).result.agent;
    assert.match(native.agent_session?.value ?? "", /^fixture-\d+$/, "only this private fixture's native provider may run commands");
    const id = crypto.randomUUID(), request = path.join(commands, `${pane}.json`), response = path.join(commands, `${id}.response.json`);
    assert.equal(fs.existsSync(request), false, "one command at a time per real pane");
    fs.writeFileSync(`${request}.pending`, JSON.stringify({ binary, argv, cwd: root, response, ...options })); fs.renameSync(`${request}.pending`, request);
    await waitFor(() => fs.existsSync(response), `native ${argv.slice(0, 2).join(" ")} response`, 25_000);
    await waitFor(() => !fs.existsSync(request), "native command completion");
    const result = JSON.parse(fs.readFileSync(response, "utf8"));
    try { result.json = JSON.parse(result.stdout); } catch { result.json = null; }
    result.text = result.stdout + result.stderr; return result;
  };
  return { root, home, runRoot, candidate, herdr, cleanup, startObserver, command,
    sasu: (pane, argv, options) => command(pane, process.execPath, [CLI, ...argv, "--json"], options),
    hide: (pane, argv) => command(pane, candidate.hide, argv),
  };
}
