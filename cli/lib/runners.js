"use strict";

// Single source of truth for command runners the repository-aware verification
// planner recognizes when it discovers an existing executable check.
//
// Two consumers must agree on this list or PRDs drift back into repeated
// `verification_command` deviations: `commandFromText` (below, in inference.js)
// extracts the command the harness can bind. Keeping the list here avoids
// duplicating runner syntax across inference paths.
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
