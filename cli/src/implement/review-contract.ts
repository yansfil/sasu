import { reviewReferences, reviewResultSchema, validateReviewResult } from "../judge/types";
import type { FocusedReviewScope, ImplementationReviewContext, ImplementationReviewResult, ReviewAssessment, ReviewScope, ReviewScopeDeclaration, RoutineReviewRole } from "./types";

/**
 * A carried ground is accepted only where the record can show it is the same
 * ground on the same bytes: the role settled it satisfied at the anchor, every
 * reference it cites was cited there too and none of them changed since, and
 * no open blocking finding names any of its requirements. What the harness
 * cannot show - that the changes do not reach that requirement through an
 * unchanged caller - stays the reviewer's declaration, which is why the
 * prompt makes the trace mandatory and why the planted-defect measurement,
 * not this check, is the evidence that the declaration is worth anything.
 */
function carriedObstacle(scope: FocusedReviewScope, role: RoutineReviewRole, label: string, requirementRefs: string[], evidenceRefs: string[], conclusion: string): string | null {
  if (conclusion !== "satisfied") return `${label} carried grounds must be satisfied; an unresolved or pending conclusion is re-reviewed, never carried`;
  const invalidated = evidenceRefs.filter((ref) => scope.invalidatedEvidenceRefs.includes(ref));
  if (invalidated.length > 0) return `${label} carries grounds citing evidence that changed since attempt ${scope.anchorAttemptId}: ${invalidated.join(", ")}; re-review it`;
  const reopened = requirementRefs.filter((ref) => scope.reopenedRequirementRefs.includes(ref));
  if (reopened.length > 0) return `${label} carries requirements named by an open blocking finding: ${reopened.join(", ")}; re-review them`;
  const anchor = scope.anchorAssessments[role].find((entry) => entry.conclusion === "satisfied" && requirementRefs.every((ref) => entry.requirementRefs.includes(ref)));
  if (anchor === undefined) return `${label} carries requirements ${requirementRefs.join(", ")} that attempt ${scope.anchorAttemptId} did not settle satisfied in one ${role} assessment`;
  const foreign = evidenceRefs.filter((ref) => !anchor.evidenceRefs.includes(ref));
  if (foreign.length > 0) return `${label} carries grounds but cites evidence the anchor assessment did not: ${foreign.join(", ")}; newly inspected evidence is a reviewed ground`;
  return null;
}

function parseScopeDeclaration(raw: unknown, scope: ReviewScope | undefined): ReviewScopeDeclaration | undefined | string {
  if (raw === undefined) return undefined;
  if (scope === undefined || scope.mode !== "focused") return "scope is accepted only in a focused round; this round reviews the whole contract";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "scope must be an object with basis and reason";
  const entry = raw as Record<string, unknown>;
  if (entry.basis !== "focused" && entry.basis !== "widened") return "scope.basis must be focused|widened";
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") return "scope.reason must state concretely how far the review reached and why";
  return { basis: entry.basis, reason: entry.reason };
}

/** Structural accounting is inspectable grounding, not proof of a model's conclusion. */
export function validateImplementationReviewResult(value: unknown, context: ImplementationReviewContext, role: RoutineReviewRole): ImplementationReviewResult | string {
  const reviewed = validateReviewResult(value, context);
  if (typeof reviewed === "string") return reviewed;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.assessments) || raw.assessments.length === 0) return `${role} assessments must be a non-empty array of concrete review grounds`;
  const declared = parseScopeDeclaration(raw.scope, context.scope);
  if (typeof declared === "string") return declared;
  const focused = context.scope?.mode === "focused" && declared?.basis !== "widened" ? context.scope : null;
  const covered = new Set<string>();
  const assessments: ReviewAssessment[] = [];
  for (const [index, item] of raw.assessments.entries()) {
    const label = `assessments[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return `${label} must be an object`;
    const entry = item as Record<string, unknown>;
    const requirementRefs = reviewReferences(entry.requirementRefs, context.requirementRefs, `${label}.requirementRefs`);
    if (typeof requirementRefs === "string") return requirementRefs;
    for (const ref of requirementRefs) {
      if (covered.has(ref)) return `${label}.requirementRefs: duplicate assessment reference ${ref}; group its grounds in one entry`;
      covered.add(ref);
    }
    const evidenceRefs = reviewReferences(entry.evidenceRefs, context.evidenceRefs, `${label}.evidenceRefs`);
    if (typeof evidenceRefs === "string") return evidenceRefs;
    if (evidenceRefs.length === 0) return `${label} requires evidence references for its grounds`;
    if (typeof entry.rationale !== "string" || entry.rationale.trim() === "") return `${label}.rationale must state concrete non-empty grounds`;
    if (entry.conclusion !== "satisfied" && entry.conclusion !== "unresolved" && entry.conclusion !== "pending-human") return `${label}.conclusion must be satisfied|unresolved|pending-human`;
    if (entry.basis !== undefined && entry.basis !== "reviewed" && entry.basis !== "carried") return `${label}.basis must be reviewed|carried when present`;
    if (entry.basis === "carried") {
      if (focused === null) return declared?.basis === "widened"
        ? `${label} cannot carry grounds in a round the reviewer widened to the whole contract`
        : `${label} cannot carry grounds outside a focused round; this round reviews the whole contract`;
      const obstacle = carriedObstacle(focused, role, label, requirementRefs, evidenceRefs, entry.conclusion);
      if (obstacle !== null) return obstacle;
    }
    if (entry.conclusion === "satisfied" && !evidenceRefs.some((ref) => context.actualEvidenceRefs.includes(ref))) {
      return `${label} satisfied requires an actual source, execution log or evidence reference; PRD and catalog metadata alone cannot establish implementation`;
    }
    if (entry.conclusion === "pending-human") {
      const deferred = reviewed.findings.filter((finding) => finding.kind === "human-confirmation" && finding.human?.timing === "post-completion");
      if (deferred.length === 0 || requirementRefs.some((ref) => !deferred.some((finding) => finding.requirementRefs.includes(ref)))) {
        return `${label} pending-human requires a corresponding validated post-completion human-confirmation finding for each referenced requirement`;
      }
    }
    if (entry.conclusion === "unresolved") {
      const blockers = reviewed.findings.filter((finding) => finding.kind === "defect" || (finding.kind === "human-confirmation" && finding.human?.timing === "prerequisite"));
      if (blockers.length === 0 || requirementRefs.some((ref) => !blockers.some((finding) => finding.requirementRefs.includes(ref)))) {
        return `${label} unresolved requires a corresponding blocking finding for each referenced requirement; preserve it in the repair history`;
      }
    }
    assessments.push({ requirementRefs, conclusion: entry.conclusion, rationale: entry.rationale, evidenceRefs, ...(entry.basis === "carried" ? { basis: "carried" as const } : {}) });
  }
  if (role === "fidelity") {
    const missing = context.requiredRequirementRefs.filter((ref) => !covered.has(ref));
    if (missing.length > 0) return `fidelity assessments missing required references: ${missing.join(", ")}`;
  }
  return { ...reviewed, assessments, ...(declared === undefined ? {} : { scope: declared }) };
}

export function implementationReviewSchema(role: RoutineReviewRole, scope: ReviewScope | undefined = undefined): string {
  const focused = scope?.mode === "focused";
  return `${reviewResultSchema()}
Include one additional top-level field in that SAME JSON object:
"assessments": [{"requirementRefs":[],"conclusion":"satisfied|unresolved|pending-human","rationale":"short concrete assessment of actual implementation and evidence","evidenceRefs":[]${focused ? ',"basis":"reviewed|carried"' : ""}}]${focused ? `
Also include "scope": {"basis":"focused|widened","reason":"how far this round reached and why"}.
"basis" is reviewed when you inspected the grounds in this round (the default when omitted) and carried only for a satisfied ground you settled at the anchor attempt whose cited evidence is unchanged and which the changes cannot reach; cite the same or fewer evidence references as that anchor assessment. Carried grounds are refused for changed evidence, for requirements named by an open blocking finding, and in a widened round.` : ""}
${role === "fidelity" ? "Fidelity must include every REQUIRED FIDELITY REFERENCE exactly once across assessments. Group related requirements in one semantic entry when the same grounds apply." : "Code must record at least one substantive assessment of implementation, integration or error paths. Do not repeat an all-requirement accounting form; use only applicable requirementRefs, or [] for code-wide grounds."}
Use each requirement reference at most once across assessments; group related grounds together. Findings may cite the same references independently.
Every assessment needs nonempty rationale and valid evidenceRefs. A satisfied assessment must cite at least one ACTUAL EVIDENCE REFERENCE whose provided contents you inspected; PRD/Decision text and catalog-only paths are not implementation evidence.
One complete source file or shared observation can support many requirements. This accounting does not require separate tests, executions, artifacts or calls per requirement.
Use unresolved for a concrete unmet requirement or evidence-access defect and include a corresponding blocking finding covering its requirementRefs. Unresolved accounting cannot PASS. Do not hide an unresolved concern in an assessment without a finding.
Use pending-human only for an explicitly reserved post-completion human judgment. Include a matching human-confirmation finding with timing post-completion covering each referenced requirement and its exact validated authority quote. This may reach complete-pending-human; it is not satisfied or evidence of product correctness. Defects, prerequisites and missing evidence stay unresolved.
These records expose coverage and grounds; they do not certify that your reasoning is correct.`;
}
