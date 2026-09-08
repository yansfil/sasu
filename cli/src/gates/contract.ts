/** Compact quick contract: requirements are references; execution and evidence belong to the whole run. */
export interface EvidenceRef { path: string; line: number; }
export interface CaptureRef { command: string; path: string; line: number; }
export interface ContractCriterion { id: string; text: string; line: number; }
export interface ContractCheck { command: string; line: number; }
export interface ContractDefect { rule: string; line: number | null; missing: string; recommendation: string; }
export interface ParsedContract {
  checks: ContractCheck[];
  criteria: ContractCriterion[];
  evidence: EvidenceRef[];
  captures: CaptureRef[];
  humanReview: { text: string; line: number }[];
  defects: ContractDefect[];
}

export const EVIDENCE_MAX_BYTES = 64 * 1024;
export const QUICK_CONTRACT_VERSION = "sasu.quick.contract.v2";
export const RETIRED_QUICK_LAST_COMMIT = "488d3cc7d6e99742e7f68a1680fcb101710c8e20";
const BACKTICKED = /^`([^`]+)`$/;

function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  return { start, end };
}

function pathDefect(value: string, line: number): ContractDefect | null {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..")) {
    return { rule: "contract-evidence-path", line, missing: `evidence path escapes the project: ${value}`, recommendation: "Use a project-relative path without .. segments." };
  }
  return null;
}

export function parseContract(content: string): ParsedContract {
  const lines = content.split("\n");
  const result: ParsedContract = { checks: [], criteria: [], evidence: [], captures: [], humanReview: [], defects: [] };
  const each = (heading: string, visit: (line: string, number: number) => void): void => {
    const section = sectionRange(lines, heading);
    if (section) for (let i = section.start + 1; i < section.end; i += 1) visit(lines[i]!, i + 1);
  };
  each("## Acceptance Criteria", (raw, line) => {
    const ac = raw.match(/^-\s+(AC\d+)\.\s+(\S.*)$/);
    if (ac) result.criteria.push({ id: ac[1]!, text: ac[2]!.trim(), line });
    if (/^\s+-\s+[A-Za-z][A-Za-z0-9_-]*\s*:/.test(raw)) {
      result.defects.push({ rule: "contract-retired-method", line, missing: `retired per-AC method contract; expected ${QUICK_CONTRACT_VERSION}. Last supporting commit: ${RETIRED_QUICK_LAST_COMMIT}`, recommendation: "Keep AC text only. Put shared commands in Checks, artifacts/captures in optional Evidence, and human input in optional Human Review." });
    }
  });
  each("## Checks", (raw, line) => {
    const bullet = raw.match(/^-\s+(\S.*)$/);
    if (!bullet) return;
    const command = bullet[1]!.trim().match(BACKTICKED);
    if (!command) result.defects.push({ rule: "contract-check-format", line, missing: `check is not a single backticked command: ${bullet[1]}`, recommendation: "Write the complete command inside backticks." });
    else result.checks.push({ command: command[1]!.trim(), line });
  });
  each("## Evidence", (raw, line) => {
    const bullet = raw.match(/^-\s+(\S.*)$/);
    if (!bullet) return;
    const value = bullet[1]!.trim();
    if (value.startsWith("capture:")) {
      const capture = value.match(/^capture:\s*`([^`]+)`\s*(?:->|→)\s*(\S.*)$/);
      if (!capture) { result.defects.push({ rule: "contract-capture-format", line, missing: "capture must be `command` -> project-relative-path", recommendation: "Declare the command that writes the artifact." }); return; }
      const artifact = capture[2]!.trim();
      const defect = pathDefect(artifact, line);
      if (defect) result.defects.push(defect);
      else result.captures.push({ command: capture[1]!.trim(), path: artifact, line });
    } else {
      const artifact = value.replace(/^evidence:\s*/, "").replace(/^`([^`]+)`$/, "$1").trim();
      const defect = artifact === "" ? { rule: "contract-evidence-empty", line, missing: "evidence has no path", recommendation: "Supply a project-relative file path." } : pathDefect(artifact, line);
      if (defect) result.defects.push(defect);
      else result.evidence.push({ path: artifact, line });
    }
  });
  each("## Human Review", (raw, line) => {
    const text = raw.trim().replace(/^-\s+/, "").trim();
    if (text !== "") result.humanReview.push({ text, line });
  });
  return result;
}
