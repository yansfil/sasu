#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const usage = "Usage: node validate_intake.mjs <qa-log.md> [--handoff <prd-handoff.md>]";
const requiredColumns = [
  "ID",
  "Kind",
  "Area",
  "Decision / fact",
  "Priority",
  "Source / owner",
  "Status",
  "PRD mapping / revisit",
];
const legacyColumns = [
  "ID",
  "Type",
  "Axis",
  "Decision / fact",
  "Impact",
  "Owner",
  "Source / evidence",
  "Status",
  "Reopen / PRD mapping",
];
const validTypes = new Set(["fact", "decision", "assumption"]);
const validImpacts = new Set(["P0", "P1", "P2"]);
const validStatuses = new Set(["open", "resolved", "deferred", "blocking", "rejected"]);

function fail(message) {
  process.stderr.write("error: " + message + "\n");
  process.exitCode = 1;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    fail("cannot read " + file + ": " + error.message);
    return "";
  }
}

function escapeRegex(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function section(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "## " + title);
  if (start < 0) return "";
  const content = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    content.push(line);
  }
  return content.join("\n").trim();
}

function headingBlocks(markdown, prefix) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith("### " + prefix)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function tableRows(markdown) {
  const lines = markdown.split(/\r?\n/).filter(line => line.trim().startsWith("|"));
  if (lines.length < 3) return { headers: [], rows: [] };
  const parse = line => line.trim().split("|").slice(1, -1).map(cell => cell.trim());
  return {
    headers: parse(lines[0]),
    rows: lines.slice(2).map(parse).filter(row => row.some(Boolean)),
  };
}

function hasField(card, field) {
  return new RegExp("^- " + escapeRegex(field) + ":\\s*\\S", "mi").test(card);
}

function parseArguments(argv) {
  const [qaLog, flag, handoff, ...extra] = argv;
  if (!qaLog || (flag && flag !== "--handoff") || (flag === "--handoff" && !handoff) || extra.length) {
    fail(usage);
    return {};
  }
  return { qaLog, handoff };
}

const { qaLog, handoff } = parseArguments(process.argv.slice(2));
if (!qaLog) process.exit();

const qaPath = path.resolve(qaLog);
const qa = readFile(qaPath);
if (!qa) process.exit();
if (handoff) {
  const rawQa = section(qa, "Raw Q&A") || qa;
  if (/^\s*(?:-\s*)?needs_normalization:\s*(?:true|yes|1)\s*$/im.test(rawQa)) {
    fail("Handoff cannot be written while needs_normalization is true.");
  }
}

const registerSection = section(qa, "Decision Register") || section(qa, "Decision Frontier");
const frontier = tableRows(registerSection);
const currentShape = frontier.headers.join("|") === requiredColumns.join("|");
const legacyShape = frontier.headers.join("|") === legacyColumns.join("|");
if (!currentShape && !legacyShape) {
  fail("Decision Register is missing or does not use the required columns.");
}
if (!frontier.rows.length) {
  fail("Decision Register must contain at least one material node.");
}

const nodes = [];
const seenIds = new Set();
for (const [index, row] of frontier.rows.entries()) {
  const rawNode = Object.fromEntries((currentShape ? requiredColumns : legacyColumns).map((column, columnIndex) => [column, row[columnIndex] || ""]));
  const node = currentShape ? rawNode : {
    ID: rawNode.ID,
    Kind: rawNode.Type,
    Area: rawNode.Axis,
    "Decision / fact": rawNode["Decision / fact"],
    Priority: rawNode.Impact,
    "Source / owner": [rawNode.Owner, rawNode["Source / evidence"]].filter(Boolean).join(": "),
    Status: rawNode.Status,
    "PRD mapping / revisit": rawNode["Reopen / PRD mapping"],
  };
  const label = "Decision Register row " + (index + 1);
  if (!/^D-\d+$/.test(node.ID)) fail(label + " needs an ID like D-01.");
  if (seenIds.has(node.ID)) fail(label + " duplicates Decision Register ID " + node.ID + ".");
  seenIds.add(node.ID);
  if (!validTypes.has(node.Kind)) fail(label + " has invalid Kind '" + node.Kind + "'.");
  if (!validImpacts.has(node.Priority)) fail(label + " has invalid Priority '" + node.Priority + "'.");
  if (!node.Area || !node["Decision / fact"] || !node["Source / owner"] || !node["PRD mapping / revisit"]) {
    fail(label + " is missing a required decision, source, owner, mapping, or revisit field.");
  }
  if (!validStatuses.has(node.Status)) fail(label + " has invalid Status '" + node.Status + "'.");
  if ((node.Priority === "P0" || node.Priority === "P1") && node.Status === "open") {
    fail(label + " leaves material " + node.Priority + " node " + node.ID + " open.");
  }
  nodes.push(node);
}

const cards = section(qa, "UX Scenario Cards");
const cardMatches = headingBlocks(cards, "UX-").filter(card => /^### UX-\d+:/m.test(card));
const uxSelected = /^selected_packs:\s*.*\bux\b/im.test(qa)
  || nodes.some(node => /^UX(?:\/design)?$/i.test(node.Area))
  || cardMatches.length > 0;
if (uxSelected) {
  if (!cardMatches.length) {
    fail("UX is selected but no UX Scenario Card exists.");
  }
  for (const card of cardMatches) {
    for (const field of ["trigger", "happy path", "state / failure", "recovery", "proof", "linked decisions"]) {
      if (!hasField(card, field)) {
        fail("UX Scenario Card is missing '" + field + "'.");
      }
    }
    const linked = (card.match(/^- linked decisions:\s*(.+)$/mi) || [])[1] || "";
    const linkedIds = linked.match(/D-\d+/g) || [];
    if (!linkedIds.length) fail("UX Scenario Card must link at least one Decision Register ID.");
    for (const id of linkedIds) {
      if (!seenIds.has(id)) fail("UX Scenario Card links unknown decision " + id + ".");
    }
  }
}

if (handoff) {
  const handoffPath = path.resolve(handoff);
  const handoffText = readFile(handoffPath);
  const trace = section(handoffText, "Decision Trace And Requirement Mapping");
  if (!trace) fail("Handoff is missing 'Decision Trace And Requirement Mapping'.");
  const traceTable = tableRows(trace);
  const decisionColumn = traceTable.headers.indexOf("Decision");
  const representedColumn = traceTable.headers.indexOf("Represented by");
  if (decisionColumn < 0 || representedColumn < 0) {
    fail("Decision Trace And Requirement Mapping must include Decision and Represented by columns.");
  }
  const uxSeeds = section(handoffText, "UX Behavior And State Seeds");
  if (uxSelected && !uxSeeds) {
    fail("UX is selected but handoff is missing 'UX Behavior And State Seeds'.");
  }
  for (const card of cardMatches) {
    const scenarioId = (card.match(/^### (UX-\d+):/m) || [])[1];
    if (scenarioId && !uxSeeds.includes(scenarioId)) {
      fail("Handoff does not preserve UX scenario " + scenarioId + ".");
    }
  }
  for (const node of nodes.filter(node => node.Priority !== "P2" && node.Status !== "rejected")) {
    const row = traceTable.rows.find(candidate => {
      const decisions = candidate[decisionColumn] || "";
      return new RegExp("(?:^|[^A-Za-z0-9-])" + escapeRegex(node.ID) + "(?:$|[^A-Za-z0-9-])").test(decisions);
    });
    if (!row) {
      fail("Handoff does not trace material decision " + node.ID + ".");
      continue;
    }
    const represented = row[representedColumn] || "";
    if (!/(?:\b(?:R|AC|T|V)\d+\b|non-goal|human review|risk|guardrail|deferred|blocking|비목표|인간 검토|위험|가드레일|보류|차단)/i.test(represented)) {
      fail("Handoff trace for " + node.ID + " lacks a concrete PRD mapping or explicit deferred/blocking destination.");
    }
  }
}

if (!process.exitCode) {
  const mode = handoff ? "qa-log and handoff" : "qa-log";
  process.stdout.write("Intake validation passed for " + mode + ": " + qaPath + "\n");
}
