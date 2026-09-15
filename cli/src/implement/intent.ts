import fs from "node:fs";
import path from "node:path";
import type { ImplementContract } from "./contract";

export interface IntentSource {
  routing: "decisions" | "full-qa-log";
  content: string;
  explanation: string;
}

export function renderDecisions(contract: ImplementContract): string {
  if (contract.decisions.length === 0) return "- none";
  return contract.decisions.map((entry) => `- ${entry.id}: ${entry.decision} (근거: ${entry.rationale})`).join("\n");
}

/** Resolve canonical intent without silently substituting a missing source. */
export function intentSource(projectRoot: string, contract: ImplementContract, specGateFresh: boolean): IntentSource {
  const source = contract.frontmatter["source_intake"];
  if (source === undefined || source.trim() === "") throw new Error("canonical intent source_intake is missing");
  if (source === "current conversation") {
    return { routing: "decisions", content: renderDecisions(contract), explanation: "The CLI cannot read chat history; the approved Decisions table records the canonical user intent." };
  }
  const root = fs.realpathSync(projectRoot);
  const resolved = path.resolve(root, source);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`canonical intent source escapes project: ${source}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`canonical intent source is missing or is not a file: ${source}`);
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${root}${path.sep}`)) throw new Error(`canonical intent source resolves outside project: ${source}`);
  if (specGateFresh) {
    return { routing: "decisions", content: renderDecisions(contract), explanation: "The current spec gate compared the canonical intake with the PRD; verification starts from the complete approved Decisions table." };
  }
  return { routing: "full-qa-log", content: fs.readFileSync(real, "utf8"), explanation: "The spec gate is absent or stale; verification fingerprints the complete canonical intake alongside the PRD." };
}
