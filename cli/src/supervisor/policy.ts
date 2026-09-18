/**
 * Per-run supervision settings a dispatch may set (D-08, D-15). Two knobs,
 * both bounded, both recorded in state.json so the tick reads the run's own
 * policy rather than a global.
 */
export const DEFAULT_PATROL_INTERVAL_MS = 15 * 60 * 1000;
/** Below this a patrol would arrive on nearly every tick; above it the "from a distance" look loses its point. */
const PATROL_MIN_MINUTES = 1;
const PATROL_MAX_MINUTES = 24 * 60;

export function parsePatrolMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PATROL_INTERVAL_MS;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < PATROL_MIN_MINUTES || minutes > PATROL_MAX_MINUTES) {
    throw new Error(`--patrol must be a whole number of minutes between ${PATROL_MIN_MINUTES} and ${PATROL_MAX_MINUTES}, got ${value}`);
  }
  return minutes * 60 * 1000;
}

export type RecoveryOwner = "supervisor" | "task-factory";

/**
 * Who replaces a dead Observer. The supervisor itself never does (D-06); a
 * Task Factory run says so at dispatch so the two loops never both input
 * into one session, and status shows which loop owns recovery.
 */
export function parseRecoveryOwner(value: string | undefined): RecoveryOwner {
  const owner = (value ?? "").trim();
  if (owner === "") return "supervisor";
  if (owner === "supervisor" || owner === "task-factory") return owner;
  throw new Error(`--recovery-owner must be supervisor or task-factory, got ${value}`);
}
