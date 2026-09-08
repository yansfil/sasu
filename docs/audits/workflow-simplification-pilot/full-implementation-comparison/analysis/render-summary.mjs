#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write("usage: node render-summary.mjs <process-metrics.json> <report.md>\n");
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
const seconds = (value) => value === null || value === undefined ? "incomplete" : `${(value / 1000).toFixed(3)} s`;
const number = (value) => value === null || value === undefined ? "unavailable" : value.toLocaleString("en-US");
const rows = data.runs.map((run) => {
  const phase = run.clocks.coarsePhases;
  return `| ${run.version} | ${run.status} | ${seconds(run.clocks.requestToReceiptMs)} | ${seconds(run.clocks.runToReceiptMs)} | ${seconds(phase.handoffToStateStartMs)} | ${seconds(phase.stateStartToFirstVerifyMs)} | ${seconds(phase.verificationAttemptWallMs)} | ${seconds(phase.interAttemptRecoveryMs)} | ${seconds(phase.finalVerifyToReceiptMs)} | ${seconds(phase.verificationNested.requiredSuiteWallUnionMs)} | ${seconds(phase.verificationNested.judgeWallUnionMs)} | ${seconds(phase.verificationNested.judgeResourceSumMs)} |`;
});

const details = data.runs.flatMap((run) => {
  const correction = run.clocks.preparationBreakdown;
  const provenance = run.executor.provenance;
  const failedAttempts = run.failures.verificationAttempts.map((item) => `${item.id} ${item.verdict} (${seconds(item.durationMs)}): ${item.error?.message ?? "no error message"}`);
  const commandFailures = run.failures.transcriptCommands.map((item) => item.kind === "command"
    ? `${item.at} exit ${item.exitCode}: ${item.command}`
    : `${item.at} ${item.kind}: ${item.action}`);
  const postVerify = run.clocks.postFinalVerifyEvents.map((item) => `${item.startedAt} ${item.action}${item.failure ? ` (${item.failure.kind})` : ""}`);
  return [
    `## ${run.version}`,
    "",
    `The executor session was ${run.executor.sessionId} with ${run.executor.modelEffort.join(", ")}.`,
    `Executor usage through the receipt boundary was ${number(run.executor.usage?.input_tokens)} input, ${number(run.executor.usage?.cached_input_tokens)} cached input, ${number(run.executor.usage?.output_tokens)} output, and ${number(run.executor.usage?.reasoning_output_tokens)} reasoning tokens.`,
    `The run recorded ${run.verification.judges.length} judge result lanes and ${run.phases["independent-judge"].calls} actual judge calls with ${number(run.judge.usage.inputTokens)} input and ${number(run.judge.usage.outputTokens)} output tokens where usage was available. Usage covers ${run.judge.usageCoverage.actualCallsRepresentedByUsage} calls and is unavailable for ${run.judge.usageCoverage.actualCallsWithoutUsage}.`,
    `Observed exact local skill reads: ${provenance.observedExactSkillReads.map((entry) => `${entry.observed ? "yes" : "no"} ${entry.expected}`).join("; ")}.`,
    `Observed pinned CLI use: ${provenance.observedPinnedCliUse ? "yes" : "no"} ${provenance.expectedCliPath}.`,
    `Receipt ${run.receipt.schema} finalized ${run.receipt.completedAt}, source fingerprint ${run.receipt.sourceFingerprint}, completion fingerprint ${run.receipt.completionFingerprint}.`,
    `Failed verification attempts: ${failedAttempts.length ? failedAttempts.join("; ") : "none"}.`,
    `Transcript command or policy failures: ${commandFailures.length ? commandFailures.join("; ") : "none"}.`,
    `Events after the final successful verify: ${postVerify.join("; ")}.`,
    ...(correction ? [`The initial preparation failure occurred ${seconds(correction.handoffToFailureMs)} after handoff, allocated no run, and the retry began ${seconds(correction.failureToRetryMs)} after that failure.`] : []),
    ...(run.metadataPathDiscrepancy ? [`The reporter predicted ${run.metadataPathDiscrepancy.predictedStatePath}, while the actual CLI state was ${run.metadataPathDiscrepancy.actualStatePath}; both paths remain recorded.`] : []),
    "",
  ];
});

const text = [
  "# Full implementation process comparison",
  "",
  "This is one sequential exploratory pair, so it does not estimate a general speedup.",
  "The old v1 and new v2 native benchmark reports remain separate because their schemas are not cross-compatible.",
  `The six Behavior texts are exactly equal: ${data.semanticAnchor.sixTextsExactlyEqual ? "yes" : "not yet established"}.`,
  "Post-receipt evaluation is excluded from these clocks and executor token counts.",
  "",
  "| Version | Status | Handoff to receipt | State start to receipt | Handoff to state start | State start to first verify | Verify-attempt wall | Between-attempt recovery | Final PASS to receipt | Suite wall | Judge wall union | Judge resource sum |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows,
  "",
  "The five coarse phases are disjoint except for a possible 1 ms timestamp rounding difference.",
  "State start to first verify is an observable interval containing implementation, evidence writing, focused checks, and any waits. It is not pure model coding time.",
  "Suite and judge figures are nested details inside verification, and judge resource sum can exceed wall time when lanes run concurrently.",
  "The old preparation interval includes an invalid-topic preparation failure, a coordinator correction gap, and retry. The new run started after that symmetric fixture correction.",
  "Both native benchmark reporters refused the actual run directory because the prepared metadata predicted matched-task-list-library while the CLI created task-list-full. Their raw exit-1 records remain under ../native-report-attempts, so no native v1/v2 report is presented.",
  "The new run's 61.346 s after its successful verify includes an ENOSPC finalize failure and recovery. It is an observed environmental confound, not a clean measurement of routine finalization latency.",
  "The implementation source outputs are not byte-identical. Old src/task-list.mjs is 871 bytes with SHA-256 eb528006ac5f59b48afdef1f6e61977d0b785f5338f9587ffe9eaa25a23f3ce3; new is 866 bytes with SHA-256 8e7bb99c244fe20910da120027e11b28ff728ecf550eba6311ce8100c45058a6.",
  "The old test is the exact 905-byte starter. The new 1,365-byte test preserves those 905 bytes as an exact prefix and appends tests; package.json and agents/config.json remain byte-identical to the shared starter in both runs.",
  "",
  ...details,
].join("\n");

fs.writeFileSync(path.resolve(output), `${text}\n`);
