import fs from "node:fs";
import { parseImplementContract, reviewProfile, type BehaviorRowContract, type ImplementContract } from "./contract";
import { normalizeProjectPath, sha256 } from "./store";
import { excludeSuiteCommand, suiteCommandNamed } from "./suite";
import type { AmendmentRecord, BehaviorRequirement, ImplementState, IssuerLabel } from "./types";

export class AmendmentRejected extends Error {
  constructor(readonly check: "arguments" | "authority" | "transition", message: string) { super(message); this.name = "AmendmentRejected"; }
}

export interface AmendmentPlan {
  changedRequirements: string[];
  addedRequirements: string[];
  removedRequirements: string[];
  scopeSectionsChanged: string[];
}

export function sealRequirement(row: BehaviorRowContract): BehaviorRequirement {
  return { id: row.id, behavior: row.behavior, decisionIds: [...row.decisionIds] };
}

export function planAmendment(state: ImplementState, current: ImplementContract, next: ImplementContract): AmendmentPlan {
  const held = new Map(state.requirements.map((entry) => [entry.id, entry]));
  const nextIds = new Set(next.rows.map((entry) => entry.id));
  const plan: AmendmentPlan = { changedRequirements: [], addedRequirements: [], removedRequirements: state.requirements.filter((entry) => !nextIds.has(entry.id)).map((entry) => entry.id), scopeSectionsChanged: [] };
  for (const requirement of next.rows) {
    const prior = held.get(requirement.id);
    if (prior === undefined) plan.addedRequirements.push(requirement.id);
    else if (JSON.stringify(prior) !== JSON.stringify(sealRequirement(requirement))) plan.changedRequirements.push(requirement.id);
  }
  for (const key of ["goal", "nonGoals", "decisions", "technicalStructure", "risks", "frontmatter"] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) plan.scopeSectionsChanged.push(key);
  }
  return plan;
}

export interface AmendmentInput { issuer: IssuerLabel; approval: string; reason: string; text: string; excludeSuite?: string[] }
export interface AmendmentOutcome { record: AmendmentRecord; plan: AmendmentPlan; derived: Array<{ file: string; text: string }> }
export function amendmentArchivePath(runDir: string, id: number): string { return `${runDir}/amendments/prd-${id}-superseded.md`; }

/** Resolve a human item's exact source region; semantics stay with its reviewer. */
function humanSource(contract: ImplementContract, sourceRef: string, prdPath: string, snapshotPath: string): string | null {
  const decision = contract.decisions.find((entry) => entry.id === sourceRef);
  if (decision !== undefined) return `${decision.decision}\n${decision.rationale}`;
  if (sourceRef === "Risks") return contract.risks;
  if (sourceRef === "Decisions") return contract.decisions.map((entry) => `${entry.id} ${entry.decision}\n${entry.rationale}`).join("\n");
  if (sourceRef === prdPath || sourceRef === snapshotPath) return contract.body;
  return null;
}

export function applyAmendment(recordRoot: string, state: ImplementState, input: AmendmentInput, at: string): AmendmentOutcome {
  if (input.issuer !== "human") throw new AmendmentRejected("authority", "amend is human-only; PRD and suite changes require the person's recorded approval");
  if (input.approval.trim() === "") throw new AmendmentRejected("arguments", "amend requires --approval <verbatim human approval>");
  if (input.reason.trim() === "") throw new AmendmentRejected("arguments", "amend requires --reason <why>");
  if (state.activeVerification !== undefined) throw new AmendmentRejected("transition", "verification still active; PRD amendment is refused");
  const pinned = normalizeProjectPath(recordRoot, state.prd.snapshotPath);
  const oldText = fs.readFileSync(pinned.absolute, "utf8");
  const current = parseImplementContract(oldText);
  const next = parseImplementContract(input.text);
  const plan = planAmendment(state, current, next);
  const exclusions = (input.excludeSuite ?? []).map((entry) => entry.trim().toUpperCase());
  if (oldText === input.text && exclusions.length === 0) throw new AmendmentRejected("arguments", "amended PRD and suite are unchanged; nothing to amend");
  // Validate all exclusions before mutating any. One invalid id must never
  // leave the first valid exclusion applied in a caller that handles errors.
  if (new Set(exclusions).size !== exclusions.length) throw new AmendmentRejected("arguments", "duplicate suite exclusion");
  for (const id of exclusions) {
    if (suiteCommandNamed(state, id) === null) throw new AmendmentRejected("arguments", `unknown suite command: ${id}`);
    if (state.suite.exclusions.some((entry) => entry.commandId === id)) throw new AmendmentRejected("arguments", `${id} is already excluded`);
  }
  const id = Math.max(0, ...state.amendments.map((entry) => entry.id)) + 1;
  const excluded: NonNullable<AmendmentRecord["excludedSuiteCommands"]> = [];
  for (const commandId of exclusions) {
    const command = suiteCommandNamed(state, commandId)!;
    const priorResult = state.suite.results.find((entry) => entry.commandId === commandId)?.status ?? "none";
    excludeSuiteCommand(state, { commandId, approval: input.approval.trim(), reason: input.reason.trim() }, at);
    excluded.push({ commandId, command: command.command, priorResult });
  }
  const closedHumanFindings: string[] = [];
  for (const finding of state.findings) {
    if (finding.kind !== "human-confirmation" || finding.status === "amended" || finding.human === undefined) continue;
    const priorSource = humanSource(current, finding.human.sourceRef, state.prdPath, state.prd.snapshotPath);
    const nextSource = humanSource(next, finding.human.sourceRef, state.prdPath, state.prd.snapshotPath);
    // A moved intake changes the provenance namespace even if the same quote
    // appears in both conversations. Human response history remains intact.
    const intakeMoved = current.frontmatter["source_intake"] !== next.frontmatter["source_intake"];
    const inputSource = finding.human.sourceRef === "instruction" || finding.human.sourceRef === current.frontmatter["source_intake"];
    if ((priorSource !== null && (nextSource === null || !nextSource.includes(finding.human.quote))) || (intakeMoved && inputSource)) {
      finding.status = "amended";
      finding.history.push({ at, attemptId: null, status: "amended", reason: `Human-approved amendment ${id} removed or replaced this item's source: ${input.reason.trim()}`, evidenceRefs: [state.prd.snapshotPath], amendmentId: id });
      closedHumanFindings.push(finding.id);
    }
  }
  const previousSnapshotPath = amendmentArchivePath(state.runDir, id);
  state.requirements = next.rows.map(sealRequirement);
  state.prd = {
    ...state.prd, sha256: sha256(input.text), status: next.frontmatter["status"] ?? null,
    approval: { source: "conversation", evidence: input.approval.trim() },
    reviewProfile: reviewProfile(next), reviewRationale: next.frontmatter["review_rationale"] ?? "",
    sourceIntake: next.frontmatter["source_intake"] ?? "",
  };
  // The old result stays honest history. Freshness changes for the entire
  // contract, never selected rows; no result is promoted onto this snapshot.
  state.completion = null;
  const record: AmendmentRecord = {
    id, at, issuer: "human", approval: input.approval.trim(), reason: input.reason.trim(),
    prdSha256: state.prd.sha256, snapshotPath: state.prd.snapshotPath, previousSnapshotPath,
    changedRequirements: plan.changedRequirements, addedRequirements: plan.addedRequirements,
    removedRequirements: plan.removedRequirements, closedHumanFindings,
    suiteSnapshotUpdated: excluded.length > 0,
    ...(excluded.length > 0 ? { excludedSuiteCommands: excluded } : {}),
  };
  state.amendments.push(record);
  return { record, plan, derived: [{ file: normalizeProjectPath(recordRoot, previousSnapshotPath).absolute, text: oldText }, { file: pinned.absolute, text: input.text }] };
}
