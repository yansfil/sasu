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
