import fs from "node:fs";
import { loadConfig } from "../config";
import type { ImplementArgs } from "./commands";
import { planRunUnits, runBatch, type BatchOutcome, type RunUnitResult } from "./runner";
import { captureSourceSnapshot, loadState, requireWorkRoot, sha256 } from "./store";
import type { ImplementCommandResult } from "./types";
import { resolveIssuer } from "./verbs";
import { beginPreview, finishPreview, recoverVerification, verificationExecutionHooks } from "./verification-activity";

/** Execute the sealed suite in the verify environment without recording a verdict. */
export async function runVerifyPreview(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const results: RunUnitResult[] = [];
  let batch: BatchOutcome | undefined;
  try {
    if (args.flags.get("preview") !== true || args.positional.length !== 2) throw new Error("use implement verify --preview [--slug <topic> | --state <path>]");
    for (const key of args.flags.keys()) {
      if (!["preview", "slug", "state", "json", "issuer"].includes(key)) throw new Error(`--${key} is not supported by suite preview`);
    }
    const options: { slug?: string; state?: string } = {};
    for (const key of ["slug", "state"] as const) {
      const value = args.flags.get(key);
      if (value !== undefined) {
        if (typeof value !== "string" || value.trim() === "") throw new Error(`--${key} requires a value`);
        options[key] = value;
      }
    }
    const issuer = args.flags.get("issuer");
    if (issuer !== undefined && typeof issuer !== "string") throw new Error("--issuer requires a value");
    resolveIssuer(issuer);
    let { statePath, state } = loadState(projectRoot, options);
    if (state.activeVerification !== undefined) {
      // A preview must not turn an interrupted real verify into a durable
      // attempt correction. Normal verify owns that recovery and its record.
      if (state.activeVerification.mode !== "preview") throw new Error("verification lease exists; finish it or run regular verify to recover it before preview");
      state = await recoverVerification(statePath, state);
    }
    const workRoot = requireWorkRoot(state);
    const config = loadConfig(workRoot);
    const units = planRunUnits(state);
    const originalText = fs.readFileSync(statePath, "utf8");
    beginPreview(statePath, state, sha256(JSON.stringify({
      prd: state.prd.sha256, source: captureSourceSnapshot(workRoot).digest,
      units, timeoutMs: config.verify.commandTimeoutMs,
    })));
    let failure: unknown;
    try {
      batch = await runBatch(state, workRoot, units, config.verify.commandTimeoutMs,
        (completed) => { results.push(completed); }, verificationExecutionHooks(statePath, state));
    } catch (error) { failure = error; }
    try { finishPreview(statePath, state, originalText); }
    catch (error) {
      const prior = failure === undefined ? "" : `${failure instanceof Error ? failure.message : String(failure)}; `;
      throw new Error(`${prior}preview cleanup failed; execution lease retained: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failure !== undefined) throw failure;
    if (batch === undefined) throw new Error("suite preview did not return an execution result");
    const succeeded = results.filter((entry) => entry.outcome === "green").length;
    const ok = batch.treeMoved === null && succeeded === units.length;
    return {
      ok, action: "verify-preview", exitCode: ok ? 0 : 1,
      message: units.length === 0 ? "no required suite commands; no verification recorded"
        : `suite preview: ${succeeded}/${units.length} commands succeeded; no verification recorded`,
      detail: { preview: true, recorded: false, results, treeMoved: batch.treeMoved },
      summary: [
        ...results.flatMap((entry) => [
          `${entry.unit.suiteCommandId}: ${entry.unit.command} (cwd ${entry.unit.cwd}) - ${entry.outcome}; exit ${entry.exitCode}`,
          ...(entry.stdout === "" ? [] : [entry.stdout]), ...(entry.stderr === "" ? [] : [entry.stderr]),
        ]),
        ...(batch.treeMoved === null ? [] : ["Source changed during preview; fix the commands before verifying."]),
        "Preview does not update verification history, evidence, suite results or reports.",
      ],
    };
  } catch (error) {
    return {
      ok: false, action: "verify-preview", exitCode: 2,
      message: error instanceof Error ? error.message : String(error),
      detail: { preview: true, recorded: false, results },
    };
  }
}
