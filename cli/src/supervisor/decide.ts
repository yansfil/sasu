import crypto from "node:crypto";
import type { AgentLookup } from "../implement/herdr";
import type { ObserverIdentity } from "../implement/types";
import { DRIFT_REPEAT_MS, STALL_THRESHOLD_MS, UNCOMMITTED_AGE_MS } from "../implement/types";
import type { IndexEntry, WakeReason, WakeRecord } from "./index";
import { TICK_INTERVAL_MS } from "./paths";

/**
 * The wake decision for one run, as a pure function of what this tick read.
 *
 * Level-triggered by construction: every input is a current fact (a status,
 * a timestamp, a sequence number), never "what the previous tick saw". The
 * one thing the previous tick leaves behind is the index's last wake, and it
 * is consulted only to avoid answering the same episode twice - so a tick
 * killed at any point, or a machine rebooted, reaches the same verdict on
 * the next tick from the same facts (B3).
 */
export interface RunFacts {
  slug: string;
  status: "active" | "retired";
  /** Epoch ms of the newest state.json event, or of run creation when there is none. */
  lastEventAt: number;
  lastEventId: number;
  /** Id of the newest `escalate` event, or null. */
  lastEscalateId: number | null;
  /** The newest `plan` event with the absolute path of its file, or null when the Implementor registered none. */
  lastPlan: { id: number; path: string } | null;
  /**
   * The latest verify attempt since dispatch when it ends two or more
   * consecutive FAIL attempts on one inputFingerprint, else null. `headSha`
   * is the HEAD its report recorded, null when no report is that attempt's.
   */
  repeatedFail: { attemptId: string; count: number; finishedAt: number; headSha: string | null } | null;
  dispatchedAt: number;
  patrolIntervalMs: number;
  observer: ObserverIdentity;
  implementor: { paneId: string; agent: string; sessionId: string; terminalId: string; hostScope: string; recordedAt: string };
}

/**
 * The run's git tree as the tick read it (`readWork`). Times are epoch ms of
 * file modification; `outsideSince` is the oldest among the outside paths
 * still on disk, null when every one of them is a deletion.
 */
export type WorkObservation =
  | { kind: "read"; head: string; commitsSinceDispatch: number; outsideBoundary: string[]; outsideSince: number | null; uncommittedFiles: number; newestChangeAt: number | null }
  | { kind: "unavailable"; detail: string };

export interface Observed {
  implementor: AgentLookup;
  observer: AgentLookup;
  /** Null for a run that is over: its git tree is not read. */
  work: WorkObservation | null;
}

export type ObserverVerdict =
  | { kind: "match"; status: string; inputGuard: string | null }
  | { kind: "observer-gone"; detail: string }
  | { kind: "unobservable"; detail: string };

export type ImplementorVerdict =
  | { kind: "present"; status: string; activityAt: number | null; stateChangeSeq: number | null }
  | { kind: "implementor-gone"; detail: string }
  | { kind: "unobservable"; detail: string };

export interface Candidate { reason: WakeReason; episode: string; detail: string }

export interface Decision {
  observer: ObserverVerdict;
  implementor: ImplementorVerdict;
  /** The git read this decision used; an unavailable read is the run's current failure. */
  work: WorkObservation | null;
  /** Every reason the facts support this tick, before the last-wake filter. */
  candidates: Candidate[];
  /** Candidates not yet answered by an accepted or unknown-outcome wake. */
  due: Candidate[];
  /** True when the run is over and its entry leaves the index after this tick. */
  terminal: boolean;
  /** Why nothing is sent this tick although `due` is non-empty; null when a send is possible. */
  deferral: string | null;
}

/**
 * Identity check at the wake boundary (D-06). Session UUID and terminal id
 * both have to match the record; name, pane, cwd and PID are not consulted.
 * "absent" is a positive answer (herdr looked and found nobody) while
 * "unavailable" proves nothing and sends nothing.
 */
// Every observer-gone verdict ends with the way out: the live smoke of
// 2026-09-18 showed status naming the replacement session without saying what
// a person does next (B18: wakes stay withheld until an explicit handover).
const HANDOVER_HINT = "wakes stay withheld until a person runs \`sasu supervisor handover --slug <slug> --approval \"<words>\"\` from the pane that should observe";

export function judgeObserver(recorded: ObserverIdentity, lookup: AgentLookup): ObserverVerdict {
  if (lookup.kind === "unavailable") return { kind: "unobservable", detail: lookup.detail };
  if (lookup.kind === "absent") return { kind: "observer-gone", detail: `no agent in the Observer's recorded pane ${recorded.paneId}; ${HANDOVER_HINT}` };
  const agent = lookup.agent;
  if (agent.sessionId !== recorded.sessionId) {
    return { kind: "observer-gone", detail: `pane ${recorded.paneId} now holds session ${agent.sessionId ?? "(unreported)"}, not the recorded Observer ${recorded.sessionId}; no input is sent to the replacement; ${HANDOVER_HINT}` };
  }
  if (agent.terminalId !== recorded.terminalId) {
    return { kind: "observer-gone", detail: `pane ${recorded.paneId} reports terminal ${agent.terminalId ?? "(unreported)"}, not the recorded ${recorded.terminalId}; a herdr server restart rotates terminal ids; ${HANDOVER_HINT}` };
  }
  return { kind: "match", status: agent.status, inputGuard: agent.inputGuard };
}

export function judgeImplementor(recorded: RunFacts["implementor"], lookup: AgentLookup): ImplementorVerdict {
  if (lookup.kind === "unavailable") return { kind: "unobservable", detail: lookup.detail };
  if (lookup.kind === "absent") return { kind: "implementor-gone", detail: `no agent in the Implementor's pane ${recorded.paneId}` };
  const agent = lookup.agent;
  if (agent.name !== recorded.agent) {
    return { kind: "implementor-gone", detail: `pane ${recorded.paneId} now holds agent ${agent.name ?? "(unnamed)"}, not the dispatched ${recorded.agent}` };
  }
  if (agent.sessionId !== recorded.sessionId) {
    return { kind: "implementor-gone", detail: `pane ${recorded.paneId} now holds session ${agent.sessionId ?? "(unreported)"}, not dispatched implementor session ${recorded.sessionId}` };
  }
  if (agent.terminalId !== recorded.terminalId) {
    return { kind: "implementor-gone", detail: `pane ${recorded.paneId} now reports terminal ${agent.terminalId ?? "(unreported)"}, not dispatched implementor terminal ${recorded.terminalId}` };
  }
  return { kind: "present", status: agent.status, activityAt: agent.activityAt, stateChangeSeq: agent.stateChangeSeq };
}

export type WakeMemory = WakeRecord | null | Pick<IndexEntry, "lastWake" | "acknowledgements" | "lastAcknowledgedAt">;

function memory(value: WakeMemory): Pick<IndexEntry, "lastWake" | "acknowledgements" | "lastAcknowledgedAt"> {
  if (value !== null && "acknowledgements" in value) return value;
  const legacy = value as WakeRecord | null;
  const acknowledgements: Partial<Record<WakeReason, string>> = {};
  if (legacy !== null && legacy.outcome === "accepted") {
    for (const token of legacy.episode.split("|")) {
      const boundary = token.indexOf(":");
      if (boundary > 0) acknowledgements[token.slice(0, boundary) as WakeReason] = token.slice(boundary + 1);
    }
  }
  return { lastWake: legacy, acknowledgements, lastAcknowledgedAt: legacy?.outcome === "accepted" ? legacy.at : null };
}

export function decideRun(facts: RunFacts, observed: Observed, wakeMemory: WakeMemory, now: number): Decision {
  const observer = judgeObserver(facts.observer, observed.observer);
  const implementor = judgeImplementor(facts.implementor, observed.implementor);
  const prior = memory(wakeMemory);
  const candidates: Candidate[] = [];
  const terminal = facts.status !== "active";

  if (terminal) {
    candidates.push({ reason: "terminal", episode: facts.status, detail: `run is ${facts.status}; it leaves the supervisor index after this wake` });
  } else {
    if (implementor.kind === "implementor-gone") {
      candidates.push({ reason: "implementor-gone", episode: "gone", detail: implementor.detail });
    }
    if (implementor.kind === "present") {
      const seq = implementor.stateChangeSeq ?? 0;
      if (implementor.status === "blocked") {
        candidates.push({ reason: "blocked", episode: String(seq), detail: `implementor ${facts.implementor.agent} is blocked in ${facts.implementor.paneId}` });
      }
      // Two consecutive ticks in the same settled state, expressed as a level:
      // the status is idle or done AND the last lifecycle change is older
      // than one tick interval. The wake says it may be transient, because a
      // momentary idle between two tool calls can still satisfy this.
      if ((implementor.status === "idle" || implementor.status === "done") && implementor.activityAt !== null && now - implementor.activityAt >= TICK_INTERVAL_MS) {
        candidates.push({ reason: "settled", episode: String(seq), detail: `implementor ${facts.implementor.agent} has been ${implementor.status} since ${new Date(implementor.activityAt).toISOString()}; possibly transient, confirm before acting` });
      }
    }
    if (facts.lastEscalateId !== null) {
      candidates.push({ reason: "escalate", episode: String(facts.lastEscalateId), detail: `escalate event ${facts.lastEscalateId} is recorded` });
    }
    // A registered plan wakes once per plan event: the Implementor keeps
    // working, and the Observer reads the file it names. A run with no plan
    // event is not a fact the tick reads anything into (D-11).
    if (facts.lastPlan !== null) {
      candidates.push({ reason: "plan", episode: String(facts.lastPlan.id), detail: `plan ${facts.lastPlan.id} registered: ${facts.lastPlan.path}` });
    }
    // A commit is the Implementor's own progress marker, so the Observer
    // glances at each one instead of waiting for the patrol clock. The episode
    // is the head: several commits between two ticks are one wake, and an
    // accepted commit wake restarts the patrol clock like any other look.
    const work = observed.work;
    if (work !== null && work.kind === "read" && work.commitsSinceDispatch > 0) {
      candidates.push({ reason: "commit", episode: work.head, detail: `${work.commitsSinceDispatch} commit(s) since dispatch; HEAD ${work.head.slice(0, 12)}` });
    }
    // Stall: the event log AND herdr activity have both been silent for the
    // threshold (B6). A working agent is activity by definition; an
    // unobservable herdr leaves only the event log to judge by (B12). A run
    // already waking for settled or blocked is not additionally stalled.
    const eventsSilent = now - facts.lastEventAt >= STALL_THRESHOLD_MS;
    const herdrSilent = implementor.kind === "unobservable"
      || (implementor.kind === "present" && implementor.status !== "working" && (implementor.activityAt === null || now - implementor.activityAt >= STALL_THRESHOLD_MS));
    const alreadyWaking = candidates.some((entry) => entry.reason === "settled" || entry.reason === "blocked" || entry.reason === "implementor-gone");
    if (eventsSilent && herdrSilent && !alreadyWaking) {
      candidates.push({ reason: "stall", episode: String(facts.lastEventId), detail: `no state.json event since ${new Date(facts.lastEventAt).toISOString()} and ${implementor.kind === "unobservable" ? "herdr activity is unobservable" : "no herdr activity"} for ${Math.round(STALL_THRESHOLD_MS / 60_000)} minutes` });
    }
    // Drift is not suppressed by settled, blocked, stall or patrol: it rides
    // along in the same wake with its own detail line.
    const drift = driftFacts(facts, work, implementor, now);
    if (drift.length > 0) {
      candidates.push({ reason: "drift", episode: drift.map((fact) => fact.token).join(","), detail: drift.map((fact) => fact.detail).join("; ") });
    }
    // Patrol is considered after current non-patrol episodes are filtered.
    // An already acknowledged escalation must not suppress a later patrol.
    const nonPatrolDue = candidates.filter((entry) => prior.acknowledgements[entry.reason] !== entry.episode);
    if (implementor.kind === "present" && implementor.status === "working" && nonPatrolDue.length === 0) {
      const acknowledgedAt = prior.lastAcknowledgedAt === null ? Number.NaN : Date.parse(prior.lastAcknowledgedAt);
      const lastLookAt = Number.isFinite(acknowledgedAt) ? acknowledgedAt : facts.dispatchedAt;
      if (now - lastLookAt >= facts.patrolIntervalMs) {
        const bucket = Math.floor((now - facts.dispatchedAt) / facts.patrolIntervalMs);
        candidates.push({ reason: "patrol", episode: String(bucket), detail: `implementor ${facts.implementor.agent} working; ${Math.round((now - lastLookAt) / 60_000)} minutes since the Observer last looked` });
      }
    }
  }

  const due = candidates.filter((entry) => prior.acknowledgements[entry.reason] !== entry.episode);
  let deferral: string | null = null;
  if (due.length > 0) {
    if (observer.kind !== "match") deferral = observer.kind === "observer-gone" ? `observer-gone: ${observer.detail}` : `observer unobservable: ${observer.detail}`;
    else if (observer.status === "working") deferral = "observer is working; delivered on a later tick";
    else if (observer.status === "blocked") deferral = "observer is blocked on its own input; herdr would refuse the wake, so it is retried on a later tick";
  }
  return { observer, implementor, work: observed.work, candidates, due, terminal, deferral };
}

interface DriftFact { token: string; detail: string }

const DRIFT_PATHS_SHOWN = 5;

/**
 * The drift facts present now, each as `<kind>:<identity>:<bucket>`. The
 * bucket counts whole DRIFT_REPEAT_MS intervals since the fact began, so a
 * fact that persists becomes a new episode, and is raised again, every ten
 * minutes until it clears. Each onset is read from the fact itself (the
 * attempt's finish, the moment the newest change turned 20 minutes old, the
 * oldest outside path's modification), so the tick keeps no memory beyond
 * the acknowledgements it already has.
 */
function driftFacts(facts: RunFacts, work: WorkObservation | null, implementor: ImplementorVerdict, now: number): DriftFact[] {
  const found: DriftFact[] = [];
  const raise = (kind: string, identity: string, since: number, detail: string): void => {
    // A modification time ahead of the tick's clock reads as a fact that just began.
    const elapsed = Math.max(0, now - since);
    const bucket = Math.floor(elapsed / DRIFT_REPEAT_MS);
    found.push({ token: `${kind}:${identity}:${bucket}`, detail: `${kind}: ${detail}${bucket === 0 ? "" : `; present ${Math.floor(elapsed / 60_000)} minutes, raised again`}` });
  };
  // The fact is "failing on one input and nothing has changed since" (review
  // R1): a HEAD other than the one the attempt ran on, or an uncommitted
  // change newer than the attempt, means the Implementor is already changing
  // the tree, and raising it then forced an escalation on exactly the work
  // we want. An unreadable tree leaves the recorded attempts to judge by.
  const repeated = facts.repeatedFail;
  const treeMoved = repeated !== null && work !== null && work.kind === "read"
    && ((repeated.headSha !== null && work.head !== repeated.headSha) || (work.newestChangeAt !== null && work.newestChangeAt > repeated.finishedAt));
  if (repeated !== null && !treeMoved) {
    raise("repeated-fail", repeated.attemptId, repeated.finishedAt, `${repeated.count} consecutive FAIL verify attempts on one verification input since dispatch, latest ${repeated.attemptId} at ${new Date(repeated.finishedAt).toISOString()}`);
  }
  if (work === null || work.kind !== "read") return found;
  if (work.outsideBoundary.length > 0) {
    const shown = work.outsideBoundary.slice(0, DRIFT_PATHS_SHOWN).join(", ");
    const more = work.outsideBoundary.length - DRIFT_PATHS_SHOWN;
    const identity = crypto.createHash("sha256").update(work.outsideBoundary.join("\0")).digest("hex").slice(0, 16);
    raise("outside-boundary", identity, work.outsideSince ?? facts.dispatchedAt, `${work.outsideBoundary.length} changed path(s) outside the delivery boundary: ${shown}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (implementor.kind === "present" && implementor.status === "working" && work.uncommittedFiles > 0 && work.newestChangeAt !== null && now - work.newestChangeAt >= UNCOMMITTED_AGE_MS) {
    const newest = new Date(work.newestChangeAt).toISOString();
    raise("uncommitted-age", newest, work.newestChangeAt + UNCOMMITTED_AGE_MS, `${work.uncommittedFiles} uncommitted path(s), newest change ${newest}, older than ${UNCOMMITTED_AGE_MS / 60_000} minutes while the implementor is working`);
  }
  return found;
}

/** The `reason:episode` tokens of a set of candidates, joined for the wake record. */
export function episodeKey(candidates: Candidate[]): string {
  return candidates.map((entry) => `${entry.reason}:${entry.episode}`).join("|");
}
