"use strict";

const fs = require("fs");
const path = require("path");

const { NAMESPACE_ROOT, PRD_ROOT_REL, RUNS_ROOT_REL, QUICK_ROOT_REL, RULES_ROOT_REL, PROJECT_CONFIG_PATH, cwd, resolveProjectPath, harnessCommand } = require("../util");

const MARKER_START = "<!-- harness:agents-namespace:start -->";
const MARKER_END = "<!-- harness:agents-namespace:end -->";

// Seeds the target project's AGENTS.md with the harness namespace contract so
// any agent (with or without the harness installed) can discover the structure.
// Marker-based and idempotent: reruns update the block in place.
function cmdSeedAgentsMd(options) {
  const projectRoot = options["project-root"]
    ? resolveProjectPath(String(options["project-root"]), cwd())
    : cwd();
  const agentsMdPath = path.join(projectRoot, "AGENTS.md");
  const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
  const warnings = [];

  const claudeState = inspectClaudeMd(claudeMdPath);
  if (!fs.existsSync(agentsMdPath) && claudeState === "regular-file") {
    if (options["adopt-claude-md"] === true) {
      // Confirmed adoption path: the existing CLAUDE.md content becomes
      // AGENTS.md verbatim, then CLAUDE.md is replaced with a symlink.
      fs.renameSync(claudeMdPath, agentsMdPath);
    } else {
      throw new Error([
        "CLAUDE.md exists as a regular file but AGENTS.md does not.",
        "AGENTS.md is the main file and CLAUDE.md must be a symlink to it.",
        "Show the user the CLAUDE.md content, get their confirmation, then rerun with --adopt-claude-md to promote it to AGENTS.md and replace CLAUDE.md with a symlink.",
      ].join("\n"));
    }
  }

  const section = seedSection();
  let agentsAction;
  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(agentsMdPath, `# Agent Notes\n\n${section}\n`);
    agentsAction = "created";
  } else {
    const before = fs.readFileSync(agentsMdPath, "utf8");
    let after;
    if (before.includes(MARKER_START) && before.includes(MARKER_END)) {
      const pattern = new RegExp(`${escapeForRegExp(MARKER_START)}[\\s\\S]*?${escapeForRegExp(MARKER_END)}`);
      after = before.replace(pattern, section.trim());
    } else {
      after = `${before.replace(/\n+$/, "\n")}\n${section}\n`;
    }
    if (after === before) {
      agentsAction = "unchanged";
    } else {
      fs.writeFileSync(agentsMdPath, after);
      agentsAction = before.includes(MARKER_START) ? "updated" : "appended";
    }
  }

  const claudeAction = ensureClaudeSymlink(claudeMdPath, warnings);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectRoot,
    agentsMd: { path: "AGENTS.md", action: agentsAction },
    claudeMd: { path: "CLAUDE.md", action: claudeAction },
    warnings,
  }, null, 2)}\n`);
}

function inspectClaudeMd(claudeMdPath) {
  let stat;
  try {
    stat = fs.lstatSync(claudeMdPath);
  } catch {
    return "missing";
  }
  return stat.isSymbolicLink() ? "symlink" : "regular-file";
}

function ensureClaudeSymlink(claudeMdPath, warnings) {
  const state = inspectClaudeMd(claudeMdPath);
  if (state === "missing") {
    fs.symlinkSync("AGENTS.md", claudeMdPath);
    return "symlinked";
  }
  if (state === "symlink") {
    const target = fs.readlinkSync(claudeMdPath);
    if (path.basename(target) === "AGENTS.md") return "already-symlink";
    warnings.push(`CLAUDE.md is a symlink to '${target}', not AGENTS.md; left untouched. Point it at AGENTS.md to follow the convention.`);
    return "foreign-symlink";
  }
  warnings.push("CLAUDE.md and AGENTS.md both exist as regular files; merge CLAUDE.md into AGENTS.md with the user, then replace CLAUDE.md with a symlink.");
  return "regular-file-conflict";
}

function seedSection() {
  return `${MARKER_START}
## Harness Namespace (\`${NAMESPACE_ROOT}/\`)

This project uses the engineering-harness PRD pipeline. Agent-facing assets live in one visible namespace:

- \`${PRD_ROOT_REL}/\` - PRD contracts, committed and human-approved before implementation.
- \`${RULES_ROOT_REL}/\` - learned rules: \`INDEX.md\` is the ledger, \`invariants/\` hold machine-checked rules (trigger globs + executable check) that gate delivery, \`pending/\` holds lessons that have not landed yet.
- \`${RUNS_ROOT_REL}/\` - per-run state and evidence (gate verdicts + implement state under one \`${RUNS_ROOT_REL}/<slug>/\`), gitignored (policy: one line \`${RUNS_ROOT_REL}/\`), never hand-edited.
- \`${QUICK_ROOT_REL}/\` - quick lane state and evidence (generated contract, receipt, verify verdict, evidence blobs), gitignored (policy: one line \`${QUICK_ROOT_REL}/\`), never hand-edited.
- \`${PROJECT_CONFIG_PATH}\` - pipeline configuration, committed.

Conventions:

- AGENTS.md is the main agent context file; CLAUDE.md is always a symlink to it.
- Before planning work that touches files matched by a rule trigger, consult \`${harnessCommand()} rules relevant --paths <files>\` or read \`${RULES_ROOT_REL}/INDEX.md\`.
- Rules are added through \`rules add\` (never hand-edit the ledger); every rule cites evidence from a real run or incident.
${MARKER_END}`;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { cmdSeedAgentsMd };
