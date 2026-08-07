#!/usr/bin/env node
"use strict";

const { SELF_PATH, displayPath, parseArgs } = require("../../../cli/lib/util");
const { cmdHook } = require("../../../cli/lib/hooks");
const { cmdInit } = require("../../../cli/lib/commands/init");
const { cmdStatus, cmdVerifyDelivery, cmdDoctor, cmdNext, cmdReady, cmdRender, cmdCleanupActive } = require("../../../cli/lib/commands/inspect");
const { cmdPlanVerification, cmdPlanExecution } = require("../../../cli/lib/commands/plan");
const { cmdMark, cmdAssign, cmdRecordArtifact, cmdRefreshArtifacts, cmdVerifyRun } = require("../../../cli/lib/commands/mark");
const { cmdReviewPrompt, cmdRequirementsReviewPrompt, cmdRequirementsReviewRecord, cmdReviewRecord, cmdFinalize } = require("../../../cli/lib/commands/review");
const { cmdReconcile } = require("../../../cli/lib/commands/reconcile");
const { cmdPause, cmdReviewPolicy } = require("../../../cli/lib/commands/lifecycle");
const { cmdRules } = require("../../../cli/lib/commands/rules");
const { cmdSeedAgentsMd } = require("../../../cli/lib/commands/setup");

// Single source of truth for dispatch and usage. `usageArgs` is what the
// usage text prints after the command name; `run` receives the raw argv rest.
const COMMANDS = [
  {
    name: "init",
    usageArgs: ['--prd <path> [--session-id <session-id>] [--allow-unapproved-prd "<verbatim user approval>"] [--delivery local|pr] [--branch <branch>] [--review-profile trivial|standard|high-risk] [--skip-worktree] [--force]'],
    run: args => cmdInit(parseArgs(args)),
  },
  { name: "status", usageArgs: ["[--state <path>]"], run: args => cmdStatus(parseArgs(args)) },
  { name: "verify-delivery", usageArgs: ["[--state <path>]"], run: args => cmdVerifyDelivery(parseArgs(args)) },
  { name: "doctor", usageArgs: [""], run: () => cmdDoctor() },
  { name: "next", usageArgs: ["[--state <path>]"], run: args => cmdNext(parseArgs(args)) },
  {
    name: "plan-verification",
    usageArgs: [
      "[--state <path>]",
      "--prd <path>   (stateless PRD contract precheck; no init, no writes)",
    ],
    run: args => cmdPlanVerification(parseArgs(args)),
  },
  { name: "plan-execution", usageArgs: ["[--state <path>] [--task-plan <json-path>]"], run: args => cmdPlanExecution(parseArgs(args)) },
  { name: "ready", usageArgs: ["[--state <path>]"], run: args => cmdReady(parseArgs(args)) },
  {
    name: "render",
    usageArgs: ["[--state <path>]   (regenerate checklist/plan/verification views from state.json)"],
    run: args => cmdRender(parseArgs(args)),
  },
  {
    name: "reconcile",
    usageArgs: ['[--reason "<why the PRD changed>"] [--state <path>]  (refresh PRD snapshot after an edit; preserves marks, never init --force)'],
    run: args => cmdReconcile(parseArgs(args)),
  },
  {
    name: "assign",
    usageArgs: ["--id <Tn> --owner coordinator|subagent:<id>|<short-owner>"],
    run: args => cmdAssign(parseArgs(args)),
  },
  {
    name: "mark",
    usageArgs: ["--kind task|ac|verification --id <id[,id...]> --status <status> [--ac <ACn[,ACn...]>] --evidence <text>"],
    run: args => cmdMark(parseArgs(args)),
  },
  { name: "verify-run", usageArgs: ["--id <Vn> -- <command...>"], run: args => cmdVerifyRun(args) },
  {
    name: "record-artifact",
    usageArgs: ["--id <id> --kind screenshot|log|browser|api|db|file --path <path> --description <text>"],
    run: args => cmdRecordArtifact(parseArgs(args)),
  },
  { name: "refresh-artifacts", usageArgs: ["[--id <id>] [--state <path>]"], run: args => cmdRefreshArtifacts(parseArgs(args)) },
  { name: "requirements-review-prompt", usageArgs: ["[--state <path>]"], run: args => cmdRequirementsReviewPrompt(parseArgs(args)) },
  {
    name: "requirements-review-record",
    usageArgs: ["--status pass|fail --report <path> --summary <text>"],
    run: args => cmdRequirementsReviewRecord(parseArgs(args)),
  },
  { name: "review-prompt", usageArgs: ["[--state <path>]"], run: args => cmdReviewPrompt(parseArgs(args)) },
  {
    name: "review-record",
    usageArgs: ["--status pass|fail --report <path> --summary <text>"],
    run: args => cmdReviewRecord(parseArgs(args)),
  },
  {
    name: "finalize",
    usageArgs: ["--status complete|partial|blocked --summary <text>"],
    run: args => cmdFinalize(parseArgs(args)),
  },
  { name: "cleanup-active", usageArgs: ["[--state <path>]"], run: args => cmdCleanupActive(parseArgs(args)) },
  {
    name: "pause",
    usageArgs: ['--reason "<verbatim user redirect or wrap-up request>"', "--clear"],
    run: args => cmdPause(parseArgs(args)),
  },
  {
    name: "review-policy",
    usageArgs: ['--profile trivial|standard|high-risk --reason "<verbatim user instruction>"'],
    run: args => cmdReviewPolicy(parseArgs(args)),
  },
  {
    name: "rules",
    usageArgs: [
      "add --file <invariant-draft.md>",
      "add --kind fact|regression --id <ID> --summary <text> --evidence <ref> (--landing <path> | --pending)",
      "check [--id <ID>] [--files <csv>] [--base <git-ref>] [--all]",
      "relevant [--paths <csv>] [--query <text>]",
    ],
    run: args => cmdRules(args),
  },
  { name: "seed-agents-md", usageArgs: ["[--project-root <path>]"], run: args => cmdSeedAgentsMd(parseArgs(args)) },
  { name: "hook", usageArgs: ["stop|pretool-use"], run: args => cmdHook(args[0] || "stop") },
];

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    const entry = COMMANDS.find(item => item.name === command);
    if (!entry) return usage(1);
    return entry.run(args);
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function usage(exitCode) {
  const script = displayPath(SELF_PATH);
  const lines = COMMANDS.flatMap(entry =>
    entry.usageArgs.map(argsText => `  node ${script} ${entry.name}${argsText ? ` ${argsText}` : ""}`));
  process.stderr.write(`Usage:\n${lines.join("\n")}\n`);
  process.exit(exitCode);
}

main();
