/**
 * The one definition of a mechanical verdict.
 *
 * `outcome` is derived from four inputs recorded beside it on the same
 * record. Three sites used to derive it independently - the single check
 * writer, the verify batch writer, and the state reader - and on 2026-09-02
 * (herdr-ide hide-ux-round4) the batch writer folded a fifth input,
 * mutatedTree, into its verdict while the reader knew nothing of it: six
 * attempts landed as exit 0 / outcome "failed" and every later command refused
 * to load the run. The reader's park comment records the same species once
 * before. One function, called by every writer and by the reader, is what
 * makes writer/reader drift structurally impossible (PRINCIPLES 3, 10).
 */
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
