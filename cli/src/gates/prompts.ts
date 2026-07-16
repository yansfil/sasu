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
- PASS may carry P2 notes only.
- requiresHuman is true only when closing the gap needs a product decision or taste judgment that an agent must not invent.
- Never output a numeric score of any kind.`;

export function gapAuditPrompt(qaLogContent: string): string {
  return `You are an independent interview-closure judge for an engineering requirements interview.
You have no prior context about this project beyond the interview log below.
Your only job: list the material gaps that would block writing a faithful PRD from this log.

A material gap is a missing or ambiguous decision about scope, primary user behavior, data,
acceptance, verification, risk, or operation that the implementing team would otherwise have to invent.
Resolved decisions, explicitly deferred items with revisit triggers, and explicitly rejected options are NOT gaps.
Do not invent nice-to-have process gaps. An empty findings list with verdict PASS is the correct
answer for a complete log.

${GAP_JSON_CONTRACT}

INTERVIEW LOG (qa-log.md):
---
${clampDocument(qaLogContent)}
---`;
}

export function specGatePrompt(prdContent: string, qaLogContent: string): string {
  return `You are an independent PRD spec-gate judge (fidelity + self-containment).
You have no prior context beyond the two documents below.

Judge the PRD on exactly three axes (D-21 contract):
(a) FIDELITY: every material decision in the interview log's Decision Register is represented in the
    PRD without distortion. Rejected options stayed rejected. Deferred items stayed deferred with a
    revisit condition. Agent assumptions were not upgraded into user decisions.
(b) TESTABILITY: every acceptance criterion is an observable, testable statement. Flag vague
    qualifiers ("적절히", "빠르게", "appropriately", "robust") used as acceptance language.
(c) VERIFICATION COMPLETENESS: every requirement and acceptance criterion maps to a verification
    item or an explicit human-verification/non-goal disposition.

Report only material violations as findings; area should be one of: fidelity, testability, verification.
An empty findings list with verdict PASS is the correct answer for a faithful, self-contained PRD.

${GAP_JSON_CONTRACT}

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
