import fs from "node:fs";
import path from "node:path";
import { parseImplementContract } from "./contract";
import { normalizeProjectPath, sha256, writeTextAtomic } from "./store";
import type { AcceptanceCriterionItem, AmendmentRecord, ImplementState } from "./types";

/**
 * Amendment: correcting the question paper mid-run (R5).
 *
 * The rule that shapes this whole module is that a correction must cost only
 * what it actually invalidates. Re-sealing the PRD and starting the ledger
 * over was the obvious implementation and the wrong one (Q8-B, rejected): a
 * typo fix in AC30 would throw away twenty proven criteria. So identity is
 * decided per row, and everything whose row survives keeps its evidence.
 */

/** The three fields that make an acceptance criterion the same question (AC14). */
export interface CriterionRow {
  text: string;
  judgment: string | null;
  evidenceDeclaration: string | null;
}

/**
 * Normalize away formatting, keep meaning.
 *
 * Collapsing runs of whitespace is what makes a Markdown table re-alignment a
 * non-event: `| AC1 | foo |` and `| AC1  |  foo |` parse to cell text that
 * differs only in spacing, and a run must not lose a green because someone
 * ran a table formatter. Everything else is significant - notably the
 * judgment tag, because moving a criterion from `machine` to `judged` changes
 * who proves it and therefore invalidates the proof it already has (D-40).
 */
function normalizeField(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function criterionRowHash(row: CriterionRow): string {
  // NUL-joined rather than newline-joined: whitespace collapse has already
  // removed every newline from the fields, so NUL is a separator no field can
  // contain, and two fields cannot smear into one another's hash.
  return sha256([
    normalizeField(row.text),
    normalizeField(row.judgment),
    normalizeField(row.evidenceDeclaration),
  ].join("\u0000"));
}

export function criterionRowOf(criterion: AcceptanceCriterionItem): CriterionRow {
  return {
    text: criterion.text,
    judgment: criterion.judgment,
    evidenceDeclaration: criterion.evidenceDeclaration,
  };
}

export class AmendmentRejected extends Error {
  constructor(readonly check: "arguments" | "authority" | "transition", message: string) {
    super(message);
    this.name = "AmendmentRejected";
  }
}

/**
 * Tasks a replacement implementor would find half-built.
 *
 * The schema has no `in_progress` status - a task is pending, complete, or
 * blocked - so "in progress" has to be read off the work itself (AC15). A
 * pending task whose criteria have been bound or attempted is one somebody is
 * holding; a pending task nobody has touched is merely next. Amending under
 * the first would move the goalposts out from under a live attempt, which is
 * the failure AC15 names.
 *
 * A park does not count: parking is the act of putting a criterion DOWN, and
 * a parked criterion whose row changes is exactly what R5 says to unpark.
 */
export function tasksInProgress(state: ImplementState): string[] {
  const byId = new Map(state.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  return state.tasks
    .filter((task) => task.status === "pending")
    .filter((task) => task.evidence.length > 0 || task.acceptanceCriteria.some((id) => {
      const criterion = byId.get(id);
      if (criterion === undefined) return false;
      return criterion.check.bindings.length > 0 || criterion.check.attempts.length > 0;
    }))
    .map((task) => task.id);
}

export interface AmendmentPlan {
  invalidatedCriteria: string[];
  addedCriteria: string[];
  unparkedCriteria: string[];
  unchangedCriteria: string[];
}

/**
 * Decide what an amended PRD costs, without applying anything.
 *
 * Split from the application so the refusal paths and the receipt can both
 * ask "what would this do?" without a write happening as a side effect.
 */
export function planAmendment(
  state: ImplementState,
  next: AcceptanceCriterionItem[],
): AmendmentPlan {
  const current = new Map(state.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const plan: AmendmentPlan = {
    invalidatedCriteria: [],
    addedCriteria: [],
    unparkedCriteria: [],
    unchangedCriteria: [],
  };
  for (const criterion of next) {
    const held = current.get(criterion.id);
    if (held === undefined) {
      plan.addedCriteria.push(criterion.id);
      continue;
    }
    if (criterionRowHash(criterionRowOf(held)) === criterionRowHash(criterionRowOf(criterion))) {
      plan.unchangedCriteria.push(criterion.id);
      continue;
    }
    plan.invalidatedCriteria.push(criterion.id);
    if (held.check.status === "parked") plan.unparkedCriteria.push(criterion.id);
  }
  return plan;
}

/**
 * Merge the amended criteria into the ledger.
 *
 * An unchanged row keeps its criterion object whole - bindings, attempts,
 * parks, decision points, green. A changed row keeps its history and loses
 * its verdict: the attempts stay readable so the next attempt is not blind,
 * but the status returns to pending because it was earned against a question
 * that no longer exists. A changed park is lifted for the same reason - the
 * criterion it was set aside for is gone (R5).
 */
function mergeCriteria(
  state: ImplementState,
  next: AcceptanceCriterionItem[],
  plan: AmendmentPlan,
  at: string,
): void {
  const current = new Map(state.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const invalidated = new Set(plan.invalidatedCriteria);
  state.acceptanceCriteria = next.map((criterion) => {
    const held = current.get(criterion.id);
    if (held === undefined) return criterion;
    if (!invalidated.has(criterion.id)) return held;
    const park = held.check.parks.at(-1);
    if (held.check.status === "parked" && park !== undefined && park.resumedAt === null) park.resumedAt = at;
    return {
      ...criterion,
      check: {
        ...held.check,
        status: "pending",
        consecutiveFailures: 0,
        decisionPoints: held.check.decisionPoints.map((point) => (
          point.resolvedAt === null ? { ...point, resolvedAt: at, resolution: "amended" as const } : point
        )),
      },
    };
  });
}

export interface AmendmentInput {
  approval: string;
  reason: string;
  /** The amended PRD text, already read from the source path. */
  text: string;
}

export interface AmendmentOutcome {
  record: AmendmentRecord;
  plan: AmendmentPlan;
}

/**
 * Where a superseded snapshot goes.
 *
 * The pinned snapshot keeps its path (`<runDir>/prd.md`) across amendments so
 * every reader - judge envelope, drift check, qa-brief - keeps resolving the
 * live question paper the same way. The version it replaced is archived under
 * its amendment id, which is what makes "the new snapshot is distinguishable
 * from the previous one" checkable rather than asserted (V3).
 */
export function amendmentArchivePath(runDir: string, id: number): string {
  return `${runDir}/amendments/prd-${id}-superseded.md`;
}

export function applyAmendment(
  recordRoot: string,
  state: ImplementState,
  input: AmendmentInput,
  at: string,
): AmendmentOutcome {
  if (input.approval.trim() === "") {
    throw new AmendmentRejected("arguments", "amend requires --approval <verbatim human approval>; correcting the question paper is a human act and the record has to carry the words that authorised it");
  }
  if (input.reason.trim() === "") {
    throw new AmendmentRejected("arguments", "amend requires --reason <why the criterion was wrong>");
  }
  const held = tasksInProgress(state);
  if (held.length > 0) {
    throw new AmendmentRejected(
      "transition",
      `amend refused: ${held.join(", ")} ${held.length === 1 ? "is" : "are"} in progress (criteria bound or attempted). Stop the task first - park what is stuck or close it - then amend. Changing the question under a live attempt is what this refusal exists to prevent.`,
    );
  }

  const contract = parseImplementContract(input.text);
  const untagged = contract.acceptanceCriteria.filter((criterion) => criterion.judgment === null);
  if (untagged.length > 0) {
    throw new AmendmentRejected("arguments", `amended PRD has untagged acceptance criteria: ${untagged.map((entry) => entry.id).join(", ")}; every row needs a machine, judged, or machine+gate:human tag`);
  }
  const nextIds = new Set(contract.acceptanceCriteria.map((entry) => entry.id));
  const removed = state.acceptanceCriteria.filter((criterion) => !nextIds.has(criterion.id)).map((entry) => entry.id);
  if (removed.length > 0) {
    // Deliberately refused rather than guessed at. R5 defines three outcomes
    // - invalidated, added, unparked - and AmendmentRecord has a field for
    // each. Dropping a criterion has no defined disposition for the evidence
    // already filed against it, and silently discarding it would make the
    // receipt's "N/M PASS" denominator move with no record of why.
    throw new AmendmentRejected("arguments", `amended PRD drops ${removed.join(", ")}; amendment may correct or add criteria but not remove them, because the evidence already filed against a dropped row has no defined disposition. Next: rewrite the criterion so the row changes (its green is then invalidated and it returns to pending), or park it with verbatim human approval. Actually removing a criterion is a decision this PRD does not define and belongs to a new one.`);
  }
  const heldTasks = new Set(state.tasks.map((entry) => entry.id));
  const nextTasks = new Set(contract.tasks.map((entry) => entry.id));
  const taskDelta = [
    ...[...nextTasks].filter((id) => !heldTasks.has(id)).map((id) => `+${id}`),
    ...[...heldTasks].filter((id) => !nextTasks.has(id)).map((id) => `-${id}`),
  ];
  if (taskDelta.length > 0) {
    // Tasks carry completion state and a dependency graph; adding or removing
    // one mid-run has invalidation semantics R5 never defined. Reordering
    // them is resequence's job and needs no amendment at all (R6).
    throw new AmendmentRejected("arguments", `amended PRD changes the task set (${taskDelta.join(", ")}); amendment corrects acceptance criteria only. Reorder pending tasks with \`sasu implement resequence\`, and take a task-set change back to a new PRD.`);
  }
  const heldVerification = new Set(state.verification.map((entry) => entry.id));
  const nextVerification = new Set(contract.verification.map((entry) => entry.id));
  const verificationDelta = [
    ...[...nextVerification].filter((id) => !heldVerification.has(id)).map((id) => `+${id}`),
    ...[...heldVerification].filter((id) => !nextVerification.has(id)).map((id) => `-${id}`),
  ];
  if (verificationDelta.length > 0) {
    throw new AmendmentRejected("arguments", `amended PRD changes the verification set (${verificationDelta.join(", ")}); the suite list was sealed at start and a V row cannot appear or vanish under it. Exclude a sealed suite command instead, or take this to a new PRD.`);
  }

  const plan = planAmendment(state, contract.acceptanceCriteria);
  const id = Math.max(0, ...state.amendments.map((entry) => entry.id)) + 1;

  // Archive first, then overwrite: if the archive write fails, the pinned
  // snapshot is still the one state.prd.sha256 names and the run is intact.
  const snapshotPath = state.prd.snapshotPath;
  const previousSnapshotPath = amendmentArchivePath(state.runDir, id);
  const pinned = normalizeProjectPath(recordRoot, snapshotPath);
  const archive = normalizeProjectPath(recordRoot, previousSnapshotPath);
  fs.mkdirSync(path.dirname(archive.absolute), { recursive: true });
  writeTextAtomic(archive.absolute, fs.readFileSync(pinned.absolute, "utf8"));
  writeTextAtomic(pinned.absolute, input.text);

  mergeCriteria(state, contract.acceptanceCriteria, plan, at);
  // Requirements are coverage labels: they hold no independent proof, so the
  // amended text simply replaces them. Task and verification TEXT is refreshed
  // for the same reason, their id sets having already been proven identical.
  state.requirements = contract.requirements;
  const taskById = new Map(contract.tasks.map((entry) => [entry.id, entry]));
  state.tasks = state.tasks.map((task) => {
    const next = taskById.get(task.id)!;
    return {
      ...task,
      text: next.text,
      title: next.title,
      requirements: next.requirements,
      acceptanceCriteria: next.acceptanceCriteria,
      dependsOn: next.dependsOn,
    };
  });
  const verificationById = new Map(contract.verification.map((entry) => [entry.id, entry]));
  state.verification = state.verification.map((item) => {
    const next = verificationById.get(item.id)!;
    return {
      ...item,
      text: next.text,
      title: next.title,
      covers: next.covers,
      mode: next.mode,
      requiredForDone: next.requiredForDone,
      canBeBlocked: next.canBeBlocked,
    };
  });
  state.prd = { ...state.prd, sha256: sha256(input.text) };

  const record: AmendmentRecord = {
    id,
    at,
    issuer: "human",
    approval: input.approval.trim(),
    reason: input.reason.trim(),
    prdSha256: state.prd.sha256,
    snapshotPath,
    previousSnapshotPath,
    invalidatedCriteria: plan.invalidatedCriteria,
    addedCriteria: plan.addedCriteria,
    unparkedCriteria: plan.unparkedCriteria,
    // T16 owns suite exclusion through amendment (AC42); until then an
    // amendment never touches the sealed list, and says so rather than
    // leaving the field to be read as unknown.
    suiteSnapshotUpdated: false,
  };
  state.amendments.push(record);
  return { record, plan };
}
