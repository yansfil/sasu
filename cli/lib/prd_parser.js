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
      status: "pending",
      evidence: [],
      artifacts: [],
    };
  }
  finishCurrent();
  return items;
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

function parseMarkdownTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cleanTableCell);
}

function cleanTableCell(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/\\\|/g, "|")
    .replace(/&nbsp;/gi, " ")
    .replace(/\*\*/g, "")
    .trim();
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
  buildIntentTrace,
  intentSourceFiles,
  splitIntentSourceValue,
  parseDecisionTraceItems,
  inferDecisionStance,
  parseVerification,
  looksLikeMarkdownTable,
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
