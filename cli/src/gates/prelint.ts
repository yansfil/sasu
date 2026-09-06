import type { Finding } from "../judge/types";
import { parseContract } from "./contract";

/**
 * Deterministic pre-judge document lint (PRD gate-prelint-json R2/R3).
 *
 * Every rule here targets an unambiguous structural defect - the rule set is
 * fixed by user decision (D-04) with a zero-false-positive goal, so parsing is
 * lenient (trimmed comparisons, prefix matches) and anything genuinely
 * ambiguous is left to the judge. ID continuity (gaps like R1,R2,R4) is an
 * explicit non-goal: intentional deletions must not block.
 *
 * A prelint failure is a hard block that never reaches the judge and never
 * consumes a gate attempt (D-02): the check costs nothing, so unlimited
 * re-fixes are harmless.
 */

// Table-cell splitting comes from the shared parser so prelint sees exactly
// the same cell boundaries the state parser persists.
const { parseQaAnswers } = require("../../lib/qa_register.js") as {
  parseQaAnswers: (content: string) => Array<{ question: string; answer: string }> | null;
};
const { splitTableRow, parseFrontmatterBlock, PRD_SECTIONS, parseBehaviorRows, missingPrdSections } = require("../../lib/prd_parser.js") as {
  parseFrontmatterBlock(markdown: string): { entries: { key: string; value: string; line: number }[]; body: string } | null;
  splitTableRow: (text: string) => string[];
  PRD_SECTIONS: readonly string[];
  parseBehaviorRows(markdown: string): { section: { line: number; headerLine?: number; header?: string[] } | null; rows: Array<{ id: string | null; line: number; defects: string[] }> };
  missingPrdSections(markdown: string): string[];
};

export interface PrelintFinding extends Finding {
  /** Stable rule identifier, e.g. "qa-dangling-decision-id". */
  rule: string;
  /** 1-indexed line the defect anchors to; null for whole-document rules. */
  line: number | null;
}

export interface PrelintResult {
  ok: boolean;
  doc: "qa-log" | "prd" | "contract";
  findings: PrelintFinding[];
  /** Non-blocking structural advisories. Never counted toward `ok`. */
  warnings?: PrelintFinding[];
}

/**
 * User-sourced-consent predicate (D-19, PRD interview-anchor R2): the same
 * three-part test the qa-unanchored-user-decision warning has always used.
 * `sasu interview decision` reuses this exact function to decide whether a
 * decision gets an automatic anchor, so the two call sites can never drift
 * into disagreeing about what counts as a user-sourced decision.
 */
export function isUserSourcedResolvedDecision(kind: string, status: string, source: string): boolean {
  return kind === "decision" && status === "resolved" && /(\buser\b|사용자)/iu.test(source);
}

function finding(rule: string, line: number | null, missing: string, recommendation: string): PrelintFinding {
  return { rule, line, area: "prelint", severity: "P0", missing, recommendation, requiresHuman: false };
}

/** Non-blocking advisory (PrelintResult.warnings): P2, never counted toward ok. */
function warning(rule: string, line: number | null, missing: string, recommendation: string): PrelintFinding {
  return { rule, line, area: "prelint", severity: "P2", missing, recommendation, requiresHuman: false };
}

interface Frontmatter {
  values: Map<string, { value: string; line: number }>;
}

/**
 * Delegates to the shared frontmatter engine in prd_parser.js - the same
 * grammar implement's contract reader uses - so a document can never parse
 * one way at the lint gate and another way at start. The local regex this
 * replaced truncated unquoted values at " #" and dropped keys whose value
 * contained a bare "#" (2026-08-30 unification).
 */
function parseFrontmatter(lines: string[]): Frontmatter | null {
  const parsed = parseFrontmatterBlock(lines.join("\n"));
  if (parsed === null) return null;
  const values = new Map<string, { value: string; line: number }>();
  for (const entry of parsed.entries) values.set(entry.key, { value: entry.value, line: entry.line });
  return { values };
}

function checkEnum(
  fm: Frontmatter,
  key: string,
  allowed: string[],
  rulePrefix: string,
  findings: PrelintFinding[],
  options: { allowMissing?: boolean } = {},
): void {
  const entry = fm.values.get(key);
  if (!entry) {
    if (!options.allowMissing) {
      findings.push(
        finding(`${rulePrefix}-frontmatter-enum`, null, `frontmatter is missing "${key}"`, `Add ${key}: one of ${allowed.join(" | ")}.`),
      );
    }
    return;
  }
  if (!allowed.includes(entry.value)) {
    findings.push(
      finding(
        `${rulePrefix}-frontmatter-enum`,
        entry.line,
        `frontmatter "${key}" is "${entry.value}" (allowed: ${allowed.join(" | ")})`,
        `Set ${key} to one of: ${allowed.join(" | ")}.`,
      ),
    );
  }
}

interface Table {
  header: string[];
  headerLine: number;
  rows: { cells: string[]; line: number }[];
}

/** Parse the first markdown table found between fromIndex (inclusive) and toIndex (exclusive). */
function parseTable(lines: string[], fromIndex: number, toIndex: number): Table | null {
  for (let i = fromIndex; i < toIndex; i += 1) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) continue;
    const header = splitRow(line);
    const rows: { cells: string[]; line: number }[] = [];
    for (let j = i + 1; j < toIndex; j += 1) {
      const rowLine = lines[j]!;
      if (!rowLine.trim().startsWith("|")) break;
      const cells = splitRow(rowLine);
      if (cells.every((cell) => /^:?-+:?$/.test(cell) || cell === "")) continue;
      rows.push({ cells, line: j + 1 });
    }
    return { header, headerLine: i + 1, rows };
  }
  return null;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return splitTableRow(trimmed).map((cell) => cell.trim());
}

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

// --- qa-log rules (gap-audit gate entrance) ---

const QA_REQUIRED_SECTIONS = ["## Current Understanding", "## Decision Register", "## Raw Q&A", "## Audit History"];
const QA_REGISTER_COLUMNS = ["ID", "Kind", "Area", "Decision / fact", "Priority", "Source / owner", "Status", "PRD mapping / revisit"];
const QA_KINDS = ["fact", "decision", "assumption"];
const QA_PRIORITIES = ["P0", "P1", "P2"];
const QA_STATUSES = ["open", "resolved", "deferred", "blocking", "rejected"];

export function prelintQaLog(content: string): PrelintResult {
  const findings: PrelintFinding[] = [];
  const warnings: PrelintFinding[] = [];
  const lines = content.split("\n");
  let questionLimit: number | null = null;

  const fm = parseFrontmatter(lines);
  if (!fm) {
    findings.push(finding("qa-frontmatter-missing", 1, "qa-log has no frontmatter block", "Start the file with --- frontmatter containing topic/status/where."));
  } else {
    checkEnum(fm, "status", ["active", "paused", "complete"], "qa", findings);
    checkEnum(fm, "where", ["greenfield", "brownfield", "docs-only", "unknown"], "qa", findings);
    const limit = fm.values.get("question_limit");
    if (limit && !/^[1-9]\d*$/.test(limit.value)) {
      findings.push(
        finding(
          "qa-question-limit-invalid",
          limit.line,
          `frontmatter question_limit is "${limit.value}" instead of a positive integer`,
          "Set question_limit to a positive integer, or remove it when the user did not set a limit.",
        ),
      );
    } else if (limit) {
      questionLimit = Number(limit.value);
    }
  }

  for (const section of QA_REQUIRED_SECTIONS) {
    if (!lines.some((line) => line.trim() === section)) {
      findings.push(finding("qa-section-missing", null, `required section "${section}" is missing`, `Add the ${section} section (interview-me template).`));
    }
  }

  // Raw Q&A is parsed BEFORE the register loop because two register rules
  // consume it: fabricated-consent detection needs to know which decisions a
  // real Q&A turn actually cites, and Q-reference checks need the set of
  // anchors that exist. Measured motivation (2026-08-20, 3 please runs): the
  // spec judge's dominant P0 class was "decision cites a nonexistent Q" /
  // "user-approved decision with no Raw Q&A evidence" - each instance cost a
  // full judge round (1-6 min) plus a fix round, and in one run six rounds in
  // a row were this same defect resurfacing in different rows. A $0
  // deterministic check catches the whole class before any judge call
  // (PRINCIPLES items 3 and 7).
  const rawQaRange = sectionRange(lines, "## Raw Q&A");
  const transcriptSourcesRange = sectionRange(lines, "## Transcript Sources");
  const transcriptStartRefs = new Set<string>();
  if (transcriptSourcesRange) {
    const sourceTable = parseTable(lines, transcriptSourcesRange.start + 1, transcriptSourcesRange.end);
    if (sourceTable) {
      const runtimeCol = sourceTable.header.indexOf("Runtime");
      const sessionCol = sourceTable.header.indexOf("Session ID");
      const startRefCol = sourceTable.header.indexOf("Start ref");
      if (runtimeCol !== -1 && sessionCol !== -1 && startRefCol !== -1) {
        for (const row of sourceTable.rows) {
          const runtime = row.cells[runtimeCol]?.trim() ?? "";
          const sessionId = row.cells[sessionCol]?.trim() ?? "";
          const startRef = row.cells[startRefCol]?.trim() ?? "";
          if (runtime !== "" && sessionId !== "" && startRef !== "") {
            transcriptStartRefs.add(`${runtime}:${sessionId}:${startRef}`);
          }
        }
      }
    }
  }
  /** Q&A anchor numbers that exist, e.g. "Q16" from "### Q16: label". */
  const qaAnchors = new Set<string>();
  let firstQuestionOverLimit: { number: number; line: number } | null = null;
  /** Decision IDs cited by at least one Raw Q&A turn's decision_ids line. */
  const qaCitedIds = new Set<string>();
  if (rawQaRange) {
    for (let i = rawQaRange.start + 1; i < rawQaRange.end; i += 1) {
      const anchor = lines[i]!.match(/^###\s*Q(\d+)\b/);
      if (anchor) {
        const questionNumber = Number(anchor[1]!);
        qaAnchors.add(`Q${questionNumber}`);
        if (questionLimit !== null && questionNumber > questionLimit && firstQuestionOverLimit === null) {
          firstQuestionOverLimit = { number: questionNumber, line: i + 1 };
        }
      }
      const cited = lines[i]!.match(/^\s*-\s*decision_ids:\s*(.*)$/);
      if (cited) for (const token of cited[1]!.match(/D-\d+/g) ?? []) qaCitedIds.add(token);
    }
  }

  if (firstQuestionOverLimit !== null && questionLimit !== null) {
    warnings.push(
      warning(
        "qa-question-limit-exceeded",
        firstQuestionOverLimit.line,
        `Raw Q&A reached Q${firstQuestionOverLimit.number}, beyond the user-set limit of ${questionLimit}`,
        `Preserve the captured evidence, do not ask another question, and pause if the extra exchange was a real question rather than a correction or closure response.`,
      ),
    );
  }

  const registerIds = new Set<string>();
  const register = sectionRange(lines, "## Decision Register");
  if (register) {
    const table = parseTable(lines, register.start + 1, register.end);
    if (!table) {
      findings.push(finding("qa-register-columns", null, "Decision Register has no parseable table", "Add the register table with the 8 template columns."));
    } else {
      const missingColumns = QA_REGISTER_COLUMNS.filter((column) => !table.header.includes(column));
      if (missingColumns.length > 0) {
        findings.push(
          finding("qa-register-columns", table.headerLine, `Decision Register table is missing column(s): ${missingColumns.join(", ")}`, "Use the 8 template columns exactly."),
        );
      } else {
        const col = (name: string) => table.header.indexOf(name);
        for (const row of table.rows) {
          if (row.cells.length < table.header.length) {
            findings.push(finding("qa-register-row", row.line, `register row has ${row.cells.length} cells (header has ${table.header.length})`, "Fix the row so every column has a cell."));
            continue;
          }
          const id = row.cells[col("ID")]!;
          if (id !== "") registerIds.add(id);
          const kind = row.cells[col("Kind")]!;
          const priority = row.cells[col("Priority")]!;
          const status = row.cells[col("Status")]!;
          if (!QA_KINDS.includes(kind)) {
            findings.push(finding("qa-register-row", row.line, `${id || "row"}: Kind "${kind}" (allowed: ${QA_KINDS.join(" | ")})`, "Use a valid Kind."));
          }
          if (!QA_PRIORITIES.includes(priority)) {
            findings.push(finding("qa-register-row", row.line, `${id || "row"}: Priority "${priority}" (allowed: ${QA_PRIORITIES.join(" | ")})`, "Use a valid Priority."));
          }
          if (!QA_STATUSES.includes(status)) {
            findings.push(finding("qa-register-row", row.line, `${id || "row"}: Status "${status}" (allowed: ${QA_STATUSES.join(" | ")})`, "Use a valid Status."));
          } else if (status === "open" && (priority === "P0" || priority === "P1")) {
            findings.push(
              finding("qa-register-open", row.line, `${id || "row"} is ${priority} and still open`, "Resolve the node with the user or classify it as deferred/blocking/rejected before closure."),
            );
          }
          const source = row.cells[col("Source / owner")]!;
          const mapping = row.cells[col("PRD mapping / revisit")]!;
          // Both citation rules below are ADVISORIES, not blocks: red-teamed
          // 2026-08-20 against every qa-log on this machine, the blocking
          // versions false-positived on 8 completed, judge-passed documents -
          // (a) Source cells count user answers while transcript sync
          // auto-assigns heading numbers (qalog.ts max+1), so batched turns
          // legitimately cite Q-numbers that exist as answers under another
          // heading (herdr-pet Q16 body carries "source: user, Q21"); and
          // (b) consent that predates the interview ("user, 사전대화",
          // session-handoff-mini D-04/D-05) has no turn to cite yet its
          // gap-audit PASSed. A warning keeps the $0 pre-judge signal (the
          // judge blocks on the real fabrication cases) without violating the
          // zero-false-positive contract above. Q-references are read from
          // the Source and mapping cells only; the free-text Decision cell is
          // skipped so a "Q4 2026"-style quarter can never fire at all.
          if (rawQaRange) {
            for (const cell of [source, mapping]) {
              for (const token of cell.match(/\bQ\d+\b/g) ?? []) {
                if (!qaAnchors.has(token)) {
                  warnings.push(
                    warning(
                      "qa-dangling-q-reference",
                      row.line,
                      `${id || "row"} cites ${token}, but no "### ${token}:" entry exists in Raw Q&A`,
                      `If the exchange is real, fix the citation to the heading that holds it; if it is not, the judge will block on it.`,
                    ),
                  );
                }
              }
            }
            const invocationSource = source.trim().match(/^user invocation:\s*(.+)$/iu);
            const isBoundInvocationDecision = invocationSource !== null && transcriptStartRefs.has(invocationSource[1]!.trim());
            if (
              isUserSourcedResolvedDecision(kind, status, source)
              && id !== ""
              && !qaCitedIds.has(id)
              && !isBoundInvocationDecision
            ) {
              warnings.push(
                warning(
                  "qa-unanchored-user-decision",
                  row.line,
                  `${id} is a resolved user-sourced decision, but no Raw Q&A turn's decision_ids cites it`,
                  `If a real exchange decided it, run sasu interview sync and link the imported Q# to ${id}; the judge blocks on unrecorded consent.`,
                ),
              );
            }
          }
          if (kind === "assumption" && status === "resolved" && (priority === "P0" || priority === "P1")) {
            findings.push(
              finding(
                "qa-resolved-material-assumption",
                row.line,
                `${id || "row"} is a resolved ${priority} assumption; material intent or evidence must not remain typed as an assumption`,
                "Ask for explicit user agreement and record it as a decision, record exact repository evidence as a fact, or defer the assumption with an owner and revisit trigger. Only reversible P2 agent defaults may be silently resolved.",
              ),
            );
          }
        }
      }
    }
  }

  if (rawQaRange && registerIds.size > 0) {
    for (let i = rawQaRange.start + 1; i < rawQaRange.end; i += 1) {
      const match = lines[i]!.match(/^\s*-\s*decision_ids:\s*(.*)$/);
      if (!match) continue;
      for (const token of match[1]!.match(/D-\d+/g) ?? []) {
        if (!registerIds.has(token)) {
          findings.push(finding("qa-dangling-decision-id", i + 1, `decision_ids references ${token} which is not in the Decision Register`, `Add ${token} to the register or fix the reference.`));
        }
      }
    }
  }

  return { ok: findings.length === 0, doc: "qa-log", findings, warnings };
}

/**
 * Cross-document rule for the spec gate (which alone holds both documents):
 * every D-id the PRD cites must exist in the interview log's Decision
 * Register. Measured motivation (2026-08-20 red-team of 6 real spec-gate P0
 * findings): the judge's dominant P0 class was a PRD citing an INVENTED
 * decision ("approved PR delivery via invented D-40"), i.e. the fabrication
 * lives in the PRD where the qa-log rules never run. Calibration across all
 * 30 real PRD+qa-log pairs on this machine: zero missing D-ids on healthy
 * documents, so this blocks (P0) under the zero-false-positive contract.
 */
export function prelintPrdDecisionIds(prdContent: string, qaLogContent: string): PrelintResult {
  const findings: PrelintFinding[] = [];
  const registerIds = new Set<string>();
  const qaLines = qaLogContent.split("\n");
  const addendum = sectionRange(qaLines, "## Addendum");
  for (let i = 0; i < qaLines.length; i += 1) {
    const line = qaLines[i]!;
    const row = line.match(/^\|\s*(D-\d+)\s*\|/);
    if (row) registerIds.add(row[1]!);
    // A post-seal decision lives as an Addendum bullet, not a Register row
    // (freshness contract v4); a PRD citing it is citing a real decision.
    // The bullet scan is scoped to the Addendum section so a D-id merely
    // mentioned in prose elsewhere never counts as a definition.
    if (addendum !== null && i > addendum.start && i < addendum.end) {
      const bullet = line.match(/^\s*-\s*(D-\d+)\b/);
      if (bullet) registerIds.add(bullet[1]!);
    }
  }
  const seen = new Set<string>();
  prdContent.split("\n").forEach((line, index) => {
    for (const token of line.match(/\bD-\d+\b/g) ?? []) {
      if (registerIds.has(token) || seen.has(token)) continue;
      seen.add(token);
      findings.push(
        finding(
          "prd-dangling-decision-id",
          index + 1,
          `PRD cites ${token}, which does not exist in the interview log's Decision Register`,
          `Register the real decision first (sasu interview decision --id ${token} ... plus the citing interview log turn) or remove the fabricated reference.`,
        ),
      );
    }
  });
  return { ok: findings.length === 0, doc: "prd", findings };
}

/**
 * Cross-document rule for the spec gate (PRD gate-loop D-09/R8): every Raw
 * Q&A turn the PRD cites (`Q<n>`) must exist and carry a non-empty user
 * answer. A PRD that cites a question nobody answered is quoting consent
 * that does not exist, which is the P0 class the judges keep catching one
 * paid round at a time. Calibration (2026-09-03, every PRD+qa-log pair on
 * this machine): zero hits on healthy pairs; interview-anchor's PRD cites
 * Q15 and Q21 that its log never held, and its spec review had stalled.
 * Quarter-style tokens (`Q4 2026`) are excluded by the year lookahead.
 */
export function prelintPrdCitedQuestions(prdContent: string, qaLogContent: string): PrelintResult {
  const findings: PrelintFinding[] = [];
  /**
   * Q number -> whether its answer bullet carries text, read through the one
   * Raw Q&A parser the freshness pin also uses, so "answered" here and
   * "pinned" there can never disagree about the same turn.
   */
  const answered = new Map<string, boolean>();
  for (const entry of parseQaAnswers(qaLogContent) ?? []) answered.set(`Q${entry.question}`, entry.answer !== "");
  const seen = new Set<string>();
  prdContent.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\bQ(\d+)\b(?!\s*\d{4})/g)) {
      const token = `Q${match[1]}`;
      if (seen.has(token) || answered.get(token) === true) continue;
      seen.add(token);
      const state = answered.has(token) ? "has an empty answer" : "does not exist";
      findings.push(
        finding(
          "prd-cited-question-unanswered",
          index + 1,
          `PRD cites ${token}, but that Raw Q&A turn ${state} in the interview log`,
          `Only a turn with the user's own answer text can back a decision: run sasu interview sync so the real exchange lands under ${token}, or cite the turn that actually holds the answer, or drop the citation.`,
        ),
      );
    }
  });
  return { ok: findings.length === 0, doc: "prd", findings };
}

// --- PRD rules (spec and verify gate entrances) ---

/**
 * The six-section PRD (prd-template R1, R11). Structure only: the section
 * titles are the parser's constants, and every Behaviors row rule comes
 * from the one reader `implement start` uses, so a document that lints
 * clean starts and one that fails here fails there on the same line.
 */
export function prelintPrd(content: string): PrelintResult {
  const findings: PrelintFinding[] = [];
  const lines = content.split("\n");

  const fm = parseFrontmatter(lines);
  if (!fm) {
    findings.push(finding("prd-frontmatter-missing", 1, "PRD has no frontmatter block", "Start the file with --- frontmatter containing status/human_approval/review_profile."));
  } else {
    checkEnum(fm, "status", ["draft", "ready"], "prd", findings);
    checkEnum(fm, "human_approval", ["pending", "approved"], "prd", findings);
    // Absence is legal: implement's init defaults a missing declaration to
    // "standard". Only a present-but-invalid value blocks.
    checkEnum(fm, "review_profile", ["trivial", "standard", "high-risk"], "prd", findings, { allowMissing: true });
  }

  const missing = missingPrdSections(content);
  if (missing.length > 0) {
    findings.push(finding("prd-section-missing", null, `missing section(s): ${missing.map((title) => `## ${title}`).join(", ")}`, `Add every section of the gen-prd template: ${PRD_SECTIONS.map((title) => `## ${title}`).join(", ")}.`));
  }

  const behaviors = parseBehaviorRows(content);
  if (behaviors.section !== null && behaviors.rows.length === 0) {
    findings.push(finding("prd-behavior-row", behaviors.section.line, "## Behaviors has no table rows", "Add at least one `| B<n> | 행동 | check:|judge:|human: ... | D-n |` row."));
  }
  for (const row of behaviors.rows) {
    for (const defect of row.defects) {
      findings.push(finding("prd-behavior-row", row.line, `${row.id ?? "row"}: ${defect}`, "Each Behaviors row is `| B<n> | what the user observes | check: <one argv command> | judge: <evidence> | human: <what to confirm> | D-n |`; the method lives in the 검사 방법 cell only."));
    }
  }

  const warnings: PrelintFinding[] = [];
  const behaviorSection = sectionRange(lines, "## Behaviors");
  checkTableRowShape(lines, behaviorSection ? parseTable(lines, behaviorSection.start + 1, behaviorSection.end) : null, "Behaviors", findings, warnings);
  const decisionSection = sectionRange(lines, "## Decisions");
  checkTableRowShape(lines, decisionSection ? parseTable(lines, decisionSection.start + 1, decisionSection.end) : null, "Decisions", findings, warnings);

  return { ok: findings.length === 0, doc: "prd", findings, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Validate table cell counts against the shared span-aware parser. */
function checkTableRowShape(
  lines: string[],
  table: Table | null,
  label: string,
  findings: PrelintFinding[],
  warnings: PrelintFinding[],
): void {
  if (!table) return;
  const headerCount = table.header.length;
  for (const row of table.rows) {
    const rawLine = lines[row.line - 1] ?? "";
    const spanAware = row.cells.length;
    if (spanAware === headerCount) continue;
    const trimmed = rawLine.trim().replace(/^\|/, "").replace(/\|$/, "");
    const rendered = trimmed.split(/(?<!\\)\|/).length;
    if (spanAware < headerCount && rendered >= headerCount) {
      findings.push(
        finding(
          "prd-table-span-collision",
          row.line,
          `${label} row parses to ${spanAware} cell(s) but its rendered form shows ${rendered} (header has ${headerCount}): a backtick code span crosses a cell boundary, so a \`|\` the reader sees as a column break is swallowed as command text`,
          "Stray backticks in two cells have paired up. Balance or remove the odd backticks so every code span opens and closes inside one cell.",
        ),
      );
    } else if (spanAware > headerCount) {
      warnings.push(
        finding(
          "prd-table-row-shape",
          row.line,
          `${label} row has ${spanAware} cells but the header has ${headerCount}; every column after the extra \`|\` shifts`,
          "Escape literal pipes in cell text as \\| (or move them into a backtick code span).",
        ),
      );
    }
  }
}


// --- quick-contract rules (verify gate entrance for the quick path) ---

/**
 * The quick contract is deliberately tiny - a goal plus acceptance criteria -
 * so its lint checks only what the verify gate mechanically depends on: a
 * frontmatter block (freshnessHash strips it, letting the post-PASS
 * status flip to complete without staling the verdict), extractable
 * `- AC#.` items under `## Acceptance Criteria` (what the semantic judge
 * reads), and a well-formed evidence lane (what the harness has to execute
 * and hash). Everything else about the document is the agent's prose.
 */
export function prelintContract(content: string): PrelintResult {
  const findings: PrelintFinding[] = [];
  const lines = content.split("\n");

  const fm = parseFrontmatter(lines);
  if (!fm) {
    findings.push(
      finding("contract-frontmatter-missing", 1, "contract has no frontmatter block", "Start the file with --- frontmatter containing topic/status."),
    );
  } else {
    if (!fm.values.get("topic")?.value) {
      findings.push(finding("contract-frontmatter-topic", null, `frontmatter is missing "topic"`, "Add topic: <kebab-case-slug> matching the --slug value."));
    }
    checkEnum(fm, "status", ["active", "complete"], "contract", findings);
  }

  const parsed = parseContract(content);
  for (const defect of parsed.defects) {
    findings.push(finding(defect.rule, defect.line, defect.missing, defect.recommendation));
  }

  const section = sectionRange(lines, "## Acceptance Criteria");
  if (!section) {
    findings.push(
      finding("contract-ac-section-missing", null, `required section "## Acceptance Criteria" is missing`, "Add ## Acceptance Criteria with '- AC1. ...' items."),
    );
    return { ok: findings.length === 0, doc: "contract", findings };
  }

  const seen = new Map<string, number>();
  for (const criterion of parsed.criteria) {
    const firstLine = seen.get(criterion.id);
    if (firstLine !== undefined) {
      findings.push(
        finding("contract-ac-duplicate", criterion.line, `${criterion.id} is defined more than once (first at line ${firstLine})`, "Give every criterion a unique AC id."),
      );
    } else {
      seen.set(criterion.id, criterion.line);
    }
  }
  if (seen.size === 0) {
    findings.push(
      finding("contract-ac-empty", section.start + 1, "## Acceptance Criteria has no '- AC#. <text>' items", "Add at least one criterion the diff judge can verify."),
    );
  }

  return { ok: findings.length === 0, doc: "contract", findings };
}

/**
 * Uniform fail-closed wrapper (D-11): any prelint execution error - not just a
 * recognized document defect - blocks the gate instead of reaching the judge.
 */
export function runPrelint(doc: "qa-log" | "prd" | "contract", content: string): PrelintResult {
  try {
    return doc === "qa-log" ? prelintQaLog(content) : doc === "contract" ? prelintContract(content) : prelintPrd(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      doc,
      findings: [finding("prelint-internal-error", null, `prelint crashed: ${message}`, "Fix the document or report a sasu bug; the judge was not consulted (fail-closed).")],
    };
  }
}
