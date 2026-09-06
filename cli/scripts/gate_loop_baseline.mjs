#!/usr/bin/env node
// Baseline extractor for the gate-loop PRD (T1): reads recorded PRD-gate
// state files from finished runs and renders per-session cycle timings, lane
// call counts, and how each gate ended. The input is the gates.json a run
// left behind plus its per-round artifacts; nothing here calls a judge or
// writes into the source run directory.
//
// Usage:
//   node cli/scripts/gate_loop_baseline.mjs --out <baseline.md> \
//     <label>=<path/to/gates.json> [<label>=<path> ...]
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  let out = null;
  const sources = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      out = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new Error(`expected <label>=<gates.json>, got: ${arg}`);
    sources.push({ label: arg.slice(0, eq), file: path.resolve(arg.slice(eq + 1)) });
  }
  if (!out) throw new Error("--out <baseline.md> is required");
  if (sources.length === 0) throw new Error("at least one <label>=<gates.json> source is required");
  return { out: path.resolve(out), sources };
}

function minutesBetween(a, b) {
  return ((Date.parse(b) - Date.parse(a)) / 60_000).toFixed(1);
}

function hhmm(iso) {
  return iso.slice(11, 19);
}

// The artifact of a round carries the lane fan-out with per-call durations.
// Artifact paths in the record are project-relative, so resolve them from the
// run directory the gates.json sits in (agents/runs/<slug>/gates/gates.json).
function loadArtifact(gatesFile, artifactRel) {
  if (!artifactRel) return null;
  const projectRoot = path.resolve(path.dirname(gatesFile), "..", "..", "..", "..");
  const abs = path.join(projectRoot, artifactRel);
  // An archived run keeps its artifacts beside its gates.json even though the
  // recorded paths still name the original run directory.
  const archived = path.join(path.dirname(gatesFile), "artifacts", path.basename(artifactRel));
  const file = fs.existsSync(abs) ? abs : fs.existsSync(archived) ? archived : null;
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function summarizeGate(gatesFile, record, deviations) {
  const rounds = (record.history ?? []).map((entry) => {
    const artifact = loadArtifact(gatesFile, entry.artifact);
    const lanes = artifact?.lanes ?? [];
    const durations = lanes.map((lane) => lane.judge?.durationMs ?? 0).filter((ms) => ms > 0);
    return {
      at: entry.at,
      verdict: entry.error ? "ERROR" : entry.verdict,
      findingCount: entry.findingCount ?? 0,
      laneCalls: lanes.length,
      laneMinMs: durations.length ? Math.min(...durations) : null,
      laneMaxMs: durations.length ? Math.max(...durations) : null,
      effort: lanes[0]?.judge?.effort ?? null,
    };
  });
  const reopens = (record.reviewReopens ?? []).map((r) => ({ at: r.at, evidence: r.evidence }));
  // An override is recorded as a store-level deviation, not on the record.
  const overridden = record.overridden ? deviations.at(-1) ?? null : null;
  const ending = overridden
    ? `overridden at ${hhmm(overridden.at)} (${JSON.stringify(overridden.reason ?? "")})`
    : record.verdict === "PASS"
      ? `sealed PASS at ${hhmm(record.lastRunAt)}`
      : `${record.verdict} (${(record.findings ?? []).length} open)`;
  return {
    rounds,
    reopens,
    cycles: reopens.length + 1,
    laneCalls: rounds.reduce((n, r) => n + r.laneCalls, 0),
    firstAt: rounds[0]?.at ?? null,
    lastAt: rounds.at(-1)?.at ?? null,
    ending,
  };
}

function renderGate(label, gate, summary) {
  const lines = [];
  lines.push(`### ${label} / ${gate}`);
  lines.push("");
  const span = summary.firstAt && summary.lastAt
    ? `${hhmm(summary.firstAt)} -> ${hhmm(summary.lastAt)} (${minutesBetween(summary.firstAt, summary.lastAt)} min)`
    : "no rounds";
  lines.push(`- rounds: ${summary.rounds.length}, cycles: ${summary.cycles}, lane calls: ${summary.laneCalls}, span: ${span}`);
  lines.push(`- ending: ${summary.ending}`);
  lines.push("");
  lines.push("| round | at | verdict | findings | lane calls | lane duration (s) | effort |");
  lines.push("|---|---|---|---|---|---|---|");
  summary.rounds.forEach((r, i) => {
    const dur = r.laneMinMs === null ? "-" : `${Math.round(r.laneMinMs / 1000)}-${Math.round(r.laneMaxMs / 1000)}`;
    lines.push(`| ${i + 1} | ${hhmm(r.at)} | ${r.verdict} | ${r.findingCount} | ${r.laneCalls} | ${dur} | ${r.effort ?? "-"} |`);
  });
  if (summary.reopens.length) {
    lines.push("");
    lines.push("Reopens:");
    for (const r of summary.reopens) lines.push(`- ${hhmm(r.at)}: ${JSON.stringify(r.evidence)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const { out, sources } = parseArgs(process.argv.slice(2));
  const sections = [];
  const totals = [];
  sections.push("# gate-loop baseline");
  sections.push("");
  sections.push("Recorded PRD-gate loops from finished runs, extracted from each run's `gates/gates.json` and round artifacts.");
  sections.push(`Generated ${new Date().toISOString()} by cli/scripts/gate_loop_baseline.mjs.`);
  sections.push("");
  sections.push("");
  for (const source of sources) {
    const state = JSON.parse(fs.readFileSync(source.file, "utf8"));
    for (const gate of ["gap-audit", "spec"]) {
      const record = state.gates?.[gate];
      if (!record || !(record.history ?? []).length) continue;
      const deviations = (state.deviations ?? []).filter((d) => d.gate === gate);
      const summary = summarizeGate(source.file, record, deviations);
      sections.push(renderGate(source.label, gate, summary));
      totals.push({ label: source.label, gate, ...summary });
    }
  }
  const table = [
    "## Summary",
    "",
    "| session | gate | rounds | cycles | lane calls | wall clock (min) | ending |",
    "|---|---|---|---|---|---|---|",
    ...totals.map((t) => `| ${t.label} | ${t.gate} | ${t.rounds.length} | ${t.cycles} | ${t.laneCalls} | ${t.firstAt ? minutesBetween(t.firstAt, t.lastAt) : "-"} | ${t.ending} |`),
    "",
  ];
  sections.splice(5, 0, ...table);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sections.join("\n"));
  process.stdout.write(`${out}\n`);
}

main();
