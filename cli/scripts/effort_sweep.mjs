#!/usr/bin/env node
// Effort sweep for the document-gate lane fan-out.
//
// Answers the question `commands.ts` asserted without measuring: what does a
// narrow lane actually cost at each reasoning budget, and what does lowering
// the budget cost in judgment quality? The recorded claim ("judge wall time is
// a flat per-call reasoning budget") is contradicted by real artifacts - the
// 2026-08-28 implement-check run shows 23s and 540s lanes at the SAME xhigh
// effort - so the budget/latency curve has to be measured, not assumed.
//
// Accuracy is scored on two sides, because a cheaper judge can fail in two
// opposite directions and a one-sided instrument would hide one of them:
//   sensitivity - a mined document must BLOCK and its planted gaps be found
//   specificity - a complete document must PASS with no invented findings
// A budget that keeps both is cheaper at no cost to the gate.
//
// Usage:
//   node cli/scripts/effort_sweep.mjs [--efforts low,medium,high,xhigh]
//     [--repeats 1] [--out <path>] [--backend codex] [--model <id>]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const distDir = path.join(root, "cli", "dist");
const { runJudge } = require(path.join(distDir, "judge", "runner.js"));
const { validateGapVerdict } = require(path.join(distDir, "judge", "types.js"));
const { loadConfig } = require(path.join(distDir, "config.js"));
const prompts = require(path.join(distDir, "gates", "prompts.js"));
const { mergeLaneFindings } = require(path.join(distDir, "gates", "commands.js"));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const efforts = arg("efforts", "low,medium,high,xhigh").split(",").map((e) => e.trim()).filter(Boolean);
const repeats = Number(arg("repeats", "1"));
const outPath = arg("out", path.join(root, "cli", "test", "fixtures", "calibration", "results", "effort-sweep.json"));
const backendOverride = arg("backend", undefined);
const modelOverride = arg("model", undefined);

if (backendOverride) process.env["SASU_JUDGE_BACKEND"] = backendOverride;

const fixtures = path.join(root, "cli", "test", "fixtures", "calibration");
const mines = JSON.parse(fs.readFileSync(path.join(fixtures, "mines-qa.json"), "utf8")).mines;

// Three documents, two expectations. The real interview log is included
// because the synthetic fixtures are 144 lines and a real qa-log is 626 - a
// budget that holds on a toy document but collapses on a real one has not been
// measured on anything that matters.
const DOCS = [
  { id: "mined", file: path.join(fixtures, "qa-log-mined.md"), expect: "BLOCK", scored: true },
  { id: "complete", file: path.join(fixtures, "qa-log-complete.md"), expect: "PASS", scored: false },
  { id: "real-passed", file: path.join(root, "agents", "interview", "implement-check", "qa-log.md"), expect: "PASS", scored: false },
];

const lanes = prompts.GAP_AUDIT_LANES;
const config = loadConfig(root);
if (modelOverride) {
  for (const profile of Object.values(config.judge.profiles)) {
    profile.primary.model = modelOverride;
  }
}
const validate = (value) => validateGapVerdict(value, { requireOrigin: false });

const findingText = (f) => `${f.area} ${f.missing} ${f.recommendation}`.toLowerCase();

function detectMines(findings) {
  const texts = findings.map(findingText);
  return mines.map((mine) => ({
    id: mine.id,
    detected: texts.some((text) => mine.keywords.some((kw) => text.includes(kw.toLowerCase()))),
  }));
}

/** One fan-out round: four lanes concurrently, wall time is the slowest lane. */
async function fanout(doc, effort) {
  const started = Date.now();
  const settled = await Promise.all(lanes.map(async (lane) => {
    const laneStart = Date.now();
    try {
      const outcome = await runJudge(
        config,
        `sweep:${doc.id}:${effort}:${lane.id}`,
        "routine",
        prompts.gapAuditPrompt(doc.content, [], { lane, laneCount: lanes.length }),
        validate,
        { effort },
      );
      return { laneId: lane.id, ms: Date.now() - laneStart, verdict: outcome.value.verdict, findings: outcome.value.findings, error: null };
    } catch (error) {
      return { laneId: lane.id, ms: Date.now() - laneStart, verdict: null, findings: [], error: String(error?.message ?? error) };
    }
  }));
  const failed = settled.filter((l) => l.error !== null);
  const merged = mergeLaneFindings(settled.map((l) => ({ laneId: l.laneId, findings: l.findings })));
  const detected = detectMines(merged.findings);
  return {
    doc: doc.id,
    effort,
    wallMs: Date.now() - started,
    slowestLaneMs: Math.max(...settled.map((l) => l.ms)),
    lanes: settled.map((l) => ({ laneId: l.laneId, ms: l.ms, verdict: l.verdict, findings: l.findings.length, error: l.error })),
    errors: failed.length,
    verdict: merged.verdict,
    expected: doc.expect,
    verdictCorrect: failed.length === 0 && merged.verdict === doc.expect,
    findingCount: merged.findings.length,
    // On a document expected to PASS, every finding is a false positive: the
    // fixture is the control sample, so noise here is measurable, not judged.
    falsePositives: doc.expect === "PASS" ? merged.findings.length : null,
    minesDetected: doc.scored ? detected.filter((m) => m.detected).length : null,
    mineTotal: doc.scored ? mines.length : null,
    mines: doc.scored ? detected : null,
    findings: merged.findings,
  };
}

for (const doc of DOCS) doc.content = fs.readFileSync(doc.file, "utf8");

const runs = [];
console.error(`[sweep] efforts=${efforts.join(",")} repeats=${repeats} docs=${DOCS.map((d) => d.id).join(",")} lanes=${lanes.length}`);
console.error(`[sweep] backend=${backendOverride ?? config.judge.profiles.routine.primary.backend} model=${modelOverride ?? config.judge.profiles.routine.primary.model}`);

for (let round = 1; round <= repeats; round += 1) {
  for (const effort of efforts) {
    for (const doc of DOCS) {
      const result = await fanout(doc, effort);
      result.round = round;
      runs.push(result);
      const acc = result.minesDetected === null
        ? `fp=${result.falsePositives}`
        : `mines=${result.minesDetected}/${result.mineTotal}`;
      console.error(
        `[sweep] r${round} ${effort.padEnd(6)} ${doc.id.padEnd(12)} ${String(result.wallMs).padStart(6)}ms `
        + `verdict=${result.verdict}${result.verdictCorrect ? "" : `(want ${result.expected})`} ${acc} errors=${result.errors}`,
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify({ at: new Date().toISOString(), runs }, null, 2)}\n`);
    }
  }
}

// Summary: one row per effort, aggregated across docs and repeats.
console.error("\n[sweep] === summary ===");
console.error("effort   wall(med)  verdictOK  mines   falsePos  errors");
for (const effort of efforts) {
  const rows = runs.filter((r) => r.effort === effort);
  const walls = rows.map((r) => r.wallMs).sort((a, b) => a - b);
  const median = walls[Math.floor(walls.length / 2)] ?? 0;
  const ok = rows.filter((r) => r.verdictCorrect).length;
  const mined = rows.filter((r) => r.minesDetected !== null);
  const minesFound = mined.reduce((s, r) => s + r.minesDetected, 0);
  const minesTotal = mined.reduce((s, r) => s + r.mineTotal, 0);
  const fp = rows.filter((r) => r.falsePositives !== null).reduce((s, r) => s + r.falsePositives, 0);
  const errors = rows.reduce((s, r) => s + r.errors, 0);
  console.error(
    `${effort.padEnd(8)} ${String(median).padStart(7)}ms  ${String(ok).padStart(2)}/${rows.length}      `
    + `${minesFound}/${minesTotal}     ${String(fp).padStart(3)}       ${errors}`,
  );
}
console.error(`\n[sweep] wrote ${outPath}`);
