import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "../config";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import { JudgeError, validateGapVerdict, type Finding, type JudgeCallRecord } from "../judge/types";
import { clampDocument } from "../gates/prompts";
import { parseRegisterRows, type RegisterRow } from "./qalog";
import { resolveQaLogPath } from "./commands";

/**
 * Mid-interview coherence check (advisory).
 *
 * This is NOT the closure gate. gap-audit asks "is the interview DONE?" and
 * treats every open node as a gap - correct at closure, pure noise mid-flight.
 * Coherence asks a different question: "do the decisions made SO FAR cohere,
 * and is the interview still on its stated goal?" It judges only RESOLVED
 * decisions for contradiction and goal-drift, and is explicitly forbidden from
 * reporting incompleteness. Its findings become next-question candidates, so
 * it never touches gate state, the retry budget, or a PASS pin.
 */

export interface CoherenceResult {
  ok: boolean;
  action: "coherence";
  slug: string;
  skipped: boolean;
  reason: string | null;
  resolvedCount: number;
  verdict: "PASS" | "BLOCK" | null;
  findings: Finding[];
  durationMs: number | null;
  judge: JudgeCallRecord | null;
  error: { code: string; message: string; recovery: string } | null;
}

/** Decisions the judge is allowed to weigh: things the user has actually settled. */
function decidedRows(rows: RegisterRow[]): RegisterRow[] {
  return rows.filter((row) => row.status === "resolved");
}

function currentUnderstanding(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Current Understanding");
  if (start === -1) return "(none recorded)";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body === "" ? "(none recorded)" : body;
}

export function coherencePrompt(topic: string, understanding: string, decided: RegisterRow[]): string {
  const decisions = decided
    .map((row) => `- ${row.id} [${row.area}] ${row.text} (source: ${row.source})`)
    .join("\n");
  return `You are an independent mid-interview coherence checker for an engineering requirements interview.
The interview is STILL IN PROGRESS. You have no prior context beyond the material below.

Judge ONE thing only: do the decisions made so far cohere with each other and with the stated goal?
This is a DIRECTION check, not a completeness check.

CRITICAL - what is NOT a finding:
- Missing decisions, unexplored areas, open questions, "you should also decide X". The interview is
  deliberately incomplete right now; incompleteness is EXPECTED and is never a finding here. A
  separate closure gate handles completeness later.
- Depth or edge-case details. Do not manufacture gaps.

Report a finding ONLY for one of these coherence problems among the RESOLVED decisions:
1. CONTRADICTION: two resolved decisions that cannot both hold.
2. GOAL DRIFT: a resolved decision that pulls the product toward a different user, scope, or purpose
   than the stated goal / current understanding.
3. INCOHERENT PREMISE: the resolved decisions collectively only make sense for a different problem
   than the one stated - a sign the interview has silently changed direction.

Severity: P0 = a contradiction or drift that invalidates decisions already made and should be
resolved before more questions pile on top; P1 = real tension worth surfacing now; P2 = minor note.
An empty findings list with verdict PASS is the correct, common answer for a coherent interview.

Reply with ONLY a JSON object, no prose, no code fences:
{
  "verdict": "PASS" | "BLOCK",
  "findings": [
    {
      "area": "<short area, e.g. scope, ux, data>",
      "severity": "P0" | "P1" | "P2",
      "missing": "<one sentence: the concrete coherence problem, naming the D# ids involved>",
      "recommendation": "<one sentence: the question to ask or the decision to revisit>",
      "requiresHuman": true | false
    }
  ]
}
Rules:
- BLOCK only when a P0/P1 coherence problem exists. PASS may carry P2 notes only.
- requiresHuman is true when resolving the contradiction needs a user product decision.
- Never report a missing decision. Never output a numeric score.

STATED GOAL: ${topic}

CURRENT UNDERSTANDING:
${clampDocument(understanding, 8_000)}

RESOLVED DECISIONS SO FAR:
${decisions}
---`;
}

export interface CoherenceOptions {
  slug: string;
  minDecisions: number;
}

/**
 * Run the advisory coherence judge. Below the minimum resolved-decision count
 * there is nothing to judge, so it skips (no judge call, no spend) rather than
 * asking a judge to rule on one or two decisions.
 */
export async function runInterviewCoherence(
  projectRoot: string,
  config: SasuConfig,
  options: CoherenceOptions,
): Promise<CoherenceResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.slug)) {
    throw new Error(`invalid topic slug: ${options.slug} (use kebab-case)`);
  }
  const file = resolveQaLogPath(projectRoot, options.slug);
  if (!fs.existsSync(file)) {
    throw new Error(`qa-log not found: ${path.relative(projectRoot, file)} (run interview init first)`);
  }
  const content = fs.readFileSync(file, "utf8");
  const topic = content.match(/^topic:\s*"?(.*?)"?\s*$/m)?.[1] ?? options.slug;
  const decided = decidedRows(parseRegisterRows(content));

  const base: CoherenceResult = {
    ok: true,
    action: "coherence",
    slug: options.slug,
    skipped: false,
    reason: null,
    resolvedCount: decided.length,
    verdict: null,
    findings: [],
    durationMs: null,
    judge: null,
    error: null,
  };

  if (decided.length < options.minDecisions) {
    return {
      ...base,
      skipped: true,
      reason: `only ${decided.length} resolved decision(s); coherence needs at least ${options.minDecisions}`,
    };
  }

  try {
    const outcome = await runJudge(
      config,
      "interview:coherence",
      "routine",
      coherencePrompt(topic, currentUnderstanding(content), decided),
      (value) => validateGapVerdict(value),
    );
    return {
      ...base,
      verdict: outcome.value.verdict,
      findings: outcome.value.findings,
      durationMs: outcome.record.durationMs,
      judge: outcome.record,
    };
  } catch (error) {
    if (!(error instanceof JudgeError)) throw error;
    const record = judgeCallRecordFrom(error);
    return {
      ...base,
      ok: false,
      durationMs: record?.durationMs ?? null,
      judge: record,
      error: {
        code: error.code,
        message: error.message,
        recovery:
          error.code === "judge-timeout"
            ? "Re-run; if it persists, raise judge.timeoutMs. Coherence is advisory - a failure never blocks the interview."
            : "Coherence is advisory: skip it and continue the interview, or fix the judge backend and re-run.",
      },
    };
  }
}
