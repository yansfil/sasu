import { reviewReferences, reviewResultSchema, validateReviewResult } from "../judge/types";
import type { ImplementationReviewContext, ImplementationReviewResult, ReviewAssessment, RoutineReviewRole } from "./types";

/** Structural accounting is inspectable grounding, not proof of a model's conclusion. */
export function validateImplementationReviewResult(value: unknown, context: ImplementationReviewContext, role: RoutineReviewRole): ImplementationReviewResult | string {
  const reviewed = validateReviewResult(value, context);
  if (typeof reviewed === "string") return reviewed;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.assessments) || raw.assessments.length === 0) return `${role} assessments must be a non-empty array of concrete review grounds`;
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
    assessments.push({ requirementRefs, conclusion: entry.conclusion, rationale: entry.rationale, evidenceRefs });
  }
  if (role === "fidelity") {
    const missing = context.requiredRequirementRefs.filter((ref) => !covered.has(ref));
    if (missing.length > 0) return `fidelity assessments missing required references: ${missing.join(", ")}`;
  }
  return { ...reviewed, assessments };
}

export function implementationReviewSchema(role: RoutineReviewRole): string {
  return `${reviewResultSchema()}
Include one additional top-level field in that SAME JSON object:
"assessments": [{"requirementRefs":[],"conclusion":"satisfied|unresolved|pending-human","rationale":"short concrete assessment of actual implementation and evidence","evidenceRefs":[]}]
${role === "fidelity" ? "Fidelity must include every REQUIRED FIDELITY REFERENCE exactly once across assessments. Group related requirements in one semantic entry when the same grounds apply." : "Code must record at least one substantive assessment of implementation, integration or error paths. Do not repeat an all-requirement accounting form; use only applicable requirementRefs, or [] for code-wide grounds."}
Use each requirement reference at most once across assessments; group related grounds together. Findings may cite the same references independently.
Every assessment needs nonempty rationale and valid evidenceRefs. A satisfied assessment must cite at least one ACTUAL EVIDENCE REFERENCE whose provided contents you inspected; PRD/Decision text and catalog-only paths are not implementation evidence.
One complete source file or shared observation can support many requirements. This accounting does not require separate tests, executions, artifacts or calls per requirement.
Use unresolved for a concrete unmet requirement or evidence-access defect and include a corresponding blocking finding covering its requirementRefs. Unresolved accounting cannot PASS. Do not hide an unresolved concern in an assessment without a finding.
Use pending-human only for an explicitly reserved post-completion human judgment. Include a matching human-confirmation finding with timing post-completion covering each referenced requirement and its exact validated authority quote. This may reach complete-pending-human; it is not satisfied or evidence of product correctness. Defects, prerequisites and missing evidence stay unresolved.
These records expose coverage and grounds; they do not certify that your reasoning is correct.`;
}
