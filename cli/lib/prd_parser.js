"use strict";

const fs = require("fs");
const path = require("path");

const { resolveProjectPath, toProjectRelative, sha256Text, escapeRegExp, firstSentence, uniqueMatches } = require("./util");

/**
 * One frontmatter value grammar for every reader. A quoted value may carry a
 * trailing `# comment` - real PRDs record the approval verbatim there
 * (`human_approval: "approved"  # user 2026-08-29 verbatim: ...`). An
 * unquoted value is taken whole, so `#` inside it never truncates. Measured
 * 2026-08-30 before unification, the two divergent copies each had a bug the
 * other did not: prelint's regex parsed `topic: fix #42` as "fix" and dropped
 * the `c#-migration` key entirely, while this file's strip-quotes rule turned
 * `"approved"  # note` into `approved"  # note` - which would refuse an
 * approved PRD at implement start.
 */
function parseFrontmatterValue(raw) {
  const trimmed = String(raw).trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const close = trimmed.indexOf(quote, 1);
    if (close > 0) return trimmed.slice(1, close);
  }
  return trimmed;
}

/**
 * Shared frontmatter block reader: entries carry 1-based line numbers so
 * lint-grade callers (prelint) can point findings at the exact line, and the
 * body is what remains after the closing `---`. Returns null when the
 * document has no frontmatter block.
 */
function parseFrontmatterBlock(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let close = 1; close < lines.length; close += 1) {
    if (lines[close].trim() !== "---") continue;
    const entries = [];
    for (let index = 1; index < close; index += 1) {
      const match = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) entries.push({ key: match[1], value: parseFrontmatterValue(match[2]), line: index + 1 });
    }
    return { entries, body: lines.slice(close + 1).join("\n") };
  }
  return null;
}

function stripFrontmatter(markdown) {
  const parsed = parseFrontmatterBlock(markdown);
  if (parsed === null) return { frontmatter: {}, body: markdown };
  const frontmatter = {};
  for (const entry of parsed.entries) frontmatter[entry.key] = entry.value;
  return { frontmatter, body: parsed.body };
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingRe.test(lines[index].trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractFirstSection(markdown, headings) {
  for (const heading of headings) {
    const section = extractSection(markdown, heading);
    if (section.trim()) return section;
  }
  return "";
}

function extractNestedSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^(#{2,6})\\s+${escapeRegExp(heading)}\\s*$`, "i");
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(headingRe);
    if (match) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  const nextHeadingRe = /^(#{2,6})\s+/;
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].trim().match(nextHeadingRe);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function extractFirstNestedSection(markdown, headings) {
  for (const heading of headings) {
    const section = extractNestedSection(markdown, heading);
    if (section.trim()) return section;
  }
  return "";
}

function looksLikeMarkdownTable(line, tableHeaders) {
  if (!line.includes("|")) return false;
  if (line.startsWith("|") || line.endsWith("|")) return true;
  if (tableHeaders) return true;
  return /\b(id|covers|coverage)\b\s*\|/i.test(line) && /\|\s*(mode|pass|expected|required|can be blocked)/i.test(line);
}

/**
 * Backtick code spans inside one table-row line, by the CommonMark
 * length-matching rule: a run of N backticks opens a span that the next run of
 * exactly N backticks closes, and an opener with no closer is literal text. A
 * backslash-escaped backtick never opens a span (the same escape convention as
 * `\|` for pipes). Positions index into the input string.
 *
 * Why this exists: a naive `split("|")` truncated a live Verification Method
 * cell at the `||` inside `` `bash -c "... || exit 1; done"` `` and the
 * truncated command was still valid shell, so the mismatch surfaced only as a
 * verify-run contract rejection. Every reader of a table cell must share one
 * definition of where a code span begins and ends.
 */
function scanCodeSpans(text) {
  const spans = [];
  let unmatched = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char !== "`") {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (text[index + runLength] === "`") runLength += 1;
    let cursor = index + runLength;
    let closer = -1;
    while (cursor < text.length) {
      if (text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let closeLength = 1;
      while (text[cursor + closeLength] === "`") closeLength += 1;
      if (closeLength === runLength) {
        closer = cursor;
        break;
      }
      cursor += closeLength;
    }
    if (closer < 0) {
      unmatched += 1;
      index += runLength;
    } else {
      spans.push({ start: index, end: closer + runLength, contentStart: index + runLength, contentEnd: closer });
      index = closer + runLength;
    }
  }
  return { spans, unmatched };
}

/**
 * Code-span contents of a cell (or any single-line text), plus the count of
 * backtick runs that never found a closer. The prelint's round-trip guard
 * (prd-method-cell-mismatch) compares these raw contents against what the
 * parsed cell yields, so the two sides must share this one scanner.
 */
function extractCodeSpans(text) {
  const value = String(text || "");
  const { spans, unmatched } = scanCodeSpans(value);
  return {
    spans: spans.map(span => value.slice(span.contentStart, span.contentEnd)),
    unmatched,
  };
}

/**
 * Split a (already outer-pipe-stripped) table row into raw cell strings.
 * A `|` is a cell delimiter only outside backtick code spans and only when not
 * escaped as `\|`; span text is copied wholesale so semantic examples keep
 * their literal pipes. This deliberately diverges from GFM, which cuts cells
 * at pipes even inside code spans, because the harness must preserve the text
 * the author approved.
 */
function splitTableRow(text) {
  const value = String(text || "");
  const { spans } = scanCodeSpans(value);
  const cells = [];
  let current = "";
  let index = 0;
  let spanIndex = 0;
  while (index < value.length) {
    if (spanIndex < spans.length && spans[spanIndex].start === index) {
      current += value.slice(index, spans[spanIndex].end);
      index = spans[spanIndex].end;
      spanIndex += 1;
      continue;
    }
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      current += char + value[index + 1];
      index += 2;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  cells.push(current);
  return cells;
}

function parseMarkdownTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return splitTableRow(trimmed).map(cleanTableCell);
}

// Cosmetic markdown-to-text transforms for the prose part of a cell. Never
// applied inside code spans: `**` is a real glob fragment and `<br>`/`&nbsp;`
// are real characters when they sit inside a backticked command.
function cleanTableCellFragment(fragment) {
  return fragment
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/\\\|/g, "|")
    .replace(/&nbsp;/gi, " ")
    .replace(/\*\*/g, "");
}

function cleanTableCell(value) {
  const text = String(value || "");
  const { spans } = scanCodeSpans(text);
  if (spans.length === 0) return cleanTableCellFragment(text).trim();
  let cleaned = "";
  let index = 0;
  let spanIndex = 0;
  while (index < text.length) {
    if (spanIndex < spans.length && spans[spanIndex].start === index) {
      // `\|` unescapes even inside a span: GFM requires the escape for any
      // literal pipe in a table, so authors write it inside backticks too.
      cleaned += text.slice(index, spans[spanIndex].end).replace(/\\\|/g, "|");
      index = spans[spanIndex].end;
      spanIndex += 1;
      continue;
    }
    const nextStop = spanIndex < spans.length ? spans[spanIndex].start : text.length;
    cleaned += cleanTableCellFragment(text.slice(index, nextStop));
    index = nextStop;
  }
  return cleaned.trim();
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeTableHeader(value) {
  return cleanTableCell(value)
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headerIndex(headers, aliases) {
  const normalizedAliases = aliases.map(normalizeTableHeader);
  return headers.findIndex(header => normalizedAliases.includes(header));
}

function tableValue(headers, cells, aliases) {
  const index = headerIndex(headers, aliases);
  return index >= 0 ? cleanTableCell(cells[index]) : "";
}

// --- The six-section PRD contract (PRD prd-template R1, R2) ---

/**
 * The six `## <title>` sections a PRD carries, in template order. One
 * constant for every reader: prelint's `prd-section-missing`, the contract
 * parser, and the gen-prd template all name the same strings (R11), so a
 * heading cannot pass the lint gate and then be unreadable at start.
 */
const PRD_SECTIONS = Object.freeze(["Goal", "Non-goals", "Decisions", "Behaviors", "Technical structure", "Risks"]);

/** The three ways a Behaviors row is settled; the cell's prefix chooses (D-06). */
const CHECK_KINDS = Object.freeze(["check", "judge", "human"]);

/**
 * One command, no shell composition: the rule `agents/config.json`
 * verify.commands and a `check:` cell share (R2). Both are run as argv
 * without a shell, so `a && b` would arrive as literal tokens - measured on
 * the gate-loop run (2026-09-03/06): `&&` in a config command made node
 * --test open "cli" as a test file, two RED results at 67 s each and a human
 * amendment to get out. Quoted text is an argument, not composition, so it is
 * stripped before the operator scan. Returns null when the command is clean.
 */
function commandCompositionDefect(command) {
  const unquoted = String(command || "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "");
  if (/(?:;|\|\||&&|(?<!\|)\|(?!\|)|[<>]|`|\$\(|&)/.test(unquoted)) {
    return "must be one command without shell composition, redirection, or substitution (it runs as argv, without a shell)";
  }
  return null;
}

/**
 * A check cell is `<kind>: <payload>`. Nothing else is read from it: for
 * `check:` the payload is the exact command the harness executes, for
 * `judge:` it names the evidence shape the acceptance judge receives, for
 * `human:` it says what the person confirms. A payload written as one
 * backtick code span (the natural Markdown for a command) is unwrapped so
 * the cell reads as the author sees it rendered.
 */
function parseCheckCell(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^([a-z]+):\s*([\s\S]*)$/);
  if (!match || !CHECK_KINDS.includes(match[1])) {
    return { kind: null, payload: null, defect: `check cell must start with one of ${CHECK_KINDS.map((kind) => `${kind}:`).join(", ")}` };
  }
  const kind = match[1];
  let payload = match[2].trim();
  const span = payload.match(/^`([^`]+)`$/);
  if (span) payload = span[1].trim();
  if (payload === "") return { kind, payload: null, defect: `${kind}: cell has no payload after the prefix` };
  if (kind === "check") {
    const defect = commandCompositionDefect(payload);
    if (defect !== null) return { kind, payload, defect: `check: command ${defect}` };
  }
  return { kind, payload, defect: null };
}

/** `[start, end)` line indexes of one `## <title>` section in the whole document. */
function sectionLineRange(lines, title) {
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/** The first Markdown table inside a line range, with 1-based line numbers. */
function tableInRange(lines, range) {
  let header = null;
  let headerLine = 0;
  const rows = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) {
      if (header !== null) break;
      continue;
    }
    const cells = parseMarkdownTableRow(line);
    if (cells.length === 0 || isTableSeparator(cells)) continue;
    if (header === null) {
      header = cells;
      headerLine = index + 1;
      continue;
    }
    rows.push({ cells, line: index + 1 });
  }
  return header === null ? null : { header, headerLine, rows };
}

/** A `B<n>` row id as the harness spells it; null when the cell is not one. */
function behaviorRowId(cell) {
  const compact = String(cell || "").replace(/\s+/g, "").toUpperCase();
  return /^B[1-9]\d*$/.test(compact) ? compact : null;
}

const CHECK_PREFIX_IN_PROSE = /(?:^|\s)(?:check|judge|human):/i;

/**
 * Read the Behaviors table: `# | 사용자가 관찰하는 행동 | 검사 방법 | 결정`.
 *
 * Every row comes back, valid or not, with its defects listed instead of
 * being dropped: prelint turns each defect into a `prd-behavior-row` finding
 * at the row's line, and the contract parser refuses the document while any
 * remain. One reader, two consumers, so a row cannot lint clean and then be
 * unreadable at start (R2, R11). Structure only is read - the id shape, the
 * cell count, the check prefix grammar - never the prose (AGENTS.md 11).
 */
function parseBehaviorRows(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const range = sectionLineRange(lines, "Behaviors");
  if (range === null) return { section: null, rows: [] };
  const table = tableInRange(lines, range);
  if (table === null) return { section: { line: range.start + 1 }, rows: [] };
  const rows = table.rows.map((row) => {
    const defects = [];
    const id = behaviorRowId(row.cells[0]);
    if (id === null) defects.push(`row id must be B<n>, got "${row.cells[0] ?? ""}"`);
    if (row.cells.length !== 4) defects.push(`row has ${row.cells.length} cell(s); the Behaviors table has 4 columns (# | 행동 | 검사 방법 | 결정)`);
    const behavior = String(row.cells[1] ?? "").trim();
    if (behavior === "") defects.push("behavior cell is empty");
    // A command belongs in the check cell and nowhere else (R11): a
    // `check:`/`judge:`/`human:` token in the behavior cell is the structural
    // sign that a method leaked into the observation.
    if (CHECK_PREFIX_IN_PROSE.test(behavior)) defects.push("behavior cell carries a check:/judge:/human: method; keep the method in the 검사 방법 cell");
    const check = parseCheckCell(row.cells[2] ?? "");
    if (check.defect !== null) defects.push(check.defect);
    const decisionCell = String(row.cells[3] ?? "").trim();
    const decisionIds = uniqueMatches(decisionCell, /\bD-\d+\b/g);
    return { id, behavior, check: { kind: check.kind, payload: check.payload }, decisionCell, decisionIds, line: row.line, defects };
  });
  const seen = new Set();
  for (const row of rows) {
    if (row.id === null) continue;
    if (seen.has(row.id)) row.defects.push(`duplicate row id ${row.id}`);
    seen.add(row.id);
  }
  return { section: { line: range.start + 1, headerLine: table.headerLine, header: table.header }, rows };
}

/** Read the Decisions table: `D-n | 결정 | 근거`. Rows without a D-id are skipped. */
function parseDecisionRows(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const range = sectionLineRange(lines, "Decisions");
  if (range === null) return [];
  const table = tableInRange(lines, range);
  if (table === null) return [];
  const rows = [];
  for (const row of table.rows) {
    const id = String(row.cells[0] ?? "").replace(/\s+/g, "").toUpperCase();
    if (!/^D-\d+$/.test(id)) continue;
    rows.push({ id, decision: String(row.cells[1] ?? "").trim(), rationale: String(row.cells[2] ?? "").trim(), line: row.line });
  }
  return rows;
}

/**
 * Which of the six sections a document lacks. Case-insensitive on the title
 * and whole-line on the heading, the same match every section reader uses.
 */
function missingPrdSections(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  return PRD_SECTIONS.filter((title) => sectionLineRange(lines, title) === null);
}

/**
 * The retired five-axis template numbered its sections (`## 7. Acceptance
 * Criteria`); the six-section template never does. A numbered h2 with no
 * `## Behaviors` is therefore the structural signature of an old document,
 * keyed on the heading grammar rather than on any title string (AGENTS.md
 * 11). The contract parser turns it into the "구 형식" refusal (R2, AC2).
 */
function isLegacyFiveAxisPrd(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  return sectionLineRange(lines, "Behaviors") === null && lines.some((line) => /^##\s+\d+\.\s/.test(line));
}

module.exports = {
  stripFrontmatter,
  parseFrontmatterBlock,
  extractSection,
  extractFirstSection,
  extractNestedSection,
  extractFirstNestedSection,
  looksLikeMarkdownTable,
  extractCodeSpans,
  splitTableRow,
  parseMarkdownTableRow,
  cleanTableCell,
  isTableSeparator,
  normalizeTableHeader,
  headerIndex,
  tableValue,
  PRD_SECTIONS,
  CHECK_KINDS,
  commandCompositionDefect,
  parseCheckCell,
  parseBehaviorRows,
  parseDecisionRows,
  missingPrdSections,
  isLegacyFiveAxisPrd,
};
