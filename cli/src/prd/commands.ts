import fs from "node:fs";
import { prelintPrd } from "../gates/prelint";
import { normalizeProjectPath } from "../implement/store";
import { parseImplementContract } from "../implement/contract";

export interface PrdCommandResult {
  ok: boolean;
  action: string;
  exitCode: number;
  message: string;
  detail?: Record<string, unknown>;
}

export function runPrdCommand(
  projectRoot: string,
  subcommand: string | undefined,
  flags: Map<string, string | true>,
): PrdCommandResult {
  if (subcommand !== "readiness") {
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown prd subcommand; use readiness" };
  }
  const input = flags.get("prd");
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, action: "readiness", exitCode: 2, message: "missing required --prd <path>" };
  }
  try {
    const resolved = normalizeProjectPath(projectRoot, input);
    if (!fs.existsSync(resolved.absolute)) throw new Error(`PRD not found: ${resolved.relative}`);
    const text = fs.readFileSync(resolved.absolute, "utf8");
    const prelint = prelintPrd(text);
    const contract = parseImplementContract(text);
    const detail = {
      prdPath: resolved.relative,
      parsed: {
        taskCount: contract.tasks.length,
        acceptanceCriteriaCount: contract.acceptanceCriteria.length,
        verificationCount: contract.verification.length,
      },
      blockingGaps: prelint.findings,
      warnings: prelint.warnings ?? [],
      status: prelint.ok ? "ready" : "needs_review",
    };
    return {
      ok: prelint.ok,
      action: "readiness",
      exitCode: prelint.ok ? 0 : 1,
      message: prelint.ok ? "PRD contract is ready for implementation" : "PRD contract has blocking gaps",
      detail,
    };
  } catch (error) {
    return {
      ok: false,
      action: "readiness",
      exitCode: 1,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
