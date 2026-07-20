/**
 * Judge inputs ride on argv (codex) and a single completion window, so each
 * document is clamped head+tail with an explicit truncation notice rather
 * than failing or silently cutting the end.
 */
export function clampDocument(text: string, maxChars = 120_000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... TRUNCATED ${text.length - maxChars} chars for judge input budget ...]\n\n${text.slice(-half)}`;
}

const GAP_JSON_CONTRACT = `Reply with ONLY a JSON object, no prose, no code fences:
{
  "verdict": "PASS" | "BLOCK",
  "findings": [
    {
      "area": "<short area, e.g. data, ux, verification>",
      "severity": "P0" | "P1" | "P2",
      "missing": "<one sentence: the concrete gap>",
      "recommendation": "<one sentence: how to close it>",
      "requiresHuman": true | false
    }
  ]
}
Rules:
- BLOCK only for material gaps (P0/P1) that would change scope, behavior, acceptance, risk, or verification.
- List EVERY material gap you can find in THIS single pass. Do not hold findings back for a later
  round: a re-run on the fixed document should find nothing new unless the document changed.
- Depth bar: internal API details that a competent implementer resolves by following the codebase's
  existing conventions - parameter type guards, null/undefined contracts, return-shape mechanics,
  which case variant gets stored - are at most P2 notes, NEVER blockers. Block only on decisions
  that change user-visible behavior, data shape, scope, or risk in a way the USER would care about.
- CONSENT PROVENANCE: compare every resolved decision or assumption with its cited Raw Q&A answer
  or exact repository evidence. A judge recommendation is not evidence or permission to resolve a
  policy. If the recorded policy is stronger or broader than the cited answer - including its scope,
  duration, lifecycle, compatibility, security, cost, or launch effect - report the unsupported part.
  Treat invented consent as P0 because it corrupts the canonical PRD source, including on a re-run.
- PASS may carry P2 notes only.
- requiresHuman is true whenever closure needs explicit user intent or approval, including product
  behavior, scope, data lifecycle, public or provider contracts, compatibility or deprecation,
  auth or security, cost, launch, and taste judgments.
- requiresHuman: false does not authorize the agent to invent or silently resolve a policy. Use false
  only when exact repository evidence settles the gap or the remaining choice is a reversible internal
  P2 engineering detail; otherwise recommend explicit confirmation or deferral.
- Never output a numeric score of any kind.`;

export interface PriorFinding {
  severity: string;
  area: string;
  missing: string;
}

/**
 * A fan-out lane: one narrow parallel judge (PRD judge-fanout R1/R2, D-06).
 * Lanes are fixed in code - gap-audit splits by document area, spec by its
 * three original review axes. areaHints route prior findings on re-runs.
 */
export interface JudgeLane {
  id: string;
  title: string;
  scope: string;
  areaHints: string[];
}

export const GAP_AUDIT_LANES: JudgeLane[] = [
  {
    id: "goal-scope",
    title: "goal, scope, and non-goals",
    scope:
      "Missing or ambiguous decisions about the product goal, target users, in-scope behavior, explicit non-goals, deferred items without revisit triggers, and scope boundaries the implementing team would otherwise invent.",
    areaHints: ["goal", "scope", "non-goal", "nongoal", "intent", "product", "user"],
  },
  {
    id: "ux-behavior",
    title: "UX, behavior, states, and recovery",
    scope:
      "Missing or ambiguous decisions about user-facing flows, golden paths, empty/loading/error/permission states, validation, retry/cancel/undo, destructive-action recovery, and copy or taste boundaries needing human judgment.",
    areaHints: ["ux", "behavior", "state", "recovery", "flow", "copy", "design", "accessibility"],
  },
  {
    id: "data-tech",
    title: "data, technical structure, and external providers",
    scope:
      "Missing or ambiguous decisions about data shape, source of truth, lifecycle/retention, schema or storage, API/service boundaries, external provider contracts, credentials ownership, compatibility, and migration.",
    areaHints: ["data", "tech", "architecture", "provider", "api", "schema", "storage", "compatibility", "migration", "integration"],
  },
  {
    id: "risk-ops-verification",
    title: "risk, operation, and verification proof",
    scope:
      "Missing or ambiguous decisions about risks and side effects, security/access boundaries, cost or rate limits, rollout/launch/operational needs, and whether every primary behavior has an observable verification proof.",
    areaHints: ["risk", "operation", "ops", "verification", "security", "launch", "cost", "proof", "observability"],
  },
];

export const SPEC_LANES: JudgeLane[] = [
  {
    id: "fidelity",
    title: "fidelity to the interview log",
    scope:
      "Every material decision in the interview log's Decision Register must be represented in the PRD without distortion: rejected options stayed rejected, deferred items kept their revisit conditions, and agent assumptions were not upgraded into user decisions.",
    areaHints: ["fidelity", "intent", "decision", "traceability"],
  },
  {
    id: "testability",
    title: "testability of acceptance criteria",
    scope:
      "Every acceptance criterion must be an observable, testable statement. Flag vague qualifiers (\"적절히\", \"빠르게\", \"appropriately\", \"robust\") used as acceptance language.",
    areaHints: ["testability", "acceptance", "criteria"],
  },
  {
    id: "verification-completeness",
    title: "verification completeness",
    scope:
      "Every requirement and acceptance criterion must map to a verification item or an explicit human-verification/non-goal disposition, and required verification must state an observable pass intent. Method: walk the R# list and the AC# list ONE BY ONE, and for each id check whether any V row's Covers column (or a human-verification/non-goal line) names it; report every id that nothing covers. This is a mechanical cross-reference - do it exhaustively, it is cheap.",
    areaHints: ["verification", "coverage", "proof"],
  },
];

/**
 * Lane scoping preamble. Mutual-exclusion wording keeps near-duplicates down
 * (D-08 accepted tradeoff), while genuinely cross-lane gaps must still be
 * reported - the CLI deduplicates.
 */
function laneContext(lane: JudgeLane | undefined, laneCount: number): string {
  if (!lane) return "";
  return `
LANE SCOPE: you are one of ${laneCount} parallel judges, each owning one lane. Your lane: ${lane.title}.
${lane.scope}
Report ONLY gaps that belong to your lane; the other lanes are judged in parallel by other judges,
so do not report gaps clearly outside your lane. If a gap genuinely spans your lane and another,
report it anyway - the harness deduplicates.
Work budget: read the document once, skim the parts outside your lane just enough for context, and
answer directly. A complete document typically has ZERO to THREE material gaps per lane - finding
nothing is a normal, correct outcome. Do not manufacture findings to appear thorough, do not
enumerate micro-variants of one gap (report the one underlying decision), and keep the total small.
`;
}

/**
 * Delta re-judgment context (anti progressive-discovery): re-runs carry the
 * previous round's findings so the judge converges instead of opening ever
 * deeper lines of questioning on an honestly revised document.
 */
function rerunContext(priorFindings: PriorFinding[], rerun = priorFindings.length > 0): string {
  if (!rerun) return "";
  if (priorFindings.length === 0) {
    // A re-run with no carried-over findings: either a fan-out lane that had
    // none routed to it, or a post-PASS STALE re-run. Origin labeling is
    // still mandatory so mechanical convergence can apply.
    return `
RE-RUN CONTEXT: this document was judged before (and may have passed) and has since been revised.
No unresolved prior finding carries over, so every finding you report MUST carry an extra field
"origin": "new". Do NOT open new, deeper lines of questioning about aspects that were previously
acceptable. Report a new finding only when the revision introduced it, it is a missed P0, or closing
it requires explicit human agreement. The harness keeps human-required findings blocking on re-runs;
other new findings below P0 cannot block.
`;
  }
  const lines = priorFindings.map((f) => `- [${f.severity}/${f.area}] ${f.missing}`).join("\n");
  return `
RE-RUN CONTEXT: this document was judged before and the findings below were reported; the author
has since revised it. Judge the revision as follows:
1. For each prior finding, check whether the revision resolves it. Resolved findings must NOT be
   reported again.
2. Report a prior finding again ONLY if it remains genuinely unaddressed.
3. Do NOT open new, deeper lines of questioning about aspects that were previously acceptable.
   A NEW finding is allowed only when it was introduced by the revision itself, or it is a
   missed P0 without which the document is unimplementable, or closing it requires explicit human
   agreement - treat all three as exceptional.
4. On this re-run every finding MUST carry an extra field "origin": "prior-unresolved" (a prior
   finding that is still unaddressed) or "new". The harness enforces convergence mechanically:
   human-required findings remain blocking; other new findings below P0 cannot block, so label honestly.

PRIOR FINDINGS:
${lines}
`;
}

export interface LanePromptOptions {
  lane?: JudgeLane;
  laneCount?: number;
  rerun?: boolean;
}

export function gapAuditPrompt(
  qaLogContent: string,
  priorFindings: PriorFinding[] = [],
  options: LanePromptOptions = {},
): string {
  const exhaustiveBlock = options.lane
    ? `Sweep the log ONCE for your lane only and list every material gap in YOUR lane in this single
reply: a re-run on the fixed log must find nothing new in your lane unless the document changed.`
    : `Be exhaustive NOW, not later. Before answering, sweep every operation, entity, and behavior the log
already mentions and list, in this same reply, every unspecified error and edge-case decision for
each of them (invalid input, missing/unknown id, empty or conflicting state, ordering ties). If an
edge case of an operation named in the log is worth blocking on, it must appear in THIS pass -
surfacing it only on a later re-run of the fixed log is a contract violation.`;
  return `You are an independent interview-closure judge for an engineering requirements interview.
You have no prior context about this project beyond the interview log below.
Your only job: list the material gaps that would block writing a faithful PRD from this log.

A material gap is a missing or ambiguous decision about scope, primary user behavior, data,
acceptance, verification, risk, or operation that the implementing team would otherwise have to invent.
Resolved decisions supported by their cited Raw Q&A answers or exact repository evidence,
explicitly deferred items with revisit triggers, and explicitly rejected options are NOT gaps.
Do not invent nice-to-have process gaps. An empty findings list with verdict PASS is the correct
answer for a complete log.

${exhaustiveBlock}
${laneContext(options.lane, options.laneCount ?? 1)}
${GAP_JSON_CONTRACT}
${rerunContext(priorFindings, options.rerun ?? priorFindings.length > 0)}
INTERVIEW LOG (qa-log.md):
---
${clampDocument(qaLogContent)}
---`;
}

export function specGatePrompt(
  prdContent: string,
  qaLogContent: string,
  priorFindings: PriorFinding[] = [],
  options: LanePromptOptions = {},
): string {
  const axes = options.lane
    ? `Judge the PRD on exactly ONE axis - ${options.lane.title.toUpperCase()}:
${options.lane.scope}`
    : `Judge the PRD on exactly three axes (D-21 contract):
(a) FIDELITY: every material decision in the interview log's Decision Register is represented in the
    PRD without distortion. Rejected options stayed rejected. Deferred items stayed deferred with a
    revisit condition. Agent assumptions were not upgraded into user decisions.
(b) TESTABILITY: every acceptance criterion is an observable, testable statement. Flag vague
    qualifiers ("적절히", "빠르게", "appropriately", "robust") used as acceptance language.
(c) VERIFICATION COMPLETENESS: every requirement and acceptance criterion maps to a verification
    item or an explicit human-verification/non-goal disposition.`;
  return `You are an independent PRD spec-gate judge (fidelity + self-containment).
You have no prior context beyond the two documents below.

${axes}

Report only material violations as findings; area should be one of: fidelity, testability, verification.
An empty findings list with verdict PASS is the correct answer for a faithful, self-contained PRD.
${laneContext(options.lane, options.laneCount ?? 1)}
${GAP_JSON_CONTRACT}
${rerunContext(priorFindings, options.rerun ?? priorFindings.length > 0)}
PRD (prd.md):
---
${clampDocument(prdContent)}
---

INTERVIEW LOG (qa-log.md):
---
${clampDocument(qaLogContent)}
---`;
}

export function semanticVerifyPrompt(diffContent: string, criteria: { id: string; text: string }[]): string {
  const criteriaBlock = criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return `You are an independent implementation reviewer.
You have no prior context beyond the acceptance criteria and the diff below.
The mechanical checks (tests/lint/build) already passed; do not re-litigate them.

For EACH acceptance criterion, judge whether the diff plausibly satisfies it.
PASS a criterion only when the diff contains concrete evidence for it (code, test, config, doc).
FAIL a criterion when the diff is missing it, contradicts it, or only gestures at it.
Judge only the listed criteria. Base reasons on specific files/hunks in the diff.

Reply with ONLY a JSON object, no prose, no code fences:
{
  "verdict": "PASS" | "FAIL",
  "criteria": [
    { "id": "<criterion id>", "verdict": "PASS" | "FAIL", "reason": "<one sentence citing diff evidence>" }
  ]
}
Rules:
- Include every listed criterion id exactly once.
- Overall verdict is FAIL if any criterion FAILs, otherwise PASS.

ACCEPTANCE CRITERIA:
${criteriaBlock}

DIFF:
---
${clampDocument(diffContent, 160_000)}
---`;
}
