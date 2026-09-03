#!/usr/bin/env node
// AC13 live judge run (PRD gate-loop, judged criterion): run the real spec
// gate over the fixture pair in which the Decision Register marks D-02
// `resolved` while the Raw Q&A turn it cites (Q2) carries no user answer,
// and the PRD transcribes D-02. The fidelity lane must report it. The run
// happens in a scratch project so no real run directory is touched; the
// verdict, the findings, and the round artifact are copied into the
// gate-loop run directory as the criterion's evidence.
//
// Usage: node cli/scripts/gate_loop_ac13.mjs --out <agents/runs/gate-loop/ac13>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "..", "dist", "cli.js");
const FIXTURES = path.resolve(HERE, "..", "test", "fixtures", "gate-loop", "ac13");

const outIndex = process.argv.indexOf("--out");
if (outIndex === -1 || !process.argv[outIndex + 1]) throw new Error("--out <dir> is required");
const out = path.resolve(process.argv[outIndex + 1]);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-gate-loop-ac13-"));
fs.mkdirSync(path.join(scratch, "agents"), { recursive: true });
fs.copyFileSync(path.join(FIXTURES, "qa-log.md"), path.join(scratch, "qa-log.md"));
fs.copyFileSync(path.join(FIXTURES, "prd.md"), path.join(scratch, "prd.md"));

const env = { ...process.env };
delete env.SASU_HERDR_ROLE;
delete env.SASU_JUDGE_BACKEND;
delete env.SASU_JUDGE_STUB_FILE;
const started = Date.now();
const run = spawnSync(process.execPath, [CLI, "gate", "spec", "--slug", "ac13", "--prd", "prd.md", "--qa-log", "qa-log.md", "--json"], {
  cwd: scratch,
  encoding: "utf8",
  env,
});
const durationMs = Date.now() - started;
let result;
try {
  result = JSON.parse(run.stdout);
} catch {
  throw new Error(`spec gate produced no JSON (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
}
const gates = JSON.parse(fs.readFileSync(path.join(scratch, "agents", "runs", "ac13", "gates", "gates.json"), "utf8"));
const artifactRel = gates.gates.spec.history.at(-1)?.artifact ?? null;
const artifact = artifactRel ? JSON.parse(fs.readFileSync(path.join(scratch, artifactRel), "utf8")) : null;
const fidelityLane = artifact?.lanes?.find((lane) => lane.laneId === "fidelity") ?? null;
const findings = [...(result.status?.findings ?? []), ...(result.status?.warnings ?? [])];
const catches = findings.filter((f) => /D-02|Q2|retention|30 days|resolved/i.test(`${f.missing} ${f.recommendation}`));

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "spec-result.json"), `${JSON.stringify(result, null, 2)}\n`);
if (artifact) fs.writeFileSync(path.join(out, "spec-artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
fs.writeFileSync(path.join(out, "gates.json"), fs.readFileSync(path.join(scratch, "agents", "runs", "ac13", "gates", "gates.json")));
const summary = [
  "# AC13 live spec run",
  "",
  `Generated ${new Date().toISOString()} by cli/scripts/gate_loop_ac13.mjs on fixtures cli/test/fixtures/gate-loop/ac13.`,
  "",
  `- exit: ${run.status}, verdict: ${result.status?.verdict ?? "n/a"}, effective: ${result.status?.effective ?? "n/a"}, wall clock: ${(durationMs / 1000).toFixed(1)}s`,
  `- lanes: ${(artifact?.lanes ?? []).map((lane) => `${lane.laneId}=${lane.verdict} (${lane.findingCount} finding(s), ${Math.round((lane.judge?.durationMs ?? 0) / 1000)}s, ${lane.judge?.backend ?? "?"}/${lane.judge?.model ?? "?"}/${lane.judge?.effort ?? "?"})`).join("; ") || "none"}`,
  `- findings naming the D-02/Q2 resolved-without-answer case: ${catches.length} of ${findings.length}`,
  "",
  "## Findings",
  "",
  ...(findings.length === 0 ? ["- none"] : findings.map((f) => `- ${f.id ?? "?"} [${f.severity}/${f.area}]${f.requiresHuman ? " [needs human decision]" : ""} ${f.missing}\n  fix: ${f.recommendation}`)),
  "",
  `Fidelity lane judge record: ${JSON.stringify(fidelityLane?.judge ?? null)}`,
  "",
];
fs.writeFileSync(path.join(out, "ac13.md"), summary.join("\n"));
process.stdout.write(`${summary.slice(0, 8).join("\n")}\nwritten: ${out}\n`);
process.exit(catches.length > 0 ? 0 : 1);
