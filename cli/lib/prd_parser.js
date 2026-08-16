"use strict";

const fs = require("fs");
const path = require("path");

const { resolveProjectPath, toProjectRelative, sha256Text, escapeRegExp, firstSentence, uniqueMatches } = require("./util");

// A verification row is required for done unless its matrix explicitly opts
// out. (Inlined from the retired v2 state_data module; this is the one piece
// of it the parser needs.)
function isVerificationRequiredForDone(verification) {
  const matrix = (verification && verification.matrix) || {};
  if (typeof matrix.requiredForDone === "boolean") return matrix.requiredForDone;
  return true;
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end).trim();
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body: markdown.slice(end + 5) };
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

/**
 * Disposition of one §4 checklist item: who deals with it.
 * `pending` is the only value the harness ever assigns - it means nobody has
 * decided yet. The other three are the agent's answer, recorded through
 * `mark --kind prework`: `human` (goes into the batched user ask), `agent`
 * (this run will do it), `resolved` (already done).
 */
const PRE_WORK_STATUSES = ["pending", "human", "agent", "resolved"];

// A bullet that IS the empty list ("- None.", "- 없음") is the author writing
// "nothing here", not a row needing a disposition. Whole-line match only: a
// substring test would also swallow "없음을 확인한 뒤 발급", which is the exact
// phrasing-gap failure that the deleted marker regex died of (2026-08-11).
const PRE_WORK_EMPTY_LIST = /^(?:none|n\/a|없음|해당\s*없음)(?:\s*(?:required|needed|필요|없습니다))?[.。]?$/i;

/**
 * Extract the human-action checklist from `## 4. Pre-Work And Required
 * Decisions` (`### 4.1` pre-work bullets and `### 4.2` human-decision
 * bullets). Every bullet comes out, and none of them is judged.
 *
 * Why this exists: in an audited real run, 62% of wall time (57+ minutes in
 * one stretch) was spent waiting on the user because human-only prerequisites
 * the PRD had already declared up front were only discovered serially
 * mid-implementation (a 42min stall plus a 15min stall). Surfacing §4
 * mechanically at init lets the skill ask for all of them in one batched
 * message before implementation starts.
 *
 * Why extraction is purely structural: this used to keep only §4.1 bullets
 * matching a literal human-only marker regex (`사람만 가능|소유자 권한|...`). On
 * 2026-08-11 that regex missed all three human-only items of a real PRD
 * (agents/prd/webhook-to-modakbul-server) - "Slack 워크스페이스 관리 권한이
 * 필요하다", "Vercel 프로젝트 소유자만 가능하다", "사람이 Meta 개발자 콘솔에서
 * 바꾼다" - whose §4.1 preamble had stated the property for every bullet at
 * once ("각 항목은 계정 소유자 신원이 필요해 에이전트가 대신할 수 없다"). The
 * empty result read as an all-clear and overrode what the agent already knew,
 * because the agent had authored that PRD seven minutes earlier; the user
 * discovered the missing Slack channel and Vercel env vars ~4 hours later -
 * the second recurrence of the stall this checklist exists to prevent.
 *
 * Markdown structure (which numbered subsection, is there a bullet marker, is
 * the checkbox checked) cannot go flaky the way Korean prose does, so the
 * harness reads only structure and leaves every disposition to the agent,
 * which reads natural language for a living (PRINCIPLES.md items 7 and 11).
 * An item nobody classified stays `pending`, and `pending` blocks the run -
 * the failure being designed out is an empty/quiet result reading as "nothing
 * to do".
 */
/**
 * Drop Markdown bold delimiters from a bullet's display text.
 *
 * Ends-only stripping (`/^\*\*|\*\*$/`) was the whole rule at both call sites,
 * and it strands the closing marker whenever the author bolds a lead-in rather
 * than the entire bullet: modakbul PW1 reached the user's batched pre-work
 * question as "Slack 채널 개설.** Slack 워크스페이스 관리 권한이 필요하다"
 * (2026-08-11). This text is what a human reads and what a prompt quotes, so
 * matched pairs go anywhere in the line, not just at the ends.
 *
 * Code spans are left byte-for-byte: inside them `**` may be meaningful text,
 * not emphasis.
 */
function stripBoldMarkers(text) {
  return text
    .split(/(`[^`]*`)/)
    .map(part => (part.startsWith("`")
      ? part
      : part.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^\*\*|\*\*$/g, "")))
    .join("");
}

function parsePreWorkChecklist(body) {
  const section = extractFirstSection(body, [
    "4. Pre-Work And Required Decisions",
    "Pre-Work And Required Decisions",
  ]);
  if (!section.trim()) return [];
  const items = [];
  let subsection = null;
  let preWorkCounter = 1;
  let humanDecisionCounter = 1;
  // Fenced example blocks inside §4 are documentation, not checklist rows; a
  // bullet inside one would otherwise surface as a spurious item in the
  // batched user ask.
  let inFence = false;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{3,6}\s+/.test(line)) {
      subsection = classifyPreWorkSubsection(line);
      continue;
    }
    if (!subsection || !line) continue;
    const bullet = line.match(/^(?:[-*]\s*(?:\[([ xX])\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    if (!bullet) continue;
    const text = stripBoldMarkers(bullet[2]).replace(/\s+/g, " ").trim();
    if (!text || PRE_WORK_EMPTY_LIST.test(text)) continue;
    // A checked box is structure, not prose: the author ticked it off in the
    // PRD, so the item starts disposed. Everything else starts pending.
    const checked = bullet[1] === "x" || bullet[1] === "X";
    items.push({
      id: subsection === "4.1" ? `PW${preWorkCounter++}` : `HD${humanDecisionCounter++}`,
      section: subsection,
      text,
      status: checked ? "resolved" : "pending",
      evidence: [],
    });
  }
  return items;
}

/**
 * The run's §4 checklist, normalized in place.
 *
 * Migration, not tolerance: state.json files written before 2026-08-11 carry
 * `{id, section, text, resolved}` items with no disposition. `resolved: true`
 * was an explicit positive signal so it maps to `resolved`; everything else -
 * including the old `resolved: false` and any unknown value - maps to
 * `pending`, which is the fail-safe direction (an item nobody classified must
 * read as "ask the user", never as "nothing to do"). Normalizing in place
 * means the next state write persists the migration.
 */
function preWorkItems(state) {
  const checklist = state && state.preWorkChecklist;
  const items = checklist && Array.isArray(checklist.items) ? checklist.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (!PRE_WORK_STATUSES.includes(item.status)) {
      item.status = item.resolved === true ? "resolved" : "pending";
    }
    delete item.resolved;
    if (!Array.isArray(item.evidence)) item.evidence = [];
  }
  return items;
}

/** Items nobody has disposed of yet. These block the run. */
function pendingPreWork(state) {
  return preWorkItems(state).filter(item => item.status === "pending");
}

function preWorkStatusDefect(status) {
  if (PRE_WORK_STATUSES.includes(status)) return null;
  return `Invalid prework status '${status}'. Allowed: ${PRE_WORK_STATUSES.join(", ")} (human = needs the user, agent = this run does it, resolved = already done)`;
}

// Structural-first subsection routing: the canonical numbered form wins
// outright (so `4.3 Decision Traceability` can never masquerade as a
// human-decision list), and unnumbered variants fall back to title keywords.
function classifyPreWorkSubsection(headingLine) {
  const title = headingLine.replace(/^#+\s*/, "");
  const numbered = title.match(/^4\.(\d+)/);
  if (numbered) {
    if (numbered[1] === "1") return "4.1";
    if (numbered[1] === "2") return "4.2";
    return null;
  }
  if (/pre-?work|사전\s*작업/i.test(title)) return "4.1";
  if (/human\s+decision|사람.*결정|인간.*결정/i.test(title)) return "4.2";
  return null;
}

function parseMarkdownItems(section, prefix, fallbackLabel) {
  const items = [];
  let counter = 1;
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    current.text = current.text.replace(/\s+/g, " ").trim();
    current.title = firstSentence(current.text);
    const coverage = coverageFromText(current.text);
    current.requirements = coverage.requirements;
    current.acceptanceCriteria = coverage.acceptanceCriteria;
    items.push(current);
    current = null;
  };
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```") || /^#+\s+/.test(line)) continue;
    const match = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    if (!match) {
      if (current && /^\s{2,}\S/.test(rawLine) && !line.startsWith("|")) {
        current.text += ` ${line}`;
      }
      continue;
    }
    finishCurrent();
    let text = stripBoldMarkers(match[1]).trim();
    if (!text) continue;
    const explicit = text.match(new RegExp(`^(${prefix}\\d+|${prefix}-\\d+|${fallbackLabel}\\s*\\d+)\\b[.)?:\\s-]*`, "i"));
    let id;
    if (explicit) {
      id = explicit[1].replace(/\s+/g, "").replace("-", "").toUpperCase();
      text = text.slice(explicit[0].length).trim();
    } else {
      id = `${prefix}${counter}`;
    }
    counter += 1;
    current = {
      id,
      text,
      status: "pending",
      evidence: [],
      artifacts: [],
    };
  }
  finishCurrent();
  return items;
}

function coverageFromText(text) {
  return {
    requirements: expandCoverageIds(text, "R"),
    acceptanceCriteria: expandCoverageIds(text, "AC"),
    tasks: expandCoverageIds(text, "T"),
    scenarios: expandCoverageIds(text, "SC"),
  };
}

function expandCoverageIds(text, prefix) {
  const source = String(text || "");
  const seen = new Set(uniqueMatches(source, new RegExp(`\\b${prefix}\\d+\\b`, "gi")).map(id => id.toUpperCase()));
  const ranges = new RegExp(`\\b${prefix}(\\d+)\\s*-\\s*(?:${prefix})?(\\d+)\\b`, "gi");
  for (const match of source.matchAll(ranges)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start <= 0 || end <= 0 || Math.abs(end - start) > 100) continue;
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      seen.add(`${prefix}${value}`);
    }
  }
  return Array.from(seen).sort((left, right) => {
    const a = Number(left.replace(/^\D+/, ""));
    const b = Number(right.replace(/^\D+/, ""));
    return a - b || left.localeCompare(right);
  });
}

function buildIntentTrace(parsed, projectRoot) {
  // Real PRDs write this as a `### 4.3` subsection, so the nested extractor
  // (any #{2,6} depth) is required; the two-hash extractor parses it empty.
  const prdDecisionTraceSection = extractFirstNestedSection(parsed.body, [
    "4.3 Decision Traceability For Fidelity Review",
    "Decision Traceability For Fidelity Review",
  ]);
  const prdDecisionItems = parseDecisionTraceItems(prdDecisionTraceSection, "prd");
  const sourceFiles = intentSourceFiles(parsed.frontmatter, projectRoot);
  const sourceDecisionItems = [];
  const sources = [];
  for (const source of sourceFiles) {
    const sourceText = fs.readFileSync(source.abs, "utf8");
    const sourceSection = extractFirstSection(sourceText, [
      "Decision Trace And Requirement Mapping",
      "Decision Traceability Seeds",
      "Decision Summary",
      "Axis Decisions",
      "Human Decisions Needed Before PRD Approval",
      "Human Decisions Before PRD Approval",
    ]);
    const items = parseDecisionTraceItems(sourceSection, source.rel);
    sourceDecisionItems.push(...items);
    sources.push({
      path: source.rel,
      sha256: sha256Text(sourceText),
      decisionCount: items.length,
    });
  }
  const decisions = [...prdDecisionItems, ...sourceDecisionItems];
  return {
    prdDecisionTraceHash: sha256Text(prdDecisionTraceSection),
    prdDecisionCount: prdDecisionItems.length,
    sourceDecisionCount: sourceDecisionItems.length,
    decisionCount: decisions.length,
    sources,
    decisions: decisions.slice(0, 80),
  };
}

function intentSourceFiles(frontmatter, projectRoot) {
  const files = [];
  for (const key of ["source_intake", "source_clarity"]) {
    for (const candidate of splitIntentSourceValue(frontmatter[key])) {
      const abs = resolveProjectPath(candidate, projectRoot);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const rel = toProjectRelative(abs, projectRoot);
      if (!files.some(file => file.rel === rel)) files.push({ abs, rel });
    }
  }
  return files;
}

function splitIntentSourceValue(value) {
  return String(value || "")
    .split(/[|,]/)
    .map(part => part.trim().replace(/^['"`]+|['"`]+$/g, ""))
    .filter(part => part && !/^(?:none|current conversation)$/i.test(part));
}

function parseDecisionTraceItems(section, source) {
  const items = [];
  let tableHeaders = null;
  const push = (text, stance = null, target = null) => {
    const cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleaned || /^none\b/i.test(cleaned) || /^없음\b/.test(cleaned)) return;
    if (/^(?:decision\s*\/\s*proposal|---+)\b/i.test(cleaned)) return;
    if (/^accepted\s*\/\s*rejected\s*\/\s*deferred\s*\/\s*open\b/i.test(cleaned)) return;
    items.push({
      id: `D${items.length + 1}`,
      source,
      stance: stance || inferDecisionStance(cleaned),
      target: target || null,
      text: firstSentence(cleaned),
      hash: sha256Text(cleaned).slice(0, 16),
    });
  };

  for (const rawLine of String(section || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```") || /^#+\s+/.test(line)) {
      if (!line) tableHeaders = null;
      continue;
    }
    if (looksLikeMarkdownTable(line, tableHeaders)) {
      const cells = parseMarkdownTableRow(line);
      if (!cells.length || isTableSeparator(cells)) continue;
      if (!tableHeaders) {
        tableHeaders = cells.map(normalizeTableHeader);
        continue;
      }
      const decision = cells[0] || "";
      const stance = cells[1] || "";
      const target = cells[2] || "";
      push(`${decision} | ${stance} | ${target}`, stance, target);
      continue;
    }
    tableHeaders = null;
    const bullet = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    if (bullet) push(bullet[1]);
  }
  return items;
}

function inferDecisionStance(text) {
  if (/\b(reject|rejected|declined|not doing|non-goal|거절|제외|하지 않)/i.test(text)) return "rejected";
  if (/\b(defer|deferred|later|follow-up|보류|나중)/i.test(text)) return "deferred";
  if (/\b(open|blocking|question|미정|질문|확인 필요)/i.test(text)) return "open";
  if (/\b(accept|accepted|approved|decided|선택|승인|확정)/i.test(text)) return "accepted";
  return "unspecified";
}

function parseVerification(section) {
  const fallbackItems = [];
  const matrixItems = [];
  let currentLevel = "General";
  let currentSubsection = "";
  let fallbackCounter = 1;
  let matrixCounter = 1;
  let tableHeaders = null;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) {
      if (!line) tableHeaders = null;
      continue;
    }
    const heading = line.match(/^#{3,4}\s*([^#]+)$/);
    if (heading) {
      currentSubsection = heading[1].trim();
      const level = currentSubsection.match(/^(Level\s*\d+.*)$/i);
      if (level) currentLevel = level[1].trim();
      tableHeaders = null;
      continue;
    }
    if (/^Evidence\s+To\s+Report$/i.test(currentSubsection)) {
      tableHeaders = null;
      continue;
    }
    if (looksLikeMarkdownTable(line, tableHeaders)) {
      const cells = parseMarkdownTableRow(line);
      if (!cells.length) continue;
      if (!tableHeaders) {
        if (isTableSeparator(cells)) continue;
        tableHeaders = cells.map(normalizeTableHeader);
        continue;
      }
      if (isTableSeparator(cells)) continue;
      const item = matrixVerificationItem(tableHeaders, cells, currentLevel, matrixCounter);
      if (item) {
        matrixItems.push(item);
        matrixCounter += 1;
      }
      continue;
    }
    tableHeaders = null;
    const bullet = line.match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|(?:\d+[.)])\s+)(.+)$/);
    const command = line.match(/^`([^`]+)`$/);
    const text = bullet ? bullet[1].trim() : command ? command[1].trim() : "";
    if (!text) continue;
    fallbackItems.push({
      id: `V${fallbackCounter}`,
      level: currentLevel,
      title: firstSentence(text),
      text,
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "verification_bullet",
    });
    fallbackCounter += 1;
  }
  const items = matrixItems.length ? matrixItems : fallbackItems;
  if (items.length === 0 && section.trim()) {
    items.push({
      id: "V1",
      level: "Verification Contract",
      title: "Run PRD Verification Contract section",
      text: section.trim(),
      status: "pending",
      evidence: [],
      artifacts: [],
      source: "verification_section",
    });
  }
  return items;
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

function parseBooleanCell(value, defaultValue) {
  const text = cleanTableCell(value).toLowerCase();
  if (!text) return defaultValue;
  if (/^(yes|y|true|required|must|done|blocker|필수|예|네|완료필수)$/.test(text)) return true;
  if (/^(no|n|false|optional|not required|skip|skippable|아니오|아님|선택|선택사항)$/.test(text)) return false;
  if (/^no\s*\/\s*blockable$/.test(text)) return false;
  return defaultValue;
}

function normalizeVerificationId(value, counter) {
  const compact = cleanTableCell(value)
    .replace(/\s+/g, "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .toUpperCase();
  return compact || `V${counter}`;
}

function matrixVerificationItem(headers, cells, currentLevel, counter) {
  const idCell = tableValue(headers, cells, ["id", "check id", "verification id"]);
  const mode = tableValue(headers, cells, ["mode", "test mode", "verification mode"]);
  const covers = tableValue(headers, cells, ["covers", "coverage", "mapped ids"]);
  const passCriteria = tableValue(headers, cells, ["pass intent", "pass criteria", "pass", "expected", "expected result", "success criteria", "proof intent"]);
  const requiredForDoneRaw = tableValue(headers, cells, ["required for done", "required", "done gate", "required_for_done"]);
  const canBeBlockedRaw = tableValue(headers, cells, ["can be blocked", "blockable", "can block", "blocker semantics", "can_be_blocked"]);
  const safeProbe = tableValue(headers, cells, ["safe probe", "probe", "safe_probe"]);
  const sideEffect = tableValue(headers, cells, ["side effect", "side effects", "allowed side effect", "allowed side effects", "external side effect", "side_effect"]);
  const sensitiveDataPolicy = tableValue(headers, cells, ["sensitive data policy", "pii policy", "secret policy", "sensitive data", "sensitive_data_policy"]);
  if (!idCell && mode && !passCriteria) return null;
  if (!covers && !passCriteria) return null;

  const textParts = [];
  if (mode) textParts.push(`Mode: ${mode}`);
  if (covers) textParts.push(`Covers: ${covers}`);
  if (passCriteria) textParts.push(`Pass: ${passCriteria}`);
  if (requiredForDoneRaw) textParts.push(`Required For Done: ${requiredForDoneRaw}`);
  if (canBeBlockedRaw) textParts.push(`Can Be Blocked: ${canBeBlockedRaw}`);
  if (safeProbe) textParts.push(`Safe Probe: ${safeProbe}`);
  if (sideEffect) textParts.push(`Side Effect: ${sideEffect}`);
  if (sensitiveDataPolicy) textParts.push(`Sensitive Data Policy: ${sensitiveDataPolicy}`);
  let text = textParts.join(". ");
  if (text && !/[.!?]$/.test(text)) text = `${text}.`;
  const id = normalizeVerificationId(idCell, counter);

  return {
    id,
    level: currentLevel,
    title: firstSentence(passCriteria || covers || id),
    text,
    status: "pending",
    evidence: [],
    artifacts: [],
    source: "verification_matrix",
    matrix: {
      mode,
      covers,
      passCriteria,
      requiredForDone: parseBooleanCell(requiredForDoneRaw, true),
      requiredForDoneRaw,
      canBeBlocked: parseBooleanCell(canBeBlockedRaw, false),
      canBeBlockedRaw,
      safeProbe,
      sideEffect,
      sensitiveDataPolicy,
    },
  };
}

function parseTestModeContract(section) {
  const rows = [];
  let tableHeaders = null;
  let counter = 1;
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) {
      if (!line) tableHeaders = null;
      continue;
    }
    if (!looksLikeMarkdownTable(line, tableHeaders)) {
      tableHeaders = null;
      continue;
    }
    const cells = parseMarkdownTableRow(line);
    if (!cells.length) continue;
    if (!tableHeaders) {
      if (isTableSeparator(cells)) continue;
      tableHeaders = cells.map(normalizeTableHeader);
      const modeIndex = headerIndex(tableHeaders, ["mode", "test mode", "verification mode"]);
      const requiredIndex = headerIndex(tableHeaders, ["required for done", "required", "done gate"]);
      if (modeIndex < 0 || requiredIndex < 0) tableHeaders = null;
      continue;
    }
    if (isTableSeparator(cells)) continue;
    const mode = tableValue(tableHeaders, cells, ["mode", "test mode", "verification mode"]);
    if (!mode) continue;
    const requiredRaw = tableValue(tableHeaders, cells, ["required for done", "required", "done gate"]);
    rows.push({
      id: `TM${counter}`,
      mode,
      normalizedMode: normalizeMode(mode),
      requiredForDone: parseTestModeRequired(requiredRaw),
      requiredForDoneRaw: requiredRaw,
      canBeBlocked: /blockable|blocked|blocker|차단|막힘/i.test(requiredRaw),
      covers: tableValue(tableHeaders, cells, ["covers", "coverage", "mapped ids"]),
      humanDecision: tableValue(tableHeaders, cells, ["human decision", "human review", "approval", "decision"]),
    });
    counter += 1;
  }
  return rows;
}

function applyTestModeDefaults(verificationItems, testModes) {
  for (const item of verificationItems || []) {
    if (!item.matrix) continue;
    const mode = inferVerificationMode(item, testModes || []);
    if (!mode) continue;
    item.testMode = mode.mode;
    item.matrix.mode = item.matrix.mode || mode.mode;
    if (!item.matrix.requiredForDoneRaw) {
      item.matrix.requiredForDone = Boolean(mode.requiredForDone);
      item.matrix.requiredForDoneRaw = mode.requiredForDoneRaw || (mode.requiredForDone ? "yes" : "no");
    }
    if (!item.matrix.canBeBlockedRaw) {
      item.matrix.canBeBlocked = Boolean(mode.canBeBlocked);
      item.matrix.canBeBlockedRaw = mode.canBeBlocked ? "yes" : "no";
    }
  }
  return verificationItems;
}

function parseTestModeRequired(value) {
  const text = cleanTableCell(value).toLowerCase();
  if (/^no\s*\/\s*blockable$/.test(text)) return false;
  return parseBooleanCell(text, true);
}

function normalizeMode(value) {
  return cleanTableCell(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferVerificationMode(verification, testModes) {
  const explicit = verification.matrix && verification.matrix.mode ? normalizeMode(verification.matrix.mode) : "";
  if (explicit) {
    return testModes.find(row => row.normalizedMode === explicit) || {
      mode: verification.matrix.mode,
      normalizedMode: explicit,
      requiredForDone: isVerificationRequiredForDone(verification),
      canBeBlocked: verification.matrix ? Boolean(verification.matrix.canBeBlocked) : false,
    };
  }
  const text = `${verification.level || ""} ${verification.text || ""}`.toLowerCase();
  const candidates = testModes || [];
  const direct = candidates.find(row => {
    const mode = row.normalizedMode || normalizeMode(row.mode);
    if (!mode) return false;
    const words = mode.split("-").filter(Boolean);
    return words.length && words.every(word => text.includes(word));
  });
  if (direct) return direct;
  const fallbackName = inferredModeNameFromText(text);
  if (!fallbackName) return null;
  const normalized = normalizeMode(fallbackName);
  return candidates.find(row => row.normalizedMode === normalized)
    || candidates.find(row => (row.normalizedMode || "").includes(normalized) || normalized.includes(row.normalizedMode || ""))
    || { mode: fallbackName, normalizedMode: normalized, requiredForDone: isVerificationRequiredForDone(verification), canBeBlocked: false };
}

function inferredModeNameFromText(text) {
  if (/(build|static|typecheck|type check|lint|compile|repo health)/.test(text)) return "build/static";
  if (/(automated|unit|integration|e2e|regression|test|spec)/.test(text)) return "automated behavior";
  if (/(browser|runtime|chromux|screenshot|viewport|dom|console|network|main flow|user flow)/.test(text)) return "browser/runtime";
  if (/(db|database|postgres|supabase|sql|query|row|migration)/.test(text)) return "db";
  if (/(api|endpoint|request|response|webhook|external|live|credential|sandbox)/.test(text)) return "live external API";
  return null;
}

function modeMatches(mode, patterns) {
  const text = `${mode && mode.normalizedMode ? mode.normalizedMode : ""} ${mode && mode.mode ? mode.mode : ""}`.toLowerCase();
  return patterns.some(pattern => pattern.test(text));
}

const PRD_IMPLEMENTATION_COLUMNS = new Set([
  "method", "check", "command", "command / method", "tool / method",
  "artifact", "artifacts", "evidence", "expected artifact", "expected artifacts",
  "environment", "env", "runtime", "live proof", "live check", "real proof",
]);

/**
 * Find implementation-owned bindings in a PRD without interpreting product
 * prose. This is the single structural rule used by stateless planning, init,
 * and gate prelint.
 */
function findPrdImplementationBindings(content) {
  const lines = String(content || "").split("\n");
  const defects = [];
  let section = null;
  let currentAc = null;
  let inVerificationMatrix = false;
  let matrixHeaderSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^##\s+(?:([0-9]+)\.\s*)?(.+?)\s*$/);
    if (heading) {
      const number = heading[1] || "";
      const title = heading[2].toLowerCase();
      section = number === "7" || title === "acceptance criteria" ? "ac"
        : number === "8" || title === "prd-level tasks" ? "task"
          : null;
      currentAc = null;
      inVerificationMatrix = false;
      matrixHeaderSeen = false;
    }
    const subsection = line.match(/^###\s+(?:9\.2\s*)?Required Agent Verification\s*$/i);
    if (subsection) {
      section = null;
      currentAc = null;
      inVerificationMatrix = true;
      matrixHeaderSeen = false;
      continue;
    }
    if (/^###\s+/.test(line) && !subsection) {
      inVerificationMatrix = false;
      matrixHeaderSeen = false;
    }

    if (section === "task" && /(?:^|\s)Scope:\s*/i.test(line)) {
      defects.push({
        code: "prd-implementation-binding",
        line: index + 1,
        message: "PRD task declares file Scope, which belongs to the implementation execution plan",
      });
    }

    if (section === "ac") {
      const definition = line.match(/^\s*-\s*(AC\d+)[.:]\s+/i);
      if (definition) currentAc = definition[1].toUpperCase();
      else if (!/^\s+\S/.test(line) || /^\s*-\s/.test(line)) currentAc = null;
      if (currentAc && /(?:^|\s)(?:Check|Artifact):\s*/i.test(line)) {
        defects.push({
          code: "prd-implementation-binding",
          line: index + 1,
          message: `${currentAc} declares an executable Check or Artifact path inside the product criterion`,
        });
      }
    }

    if (inVerificationMatrix && !matrixHeaderSeen && line.trim().startsWith("|")) {
      const header = parseMarkdownTableRow(line);
      const normalizedHeader = header.map(column => column.trim().toLowerCase());
      if (!normalizedHeader.includes("id") || !normalizedHeader.includes("mode") || !normalizedHeader.includes("covers")) {
        continue;
      }
      matrixHeaderSeen = true;
      for (const column of header) {
        if (!PRD_IMPLEMENTATION_COLUMNS.has(column.trim().toLowerCase())) continue;
        defects.push({
          code: "prd-implementation-binding",
          line: index + 1,
          message: `9.2 declares implementation-owned column "${column}"`,
        });
      }
    }
  }
  return defects;
}

module.exports = {
  stripFrontmatter,
  extractSection,
  extractFirstSection,
  extractNestedSection,
  extractFirstNestedSection,
  parseMarkdownItems,
  coverageFromText,
  expandCoverageIds,
  parsePreWorkChecklist,
  preWorkItems,
  pendingPreWork,
  preWorkStatusDefect,
  classifyPreWorkSubsection,
  PRE_WORK_STATUSES,
  buildIntentTrace,
  intentSourceFiles,
  splitIntentSourceValue,
  parseDecisionTraceItems,
  inferDecisionStance,
  parseVerification,
  looksLikeMarkdownTable,
  extractCodeSpans,
  splitTableRow,
  parseMarkdownTableRow,
  cleanTableCell,
  isTableSeparator,
  normalizeTableHeader,
  headerIndex,
  tableValue,
  parseBooleanCell,
  normalizeVerificationId,
  matrixVerificationItem,
  parseTestModeContract,
  applyTestModeDefaults,
  parseTestModeRequired,
  normalizeMode,
  inferVerificationMode,
  inferredModeNameFromText,
  modeMatches,
  findPrdImplementationBindings,
};
