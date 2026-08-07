import type { Finding } from "../judge/types";

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

export interface PrelintFinding extends Finding {
  /** Stable rule identifier, e.g. "qa-dangling-decision-id". */
  rule: string;
  /** 1-indexed line the defect anchors to; null for whole-document rules. */
  line: number | null;
}

export interface PrelintResult {
  ok: boolean;
  doc: "qa-log" | "prd";
  findings: PrelintFinding[];
}

function finding(rule: string, line: number | null, missing: string, recommendation: string): PrelintFinding {
  return { rule, line, area: "prelint", severity: "P0", missing, recommendation, requiresHuman: false };
}

interface Frontmatter {
  values: Map<string, { value: string; line: number }>;
  bodyStartIndex: number;
}

function parseFrontmatter(lines: string[]): Frontmatter | null {
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      const values = new Map<string, { value: string; line: number }>();
      for (let j = 1; j < i; j += 1) {
        const match = lines[j]!.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*"?([^"]*?)"?\s*$/);
        if (match) values.set(match[1]!, { value: match[2]!.trim(), line: j + 1 });
      }
      return { values, bodyStartIndex: i + 1 };
    }
  }
  return null;
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
  return trimmed.split("|").map((cell) => cell.trim());
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
  const lines = content.split("\n");

  const fm = parseFrontmatter(lines);
  if (!fm) {
    findings.push(finding("qa-frontmatter-missing", 1, "qa-log has no frontmatter block", "Start the file with --- frontmatter containing topic/status/where."));
  } else {
    checkEnum(fm, "status", ["active", "paused", "complete"], "qa", findings);
    checkEnum(fm, "where", ["greenfield", "brownfield", "docs-only", "unknown"], "qa", findings);
  }

  for (const section of QA_REQUIRED_SECTIONS) {
    if (!lines.some((line) => line.trim() === section)) {
      findings.push(finding("qa-section-missing", null, `required section "${section}" is missing`, `Add the ${section} section (interview-me template).`));
    }
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
          } else if (kind === "assumption" && status === "resolved" && (priority === "P0" || priority === "P1")) {
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

  const rawQa = sectionRange(lines, "## Raw Q&A");
  if (rawQa && registerIds.size > 0) {
    for (let i = rawQa.start + 1; i < rawQa.end; i += 1) {
      const match = lines[i]!.match(/^\s*-\s*decision_ids:\s*(.*)$/);
      if (!match) continue;
      for (const token of match[1]!.match(/D-\d+/g) ?? []) {
        if (!registerIds.has(token)) {
          findings.push(finding("qa-dangling-decision-id", i + 1, `decision_ids references ${token} which is not in the Decision Register`, `Add ${token} to the register or fix the reference.`));
        }
      }
    }
  }

  return { ok: findings.length === 0, doc: "qa-log", findings };
}

// --- PRD rules (spec and verify gate entrances) ---

const ID_DEFINITION = /^\s*-\s*(R|AC|T|V)(\d+)[.:]\s/;
const ID_TOKEN = /(R|AC|T|V)(\d+)(?:\s*-\s*(?:(R|AC|T|V))?(\d+))?/g;

/** Expand one Covers token, including same-prefix ranges like R1-R4 / R1-4. */
function expandToken(match: RegExpMatchArray): string[] {
  const prefix = match[1]!;
  const from = Number(match[2]!);
  if (match[4] === undefined) return [`${prefix}${from}`];
  const rangePrefix = match[3] ?? prefix;
  const to = Number(match[4]!);
  if (rangePrefix !== prefix) return [`${prefix}${from}`, `${rangePrefix}${to}`]; // "R1-AC4": two plain refs
  if (to < from || to - from > 500) return [`${prefix}${from}`, `${prefix}${to}`];
  const ids: string[] = [];
  for (let n = from; n <= to; n += 1) ids.push(`${prefix}${n}`);
  return ids;
}

function coversTokens(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(new RegExp(ID_TOKEN.source, "g"))) {
    ids.push(...expandToken(match));
  }
  return ids;
}

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

  const sectionNumbers = new Set<number>();
  for (const line of lines) {
    const match = line.match(/^##\s+(\d+)\./);
    if (match) sectionNumbers.add(Number(match[1]!));
  }
  const missingSections = [];
  for (let n = 1; n <= 12; n += 1) if (!sectionNumbers.has(n)) missingSections.push(n);
  if (missingSections.length > 0) {
    findings.push(finding("prd-section-missing", null, `missing numbered section(s): ${missingSections.join(", ")}`, "Add every '## <n>.' section from the gen-prd template (1-12)."));
  }

  // Defined IDs: list items plus 9.2 table ID cells.
  const defined = new Set<string>();
  const acDefinitionLines = new Map<string, number>();
  const acRequirementRefs = new Map<string, Set<string>>();
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(ID_DEFINITION);
    if (!match) continue;
    const id = `${match[1]}${match[2]}`;
    defined.add(id);
    if (match[1] === "AC" && !acDefinitionLines.has(id)) {
      acDefinitionLines.set(id, i + 1);
      // The readiness planner counts an AC covered when a check covers any R#
      // the AC references; record those refs so both engines agree.
      acRequirementRefs.set(id, new Set(lines[i]!.match(/\bR\d+\b/g) ?? []));
    }
  }

  const verification = findSubsection(lines, "9.2");
  const verificationTable = verification ? parseTable(lines, verification.start + 1, verification.end) : null;
  const coversColumn = verificationTable ? verificationTable.header.indexOf("Covers") : -1;
  const modeColumn = verificationTable ? verificationTable.header.indexOf("Mode") : -1;
  const vRows = (verificationTable?.rows ?? []).filter((row) => /^V\d+$/.test(row.cells[0] ?? ""));
  for (const row of vRows) defined.add(row.cells[0]!);

  // Dangling Covers references: list lines with "Covers" plus 9.2 Covers cells.
  const references: { id: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^\s*-\s/.test(line)) continue;
    const covers = line.match(/Covers\s+([^.]*)/);
    if (covers) for (const id of coversTokens(covers[1]!)) references.push({ id, line: i + 1 });
  }
  const coveredAcs = new Set<string>();
  const coveredRs = new Set<string>();
  for (const row of vRows) {
    if (coversColumn === -1 || row.cells[coversColumn] === undefined) continue;
    for (const id of coversTokens(row.cells[coversColumn]!)) {
      references.push({ id, line: row.line });
      if (id.startsWith("AC")) coveredAcs.add(id);
      if (id.startsWith("R")) coveredRs.add(id);
    }
  }
  for (const ref of references) {
    if (!defined.has(ref.id)) {
      findings.push(finding("prd-dangling-ref", ref.line, `Covers references ${ref.id} which is not defined anywhere in the PRD`, `Define ${ref.id} or fix the reference.`));
    }
  }

  for (const [ac, line] of acDefinitionLines) {
    const viaRequirement = [...(acRequirementRefs.get(ac) ?? [])].some((r) => coveredRs.has(r));
    if (!coveredAcs.has(ac) && !viaRequirement) {
      findings.push(finding("prd-uncovered-ac", line, `${ac} is not covered by any V row in 9.2 Required Agent Verification (directly or via a covered R# it references)`, `Add ${ac} (or an R# it references) to a V row's Covers.`));
    }
  }

  // Mode conformance: every 9.2 Mode must be a 9.1 Test Mode Contract row.
  const modeContract = findSubsection(lines, "9.1");
  const modeTable = modeContract ? parseTable(lines, modeContract.start + 1, modeContract.end) : null;
  const modeCells = new Set((modeTable?.rows ?? []).map((row) => row.cells[0] ?? "").filter((mode) => mode !== ""));
  if (vRows.length > 0 && modeColumn !== -1) {
    for (const row of vRows) {
      const mode = row.cells[modeColumn] ?? "";
      if (!modeCells.has(mode)) {
        findings.push(
          finding("prd-mode-mismatch", row.line, `${row.cells[0]}: Mode "${mode}" does not match any 9.1 Test Mode Contract row`, "Use a Mode that exists in the Test Mode Contract table."),
        );
      }
    }
  }

  return { ok: findings.length === 0, doc: "prd", findings };
}

function findSubsection(lines: string[], number: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => new RegExp(`^###\\s+${number.replace(".", "\\.")}\\b`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^###?\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Uniform fail-closed wrapper (D-11): any prelint execution error - not just a
 * recognized document defect - blocks the gate instead of reaching the judge.
 */
export function runPrelint(doc: "qa-log" | "prd", content: string): PrelintResult {
  try {
    return doc === "qa-log" ? prelintQaLog(content) : prelintPrd(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      doc,
      findings: [finding("prelint-internal-error", null, `prelint crashed: ${message}`, "Fix the document or report a sasu bug; the judge was not consulted (fail-closed).")],
    };
  }
}
