#!/usr/bin/env node
// A/B calibration for the judge fan-out (PRD judge-fanout V6/AC9, D-10):
// runs the SAME mined document through the single-judge path and the
// lane-parallel fan-out path with live judges, then scores both against the
// planted mines. Pass bar (user-set): fan-out mine detections >= single-judge
// detections AND fan-out wall time <= 50% of single-judge wall time.
//
// Usage:
//   node cli/scripts/fanout_ab_calibration.mjs --gate gap-audit \
//     --doc cli/test/fixtures/calibration/qa-log-mined.md \
//     --mines cli/test/fixtures/calibration/mines-qa.json \
//     [--out <result.json>]
//   node cli/scripts/fanout_ab_calibration.mjs --gate spec \
//     --doc cli/test/fixtures/calibration/prd-mined.md \
//     --qa-log cli/test/fixtures/calibration/qa-log-complete.md \
//     --mines cli/test/fixtures/calibration/mines-prd.json \
//     [--out <result.json>]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist");
const { runJudge } = require(path.join(distDir, "judge", "runner.js"));
const { validateGapVerdict } = require(path.join(distDir, "judge", "types.js"));
const { loadConfig } = require(path.join(distDir, "config.js"));
const prompts = require(path.join(distDir, "gates", "prompts.js"));
const { mergeLaneFindings } = require(path.join(distDir, "gates", "commands.js"));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const gate = arg("gate");
const docPath = arg("doc");
const minesPath = arg("mines");
const qaLogPath = arg("qa-log");
const outPath = arg("out");
if (!gate || !docPath || !minesPath || (gate !== "gap-audit" && gate !== "spec")) {
  console.error("usage: fanout_ab_calibration.mjs --gate <gap-audit|spec> --doc <path> --mines <path> [--qa-log <path>] [--out <path>]");
  process.exit(2);
}
if (gate === "spec" && !qaLogPath) {
  console.error("spec calibration needs --qa-log <companion qa-log path>");
  process.exit(2);
}

const doc = fs.readFileSync(docPath, "utf8");
const qaLog = qaLogPath ? fs.readFileSync(qaLogPath, "utf8") : null;
const mines = JSON.parse(fs.readFileSync(minesPath, "utf8")).mines;
const config = loadConfig(process.cwd());

const lanes = gate === "gap-audit" ? prompts.GAP_AUDIT_LANES : prompts.SPEC_LANES;
const buildPrompt = (options) =>
  gate === "gap-audit" ? prompts.gapAuditPrompt(doc, [], options) : prompts.specGatePrompt(doc, qaLog, [], options);

function findingText(finding) {
  return `${finding.area} ${finding.missing} ${finding.recommendation}`.toLowerCase();
}

function detectMines(findings) {
  const texts = findings.map(findingText);
  return mines.map((mine) => ({
    id: mine.id,
    detected: texts.some((text) => mine.keywords.some((kw) => text.includes(kw.toLowerCase()))),
  }));
}

function nearDuplicateRate(findings) {
  // Informal observation (D-08): pairs whose token sets overlap heavily but
  // were not string-deduped.
  let pairs = 0;
  let near = 0;
  const tokenSets = findings.map((f) => new Set(findingText(f).split(/\s+/).filter((t) => t.length > 2)));
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      pairs += 1;
      const smaller = Math.min(tokenSets[i].size, tokenSets[j].size) || 1;
      const overlap = [...tokenSets[i]].filter((t) => tokenSets[j].has(t)).length;
      if (overlap / smaller >= 0.6) near += 1;
    }
  }
  return { pairs, nearDuplicatePairs: near };
}

async function timed(fn) {
  const startedAt = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - startedAt };
}

const validate = (value) => validateGapVerdict(value, { requireOrigin: false });

console.error(`[calibration] gate=${gate} doc=${docPath} (${doc.length} chars), ${mines.length} mines, ${lanes.length} lanes`);

console.error("[calibration] single-judge run...");
const single = await timed(async () => {
  const outcome = await runJudge(config, `calibration:${gate}:single`, "routine", buildPrompt({}), validate);
  return outcome.value;
});
console.error(`[calibration] single: ${single.ms}ms, verdict=${single.value.verdict}, findings=${single.value.findings.length}`);

console.error("[calibration] fan-out run...");
const fanout = await timed(async () => {
  const outcomes = await Promise.all(
    lanes.map((lane) =>
      runJudge(config, `calibration:${gate}:lane:${lane.id}`, "routine", buildPrompt({ lane, laneCount: lanes.length }), validate),
    ),
  );
  return {
    merged: mergeLaneFindings(outcomes.map((o, i) => ({ laneId: lanes[i].id, findings: o.value.findings }))),
    laneMs: null,
  };
});
console.error(`[calibration] fanout: ${fanout.ms}ms, verdict=${fanout.value.merged.verdict}, findings=${fanout.value.merged.findings.length} (deduped ${fanout.value.merged.dedupedCount})`);

const singleMines = detectMines(single.value.findings);
const fanoutMines = detectMines(fanout.value.merged.findings);
const singleDetected = singleMines.filter((m) => m.detected).length;
const fanoutDetected = fanoutMines.filter((m) => m.detected).length;
const timeHalved = fanout.ms <= single.ms * 0.5;
const detectionParity = fanoutDetected >= singleDetected;

const result = {
  gate,
  doc: docPath,
  docChars: doc.length,
  at: new Date().toISOString(),
  model: config.judge.profiles.routine.primary.model,
  single: {
    ms: single.ms,
    verdict: single.value.verdict,
    findingCount: single.value.findings.length,
    minesDetected: singleDetected,
    mines: singleMines,
    findings: single.value.findings,
  },
  fanout: {
    ms: fanout.ms,
    verdict: fanout.value.merged.verdict,
    findingCount: fanout.value.merged.findings.length,
    dedupedCount: fanout.value.merged.dedupedCount,
    laneFindingCounts: fanout.value.merged.laneFindingCounts,
    minesDetected: fanoutDetected,
    mines: fanoutMines,
    nearDuplicates: nearDuplicateRate(fanout.value.merged.findings),
    findings: fanout.value.merged.findings,
  },
  passBar: {
    detectionParity,
    timeHalved,
    speedRatio: Number((fanout.ms / single.ms).toFixed(3)),
    pass: detectionParity && timeHalved,
  },
};

const output = JSON.stringify(result, null, 2);
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${output}\n`);
}
console.log(output);
process.exit(result.passBar.pass ? 0 : 1);
