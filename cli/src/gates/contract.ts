/**
 * Quick-path contract parser.
 *
 * The contract is the whole spec for a quick run, so its evidence lane is the
 * only place a runtime claim (an API response, a screenshot) can enter the
 * gate. The lane is declarative on purpose: the contract names WHAT proves a
 * criterion and, for anything reproducible, the COMMAND that produces it - the
 * harness runs that command on its own clock and hashes the result into the
 * PASS pin. An agent-submitted artifact is never trusted as fresh.
 *
 * Evidence tiers, most trustworthy first (the skill requires escalating to the
 * highest tier a criterion can reach):
 *   1. `check: <cmd>`           - the harness runs it and shows the judge its exit
 *                                 code and output; no submission bias. A `## Checks`
 *                                 bullet is the same thing scoped to the whole run.
 *   2. `evidence: <path>`       - text inlined into the judge prompt, hash-pinned.
 *   3. `capture: <cmd> -> <path>` - harness-run capture attached to the judge.
 *   4. `human: <why>`           - not judged; handed to the user as requiresHuman.
 *
 * Parsing is shared by the prelint (which reports structural defects) and the
 * verify flow (which executes the lane), so both always read one grammar.
 */

export interface EvidenceRef {
  path: string;
  line: number;
}

export interface CaptureRef {
  command: string;
  path: string;
  line: number;
}

export interface CriterionCheck {
  command: string;
  line: number;
}

export interface ContractCriterion {
  id: string;
  text: string;
  line: number;
  /** Commands that prove THIS criterion; their result is shown to the judge. */
  checks: CriterionCheck[];
  evidence: EvidenceRef[];
  captures: CaptureRef[];
  /** Non-null when the criterion is declared human-verified; never judged. */
  human: string | null;
}

export interface ContractCheck {
  command: string;
  line: number;
}

export interface ContractDefect {
  rule: string;
  line: number | null;
  missing: string;
  recommendation: string;
}

export interface ParsedContract {
  checks: ContractCheck[];
  criteria: ContractCriterion[];
  defects: ContractDefect[];
}

/** Per-file cap on inlined text evidence; larger proof must become a check command. */
export const EVIDENCE_MAX_BYTES = 64 * 1024;

const AC_LINE = /^-\s+(AC\d+)\.\s+(\S.*)$/;
const SUBFIELD_LINE = /^\s+-\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const CAPTURE_VALUE = /^`([^`]+)`\s*(?:->|→)\s*(\S.*)$/;
const BACKTICKED = /^`([^`]+)`$/;

function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * A path the harness will read or write must stay inside the project and be
 * nameable from its root: an absolute path or a `..` escape would let the
 * contract point the evidence lane outside the tree the fingerprint covers.
 */
function pathDefect(rule: string, label: string, value: string, line: number): ContractDefect | null {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return { rule, line, missing: `${label} path is absolute: ${value}`, recommendation: "Use a path relative to the project root." };
  }
  if (value.split(/[\\/]/).includes("..")) {
    return { rule, line, missing: `${label} path escapes the project root: ${value}`, recommendation: "Keep evidence inside the project, e.g. under agents/quick/<slug>/evidence/." };
  }
  return null;
}

export function parseContract(content: string): ParsedContract {
  const lines = content.split("\n");
  const defects: ContractDefect[] = [];

  const checks: ContractCheck[] = [];
  const checksSection = sectionRange(lines, "## Checks");
  if (checksSection) {
    for (let i = checksSection.start + 1; i < checksSection.end; i += 1) {
      const raw = lines[i]!;
      const match = raw.match(/^-\s+(\S.*)$/);
      if (!match) continue;
      const value = match[1]!.trim();
      const backticked = value.match(BACKTICKED);
      if (!backticked) {
        defects.push({
          rule: "contract-check-format",
          line: i + 1,
          missing: `check "${value}" is not a single backticked command`,
          recommendation: "Write the whole command in backticks, e.g. `bash -c \"cd api && npm test\"`.",
        });
        continue;
      }
      checks.push({ command: backticked[1]!.trim(), line: i + 1 });
    }
  }

  const criteria: ContractCriterion[] = [];
  const acSection = sectionRange(lines, "## Acceptance Criteria");
  if (acSection) {
    let current: ContractCriterion | null = null;
    for (let i = acSection.start + 1; i < acSection.end; i += 1) {
      const raw = lines[i]!;
      const acMatch = raw.match(AC_LINE);
      if (acMatch) {
        current = { id: acMatch[1]!, text: acMatch[2]!.trim(), line: i + 1, checks: [], evidence: [], captures: [], human: null };
        criteria.push(current);
        continue;
      }
      const subMatch = raw.match(SUBFIELD_LINE);
      if (!subMatch) continue;
      const key = subMatch[1]!.toLowerCase();
      const value = subMatch[2]!.trim();
      if (!current) {
        defects.push({
          rule: "contract-orphan-subfield",
          line: i + 1,
          missing: `"${key}:" is not attached to any acceptance criterion`,
          recommendation: "Indent evidence fields under their '- AC#. ...' line.",
        });
        continue;
      }
      if (key === "check") {
        const backticked = value.match(BACKTICKED);
        if (!backticked) {
          defects.push({
            rule: "contract-criterion-check-format",
            line: i + 1,
            missing: `${current.id}: check "${value}" is not a single backticked command`,
            recommendation: "Write the whole command in backticks, e.g. check: `bash -c \"curl -sf localhost:3000/health\"`.",
          });
          continue;
        }
        current.checks.push({ command: backticked[1]!.trim(), line: i + 1 });
      } else if (key === "evidence") {
        if (value === "") {
          defects.push({ rule: "contract-evidence-empty", line: i + 1, missing: `${current.id}: evidence has no path`, recommendation: "Give a project-relative path to the evidence file." });
          continue;
        }
        const bad = pathDefect("contract-evidence-path", `${current.id}: evidence`, value, i + 1);
        if (bad) defects.push(bad);
        else current.evidence.push({ path: value, line: i + 1 });
      } else if (key === "capture") {
        const captureMatch = value.match(CAPTURE_VALUE);
        if (!captureMatch) {
          defects.push({
            rule: "contract-capture-format",
            line: i + 1,
            missing: `${current.id}: capture must be \`<command>\` -> <artifact path>`,
            recommendation: "Declare the command that produces the artifact, e.g. capture: `node scripts/shot.js out/dark.png` -> out/dark.png.",
          });
          continue;
        }
        const artifact = captureMatch[2]!.trim();
        const bad = pathDefect("contract-capture-path", `${current.id}: capture artifact`, artifact, i + 1);
        if (bad) defects.push(bad);
        else current.captures.push({ command: captureMatch[1]!.trim(), path: artifact, line: i + 1 });
      } else if (key === "human") {
        if (value === "") {
          defects.push({ rule: "contract-human-empty", line: i + 1, missing: `${current.id}: human has no reason`, recommendation: "State what a person must check and why a command cannot." });
          continue;
        }
        current.human = value;
      } else {
        defects.push({
          rule: "contract-unknown-subfield",
          line: i + 1,
          missing: `${current.id}: unknown evidence field "${key}"`,
          recommendation: "Use one of: check, evidence, capture, human.",
        });
      }
    }
  }

  // A criterion cannot be both judged and handed to a person: the mixed shape
  // reads as "verified" while nobody owns half the proof.
  for (const criterion of criteria) {
    if (criterion.human !== null && (criterion.evidence.length > 0 || criterion.captures.length > 0 || criterion.checks.length > 0)) {
      defects.push({
        rule: "contract-human-conflict",
        line: criterion.line,
        missing: `${criterion.id} declares human verification AND machine evidence`,
        recommendation: "Split it into two criteria, or drop the human field if the evidence proves it.",
      });
    }
  }

  return { checks, criteria, defects };
}
