"use strict";

const fs = require("fs");
const path = require("path");

const { resolveProjectPath, toProjectRelative, sha256Text, escapeRegExp, firstSentence, uniqueMatches } = require("./util");
const { isVerificationRequiredForDone } = require("./state_data");

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

// Literal human-only markers PRD authors write on `### 4.1` pre-work bullets.
// The gen-prd contract requires every pre-work item to say why it is
// human-only, so matching the literal phrase is the honest detector; no
// attempt is made to semantically understand what the bullet asks for.
const PRE_WORK_HUMAN_MARKERS = /사람만\s*가능|human[\s-]*only|사용자만|소유자\s*권한|owner[\s-]*only/i;

// Extract the human-action checklist from `## 4. Pre-Work And Required
// Decisions` (`### 4.1` pre-work bullets and `### 4.2` human-decision
// bullets).
//
// Why this exists: in an audited real run, 62% of wall time (57+ minutes in
// one stretch) was spent waiting on the user because human-only prerequisites
// the PRD had already declared up front — §4.1 items literally marked
// "사람만 가능", an unapproved §4.2 decision — were only discovered serially
// mid-implementation (a 42min stall plus a 15min stall). Surfacing them
// mechanically at init lets the skill ask for all of them in one batched
// message before implementation starts.
//
// This is a surfacing mechanism, not a judgment. Detection is structural
// first (which numbered subsection the bullet lives in), heuristic second
// (the literal marker / resolved words). A 4.1 bullet without a human-only
// marker is simply not extracted — the skill text covers that residue — and
// unresolved items never block init; the contract is "surface loudly".
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
  // marker-bearing bullet inside one would otherwise surface as a spurious
  // item in the batched user ask.
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
    const text = bullet[2].replace(/^\*\*|\*\*$/g, "").replace(/\s+/g, " ").trim();
    // \b is useless after Hangul (not ASCII word chars), so the Korean
    // "none" forms are matched without a boundary.
    if (!text || /^(?:none\b|n\/a\b|없음|해당\s*없음)/i.test(text)) continue;
    const resolved = bullet[1] === "x" || bullet[1] === "X" || isPreWorkResolved(text);
    const humanMarked = PRE_WORK_HUMAN_MARKERS.test(text);
    // 4.1 mixes human-only and agent-doable prep, so only marker-bearing
    // bullets are extracted there. 4.2 bullets are human decisions by
    // definition, so every open one surfaces; a resolved unmarked 4.2 bullet
    // is old news and stays out of the checklist.
    if (subsection === "4.1" && !humanMarked) continue;
    if (subsection === "4.2" && !humanMarked && resolved) continue;
    items.push({
      id: subsection === "4.1" ? `PW${preWorkCounter++}` : `HD${humanDecisionCounter++}`,
      section: subsection,
      text,
      resolved,
    });
  }
  return items;
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

function isPreWorkResolved(text) {
  // "미완료"/"not done" contain the positive marker as a substring, so the
  // negated and future forms must be rejected before the positive scan.
  // "완료되지 않음", "완료 안 됨", "완료 예정", "진행 중", "보류" are all
  // standard Korean phrasings for open items; misreading any of them as
  // resolved silently drops a genuinely open human decision from the
  // checklist - the exact mid-run stall this feature exists to prevent.
  if (/미완료|미해결|되지\s*않|안\s*됨|안됨|예정|진행\s*중|보류|not\s+(?:yet\s+)?(?:done|resolved|completed)|unresolved|incomplete|pending/i.test(text)) return false;
  return /완료됨|완료|해결됨|\bdone\b|\bresolved\b|\bcompleted\b/i.test(text);
}

function parseMarkdownItems(section, prefix, fallbackLabel) {
  const items = [];
  let counter = 1;
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    current.text = current.text.replace(/\s+/g, " ").trim();
    current.title = firstSentence(current.text);
    current.requirements = uniqueMatches(current.text, /\bR\d+\b/gi);
    current.acceptanceCriteria = uniqueMatches(current.text, /\bAC\d+\b/gi);
    // §8 task tail `Scope: <glob>[, <glob>...]` - the PRD's own declaration of
    // where this task's change lives. Extracted for every item kind (only
    // tasks use it today) so the verify gate can scope a judge lane's diff to
    // the paths the vetted document named, instead of paths the implementer
    // picked at verification time (submission-bias boundary, D: verify-input
    // selection belongs to the document/harness). Parsed from the pre-strip
    // raw text: the bold-marker strip on `text` eats a line-final `**`, which
    // is exactly how a recursive glob ends.
    const scopeGlobs = parseScopeGlobs(current.rawText.replace(/\s+/g, " ").trim());
    if (scopeGlobs.length) current.scopeGlobs = scopeGlobs;
    delete current.rawText;
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
        current.rawText += ` ${line}`;
      }
      continue;
    }
    finishCurrent();
    let text = match[1].replace(/^\*\*|\*\*$/g, "").trim();
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
      rawText: match[1].trim(),
      status: "pending",
      evidence: [],
      artifacts: [],
    };
  }
  finishCurrent();
  return items;
}

/**
 * `Scope:` tail grammar for §8 task bullets: `Scope: <glob>[, <glob>...]` at
 * the end of the bullet. One grammar, three readers - this parser (init state),
 * the TS prelint (syntax gate), and the verify gate's lane scoping - so the
 * regexes live here and everyone imports them.
 */
const SCOPE_TAIL = /(?:^|\s)Scope:\s*(.+)$/;

function parseScopeGlobs(text) {
  const match = String(text || "").match(SCOPE_TAIL);
  if (!match) return [];
  return match[1]
    .replace(/\.\s*$/, "")
    .split(",")
    .map(part => part.trim().replace(/^`|`$/g, "").trim())
    .filter(Boolean);
}

// Syntax validation shared with prelint: null when the glob is acceptable,
// otherwise the human-readable reason. Globs are repo-relative by contract -
// the diff they scope is repo-relative - so absolute paths and `..` escapes
// are structural defects, not style.
function scopeGlobDefect(glob) {
  const value = String(glob || "").trim();
  if (!value) return "empty glob";
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return `glob is absolute: ${value}`;
  if (value.split("/").includes("..")) return `glob escapes the project root: ${value}`;
  if (/\\/.test(value)) return `glob uses backslashes: ${value} (use forward slashes)`;
  if (!/^[A-Za-z0-9_@.\-/*?]+$/.test(value)) return `glob has unsupported characters: ${value} (allowed: letters, digits, _ @ . - / * ?)`;
  return null;
}

/**
 * AC oracle tail grammar (§7): a machine-checkable acceptance criterion may
 * end with one of
 *   Check: `<command>` -> <expected stdout substring>
 *   Check: `<command>`                (exit 0 alone proves it)
 *   Artifact: <project-relative path> (existence proves it)
 * Scaled-down import of ouroboros's AcceptanceCriterionSpec
 * (verify_command/output_assertion/expected_artifacts): the oracle is declared
 * in the vetted document at PRD time and executed by the harness, so the
 * implementer never picks what proves the criterion. Oracle-backed ACs are
 * settled mechanically and skip the judge lane entirely.
 */
const AC_ORACLE_CHECK = /(?:^|\s)Check:\s*`([^`]+)`\s*(?:(?:->|→)\s*(\S.*))?$/;
const AC_ORACLE_ARTIFACT = /(?:^|\s)Artifact:\s*(\S+?)\s*$/;

function parseAcOracle(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const check = normalized.match(AC_ORACLE_CHECK);
  if (check) {
    let expect = (check[2] || "").trim();
    // A backtick-wrapped expectation is taken verbatim (the escape hatch for
    // expectations that literally end in a period). A bare one sheds the
    // bullet's sentence-final period so `-> ok.` asserts "ok", not "ok." -
    // unless the period follows a quote, which reads as literal content
    // (e.g. a JSON snippet like -> "status":"ok").
    const backticked = expect.match(/^`(.*)`$/);
    if (backticked) expect = backticked[1];
    else if (!/["'`]\.$/.test(expect)) expect = expect.replace(/\.$/, "");
    return { kind: "check", command: check[1].trim(), expect: expect || null };
  }
  const artifact = normalized.match(AC_ORACLE_ARTIFACT);
  if (artifact) {
    const artifactPath = artifact[1].replace(/^`|`$/g, "").replace(/\.$/, "");
    return { kind: "artifact", path: artifactPath };
  }
  return null;
}

// Structural defects in an oracle tail, for the $0 prelint: a bullet that
// gestures at the reserved Check:/Artifact: markers but does not parse must
// block before any judge or oracle run reads it as prose.
function acOracleDefect(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const mentionsCheck = /(?:^|\s)Check:/.test(normalized);
  const mentionsArtifact = /(?:^|\s)Artifact:/.test(normalized);
  if (!mentionsCheck && !mentionsArtifact) return null;
  if (mentionsCheck && mentionsArtifact) {
    return "AC declares both Check: and Artifact: oracles; keep exactly one (split the criterion if both proofs matter)";
  }
  if (mentionsCheck && !AC_ORACLE_CHECK.test(normalized)) {
    return "Check: oracle must be `Check: \\`<command>\\` [-> <expected stdout substring>]` at the end of the bullet, command in backticks";
  }
  const oracle = parseAcOracle(normalized);
  if (oracle && oracle.kind === "artifact") {
    if (oracle.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(oracle.path)) {
      return `Artifact: oracle path is absolute: ${oracle.path} (use a project-relative path)`;
    }
    if (oracle.path.split(/[\\/]/).includes("..")) {
      return `Artifact: oracle path escapes the project root: ${oracle.path}`;
    }
  }
  if (mentionsArtifact && !oracle) {
    return "Artifact: oracle must be `Artifact: <project-relative path>` at the end of the bullet";
  }
  return null;
}

/**
 * Task scope view for the verify gate's lane scoping (TS side requires this
 * through the same lib the state parser uses, so both read one §8 grammar).
 * `acceptanceCriteria`/`requirements` are the task's Covers references; an AC
 * is scope-covered by a task either directly or via a shared R# - the same
 * chain the prelint's AC-coverage rule walks.
 */
function parsePrdTasksForScoping(prdContent) {
  const parsed = stripFrontmatter(String(prdContent || ""));
  const tasks = parseMarkdownItems(extractFirstSection(parsed.body, [
    "8. PRD-Level Tasks",
    "PRD-Level Tasks",
  ]), "T", "Task");
  return tasks.map(task => ({
    id: task.id,
    scopeGlobs: task.scopeGlobs || [],
    acceptanceCriteria: task.acceptanceCriteria || [],
    requirements: task.requirements || [],
  }));
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
  return /\b(id|covers|coverage)\b\s*\|/i.test(line) && /\|\s*(method|check|command|artifact|artifacts|pass)/i.test(line);
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
 * escaped as `\|`; span text is copied wholesale so commands keep their pipes.
 * This deliberately diverges from GFM (which cuts cells at pipes even inside
 * code spans) because the PRD contract treats a backticked Method cell as the
 * literal command to execute - what the author wrote inside the backticks is
 * what must run.
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
  const method = tableValue(headers, cells, ["method", "check", "command", "command / method", "tool / method", "scenario", "flow"]);
  const artifact = tableValue(headers, cells, ["artifact", "artifacts", "evidence", "expected artifact", "expected artifacts"]);
  const passCriteria = tableValue(headers, cells, ["pass intent", "pass criteria", "pass", "expected", "expected result", "success criteria", "proof intent"]);
  const environment = tableValue(headers, cells, ["environment", "env", "runtime"]);
  const requiredForDoneRaw = tableValue(headers, cells, ["required for done", "required", "done gate", "required_for_done"]);
  const canBeBlockedRaw = tableValue(headers, cells, ["can be blocked", "blockable", "can block", "blocker semantics", "can_be_blocked"]);
  const safeProbe = tableValue(headers, cells, ["safe probe", "probe", "safe_probe"]);
  const liveProof = tableValue(headers, cells, ["live proof", "live check", "real proof", "live_proof"]);
  const sideEffect = tableValue(headers, cells, ["side effect", "side effects", "external side effect", "side_effect"]);
  const sensitiveDataPolicy = tableValue(headers, cells, ["sensitive data policy", "pii policy", "secret policy", "sensitive data", "sensitive_data_policy"]);
  if (!idCell && mode && !method && !artifact && !passCriteria) return null;
  if (!covers && !method && !artifact && !passCriteria) return null;

  const textParts = [];
  if (mode) textParts.push(`Mode: ${mode}`);
  if (covers) textParts.push(`Covers: ${covers}`);
  if (method) textParts.push(`Check: ${method}`);
  if (artifact) textParts.push(`Artifact: ${artifact}`);
  if (passCriteria) textParts.push(`Pass: ${passCriteria}`);
  if (environment) textParts.push(`Environment: ${environment}`);
  if (requiredForDoneRaw) textParts.push(`Required For Done: ${requiredForDoneRaw}`);
  if (canBeBlockedRaw) textParts.push(`Can Be Blocked: ${canBeBlockedRaw}`);
  if (safeProbe) textParts.push(`Safe Probe: ${safeProbe}`);
  if (liveProof) textParts.push(`Live Proof: ${liveProof}`);
  if (sideEffect) textParts.push(`Side Effect: ${sideEffect}`);
  if (sensitiveDataPolicy) textParts.push(`Sensitive Data Policy: ${sensitiveDataPolicy}`);
  let text = textParts.join(". ");
  if (text && !/[.!?]$/.test(text)) text = `${text}.`;
  const id = normalizeVerificationId(idCell, counter);

  return {
    id,
    level: currentLevel,
    title: firstSentence(method || covers || passCriteria || id),
    text,
    status: "pending",
    evidence: [],
    artifacts: [],
    source: "verification_matrix",
    matrix: {
      mode,
      covers,
      method,
      artifact,
      passCriteria,
      environment,
      requiredForDone: parseBooleanCell(requiredForDoneRaw, true),
      requiredForDoneRaw,
      canBeBlocked: parseBooleanCell(canBeBlockedRaw, false),
      canBeBlockedRaw,
      safeProbe,
      liveProof,
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

module.exports = {
  stripFrontmatter,
  extractSection,
  extractFirstSection,
  extractNestedSection,
  extractFirstNestedSection,
  parseMarkdownItems,
  parseScopeGlobs,
  scopeGlobDefect,
  parseAcOracle,
  acOracleDefect,
  parsePrdTasksForScoping,
  parsePreWorkChecklist,
  classifyPreWorkSubsection,
  isPreWorkResolved,
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
};
