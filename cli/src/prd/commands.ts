import fs from "node:fs";
import { prelintPrd } from "../gates/prelint";
import { normalizeProjectPath } from "../implement/store";
import { parseImplementContract } from "../implement/contract";
import { setFrontmatterValue } from "../interview/qalog";

const { parseFrontmatterBlock } = require("../../lib/prd_parser.js") as {
  parseFrontmatterBlock(markdown: string): { entries: { key: string; value: string; line: number }[]; body: string } | null;
};

export interface PrdCommandResult {
  ok: boolean;
  action: string;
  exitCode: number;
  message: string;
  detail?: Record<string, unknown>;
}

interface ResolvedPrd {
  relative: string;
  absolute: string;
  text: string;
}

function resolvePrd(projectRoot: string, flags: Map<string, string | true>): ResolvedPrd {
  const input = flags.get("prd");
  if (typeof input !== "string" || input.trim() === "") throw new Error("missing required --prd <path>");
  const resolved = normalizeProjectPath(projectRoot, input);
  if (!fs.existsSync(resolved.absolute)) throw new Error(`PRD not found: ${resolved.relative}`);
  return { ...resolved, text: fs.readFileSync(resolved.absolute, "utf8") };
}

function frontmatterValue(text: string, key: string): string | null {
  const block = parseFrontmatterBlock(text);
  if (block === null) return null;
  for (const entry of block.entries) if (entry.key === key) return entry.value;
  return null;
}

function readinessOf(prd: ResolvedPrd): { ok: boolean; detail: Record<string, unknown> } {
  const prelint = prelintPrd(prd.text);
  // The contract parser is the reader `implement start` uses; a document
  // prelint passes but start would refuse (a five-axis PRD, a dangling D-id)
  // is reported here with start's own words rather than discovered at start.
  let parsed: Record<string, unknown>;
  let contractError: string | null = null;
  try {
    const contract = parseImplementContract(prd.text);
    const kinds = contract.rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.check.kind] = (counts[row.check.kind] ?? 0) + 1;
      return counts;
    }, { check: 0, judge: 0, human: 0 });
    parsed = { rowCount: contract.rows.length, rowKinds: kinds, decisionCount: contract.decisions.length };
  } catch (error) {
    contractError = error instanceof Error ? error.message : String(error);
    parsed = { rowCount: 0, rowKinds: { check: 0, judge: 0, human: 0 }, decisionCount: 0 };
  }
  return {
    ok: prelint.ok && contractError === null,
    detail: {
      prdPath: prd.relative,
      parsed,
      contractError,
      blockingGaps: prelint.findings,
      warnings: prelint.warnings ?? [],
      status: prelint.ok ? "ready" : "needs_review",
    },
  };
}

/**
 * Lifecycle transitions are CLI verbs, not text surgery. Before these verbs
 * existed the rule "mark status: ready only when the readiness gate passes"
 * and "never write approved without the user's words" lived only in skill
 * prose, and measured sessions routed around it: agents grepped the dist
 * bundle for the enum values, flipped `status:` with python/sed, and one
 * $please run wrote `human_approval: "approved"` for a document no human had
 * read (2026-08-29 audit). A prose rule is a request for discipline; these
 * verbs are the guard. The recorded verbatim is the same falsifiable-quote
 * pattern gate delegate/override use: the CLI cannot authenticate a human,
 * but it can force a quote the user can repudiate.
 */
export function runPrdCommand(
  projectRoot: string,
  subcommand: string | undefined,
  flags: Map<string, string | true>,
): PrdCommandResult {
  try {
    if (subcommand === "readiness") {
      const prd = resolvePrd(projectRoot, flags);
      const readiness = readinessOf(prd);
      return {
        ok: readiness.ok,
        action: "readiness",
        exitCode: readiness.ok ? 0 : 1,
        message: readiness.ok ? "PRD contract is ready for implementation" : "PRD contract has blocking gaps",
        detail: readiness.detail,
      };
    }

    if (subcommand === "ready") {
      const prd = resolvePrd(projectRoot, flags);
      const current = frontmatterValue(prd.text, "status");
      if (current === "ready") {
        return { ok: true, action: "ready", exitCode: 0, message: "PRD status is already ready (no change)" };
      }
      const readiness = readinessOf(prd);
      if (!readiness.ok) {
        return {
          ok: false,
          action: "ready",
          exitCode: 1,
          message: "refused: the readiness gate has blocking gaps; fix them, then rerun",
          detail: readiness.detail,
        };
      }
      fs.writeFileSync(prd.absolute, setFrontmatterValue(prd.text, "status", "ready", true));
      return { ok: true, action: "ready", exitCode: 0, message: `PRD status set to ready (readiness gate passed)`, detail: readiness.detail };
    }

    if (subcommand === "approve") {
      const prd = resolvePrd(projectRoot, flags);
      const evidence = flags.get("evidence");
      if (typeof evidence !== "string" || evidence.trim() === "") {
        throw new Error('prd approve requires --evidence "<the user\'s verbatim approval>" - approval is a human decision and the quote is what makes fabrication falsifiable');
      }
      if (frontmatterValue(prd.text, "human_approval") === "approved") {
        return { ok: false, action: "approve", exitCode: 1, message: "refused: PRD is already approved; the original approval record stands" };
      }
      if (frontmatterValue(prd.text, "status") !== "ready") {
        return { ok: false, action: "approve", exitCode: 1, message: "refused: only a ready PRD can be approved; run sasu prd ready first" };
      }
      const quote = evidence.replace(/\s+/g, " ").trim();
      const stamp = new Date().toISOString().slice(0, 10);
      const flipped = setFrontmatterValue(prd.text, "human_approval", "approved", true)
        .replace(/^human_approval: "approved"$/m, `human_approval: "approved"  # user ${stamp} verbatim: ${quote}`);
      fs.writeFileSync(prd.absolute, flipped);
      return { ok: true, action: "approve", exitCode: 0, message: "PRD approved; the user's verbatim is recorded on the frontmatter line" };
    }

    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown prd subcommand; use readiness | ready | approve" };
  } catch (error) {
    return {
      ok: false,
      action: subcommand ?? "unknown",
      exitCode: subcommand === "readiness" || subcommand === "ready" || subcommand === "approve" ? 1 : 2,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
