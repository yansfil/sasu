import fs from "node:fs";
import { parseImplementState } from "../implement/store";
import type { ImplementState, SupervisionRecord } from "../implement/types";
import type { RunFacts } from "./decide";

/**
 * The parts of a run record the supervisor reads. One reader for the tick
 * and for `status --digest`, so the two never disagree about what "the last
 * event" or "the dispatch" means (D-11).
 */
export interface ReadRun {
  state: ImplementState;
  supervision: SupervisionRecord;
  facts: RunFacts;
}

export const MAX_RUN_STATE_BYTES = 8 * 1024 * 1024;

export function requireSupervision(state: ImplementState): SupervisionRecord {
  const supervision = state.supervision ?? null;
  if (supervision === null) throw new Error(`run ${state.topicSlug} was never dispatched under Herdr, so it has no supervision record`);
  return supervision;
}

export function runFacts(state: ImplementState, supervision: SupervisionRecord): RunFacts {
  const lastEvent = state.events.at(-1);
  const lastEventAt = Date.parse(lastEvent?.at ?? state.createdAt);
  if (!Number.isFinite(lastEventAt)) throw new Error(`run ${state.topicSlug} has an invalid event or creation timestamp`);
  const dispatchedAt = Date.parse(supervision.dispatchedAt);
  if (!Number.isFinite(dispatchedAt)) throw new Error(`run ${state.topicSlug} has an invalid dispatchedAt`);
  const escalate = [...state.events].reverse().find((event) => event.kind === "escalate");
  const plan = [...state.events].reverse().find((event) => event.kind === "plan");
  return {
    slug: state.topicSlug,
    status: state.status,
    lastEventAt,
    lastEventId: lastEvent?.id ?? 0,
    lastEscalateId: escalate?.id ?? null,
    lastPlan: plan === undefined ? null : { id: plan.id, path: plan.subject ?? "" },
    dispatchedAt,
    patrolIntervalMs: supervision.patrolIntervalMs,
    observer: supervision.observer,
    implementor: supervision.implementor,
  };
}

/** Read one run record from disk; every failure is the caller's to record against that run alone (B12). */
export function readRun(statePath: string): ReadRun {
  const bytes = fs.statSync(statePath).size;
  if (bytes > MAX_RUN_STATE_BYTES) throw new Error(`implement state is ${bytes} bytes, above the ${MAX_RUN_STATE_BYTES} byte cap: ${statePath}`);
  const state = parseImplementState(fs.readFileSync(statePath, "utf8"));
  const supervision = requireSupervision(state);
  return { state, supervision, facts: runFacts(state, supervision) };
}
