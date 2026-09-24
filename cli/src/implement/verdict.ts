import type { UnifiedVerificationAttempt, VerificationStatus } from "./types";

/** Mechanical results use the same process facts in both recording and review. */
export interface VerdictInputs {
  exitCode: number;
  timedOut: boolean;
  signal: string | null;
  /** True when the command rewrote judged source while it ran. */
  mutatedTree: boolean;
}

/**
 * "tree-moved" is a third value rather than a flavour of "failed": the exit
 * code was honestly 0, so there is no failure class to count toward a
 * same-class decision point, and it must not be "green" either, because the
 * verdict names a tree the command did not leave alone.
 */
export type MechanicalOutcome = "green" | "failed" | "tree-moved";

export function mechanicalOutcome(inputs: VerdictInputs): MechanicalOutcome {
  if (inputs.timedOut || inputs.signal !== null || inputs.exitCode !== 0) return "failed";
  return inputs.mutatedTree ? "tree-moved" : "green";
}

/** The verdict an attempt stands for: an error or a failed required command outranks the recorded verdict. */
export function effectiveVerdict(attempt: UnifiedVerificationAttempt): VerificationStatus {
  if (attempt.error !== null) return attempt.verdict === "FAIL" ? "FAIL" : "ERROR";
  if (attempt.mechanical.some((entry) => entry.status !== "PASS")) return "FAIL";
  return attempt.verdict;
}

/**
 * How many FAIL attempts in a row, ending with `attempts[end]`, ran on the same
 * recorded input. herdr-ide `web-shell-pivot-s4` (2026-09-24) ran attempts
 * 6-8 on one inputFingerprint, each a full suite of about 1-4 minutes, and
 * every one failed in the Rust suite. `verify` discloses the count and the
 * supervisor raises drift from it; neither refuses the run, because
 * reproducing a failure on unchanged input is a legitimate diagnostic.
 */
export function identicalInputFailures(attempts: readonly UnifiedVerificationAttempt[], end: number): number {
  const last = attempts[end];
  if (last === undefined) throw new Error(`verification attempt index ${end} is outside the ${attempts.length} recorded attempts`);
  let count = 0;
  for (let index = end; index >= 0; index -= 1) {
    const held = attempts[index]!;
    if (effectiveVerdict(held) !== "FAIL" || held.inputFingerprint !== last.inputFingerprint) break;
    count += 1;
  }
  return count;
}
