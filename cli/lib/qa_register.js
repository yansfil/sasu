"use strict";

// Decision Register reader shared by every consumer that needs the qa-log's
// decisions as data: the TypeScript interview module (cli/src/interview/
// qalog.ts re-exports parseRegisterRows from here), the gate freshness hash
// (gate_freshness.js pins a qa-log by its decision cells), and the gate
// lane digests (cli/src/gates/commands.ts). One parser, so the pin, the
// prelint, and the rerun contract can never disagree about what a decision
// row is (PRINCIPLES item 10; oh-my-principle engineering rule 7).

const crypto = require("crypto");

const REGISTER_HEADING = "## Decision Register";
const RAW_QA_HEADING = "## Raw Q&A";

function sectionRange(lines, heading) {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Rows of the `## Decision Register` table, or null when the section is
 * absent. Cells: ID | Kind | Area | Decision / fact | Priority | Source /
 * owner | Status | PRD mapping / revisit.
 */
function parseRegisterRows(content) {
  const lines = content.split("\n");
  const range = sectionRange(lines, REGISTER_HEADING);
  if (range === null) return null;
  const rows = [];
  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
    if (cells[0] === "ID") continue;
    if (cells.length < 8) continue;
    rows.push({
      id: cells[0],
      kind: cells[1],
      area: cells[2],
      text: cells[3],
      priority: cells[4],
      source: cells[5],
      status: cells[6],
      mapping: cells[7],
    });
  }
  return rows;
}

/**
 * The decision content of a row - what was decided, how important it is,
 * and whether it stands. Source/owner and PRD mapping are bookkeeping the
 * agent rewrites while anchoring and drafting (PRD gate-loop D-05: a one-line
 * anchor fix re-opened a sealed PASS and drew ten new findings), so they are
 * outside the pinned content on purpose.
 */
function decisionCellKey(row) {
  return [row.id, row.kind, row.area, row.text, row.priority, row.status].map((cell) => cell.trim()).join("|");
}

function sha256Of(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * The user's answer text of every `## Raw Q&A` turn, keyed by question
 * number, or null when the section is absent. Only the `- answer:` line
 * counts: the turn's label, anchors (`- decision_ids:`), route, source_ref,
 * asked/recommended text and notes are the agent's bookkeeping. Answers are
 * the evidence a spec judge compares decisions against (PRD gate-loop D-08),
 * which is why they are pinned with the decision cells (gate_freshness.js).
 */
function parseQaAnswers(content) {
  const lines = content.split("\n");
  const range = sectionRange(lines, RAW_QA_HEADING);
  if (range === null) return null;
  const answers = [];
  let question = null;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const heading = lines[i].match(/^###\s+Q(\d+)\b/);
    if (heading) {
      question = heading[1];
      continue;
    }
    const answer = lines[i].match(/^-\s*answer:(.*)$/);
    if (answer && question !== null) answers.push({ question, answer: answer[1].trim() });
  }
  return answers;
}

/** Digest of the answers by question number, independent of turn order. */
function answerDigest(answers) {
  return sha256Of(answers.map((entry) => `Q${entry.question}|${entry.answer}`).sort().join("\n"));
}

/** Order-independent digest of a set of rows' decision cells. */
function decisionDigest(rows) {
  return sha256Of(rows.map(decisionCellKey).sort().join("\n"));
}

module.exports = { REGISTER_HEADING, RAW_QA_HEADING, parseRegisterRows, decisionCellKey, decisionDigest, parseQaAnswers, answerDigest };
