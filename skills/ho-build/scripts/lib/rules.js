"use strict";

// Rules engine: learned lessons that landed as machine-checkable assets.
//
// Three kinds share one ledger (agents/rules/INDEX.md) but land differently:
// - fact: body lives in project docs, ledger row only.
// - invariant: body IS the rule file (agents/rules/invariants/<id>.md) with a
//   trigger (path globs) and an executable check; deliver runs it pre-push.
// - regression: body is a test in the project's own suite, ledger row only;
//   not-yet-written tests wait under agents/rules/pending/.
//
// Unverifiable good intentions are rejected: an invariant without a trigger
// and an executable (or explicitly human-confirmable) check cannot register.

const fs = require("fs");
const path = require("path");

const { RULES_ROOT_REL, nowIso, ensureDir, runCommand, normalizeRelPath, escapeRegExp } = require("./util");

const RULE_KINDS = ["fact", "invariant", "regression"];
const CHECK_TYPES = ["command", "grep", "manual"];
const ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Za-z0-9][A-Za-z0-9-]*$/;

function rulesRoot(projectRoot) {
  return path.join(projectRoot, RULES_ROOT_REL);
}

function invariantsDir(projectRoot) {
  return path.join(rulesRoot(projectRoot), "invariants");
}

function pendingDir(projectRoot) {
  return path.join(rulesRoot(projectRoot), "pending");
}

function indexPath(projectRoot) {
  return path.join(rulesRoot(projectRoot), "INDEX.md");
}

// --- frontmatter (strict subset, no YAML dependency) ----------------------
//
// Supported shape, two-space indentation, string scalars and string lists:
//   key: value
//   key:
//     - item
//   key:
//     subkey: value
//     subkey:
//       - item

function parseFrontmatter(text, sourceLabel) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`${sourceLabel}: missing frontmatter (--- block) at the top`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${sourceLabel}: unterminated frontmatter block`);
  const body = lines.slice(end + 1).join("\n").trim();
  const data = {};
  // Stack of [indent, container] so nested maps and lists attach correctly.
  const stack = [[-1, data]];
  let lastKeyHolder = null;
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1][0]) stack.pop();
    const container = stack[stack.length - 1][1];
    if (line.startsWith("- ")) {
      if (!lastKeyHolder) throw new Error(`${sourceLabel}: list item without a key near line ${index + 1}`);
      const { holder, key } = lastKeyHolder;
      if (!Array.isArray(holder[key])) {
        if (holder[key] && typeof holder[key] === "object" && Object.keys(holder[key]).length) {
          throw new Error(`${sourceLabel}: key '${key}' mixes map and list entries`);
        }
        holder[key] = [];
      }
      holder[key].push(stripScalar(line.slice(2)));
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) throw new Error(`${sourceLabel}: unparsable frontmatter line ${index + 1}: ${line}`);
    const [, key, rest] = match;
    if (Array.isArray(container)) throw new Error(`${sourceLabel}: map entry inside a list near line ${index + 1}`);
    if (rest) {
      container[key] = stripScalar(rest);
      lastKeyHolder = null;
    } else {
      container[key] = {};
      stack.push([indent, container[key]]);
      lastKeyHolder = { holder: container, key };
    }
  }
  return { data, body };
}

function stripScalar(value) {
  const trimmed = String(value).trim();
  const quoted = trimmed.match(/^"(.*)"$|^'(.*)'$/);
  return quoted ? (quoted[1] !== undefined ? quoted[1] : quoted[2]) : trimmed;
}

// --- glob matching ---------------------------------------------------------

function globToRegExp(glob) {
  const normalized = normalizeRelPath(glob);
  let out = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        // `**` spans directories; `**/` also matches zero segments.
        out += normalized[index + 2] === "/" ? "(?:.*/)?" : ".*";
        index += normalized[index + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`${out}$`);
}

function globMatches(glob, relPath) {
  const rel = normalizeRelPath(relPath);
  if (globToRegExp(glob).test(rel)) return true;
  // A directory-ish glob like `skills/*/scripts/**` should also match the
  // scope `skills/x/scripts` itself.
  const withoutSuffix = normalizeRelPath(glob).replace(/\/\*\*$/, "");
  return withoutSuffix !== normalizeRelPath(glob) && globToRegExp(withoutSuffix).test(rel);
}

// Literal prefix of a glob before its first wildcard, used for the
// conservative best-effort match against execution write scopes.
function globLiteralPrefix(glob) {
  const normalized = normalizeRelPath(glob);
  const wildcard = normalized.search(/[*?]/);
  const literal = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  return literal.replace(/\/[^/]*$/, match => (match.includes("*") || match.includes("?") ? "" : match)) || literal;
}

function prefixOverlaps(globPrefix, scope) {
  const left = normalizeRelPath(globPrefix);
  const right = normalizeRelPath(scope);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

// --- invariant loading and validation --------------------------------------

function validateInvariant(data, body, sourceLabel) {
  const problems = [];
  if (!data.id || !ID_PATTERN.test(String(data.id))) {
    problems.push(`id must match ${ID_PATTERN} (got '${data.id || ""}')`);
  }
  if (data.kind && data.kind !== "invariant") problems.push(`kind must be 'invariant' (got '${data.kind}')`);
  const status = data.status || "active";
  if (!["active", "retired"].includes(status)) problems.push(`status must be active or retired (got '${status}')`);
  const evidence = Array.isArray(data.evidence) ? data.evidence.filter(Boolean) : [];
  if (evidence.length === 0) problems.push("evidence is required: cite at least one run, deviation, or incident reference");
  const triggerPaths = data.trigger && Array.isArray(data.trigger.paths) ? data.trigger.paths.filter(Boolean) : [];
  if (triggerPaths.length === 0) problems.push("trigger.paths is required: list at least one path glob that arms this rule");
  const check = data.check && typeof data.check === "object" ? data.check : {};
  if (!CHECK_TYPES.includes(check.type)) {
    problems.push(`check.type must be one of ${CHECK_TYPES.join(", ")}`);
  } else if (check.type === "command" && !check.run) {
    problems.push("check.run is required for check.type command");
  } else if (check.type === "grep" && (!check.pattern || !check.files)) {
    problems.push("check.pattern and check.files are required for check.type grep");
  } else if (check.type === "manual" && !check.confirm) {
    problems.push("check.confirm is required for check.type manual: state exactly what a human must confirm");
  }
  if (!body) problems.push("body is required: one short paragraph stating the rule");
  if (problems.length) {
    throw new Error(`${sourceLabel}: not a valid invariant:\n- ${problems.join("\n- ")}`);
  }
  return {
    id: String(data.id),
    kind: "invariant",
    status,
    created: data.created || null,
    evidence,
    trigger: { paths: triggerPaths.map(normalizeRelPath) },
    check: {
      type: check.type,
      run: check.run || null,
      pattern: check.pattern || null,
      files: check.files || null,
      expect: check.expect || (check.type === "grep" ? "present" : null),
      confirm: check.confirm || null,
    },
    summary: body.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim(),
    body,
  };
}

function loadInvariants(projectRoot) {
  const dir = invariantsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8"), path.join(RULES_ROOT_REL, "invariants", entry));
    out.push({ ...validateInvariant(data, body, entry), file: path.join(RULES_ROOT_REL, "invariants", entry) });
  }
  return out;
}

function loadPending(projectRoot) {
  const dir = pendingDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, entry), "utf8"), entry);
    out.push({
      id: data.id || entry.replace(/\.md$/, ""),
      kind: data.kind || "regression",
      summary: body.split(/\n/)[0] || "",
      file: path.join(RULES_ROOT_REL, "pending", entry),
    });
  }
  return out;
}

// --- ledger (INDEX.md) ------------------------------------------------------

const INDEX_HEADER = [
  "# Rules Ledger",
  "",
  "One row per learned rule. Bodies live at the landing path; this file is",
  "metadata plus the evidence trail. Maintained by `rules add`; do not edit by hand.",
  "",
  "| ID | Kind | Status | Landing | Evidence | Summary |",
  "| --- | --- | --- | --- | --- | --- |",
];

function readLedger(projectRoot) {
  const file = indexPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const cells = line.split("|").map(cell => cell.trim());
    // | ID | Kind | Status | Landing | Evidence | Summary | -> 8 cells with edges.
    if (cells.length < 8 || cells[1] === "ID" || cells[1].startsWith("---")) continue;
    rows.push({
      id: cells[1],
      kind: cells[2],
      status: cells[3],
      landing: cells[4].replace(/^`|`$/g, ""),
      evidence: cells[5],
      summary: cells[6],
    });
  }
  return rows;
}

function writeLedger(projectRoot, rows) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const lines = sorted.map(row =>
    `| ${row.id} | ${row.kind} | ${row.status} | \`${row.landing}\` | ${row.evidence} | ${row.summary} |`);
  ensureDir(rulesRoot(projectRoot));
  fs.writeFileSync(indexPath(projectRoot), `${[...INDEX_HEADER, ...lines].join("\n")}\n`);
}

function upsertLedgerRow(projectRoot, row) {
  const rows = readLedger(projectRoot).filter(existing => existing.id !== row.id);
  rows.push(row);
  writeLedger(projectRoot, rows);
}

function findDuplicate(projectRoot, id, summary) {
  const rows = readLedger(projectRoot);
  const byId = rows.find(row => row.id === id);
  if (byId) return { reason: "id", row: byId };
  const normalized = String(summary || "").replace(/\s+/g, " ").trim().toLowerCase();
  const bySummary = normalized && rows.find(row => row.summary.replace(/\s+/g, " ").trim().toLowerCase() === normalized);
  if (bySummary) return { reason: "summary", row: bySummary };
  return null;
}

// --- changed files and check execution --------------------------------------

function changedFiles(projectRoot, options = {}) {
  if (options.files) {
    return String(options.files).split(",").map(normalizeRelPath).filter(Boolean);
  }
  const args = options.base
    ? ["diff", "--name-only", String(options.base)]
    : ["diff", "--name-only", "HEAD"];
  const diff = runCommand("git", args, { cwd: projectRoot }).stdout.split("\n");
  const untracked = runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectRoot }).stdout.split("\n");
  return Array.from(new Set([...diff, ...untracked].map(normalizeRelPath).filter(Boolean)));
}

function matchInvariants(invariants, files) {
  return invariants
    .filter(rule => rule.status === "active")
    .map(rule => ({
      rule,
      matchedFiles: files.filter(file => rule.trigger.paths.some(glob => globMatches(glob, file))),
    }))
    .filter(entry => entry.matchedFiles.length > 0);
}

function runCheck(projectRoot, rule) {
  const check = rule.check;
  if (check.type === "manual") {
    return { status: "manual", detail: check.confirm };
  }
  if (check.type === "command") {
    try {
      const result = runCommand("bash", ["-lc", check.run], { cwd: projectRoot });
      return { status: "pass", detail: tail(result.stdout) };
    } catch (error) {
      return { status: "fail", detail: tail(error.message) };
    }
  }
  // grep: pattern must be present (default) or absent in files matching the glob.
  const matches = [];
  for (const file of listTrackedAndUntracked(projectRoot)) {
    if (!globMatches(check.files, file)) continue;
    const abs = path.join(projectRoot, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (new RegExp(check.pattern).test(fs.readFileSync(abs, "utf8"))) matches.push(file);
  }
  const expectPresent = check.expect !== "absent";
  const ok = expectPresent ? matches.length > 0 : matches.length === 0;
  return {
    status: ok ? "pass" : "fail",
    detail: expectPresent
      ? (ok ? `pattern found in: ${matches.join(", ")}` : `pattern '${check.pattern}' not found in files matching ${check.files}`)
      : (ok ? "pattern absent as required" : `pattern '${check.pattern}' must be absent but appears in: ${matches.join(", ")}`),
  };
}

function listTrackedAndUntracked(projectRoot) {
  const tracked = runCommand("git", ["ls-files"], { cwd: projectRoot }).stdout.split("\n");
  const untracked = runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectRoot }).stdout.split("\n");
  return Array.from(new Set([...tracked, ...untracked].map(normalizeRelPath).filter(Boolean)));
}

function tail(text, lines = 6) {
  const parts = String(text || "").trim().split("\n");
  return parts.slice(-lines).join("\n");
}

function checkRules(projectRoot, options = {}) {
  const allInvariants = loadInvariants(projectRoot);
  const requestedId = String(options.id || "").trim();
  const invariants = requestedId
    ? allInvariants.filter(rule => rule.id === requestedId)
    : allInvariants;
  if (requestedId && invariants.length === 0) {
    throw new Error(`Invariant ${requestedId} not found`);
  }
  const files = options.all ? null : changedFiles(projectRoot, options);
  const matched = options.all
    ? invariants.filter(rule => rule.status === "active").map(rule => ({ rule, matchedFiles: ["(all)"] }))
    : matchInvariants(invariants, files);
  const results = matched.map(({ rule, matchedFiles }) => ({
    id: rule.id,
    summary: rule.summary,
    file: rule.file,
    checkType: rule.check.type,
    matchedFiles,
    ...runCheck(projectRoot, rule),
  }));
  const pending = loadPending(projectRoot);
  return {
    ok: results.every(result => result.status !== "fail"),
    changedFileCount: files ? files.length : null,
    ruleCount: allInvariants.length,
    results,
    manualConfirmations: results.filter(result => result.status === "manual"),
    failures: results.filter(result => result.status === "fail"),
    pending: { count: pending.length, items: pending },
  };
}

function relevantRules(projectRoot, options = {}) {
  const invariants = loadInvariants(projectRoot);
  const ledger = readLedger(projectRoot);
  const paths = options.paths ? String(options.paths).split(",").map(normalizeRelPath).filter(Boolean) : [];
  const query = options.query ? String(options.query).toLowerCase().split(/\s+/).filter(Boolean) : [];
  const invariantHits = invariants.filter(rule => {
    if (rule.status !== "active") return false;
    const pathHit = paths.length > 0 && paths.some(candidate =>
      rule.trigger.paths.some(glob => globMatches(glob, candidate) || prefixOverlaps(globLiteralPrefix(glob), candidate)));
    const text = `${rule.id} ${rule.summary} ${rule.body}`.toLowerCase();
    const queryHit = query.length > 0 && query.every(term => text.includes(term));
    return paths.length === 0 && query.length === 0 ? true : pathHit || queryHit;
  });
  const ledgerHits = ledger.filter(row => {
    if (row.kind === "invariant") return false;
    if (query.length === 0) return paths.length === 0;
    const text = `${row.id} ${row.summary} ${row.landing}`.toLowerCase();
    return query.every(term => text.includes(term));
  });
  return { invariants: invariantHits, others: ledgerHits };
}

// Best-effort plan-time injection: an invariant applies to a run when any
// execution write scope prefix-overlaps a trigger glob. Exact enforcement
// stays with the changed-file check at deliver time.
function invariantsForWriteScopes(projectRoot, writeScopes) {
  const scopes = (writeScopes || []).map(normalizeRelPath).filter(Boolean);
  if (scopes.length === 0) return [];
  return loadInvariants(projectRoot)
    .filter(rule => rule.status === "active")
    .filter(rule => rule.trigger.paths.some(glob =>
      scopes.some(scope => globMatches(glob, scope) || prefixOverlaps(globLiteralPrefix(glob), scope))));
}

module.exports = {
  RULE_KINDS,
  rulesRoot,
  invariantsDir,
  pendingDir,
  indexPath,
  parseFrontmatter,
  globMatches,
  globLiteralPrefix,
  prefixOverlaps,
  validateInvariant,
  loadInvariants,
  loadPending,
  readLedger,
  writeLedger,
  upsertLedgerRow,
  findDuplicate,
  changedFiles,
  matchInvariants,
  checkRules,
  relevantRules,
  invariantsForWriteScopes,
  nowIso,
};
