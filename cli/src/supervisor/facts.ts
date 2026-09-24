import fs from "node:fs";
import path from "node:path";
import { parseImplementState } from "../implement/store";
import { identicalInputFailures } from "../implement/verdict";
import type { ImplementState, SupervisionRecord, UnifiedVerificationAttempt } from "../implement/types";
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
  // Only this dispatch's attempts count: a replacement Implementor must not
  // inherit its predecessor's identical-input failures as its own drift.
  const attempts = state.verificationAttempts.filter((attempt) => Date.parse(attempt.finishedAt) >= dispatchedAt);
  const latest = attempts.at(-1);
  const repeated = latest === undefined ? 0 : identicalInputFailures(attempts, attempts.length - 1);
  return {
    slug: state.topicSlug,
    status: state.status,
    lastEventAt,
    lastEventId: lastEvent?.id ?? 0,
    lastEscalateId: escalate?.id ?? null,
    // The plan lives in the tree the Implementor edits, which for an isolated
    // run is the worktree, not the record tree the Observer reads from; the
    // wake carries the absolute path so the Observer opens the right file
    // (measured 2026-09-21: a relative path pointed at an empty record dir).
    lastPlan: plan === undefined ? null : { id: plan.id, path: path.resolve(state.worktree?.path ?? state.projectRoot, plan.subject ?? "") },
    repeatedFail: latest !== undefined && repeated >= 2 ? { attemptId: latest.id, count: repeated, finishedAt: Date.parse(latest.finishedAt), headSha: reportHead(state, latest) } : null,
    dispatchedAt,
    patrolIntervalMs: supervision.patrolIntervalMs,
    observer: supervision.observer,
    implementor: supervision.implementor,
  };
}

/**
 * The HEAD the latest attempt ran on. `verify` writes the report with the
 * attempt it finishes, so the report is that attempt's when it carries the
 * attempt's input and was generated no earlier than the attempt finished;
 * otherwise (no report, or one an amendment cleared) the head is unknown.
 */
function reportHead(state: ImplementState, attempt: UnifiedVerificationAttempt): string | null {
  const report = state.verificationReport;
  if (report === null || report.inputFingerprint !== attempt.inputFingerprint || Date.parse(report.generatedAt) < Date.parse(attempt.finishedAt)) return null;
  return report.headSha;
}

/** Read one run record from disk; every failure is the caller's to record against that run alone (B12). */
export function readRun(statePath: string): ReadRun {
  const bytes = fs.statSync(statePath).size;
  if (bytes > MAX_RUN_STATE_BYTES) throw new Error(`implement state is ${bytes} bytes, above the ${MAX_RUN_STATE_BYTES} byte cap: ${statePath}`);
  const state = parseImplementState(fs.readFileSync(statePath, "utf8"));
  const supervision = requireSupervision(state);
  return { state, supervision, facts: runFacts(state, supervision) };
}
