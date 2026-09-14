// Live before/after comparison for issue #3: same fixture, same contract, same
// judge profile, one CLI build per label. Usage: node run.mjs <label> <cli.js> <outDir>
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [label, cli, outDir] = process.argv.slice(2);
if (!label || !cli || !outDir) throw new Error("usage: run.mjs <label> <cli.js> <outDir>");
fs.mkdirSync(outDir, { recursive: true });
const root = path.join(outDir, "project");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "lib"), { recursive: true });
fs.mkdirSync(path.join(root, "agents/prd/exp"), { recursive: true });

const PRD_PATH = "agents/prd/exp/prd.md";
const rows = Array.from({ length: 30 }, (_, i) => `| B${i + 1} | The exported command(${i + 1}) function returns the number ${i + 1}. | D-01 |`);
rows.push("| B31 | If the injected store throws while saving, save returns ok false with the error message and preserves the input value. | D-02 |");
fs.writeFileSync(path.join(root, PRD_PATH), `---
topic: "incremental review experiment"
status: "ready"
human_approval: "approved"
review_profile: "standard"
review_rationale: "harness measurement fixture"
source_intake: "current conversation"
---

# PRD: incremental review experiment

## Goal
The public command returns every requested number and save reports storage failures honestly.

## Non-goals
No network service, no persistence beyond the injected store, no CLI.

## Decisions
| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | command(n) returns the number n for 1 through 30 and formats every value through present in src/format.mjs. | The user requested all thirty values through one shared formatter. |
| D-02 | save never throws; a store failure is reported as ok false with the error message and the original value. | Callers must be able to retry with the same value. |

## Behaviors
| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
${rows.join("\n")}

## Technical structure
The public API is command and save exported from src/public.mjs; command dispatches to value functions in src/values.mjs and formats each result through present in src/format.mjs. lib/ holds unrelated report modules.

## Risks
None.
`);
fs.writeFileSync(path.join(root, ".gitignore"), "agents/\nnode_modules/\n");
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "exp", type: "module", scripts: { test: "node smoke.test.mjs" } }, null, 2));
fs.writeFileSync(path.join(root, "smoke.test.mjs"), `import { command, save } from "./src/public.mjs";
if (command(1) !== 1 || command(2) !== 2) { console.error("smoke: command(1..2) wrong"); process.exit(1); }
const failed = save({ write() { throw new Error("disk full"); } }, "draft");
if (failed.ok !== false) { console.error("smoke: save did not report failure"); process.exit(1); }
console.log("smoke ok: command(1)=1 command(2)=2 save-failure reported");
`);
for (let i = 1; i <= 60; i += 1) {
  fs.writeFileSync(path.join(root, "lib", `report${i}.mjs`), `// Report module ${i}: formats a summary line for dashboard ${i}.\nexport function report${i}(rows) {\n  return rows.map((row) => \`${i}:\${row.id}=\${row.total}\`).join("\\n");\n}\nexport const REPORT_${i}_VERSION = ${i};\n`);
}
fs.writeFileSync(path.join(root, "src/public.mjs"), `export function command() { throw new Error("not implemented"); }\nexport function save() { throw new Error("not implemented"); }\n`);
const git = (args) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=exp", "-c", "user.email=exp@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]);

const values = (mutate = (i, body) => body) => Array.from({ length: 30 }, (_, i) => `export function value${i + 1}() { ${mutate(i + 1, `return ${i + 1};`)} }`).join("\n") + "\n";
const format = (body = "return value;") => `// Shared presentation helper used by every public command result.\nexport function present(value) { ${body} }\n`;
const publicSource = `import { ${Array.from({ length: 30 }, (_, i) => `value${i + 1}`).join(", ")} } from "./values.mjs";
import { present } from "./format.mjs";
const actions = [${Array.from({ length: 30 }, (_, i) => `value${i + 1}`).join(", ")}];
export function command(n) { return present(actions[n - 1]?.()); }
export function save(store, value) {
  try { store.write(value); return { ok: true }; }
  catch (error) {
    let message = "store failure";
    try { message = error instanceof Error && typeof error.message === "string" ? error.message : typeof error === "string" ? error : "store failure"; } catch { message = "store failure"; }
    return { ok: false, error: message, value };
  }
}
`;
const write = (rel, text) => fs.writeFileSync(path.join(root, rel), text);

function env() {
  const e = { ...process.env };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "SASU_HERDR_ROLE", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", ...(process.env.EXP_STUB ? [] : ["SASU_JUDGE_BACKEND", "SASU_JUDGE_STUB_FILE"])]) delete e[key];
  return e;
}
function sasu(args, log) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: root, encoding: "utf8", env: env(), maxBuffer: 64 * 1024 * 1024 });
  if (log) fs.writeFileSync(log, `$ sasu ${args.join(" ")}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, wallMs: Date.now() - started, stderr: r.stderr };
}
const state = () => JSON.parse(fs.readFileSync(path.join(root, "agents/runs/exp/state.json"), "utf8"));

const rounds = [];
function record(name, expected, outcome) {
  const s = state();
  const attempt = s.verificationAttempts.at(-1);
  const lane = (l) => l === null ? null : { verdict: l.verdict, durationMs: l.durationMs, carriedFrom: l.carriedFrom ?? null, backend: l.judge?.backend ?? null, model: l.judge?.model ?? null, attempts: l.judge?.attempts ?? null, retries: (l.judge?.retries ?? []).map((r) => `${r.code}/${r.reason}`),
    readRounds: l.judge?.activity?.readRounds ?? null, readOutputChars: l.judge?.activity?.readOutputChars ?? null, commands: l.judge?.activity?.commands?.length ?? null, usage: l.judge?.usage ?? null, error: l.error?.message ?? null,
    scope: l.result?.scope ?? null, carriedAssessments: l.result?.assessments?.filter((a) => a.basis === "carried").length ?? null, assessments: l.result?.assessments?.map((a) => ({ refs: a.requirementRefs, conclusion: a.conclusion, basis: a.basis ?? "reviewed" })) ?? null,
    findings: l.result?.findings?.map((f) => ({ kind: f.kind, refs: f.requirementRefs, problem: f.problem.slice(0, 200) })) ?? null, dispositions: l.result?.priorDispositions ?? null };
  const entry = { round: name, expected, verifyStatus: outcome.status, verifyWallMs: outcome.wallMs, verdict: attempt.verdict, error: attempt.error, reviewScope: attempt.reviewScope ?? null,
    mechanical: attempt.mechanical.map((m) => ({ status: m.status, durationMs: m.durationMs })), roundContext: { changedPaths: attempt.roundContext.changedPaths, newEvidence: attempt.roundContext.newEvidence.map((e) => e.path) },
    fidelity: lane(attempt.reviews.fidelity), code: lane(attempt.reviews.code), openFindings: s.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, kind: f.kind, refs: f.requirementRefs, problem: f.problem.slice(0, 200) })), findingCount: s.findings.length };
  rounds.push(entry);
  fs.writeFileSync(path.join(outDir, "rounds.json"), JSON.stringify(rounds, null, 2));
  console.log(`[${label}] ${name}: verify=${outcome.status} verdict=${attempt.verdict} scope=${attempt.reviewScope?.mode ?? "n/a"} wall=${(outcome.wallMs / 1000).toFixed(0)}s fid=${entry.fidelity?.verdict}/${((entry.fidelity?.durationMs ?? 0) / 1000).toFixed(0)}s/${entry.fidelity?.readRounds}r/${entry.fidelity?.readOutputChars}c code=${entry.code?.verdict}/${((entry.code?.durationMs ?? 0) / 1000).toFixed(0)}s/${entry.code?.readRounds}r/${entry.code?.readOutputChars}c`);
}

const started = sasu(["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], path.join(outDir, "start.log"));
if (started.status !== 0) throw new Error(`start failed: ${started.stderr}`);
write("src/values.mjs", values()); write("src/format.mjs", format()); write("src/public.mjs", publicSource);

// R1: the whole product, correct.
record("R1-initial-full", "PASS", sasu(["implement", "verify"], path.join(outDir, "R1.log")));
// R2: a behavior-preserving local refactor of one value.
write("src/values.mjs", values((i, body) => i === 7 ? "const seven = 3 + 4; return seven;" : body));
record("R2-local-refactor", "PASS", sasu(["implement", "verify"], path.join(outDir, "R2.log")));
// R3: a two-line change to the shared helper every command runs through; the suite still passes.
write("src/format.mjs", format("if (typeof value === \"number\" && value > 24) return undefined;\n  return value;"));
record("R3-shared-helper-defect", "FAIL naming some of B25..B30", sasu(["implement", "verify"], path.join(outDir, "R3.log")));
// R3b: the fix; both roles must resolve the finding.
write("src/format.mjs", format());
record("R3b-helper-fix", "PASS with F resolved", sasu(["implement", "verify"], path.join(outDir, "R3b.log")));
// R4: source untouched except an unrelated comment; a new registered runtime observation contradicts the settled B30 ground.
write("lib/report1.mjs", fs.readFileSync(path.join(root, "lib/report1.mjs"), "utf8").replace("// Report module 1:", "// Report module 1 (reviewed):"));
fs.mkdirSync(path.join(root, "agents/observations"), { recursive: true });
write("agents/observations/runtime.log", `$ node -e 'import("./src/public.mjs").then((m) => { for (const n of [1, 15, 29, 30]) console.log("command(" + n + ")=", m.command(n)); })'\ncommand(1)= 1\ncommand(15)= 15\ncommand(29)= 29\ncommand(30)= undefined\n`);
const registered = sasu(["implement", "artifact", "--kind", "log", "--path", "agents/observations/runtime.log", "--description", "Runtime observation of command(n) for n in 1, 15, 29, 30 on the current source", "--source", "operator, node -e over the working tree", "--collected-at", new Date().toISOString(), "--target", "src/public.mjs working tree", "--environment", "local node"], path.join(outDir, "R4-artifact.log"));
if (registered.status !== 0) throw new Error(`artifact failed: ${registered.stderr}`);
record("R4-contradicting-evidence", "not a clean PASS on B30: a finding or an unresolved B30 assessment", sasu(["implement", "verify"], path.join(outDir, "R4.log")));
fs.copyFileSync(path.join(root, "agents/runs/exp/state.json"), path.join(outDir, "state.json"));
console.log(`[${label}] done`);
