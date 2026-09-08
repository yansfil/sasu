import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { parseCommandArgv } from "./runner";
import type { ReviewProfile } from "./types";

interface ParsedBehaviorRow {
  id: string | null;
  behavior: string;
  decisionIds: string[];
  line: number;
  defects: string[];
}

interface ParserLibrary {
  PRD_SECTIONS: readonly string[];
  stripFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string };
  extractSection(markdown: string, heading: string): string;
  parseBehaviorRows(markdown: string): { section: { line: number } | null; rows: ParsedBehaviorRow[] };
  parseDecisionRows(markdown: string): Array<{ id: string; decision: string; rationale: string; line: number }>;
  missingPrdSections(markdown: string): string[];
  isLegacyFiveAxisPrd(markdown: string): boolean;
}

// The Markdown grammar is shared with prelint (one reader for both gates, R11);
// this is parsing reuse, not persistence compatibility.
const parser = require("../../lib/prd_parser.js") as ParserLibrary;

/**
 * The last commit whose `implement start` read the five-axis template
 * (R/AC/T/V/SC). Named in the refusal so a holder of an old PRD knows which
 * checkout can still run it, instead of being told only that it cannot (R2,
 * AC2). Old documents under agents/prd stay as files; nothing converts them.
 */
export const LEGACY_PRD_LAST_COMMIT = "e71731a93f17d335beb0557a83e726654993732c";

export interface DecisionRow {
  id: string;
  decision: string;
  rationale: string;
}

export interface BehaviorRowContract {
  id: string;
  behavior: string;
  decisionIds: string[];
  /** 1-based line of the row in the PRD; amend reports it. */
  line: number;
}

export interface ImplementContract {
  frontmatter: Record<string, string>;
  body: string;
  goal: string;
  nonGoals: string;
  decisions: DecisionRow[];
  rows: BehaviorRowContract[];
  technicalStructure: string;
  risks: string;
}

function profile(value: string | undefined): ReviewProfile {
  if (value === "trivial" || value === "standard" || value === "high-risk") return value;
  return "standard";
}

/**
 * Read a six-section PRD into the run's contract.
 *
 * Refuses, in this order: a five-axis document (naming the last commit that
 * reads it), a missing section, an unreadable Behaviors row. The row rules
 * are the parser's, so a document that lints clean starts, and one that does
 * not start also fails prelint on the same line (R2, R11).
 */
export function parseImplementContract(markdown: string): ImplementContract {
  if (parser.isLegacyFiveAxisPrd(markdown)) {
    throw new Error(`이 PRD는 구 형식(R/AC/T/V 다섯 축)이며 이 형식을 읽는 마지막 커밋은 \`${LEGACY_PRD_LAST_COMMIT}\` 입니다. 여섯 섹션 형식(${parser.PRD_SECTIONS.join(", ")})으로 다시 작성하세요.`);
  }
  const missing = parser.missingPrdSections(markdown);
  if (missing.length > 0) throw new Error(`PRD is missing section(s): ${missing.map((title) => `## ${title}`).join(", ")}`);
  const parsed = parser.stripFrontmatter(markdown);
  const behaviors = parser.parseBehaviorRows(markdown);
  if (behaviors.rows.length === 0) throw new Error("## Behaviors has no table rows; a run needs at least one B<n> row");
  const defects = behaviors.rows.flatMap((row) => row.defects.map((defect) => `line ${row.line} (${row.id ?? "row"}): ${defect}`));
  if (defects.length > 0) throw new Error(`Behaviors rows are unreadable:\n${defects.join("\n")}`);
  const decisions = parser.parseDecisionRows(markdown).map(({ id, decision, rationale }) => ({ id, decision, rationale }));
  const decisionIds = new Set(decisions.map((row) => row.id));
  for (const row of behaviors.rows) {
    for (const id of row.decisionIds) {
      if (!decisionIds.has(id)) throw new Error(`line ${row.line} (${row.id}): cites ${id}, which is not in the Decisions table`);
    }
  }
  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    goal: parser.extractSection(parsed.body, "Goal"),
    nonGoals: parser.extractSection(parsed.body, "Non-goals"),
    decisions,
    rows: behaviors.rows.map((row) => ({ id: row.id!, behavior: row.behavior, decisionIds: [...row.decisionIds], line: row.line })),
    technicalStructure: parser.extractSection(parsed.body, "Technical structure"),
    risks: parser.extractSection(parsed.body, "Risks"),
  };
}

export function reviewProfile(contract: ImplementContract): ReviewProfile {
  return profile(contract.frontmatter["review_profile"]);
}

export interface DetectedCommand {
  kind: "test" | "e2e" | "build" | "typecheck" | "lint";
  command: string;
  cwd: string;
}

function packageCommands(projectRoot: string, relativeDir: string): DetectedCommand[] {
  const file = path.join(projectRoot, relativeDir, "package.json");
  if (!fs.existsSync(file)) return [];
  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(fs.readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const cwd = relativeDir || ".";
  const commands: DetectedCommand[] = [];
  if (scripts["test"] !== undefined) commands.push({ kind: "test", command: "npm test", cwd });
  if (scripts["test:e2e"] !== undefined) commands.push({ kind: "e2e", command: "npm run test:e2e", cwd });
  if (scripts["build"] !== undefined) commands.push({ kind: "build", command: "npm run build", cwd });
  if (scripts["typecheck"] !== undefined) commands.push({ kind: "typecheck", command: "npm run typecheck", cwd });
  if (scripts["lint"] !== undefined) commands.push({ kind: "lint", command: "npm run lint", cwd });
  return commands;
}

function detectedCommands(projectRoot: string): DetectedCommand[] {
  const commands = packageCommands(projectRoot, "");
  const cliPackage = path.join(projectRoot, "cli", "package.json");
  if (fs.existsSync(cliPackage)) commands.push(...packageCommands(projectRoot, "cli"));
  const rootTests = path.join(projectRoot, "tests");
  if (fs.existsSync(rootTests) && fs.readdirSync(rootTests).some((name) => name.endsWith(".test.mjs"))) {
    commands.unshift({ kind: "test", command: "node --test tests/*.test.mjs", cwd: "." });
  }
  return commands;
}

function configuredCommands(projectRoot: string): DetectedCommand[] {
  const commands = loadConfig(projectRoot).verify.commands;
  return (["test", "build", "typecheck", "lint"] as const)
    .filter((kind) => typeof commands[kind] === "string" && commands[kind]!.trim() !== "")
    .map((kind) => ({ kind, command: commands[kind]!, cwd: "." }));
}

/**
 * The regression suite a run is measured against, sealed at start (AC5 of
 * the gate-loop PRD). An explicit project config is the only reliable way
 * to bind a nested product's checks when the repository also contains
 * harness checks; config lives in the record tree, detection inspects the
 * tree the commands will actually run in (the run's worktree when isolated).
 */
export function suiteCommands(configRoot: string, treeRoot: string): DetectedCommand[] {
  const commands = configuredCommands(configRoot);
  const seen = new Set<string>();
  return (commands.length > 0 ? commands : detectedCommands(treeRoot)).filter((entry) => {
    // Labels are reporting metadata. The actual command, working directory and
    // run-wide execution configuration define an execution, not its test/build label.
    const key = JSON.stringify([path.resolve(treeRoot, entry.cwd), parseCommandArgv(entry.command)]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
