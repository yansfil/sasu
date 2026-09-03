#!/usr/bin/env node
// AC16 replay (PRD gate-loop, judged criterion): run the rebuilt gap-audit
// loop over copies of the three interview logs whose original loops are
// recorded in baseline.md, with real judges, and record how each loop ends.
// The originals are never touched: each log is copied into the gate-loop run
// directory and judged from a scratch project root. Because the copies are
// the final, already-sealed documents, an agent-fixable BLOCK cannot be fixed
// mid-replay; the loop reruns once so the open set's subset rule is observed,
// then stops. The record is honest about a BLOCK-stable end.
//
// Usage:
//   node cli/scripts/gate_loop_replay.mjs --run-dir <agents/runs/gate-loop> \
//     <slug>=<path/to/qa-log.md> [<slug>=<path> ...] [--max-rounds 2]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "..", "dist", "cli.js");

function parseArgs(argv) {
  let runDir = null;
  let maxRounds = 2;
  const sources = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-dir") { runDir = path.resolve(argv[i + 1]); i += 1; continue; }
    if (arg === "--max-rounds") { maxRounds = Number(argv[i + 1]); i += 1; continue; }
    if (arg === "--render-only") continue;
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new Error(`expected <slug>=<qa-log.md>, got: ${arg}`);
    sources.push({ slug: arg.slice(0, eq), file: path.resolve(arg.slice(eq + 1)) });
  }
  if (!runDir) throw new Error("--run-dir <agents/runs/gate-loop> is required");
  if (sources.length === 0 && !argv.includes("--render-only")) throw new Error("at least one <slug>=<qa-log.md> is required");
  return { runDir, maxRounds, sources };
}

function cli(cwd, args) {
  const env = { ...process.env };
  delete env.SASU_HERDR_ROLE;
  delete env.SASU_JUDGE_BACKEND;
  delete env.SASU_JUDGE_STUB_FILE;
  const started = Date.now();
  const run = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(run.stdout); } catch { json = null; }
  return { status: run.status, json, stderr: run.stderr, stdout: run.stdout, durationMs: Date.now() - started };
}

function replayOne(source, runDir, maxRounds) {
  const copyDir = path.join(runDir, "replay", source.slug);
  fs.mkdirSync(copyDir, { recursive: true });
  const copy = path.join(copyDir, "qa-log.md");
  fs.copyFileSync(source.file, copy);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `sasu-gate-loop-replay-${source.slug}-`));
  fs.mkdirSync(path.join(scratch, "agents", "interview", source.slug), { recursive: true });
  const scratchLog = path.join(scratch, "agents", "interview", source.slug, "qa-log.md");
  fs.copyFileSync(copy, scratchLog);
  const rounds = [];
  const startedAt = new Date().toISOString();
  for (let round = 1; round <= maxRounds; round += 1) {
    const result = cli(scratch, ["gate", "gap-audit", "--slug", source.slug, "--qa-log", `agents/interview/${source.slug}/qa-log.md`]);
    const status = result.json?.status ?? null;
    const gates = JSON.parse(fs.readFileSync(path.join(scratch, "agents", "runs", source.slug, "gates", "gates.json"), "utf8"));
    const artifactRel = gates.gates["gap-audit"].history.at(-1)?.artifact ?? null;
    const artifact = artifactRel ? JSON.parse(fs.readFileSync(path.join(scratch, artifactRel), "utf8")) : null;
    const lanes = artifact?.lanes ?? [];
    rounds.push({
      round,
      at: new Date().toISOString(),
      exit: result.status,
      verdict: status?.verdict ?? "ERROR",
      effective: status?.effective ?? "n/a",
      open: (status?.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, area: f.area, requiresHuman: f.requiresHuman, missing: f.missing })),
      warnings: (status?.warnings ?? []).length,
      resolved: artifact?.resolvedFindings?.length ?? 0,
      dropped: artifact?.droppedFindings?.length ?? 0,
      laneCalls: lanes.length,
      laneDurationsMs: lanes.map((lane) => lane.judge?.durationMs ?? 0),
      effort: lanes[0]?.judge?.effort ?? null,
      model: lanes[0]?.judge?.model ?? null,
      durationMs: result.durationMs,
      error: result.json?.error ?? null,
    });
    if (status?.verdict !== "BLOCK") break;
  }
  // Keep the whole scratch record (state, artifacts, the log the harness
  // wrote its Audit entries into) beside the copy.
  fs.cpSync(path.join(scratch, "agents", "runs", source.slug, "gates"), path.join(copyDir, "gates"), { recursive: true });
  fs.copyFileSync(scratchLog, path.join(copyDir, "qa-log.after.md"));
  return { slug: source.slug, source: source.file, startedAt, finishedAt: new Date().toISOString(), rounds };
}

function minutes(a, b) {
  return ((Date.parse(b) - Date.parse(a)) / 60_000).toFixed(1);
}

function render(results, maxRounds) {
  const lines = [
    "# gate-loop replay",
    "",
    `Generated ${new Date().toISOString()} by cli/scripts/gate_loop_replay.mjs on copies of the three interview logs; real judges; at most ${maxRounds} round(s) per loop because the copies are final documents nobody can fix mid-replay.`,
    "",
    "## Summary",
    "",
    "| session | rounds | lane calls | wall clock (min) | ending | open at end |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const last = r.rounds.at(-1);
    const calls = r.rounds.reduce((n, round) => n + round.laneCalls, 0);
    const human = last.open.filter((f) => f.requiresHuman).length;
    const ending = last.verdict === "PASS"
      ? "sealed PASS"
      : last.verdict === "NEEDS_HUMAN"
        ? `NEEDS_HUMAN (${last.open.length} question(s) in one bundle)`
        : last.verdict === "BLOCK"
          ? `BLOCK-stable (${last.open.length} open: ${human} need a human decision, ${last.open.length - human} agent-fixable; nothing can be fixed on a copy)`
          : `ERROR: ${last.error?.code ?? "?"}`;
    lines.push(`| ${r.slug} | ${r.rounds.length} | ${calls} | ${minutes(r.startedAt, r.finishedAt)} | ${ending} | ${last.open.length} |`);
  }
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.slug}`, "", `- source: ${r.source}`, "", "| round | verdict | open | warnings | resolved | dropped | lane calls | lane duration (s) | effort | round wall (s) |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const round of r.rounds) {
      const durs = round.laneDurationsMs.filter((ms) => ms > 0);
      const dur = durs.length ? `${Math.round(Math.min(...durs) / 1000)}-${Math.round(Math.max(...durs) / 1000)}` : "-";
      lines.push(`| ${round.round} | ${round.verdict} | ${round.open.length} | ${round.warnings} | ${round.resolved} | ${round.dropped} | ${round.laneCalls} | ${dur} | ${round.effort ?? "-"} | ${Math.round(round.durationMs / 1000)} |`);
    }
    const last = r.rounds.at(-1);
    if (last.open.length > 0) {
      lines.push("", "Open at end:");
      for (const f of last.open) lines.push(`- ${f.id ?? "?"} [${f.severity}/${f.area}]${f.requiresHuman ? " [needs human decision]" : ""} ${f.missing}`);
    }
    if (last.error) lines.push("", `Error: ${last.error.code}: ${last.error.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

const { runDir, maxRounds, sources } = parseArgs(process.argv.slice(2));
// --render-only rewrites replay.md from the recorded replay.json without a
// judge call, so a wording fix in the record never costs another live run.
if (process.argv.includes("--render-only")) {
  const recorded = JSON.parse(fs.readFileSync(path.join(runDir, "replay.json"), "utf8"));
  fs.writeFileSync(path.join(runDir, "replay.md"), render(recorded, maxRounds));
  process.stdout.write(`${path.join(runDir, "replay.md")}\n`);
  process.exit(0);
}
const results = [];
for (const source of sources) {
  process.stderr.write(`[replay] ${source.slug}: ${source.file}\n`);
  const result = replayOne(source, runDir, maxRounds);
  for (const round of result.rounds) process.stderr.write(`[replay] ${source.slug} round ${round.round}: ${round.verdict} open=${round.open.length} calls=${round.laneCalls} ${Math.round(round.durationMs / 1000)}s\n`);
  results.push(result);
  fs.writeFileSync(path.join(runDir, "replay.json"), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "replay.md"), render(results, maxRounds));
}
process.stdout.write(`${path.join(runDir, "replay.md")}\n`);
