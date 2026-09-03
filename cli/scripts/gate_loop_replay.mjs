#!/usr/bin/env node
// AC16 replay (PRD gate-loop, judged criterion): run the rebuilt gap-audit
// loop over copies of the three interview logs whose original loops are
// recorded in baseline.md, with real judges, and record how each loop ends.
// The originals are never touched: each log is copied into the gate-loop run
// directory and judged from a scratch project root. The loop reruns while
// the verdict is BLOCK, up to --max-rounds, so the open set's subset rule is
// observed on an unchanged document. When a BLOCK-stable end still carries an
// agent-fixable finding, the loop continues the way a live interview would:
// the implementor edits the copy (replay/<slug>/qa-log.after.md, never a
// Decision Register cell) and `--continue <slug> --fix "<what was edited>"`
// judges it again from the recorded gate state, appending the round to the
// record with the fix named. The record is honest about how each loop ended.
//
// Usage:
//   node cli/scripts/gate_loop_replay.mjs --run-dir <agents/runs/gate-loop> \
//     <slug>=<path/to/qa-log.md> [<slug>=<path> ...] [--max-rounds 2]
//   node cli/scripts/gate_loop_replay.mjs --run-dir <agents/runs/gate-loop> \
//     --continue <slug> --fix "<edit applied to the copy>" [--max-rounds 1]
//   node cli/scripts/gate_loop_replay.mjs --run-dir <agents/runs/gate-loop> --render-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.resolve(HERE, "..", "dist", "cli.js");

function parseArgs(argv) {
  let runDir = null;
  let maxRounds = null;
  let continueSlug = null;
  let fix = null;
  const sources = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-dir") { runDir = path.resolve(argv[i + 1]); i += 1; continue; }
    if (arg === "--max-rounds") { maxRounds = Number(argv[i + 1]); i += 1; continue; }
    if (arg === "--continue") { continueSlug = argv[i + 1]; i += 1; continue; }
    if (arg === "--fix") { fix = argv[i + 1]; i += 1; continue; }
    if (arg === "--render-only") continue;
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new Error(`expected <slug>=<qa-log.md>, got: ${arg}`);
    sources.push({ slug: arg.slice(0, eq), file: path.resolve(arg.slice(eq + 1)) });
  }
  if (!runDir) throw new Error("--run-dir <agents/runs/gate-loop> is required");
  const renderOnly = argv.includes("--render-only");
  if (continueSlug !== null && !fix) throw new Error("--continue needs --fix \"<edit applied to the copy>\" so the record names what changed");
  if (continueSlug !== null && sources.length > 0) throw new Error("--continue takes no <slug>=<qa-log.md> sources");
  if (sources.length === 0 && !renderOnly && continueSlug === null) throw new Error("at least one <slug>=<qa-log.md> is required");
  // A fresh loop reruns once on the unchanged copy; a continued loop judges
  // the fixed copy once.
  return { runDir, maxRounds: maxRounds ?? (continueSlug === null ? 2 : 1), sources, continueSlug, fix, renderOnly };
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
  const startedAt = new Date().toISOString();
  const rounds = judgeRounds(scratch, source.slug, 1, maxRounds, null);
  saveScratch(scratch, source.slug, copyDir, scratchLog);
  return { slug: source.slug, source: source.file, startedAt, finishedAt: new Date().toISOString(), rounds };
}

// Keep the whole scratch record (state, artifacts, the log the harness wrote
// its Audit entries into) beside the copy.
function saveScratch(scratch, slug, copyDir, scratchLog) {
  fs.rmSync(path.join(copyDir, "gates"), { recursive: true, force: true });
  fs.cpSync(path.join(scratch, "agents", "runs", slug, "gates"), path.join(copyDir, "gates"), { recursive: true });
  fs.copyFileSync(scratchLog, path.join(copyDir, "qa-log.after.md"));
}

// Continue a recorded loop: rebuild the scratch root from the copy the
// implementor edited and the gate state the previous rounds left, so the
// judge sees a rerun (lane digests pinned, prior findings carried) exactly as
// a live interview's next round would.
function continueOne(recorded, runDir, maxRounds, fix) {
  const copyDir = path.join(runDir, "replay", recorded.slug);
  const edited = path.join(copyDir, "qa-log.after.md");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `sasu-gate-loop-replay-${recorded.slug}-`));
  fs.mkdirSync(path.join(scratch, "agents", "interview", recorded.slug), { recursive: true });
  const scratchLog = path.join(scratch, "agents", "interview", recorded.slug, "qa-log.md");
  fs.copyFileSync(edited, scratchLog);
  fs.cpSync(path.join(copyDir, "gates"), path.join(scratch, "agents", "runs", recorded.slug, "gates"), { recursive: true });
  const from = recorded.rounds.at(-1).round + 1;
  const rounds = judgeRounds(scratch, recorded.slug, from, from + maxRounds - 1, fix);
  saveScratch(scratch, recorded.slug, copyDir, scratchLog);
  return { ...recorded, finishedAt: new Date().toISOString(), rounds: [...recorded.rounds, ...rounds] };
}

function judgeRounds(scratch, slug, firstRound, lastRound, fix) {
  const rounds = [];
  for (let round = firstRound; round <= lastRound; round += 1) {
    const result = cli(scratch, ["gate", "gap-audit", "--slug", slug, "--qa-log", `agents/interview/${slug}/qa-log.md`]);
    const status = result.json?.status ?? null;
    const gates = JSON.parse(fs.readFileSync(path.join(scratch, "agents", "runs", slug, "gates", "gates.json"), "utf8"));
    const artifactRel = gates.gates["gap-audit"].history.at(-1)?.artifact ?? null;
    const artifact = artifactRel ? JSON.parse(fs.readFileSync(path.join(scratch, artifactRel), "utf8")) : null;
    const lanes = artifact?.lanes ?? [];
    rounds.push({
      round,
      at: new Date().toISOString(),
      // The edit the implementor applied to the copy before this round, or
      // null when the document was judged unchanged.
      fixApplied: round === firstRound ? fix : null,
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
  return rounds;
}

function render(results) {
  const lines = [
    "# gate-loop replay",
    "",
    `Generated ${new Date().toISOString()} by cli/scripts/gate_loop_replay.mjs on copies of the three interview logs with real judges. A loop reruns while BLOCK on the unchanged copy (two rounds at most); when a BLOCK-stable end still holds an agent-fixable finding, the implementor applies that one edit to the copy and the loop continues with one more judged round, recorded below as "fix applied".`,
    "",
    "## Summary",
    "",
    "| session | rounds | lane calls | judged wall clock (min) | ending | open at end |",
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
          ? `BLOCK-stable (${last.open.length} open: ${human} need a human decision, ${last.open.length - human} agent-fixable)`
          : `ERROR: ${last.error?.code ?? "?"}`;
    // Sum of the rounds' own wall time: a continued loop has idle time
    // between its recorded end and the fix, which is not judging.
    const judgedMinutes = (r.rounds.reduce((n, round) => n + round.durationMs, 0) / 60_000).toFixed(1);
    lines.push(`| ${r.slug} | ${r.rounds.length} | ${calls} | ${judgedMinutes} | ${ending} | ${last.open.length} |`);
  }
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.slug}`, "", `- source: ${r.source}`, "", "| round | verdict | open | warnings | resolved | dropped | lane calls | lane duration (s) | effort | round wall (s) |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const round of r.rounds) {
      const durs = round.laneDurationsMs.filter((ms) => ms > 0);
      const dur = durs.length ? `${Math.round(Math.min(...durs) / 1000)}-${Math.round(Math.max(...durs) / 1000)}` : "-";
      lines.push(`| ${round.round} | ${round.verdict} | ${round.open.length} | ${round.warnings} | ${round.resolved} | ${round.dropped} | ${round.laneCalls} | ${dur} | ${round.effort ?? "-"} | ${Math.round(round.durationMs / 1000)} |`);
    }
    for (const round of r.rounds) {
      if (round.fixApplied) lines.push("", `Fix applied to the copy before round ${round.round}: ${round.fixApplied}`);
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

const { runDir, maxRounds, sources, continueSlug, fix, renderOnly } = parseArgs(process.argv.slice(2));
const recordFile = path.join(runDir, "replay.json");
const readRecord = () => JSON.parse(fs.readFileSync(recordFile, "utf8"));
const writeRecord = (results) => {
  fs.writeFileSync(recordFile, `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, "replay.md"), render(results));
};
const logRounds = (result) => {
  for (const round of result.rounds) process.stderr.write(`[replay] ${result.slug} round ${round.round}: ${round.verdict} open=${round.open.length} calls=${round.laneCalls} ${Math.round(round.durationMs / 1000)}s${round.fixApplied ? " (fix applied)" : ""}\n`);
};
// --render-only rewrites replay.md from the recorded replay.json without a
// judge call, so a wording fix in the record never costs another live run.
if (renderOnly) {
  writeRecord(readRecord());
} else if (continueSlug !== null) {
  const results = readRecord();
  const index = results.findIndex((r) => r.slug === continueSlug);
  if (index === -1) throw new Error(`no recorded loop for ${continueSlug} in ${recordFile}`);
  if (results[index].rounds.at(-1).verdict !== "BLOCK") throw new Error(`${continueSlug} did not end BLOCK; nothing to continue`);
  process.stderr.write(`[replay] continue ${continueSlug}: ${fix}\n`);
  results[index] = continueOne(results[index], runDir, maxRounds, fix);
  logRounds(results[index]);
  writeRecord(results);
} else {
  const results = [];
  for (const source of sources) {
    process.stderr.write(`[replay] ${source.slug}: ${source.file}\n`);
    const result = replayOne(source, runDir, maxRounds);
    logRounds(result);
    results.push(result);
    writeRecord(results);
  }
}
process.stdout.write(`${path.join(runDir, "replay.md")}\n`);
