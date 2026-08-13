import fs from "node:fs";
import path from "node:path";
import type { ImplementContract } from "./contract";
import type { ContractItem, ImplementState, MechanicalRunRecord, RegisteredArtifact } from "./types";

const JSON_RULE = "Reply with ONLY the requested JSON object. Do not use prose or code fences.";

function clamp(text: string, limit = 120_000): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 120) / 2);
  return `${text.slice(0, half)}\n\n[... input truncated by sasu ...]\n\n${text.slice(-half)}`;
}

function artifactSummary(artifacts: RegisteredArtifact[]): string {
  if (artifacts.length === 0) return "- none";
  return artifacts
    .map((artifact) => `- ${artifact.verificationId} ${artifact.kind} ${artifact.path} sha256=${artifact.sha256} - ${artifact.description}`)
    .join("\n");
}

function mechanicalSummary(runs: MechanicalRunRecord[]): string {
  if (runs.length === 0) return "- none";
  return runs
    .map((run) => `- ${run.status} cwd=${run.cwd} command=${run.command} verification=${run.verificationIds.join(",")} log=${run.logPath}`)
    .join("\n");
}

export function acceptancePrompt(
  state: ImplementState,
  criterion: ContractItem,
  changeMaterial: string,
  runs: MechanicalRunRecord[],
): string {
  const verification = state.verification.filter((entry) => entry.covers.includes(criterion.id));
  const verificationIds = new Set(verification.map((entry) => entry.id));
  const relevantRuns = runs.filter((run) => run.verificationIds.some((id) => verificationIds.has(id)));
  const relevantArtifacts = state.artifacts.filter((artifact) => verificationIds.has(artifact.verificationId));
  const requirements = state.requirements.filter((entry) => criterion.requirements.includes(entry.id));
  return `You are the acceptance-criterion judge for one semantic criterion in a completed implementation.
Judge only whether the implementation and registered evidence satisfy the criterion below.
Do not judge whether the original conversation's intent was preserved. A separate fidelity judge owns that question.
For PASS, cite a concrete changed file, diff hunk, mechanical log, or registered artifact.

${JSON_RULE}
{
  "verdict": "PASS" | "FAIL",
  "criteria": [
    { "id": "AC1", "verdict": "PASS" | "FAIL", "reason": "why", "evidence": "file, hunk, log, or artifact" }
  ]
}

ACCEPTANCE CRITERION:
- ${criterion.id}: ${criterion.text}

MAPPED REQUIREMENTS:
${requirements.length === 0 ? "- none" : requirements.map((entry) => `- ${entry.id}: ${entry.text}`).join("\n")}

MAPPED VERIFICATION PASS INTENTS:
${verification.length === 0 ? "- none" : verification.map((entry) => `- ${entry.id}: ${entry.passIntent}`).join("\n")}

RELEVANT MECHANICAL RESULTS:
${mechanicalSummary(relevantRuns)}

RELEVANT REGISTERED ARTIFACTS:
${artifactSummary(relevantArtifacts)}

RUN-OWNED CHANGE MATERIAL:
${clamp(changeMaterial)}`;
}

export interface FidelitySource {
  routing: "decision-traceability" | "full-qa-log";
  content: string;
  explanation: string;
}

export function fidelitySource(
  projectRoot: string,
  contract: ImplementContract,
  specGateFresh: boolean,
): FidelitySource {
  const source = contract.frontmatter["source_intake"] ?? "";
  if (source !== "" && source !== "current conversation" && !specGateFresh) {
    const resolved = path.resolve(projectRoot, source);
    if (resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`)) {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return {
          routing: "full-qa-log",
          content: fs.readFileSync(resolved, "utf8"),
          explanation: "The spec gate is absent or stale, so fidelity reads the complete canonical qa-log.",
        };
      }
    }
  }
  return {
    routing: "decision-traceability",
    content: contract.decisionTraceability,
    explanation:
      source === "current conversation"
        ? "The CLI cannot read chat history, so the PRD Decision Traceability section is the canonical source."
        : "A fresh spec gate settled qa-log to PRD fidelity, so this review starts from Decision Traceability.",
  };
}

export function fidelityPrompt(
  prdText: string,
  contract: ImplementContract,
  state: ImplementState,
  source: FidelitySource,
  changeMaterial: string,
): string {
  const claims = [
    `run=${state.status}`,
    ...state.tasks.map((entry) => `${entry.id}=${entry.status}`),
  ].join(", ");
  return `You are the independent requirements-fidelity judge for a completed implementation.
Judge intent lineage only. Do not repeat code-correctness, per-verification artifact sufficiency, or acceptance-criterion testing. The acceptance judge owns those questions.

Use this fixed rubric:
- F1 Original goal preserved.
- F2 Accepted decisions and constraints preserved.
- F3 Rejected options and non-goals were not reintroduced.
- F4 Deviations do not distort the intended product or workflow.
- F5 Completion and status claims are not overstated.

${JSON_RULE}
{
  "verdict": "PASS" | "FAIL",
  "checks": [
    { "id": "F1", "verdict": "PASS" | "FAIL", "reason": "why", "evidence": "decision or implementation reference" }
  ]
}
Return exactly F1 through F5 once each. PASS cannot contain a failed check.

SOURCE ROUTING: ${source.routing}
${source.explanation}

CANONICAL INTENT SOURCE:
${clamp(source.content)}

DECISION TRACEABILITY:
${clamp(contract.decisionTraceability)}

FULL APPROVED PRD:
${clamp(prdText)}

PRD SCOPE AND NON-GOALS:
${clamp(contract.scope)}

PRD RISKS AND OPEN DECISIONS:
${clamp(contract.risks)}

RECORDED DEVIATIONS:
${state.deviations.length === 0 ? "- none" : state.deviations.map((entry) => `- ${entry.type}: ${entry.summary}`).join("\n")}

IMPLEMENTATION CLAIMS:
${claims}
Acceptance-criterion statuses are intentionally omitted because the independent acceptance lane is judging them concurrently. Do not treat their pre-verify state as a completion claim.

REGISTERED ARTIFACT ROSTER:
${artifactSummary(state.artifacts)}

CURATED RUN-OWNED CHANGE SUMMARY:
${clamp(changeMaterial)}`;
}

export function riskPrompt(
  prdText: string,
  changeMaterial: string,
  acceptance: unknown,
  fidelity: unknown,
): string {
  return `You are the final adversarial risk judge for a high-risk implementation.
The acceptance and fidelity judges have already completed. Inspect only residual sensitive, destructive, irreversible, costly, production, security, rollback, and evidence-integrity risks.

${JSON_RULE}
{ "verdict": "PASS" | "FAIL", "findings": ["specific residual risk"] }
PASS requires an empty findings array. FAIL requires at least one finding.

ACCEPTANCE RESULT:
${JSON.stringify(acceptance)}

FIDELITY RESULT:
${JSON.stringify(fidelity)}

RUN-OWNED CHANGE MATERIAL:
${clamp(changeMaterial)}

PRD:
${clamp(prdText)}`;
}
