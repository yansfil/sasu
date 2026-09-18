import type { AgentLookup } from "../implement/herdr";
import type { ObserverIdentity } from "../implement/types";
import { STALL_THRESHOLD_MS } from "../implement/types";
import type { WakeReason, WakeRecord } from "./index";
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
  dispatchedAt: number;
  patrolIntervalMs: number;
  observer: ObserverIdentity;
  implementor: { paneId: string; agent: string };
}

export interface Observed {
  implementor: AgentLookup;
  observer: AgentLookup;
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
export function judgeObserver(recorded: ObserverIdentity, lookup: AgentLookup): ObserverVerdict {
  if (lookup.kind === "unavailable") return { kind: "unobservable", detail: lookup.detail };
  if (lookup.kind === "absent") return { kind: "observer-gone", detail: `no agent in the Observer's recorded pane ${recorded.paneId}` };
  const agent = lookup.agent;
  if (agent.sessionId !== recorded.sessionId) {
    return { kind: "observer-gone", detail: `pane ${recorded.paneId} now holds session ${agent.sessionId ?? "(unreported)"}, not the recorded Observer ${recorded.sessionId}; no input is sent to the replacement` };
  }
  if (agent.terminalId !== recorded.terminalId) {
    return { kind: "observer-gone", detail: `pane ${recorded.paneId} reports terminal ${agent.terminalId ?? "(unreported)"}, not the recorded ${recorded.terminalId}; a herdr server restart rotates terminal ids, so re-record the Observer with \`sasu supervisor handover\` before wakes resume` };
  }
  return { kind: "match", status: agent.status, inputGuard: agent.inputGuard };
}

export function judgeImplementor(recorded: { paneId: string; agent: string }, lookup: AgentLookup): ImplementorVerdict {
  if (lookup.kind === "unavailable") return { kind: "unobservable", detail: lookup.detail };
  if (lookup.kind === "absent") return { kind: "implementor-gone", detail: `no agent in the Implementor's pane ${recorded.paneId}` };
  const agent = lookup.agent;
  if (agent.name !== null && agent.name !== recorded.agent) {
    return { kind: "implementor-gone", detail: `pane ${recorded.paneId} now holds agent ${agent.name}, not the dispatched ${recorded.agent}` };
  }
  return { kind: "present", status: agent.status, activityAt: agent.activityAt, stateChangeSeq: agent.stateChangeSeq };
}

/** The `reason:episode` tokens an accepted or unknown wake has already answered. */
function answered(lastWake: WakeRecord | null): Set<string> {
  if (lastWake === null || lastWake.outcome === "rejected") return new Set();
  return new Set(lastWake.episode.split("|").filter(Boolean));
}

export function decideRun(facts: RunFacts, observed: Observed, lastWake: WakeRecord | null, now: number): Decision {
  const observer = judgeObserver(facts.observer, observed.observer);
  const implementor = judgeImplementor(facts.implementor, observed.implementor);
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
    // Patrol: the implementor is working and nothing else is due, but the
    // Observer has not looked for a patrol interval (B7). Measured from the
    // last wake when there was one, else from the dispatch.
    if (implementor.kind === "present" && implementor.status === "working" && candidates.length === 0) {
      const lastLookAt = lastWake !== null && lastWake.outcome !== "rejected" ? Date.parse(lastWake.at) : facts.dispatchedAt;
      if (now - lastLookAt >= facts.patrolIntervalMs) {
        const bucket = Math.floor((now - facts.dispatchedAt) / facts.patrolIntervalMs);
        candidates.push({ reason: "patrol", episode: String(bucket), detail: `implementor ${facts.implementor.agent} working; ${Math.round((now - lastLookAt) / 60_000)} minutes since the Observer last looked` });
      }
    }
  }

  const done = answered(lastWake);
  const due = candidates.filter((entry) => !done.has(`${entry.reason}:${entry.episode}`));
  let deferral: string | null = null;
  if (due.length > 0) {
    if (observer.kind !== "match") deferral = observer.kind === "observer-gone" ? `observer-gone: ${observer.detail}` : `observer unobservable: ${observer.detail}`;
    else if (observer.status === "working") deferral = "observer is working; delivered on a later tick";
    else if (observer.status === "blocked") deferral = "observer is blocked on its own input; herdr would refuse the wake, so it is retried on a later tick";
  }
  return { observer, implementor, candidates, due, terminal, deferral };
}

/** The `reason:episode` tokens of a set of candidates, joined for the wake record. */
export function episodeKey(candidates: Candidate[]): string {
  return candidates.map((entry) => `${entry.reason}:${entry.episode}`).join("|");
}
