"use strict";

const fs = require("fs");
const path = require("path");

const { RULES_ROOT_REL, cwd, resolveProjectPath, toProjectRelative, ensureDir, nowIso, normalizeRelPath } = require("../util");
const {
  RULE_KINDS,
  invariantsDir,
  pendingDir,
  parseFrontmatter,
  validateInvariant,
  findDuplicate,
  upsertLedgerRow,
  checkRules,
  relevantRules,
} = require("../rules");

function cmdRules(args) {
  const [sub, ...rest] = args;
  const options = parseRuleArgs(rest);
  if (sub === "add") return cmdRulesAdd(options);
  if (sub === "check") return cmdRulesCheck(options);
  if (sub === "relevant") return cmdRulesRelevant(options);
  throw new Error("Usage: rules add|check|relevant ... (see usage)");
}

function parseRuleArgs(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function cmdRulesAdd(options) {
  const projectRoot = cwd();
  if (options.file) return addInvariant(projectRoot, options);
  const kind = String(options.kind || "").trim();
  if (!RULE_KINDS.includes(kind)) {
    throw new Error("rules add needs --file <invariant-draft.md> or --kind fact|regression with --id/--summary/--evidence");
  }
  if (kind === "invariant") throw new Error("invariants are added from a draft file: rules add --file <draft.md>");
  return addLedgerOnlyRule(projectRoot, kind, options);
}

function addInvariant(projectRoot, options) {
  const draftAbs = resolveProjectPath(String(options.file), projectRoot);
  if (!fs.existsSync(draftAbs)) throw new Error(`Draft not found: ${draftAbs}`);
  const text = fs.readFileSync(draftAbs, "utf8");
  const { data, body } = parseFrontmatter(text, toProjectRelative(draftAbs, projectRoot));
  const rule = validateInvariant(data, body, toProjectRelative(draftAbs, projectRoot));

  const duplicate = findDuplicate(projectRoot, rule.id, rule.summary);
  if (duplicate) {
    throw new Error([
      `Duplicate rule (${duplicate.reason} match): ${duplicate.row.id} already covers this.`,
      `Existing: ${duplicate.row.summary} (${duplicate.row.landing})`,
      "Update the existing rule instead of adding a twin.",
    ].join("\n"));
  }

  const targetRel = path.join(RULES_ROOT_REL, "invariants", `${rule.id}.md`);
  const targetAbs = path.join(projectRoot, targetRel);
  const created = targetAbs !== draftAbs;
  if (created) {
    ensureDir(invariantsDir(projectRoot));
    fs.copyFileSync(draftAbs, targetAbs);
  }
  try {
    upsertLedgerRow(projectRoot, {
      id: rule.id,
      kind: "invariant",
      status: rule.status,
      landing: targetRel,
      evidence: rule.evidence.join("; "),
      summary: rule.summary,
    });
  } catch (error) {
    // Keep file creation and ledger registration atomic.
    if (created) fs.rmSync(targetAbs, { force: true });
    throw error;
  }
  emit({ ok: true, action: "added", kind: "invariant", id: rule.id, landing: targetRel, check: rule.check.type, trigger: rule.trigger.paths });
}

function addLedgerOnlyRule(projectRoot, kind, options) {
  const id = String(options.id || "").trim();
  const summary = String(options.summary || "").replace(/\s+/g, " ").trim();
  const evidence = String(options.evidence || "").trim();
  if (!id || !summary) throw new Error(`rules add --kind ${kind} requires --id and --summary`);
  if (!evidence) throw new Error("evidence is required: cite the run, deviation, or incident this lesson comes from");

  const duplicate = findDuplicate(projectRoot, id, summary);
  if (duplicate) {
    throw new Error([
      `Duplicate rule (${duplicate.reason} match): ${duplicate.row.id} already covers this.`,
      `Existing: ${duplicate.row.summary} (${duplicate.row.landing})`,
      "Update the existing rule instead of adding a twin.",
    ].join("\n"));
  }

  const pending = options.pending === true;
  let landingRel;
  if (pending) {
    landingRel = path.join(RULES_ROOT_REL, "pending", `${id}.md`);
    ensureDir(pendingDir(projectRoot));
    fs.writeFileSync(path.join(projectRoot, landingRel), [
      "---",
      `id: ${id}`,
      `kind: ${kind}`,
      "status: pending",
      `created: ${nowIso()}`,
      "evidence:",
      `  - ${evidence}`,
      "---",
      summary,
      "",
    ].join("\n"));
  } else {
    if (!options.landing) {
      throw new Error(`rules add --kind ${kind} requires --landing <existing path> (where the lesson landed), or --pending for a not-yet-landed lesson`);
    }
    landingRel = normalizeRelPath(toProjectRelative(resolveProjectPath(String(options.landing), projectRoot), projectRoot));
    if (!fs.existsSync(path.join(projectRoot, landingRel))) {
      throw new Error(`Landing path does not exist: ${landingRel}. A ${kind} only counts as learned once it has landed (docs page or test); use --pending until then.`);
    }
  }
  upsertLedgerRow(projectRoot, {
    id,
    kind,
    status: pending ? "pending" : "active",
    landing: landingRel,
    evidence,
    summary,
  });
  emit({ ok: true, action: "added", kind, id, landing: landingRel, pending });
}

function cmdRulesCheck(options) {
  const projectRoot = cwd();
  const report = checkRules(projectRoot, {
    files: options.files,
    base: options.base,
    all: options.all === true,
  });
  emit(report);
  if (!report.ok) process.exitCode = 1;
}

function cmdRulesRelevant(options) {
  const projectRoot = cwd();
  const { invariants, others } = relevantRules(projectRoot, { paths: options.paths, query: options.query });
  emit({
    ok: true,
    invariants: invariants.map(rule => ({
      id: rule.id,
      summary: rule.summary,
      trigger: rule.trigger.paths,
      check: rule.check.type,
      file: rule.file,
    })),
    others,
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

module.exports = { cmdRules };
