"use strict";

// Single source of truth for the command runners the verification planner
// recognizes at the start of a PRD 9.2 Method command.
//
// Two consumers must agree on this list or PRDs drift back into repeated
// `verification_command` deviations: `commandFromText` (below, in inference.js)
// extracts the command the harness will actually run, and the pre-judge lint
// (cli/src/gates/prelint.ts) refuses a Method cell whose backticked command
// starts with anything else. A command the lint accepts must be a command the
// planner can parse, so the list lives here rather than in either consumer.
const RUNNER_COMMANDS = [
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "pytest",
  "python",
  "node",
  "tsx",
  "ts-node",
  "deno",
  "go",
  "cargo",
  "make",
  "docker",
  "docker-compose",
  "bash",
  "sh",
  "zsh",
  "test",
  "sed",
  "cat",
  "curl",
  "jq",
  "uv",
  "uvx",
  "php",
  "ruby",
  "perl",
  "mvn",
  "gradle",
];

// `docker-compose` must be tried before `docker` so the longer name is not
// truncated by the shorter alternative.
const RUNNER_PATTERN = RUNNER_COMMANDS.slice()
  .sort((a, b) => b.length - a.length)
  .join("|");

module.exports = { RUNNER_COMMANDS, RUNNER_PATTERN };
