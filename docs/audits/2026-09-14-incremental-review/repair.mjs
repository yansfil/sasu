// Live repair measurement. Continues the run left by run.mjs in <outDir>/project.
// R5: verify while killing the Code lane's judge process (Codex, then its Claude fallback) so that
// exactly one lane ends in a real backend error. R6: verify again on identical input.
// Usage: node repair.mjs <label> <cli.js> <outDir>
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const [label, cli, outDir] = process.argv.slice(2);
const root = path.join(outDir, "project");
function env() {
  const e = { ...process.env };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "SASU_HERDR_ROLE", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "SASU_JUDGE_BACKEND", "SASU_JUDGE_STUB_FILE"]) delete e[key];
  return e;
}
const state = () => JSON.parse(fs.readFileSync(path.join(root, "agents/runs/exp/state.json"), "utf8"));
const children = (pid) => { const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }); return r.stdout.split("\n").filter(Boolean).map(Number); };
const argv = (pid) => spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${label}] ${m}`);

async function verify(name, log_, sabotage, extra = []) {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, "implement", "verify", "--json", ...extra], { cwd: root, env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const events = [];
  if (sabotage) {
    const seen = new Set();
    let codeCodex = null, killedCodex = false, killedFallback = false;
    let done = false; exit.then(() => { done = true; });
    while (!done && !(killedCodex && killedFallback)) {
      for (const pid of children(child.pid)) {
        if (seen.has(pid)) continue;
        const cmd = argv(pid);
        if (cmd === "") continue;
        seen.add(pid);
        const head = cmd.slice(0, 200).replace(/\s+/g, " ");
        if (!killedCodex && /independent Code reviewer/.test(cmd)) {
          codeCodex = pid; process.kill(pid, "SIGKILL"); killedCodex = true;
          events.push({ at: Date.now() - started, action: "SIGKILL code-lane codex", pid, head }); log(`killed code-lane codex pid ${pid} at ${Date.now() - started}ms`);
        } else if (killedCodex && !killedFallback && !/independent Fidelity reviewer/.test(cmd) && /claude/.test(head)) {
          process.kill(pid, "SIGKILL"); killedFallback = true;
          events.push({ at: Date.now() - started, action: "SIGKILL code-lane claude fallback", pid, head }); log(`killed code-lane claude pid ${pid} at ${Date.now() - started}ms`);
        } else {
          events.push({ at: Date.now() - started, action: "observed", pid, head });
        }
      }
      await sleep(300);
    }
  }
  const code = await exit;
  fs.writeFileSync(log_, `$ sasu implement verify --json\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  return { status: code, wallMs: Date.now() - started, events };
}

const lane = (l) => l === null ? null : { verdict: l.verdict, durationMs: l.durationMs, carriedFrom: l.carriedFrom ?? null, backend: l.judge?.backend ?? null, model: l.judge?.model ?? null, attempts: l.judge?.attempts ?? null, retries: (l.judge?.retries ?? []).map((r) => `${r.code}/${r.reason}`), fallback: l.judge?.fallback ?? null,
  readRounds: l.judge?.activity?.readRounds ?? null, readOutputChars: l.judge?.activity?.readOutputChars ?? null, usage: l.judge?.usage ?? null, error: l.error?.message ?? null, scope: l.result?.scope ?? null,
  carriedAssessments: l.result?.assessments?.filter((a) => a.basis === "carried").length ?? null, assessments: l.result?.assessments?.map((a) => ({ refs: a.requirementRefs, conclusion: a.conclusion, basis: a.basis ?? "reviewed" })) ?? null,
  findings: l.result?.findings?.map((f) => ({ kind: f.kind, refs: f.requirementRefs, problem: f.problem.slice(0, 200) })) ?? null, dispositions: l.result?.priorDispositions ?? null };
const rounds = [];
function record(name, expected, outcome) {
  const s = state();
  const attempt = s.verificationAttempts.at(-1);
  const entry = { round: name, expected, verifyStatus: outcome.status, verifyWallMs: outcome.wallMs, sabotage: outcome.events, verdict: attempt.verdict, error: attempt.error ?? null, deviations: (attempt.deviations ?? []).map((d) => d.code ?? d), reviewScope: attempt.reviewScope ?? null,
    mechanical: attempt.mechanical.map((m) => ({ status: m.status, durationMs: m.durationMs })), roundContext: { changedPaths: attempt.roundContext.changedPaths, newEvidence: attempt.roundContext.newEvidence.map((e) => e.path) },
    fidelity: lane(attempt.reviews.fidelity), code: lane(attempt.reviews.code), openFindings: s.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, kind: f.kind, refs: f.requirementRefs })), findingCount: s.findings.length, attemptCount: s.verificationAttempts.length };
  rounds.push(entry);
  fs.writeFileSync(path.join(outDir, "rounds-repair.json"), JSON.stringify(rounds, null, 2));
  log(`${name}: verify=${outcome.status} verdict=${attempt.verdict} error=${attempt.error?.message ?? attempt.error ?? "-"} scope=${attempt.reviewScope?.mode ?? "n/a"} carried=${JSON.stringify(attempt.reviewScope?.carriedLanes ?? null)} wall=${(outcome.wallMs / 1000).toFixed(0)}s fid=${entry.fidelity?.verdict}/${((entry.fidelity?.durationMs ?? 0) / 1000).toFixed(0)}s/${entry.fidelity?.readRounds}r/${entry.fidelity?.readOutputChars}c/from=${entry.fidelity?.carriedFrom?.slice(0, 8) ?? "-"} code=${entry.code?.verdict}/${((entry.code?.durationMs ?? 0) / 1000).toFixed(0)}s/${entry.code?.readRounds}r/${entry.code?.readOutputChars}c err=${entry.code?.error ?? "-"}`);
}

record("R5-code-lane-backend-error", "attempt error at review; fidelity settled, code lane backend error", await verify("R5", path.join(outDir, "R5.log"), true, process.env.REPAIR_GRANT ? ["--grant-budget", process.env.REPAIR_GRANT] : []));
record("R6-same-input-after-error", label === "candidate" ? "repair: fidelity reused, only code lane executed" : "full re-review of both lanes", await verify("R6", path.join(outDir, "R6.log"), false));
fs.copyFileSync(path.join(root, "agents/runs/exp/state.json"), path.join(outDir, "state.json"));
log("done");
