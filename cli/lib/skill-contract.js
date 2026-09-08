"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKILL_NAMES = Object.freeze([
  "interview-me",
  "gen-prd",
  "implement",
  "benchmark-implement",
  "ship",
  "sasu-setup",
  "please",
  "remember",
  "quick",
  "challenge",
]);

const invocationPattern = new RegExp(
  `\\$(${SKILL_NAMES.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "g",
);

function substituteForClaude(text) {
  const roots = text.split("~/.codex/skills/").join("~/.claude/skills/");
  return roots.replace(invocationPattern, "/$1");
}

function assertRuntime(runtime) {
  if (runtime !== "codex" && runtime !== "claude") {
    throw new Error(`Unsupported skill runtime: ${runtime}`);
  }
}

function runtimeIncludesEntry(runtime, entryName) {
  assertRuntime(runtime);
  return runtime !== "claude" || entryName !== "agents";
}

function collectContractFiles(absolute, relative, files, ancestors) {
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    files.push(relative);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Unsupported skill contract entry: ${absolute}`);
  }
  const real = fs.realpathSync(absolute);
  if (ancestors.has(real)) {
    throw new Error(`Cyclic skill contract directory: ${absolute}`);
  }
  const nextAncestors = new Set(ancestors).add(real);
  for (const entry of fs.readdirSync(absolute).sort()) {
    collectContractFiles(
      path.join(absolute, entry),
      `${relative}/${entry}`,
      files,
      nextAncestors,
    );
  }
}

/** Enumerates every effective file below a skill directory, including files
 * reached through symlinked auxiliary directories. */
function treeFiles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Missing skill directory: ${root}`);
  }
  const files = [];
  for (const entry of fs.readdirSync(root).sort()) {
    collectContractFiles(path.join(root, entry), entry, files, new Set());
  }
  return files;
}

/**
 * Enumerates the complete effective file contract installed for one runtime.
 * Auxiliary directories are symlinked by the installer, but their executable
 * files still affect runtime behavior and therefore belong in freshness checks.
 */
function contractFiles(skillsRoot, name, runtime) {
  assertRuntime(runtime);
  const sourceDir = path.join(skillsRoot, name);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Missing skill source: ${sourceDir}`);
  }
  const files = treeFiles(sourceDir).filter((relative) =>
    runtimeIncludesEntry(runtime, relative.split("/", 1)[0]),
  );
  if (!files.includes("SKILL.md")) throw new Error(`Missing ${path.join(sourceDir, "SKILL.md")}`);
  return files;
}

function transformContractFile(runtime, relative, text, options = {}) {
  assertRuntime(runtime);
  const substituted = relative === "SKILL.md"
    || (relative.startsWith("references/") && relative.endsWith(".md"));
  const transformed = runtime === "claude" && substituted ? substituteForClaude(text) : text;
  if (!substituted || !options.skillsRoot) return transformed;
  // Bind only this package's siblings: a staged candidate must use its own
  // scripts, while external tools such as Herdr stay at their installed paths.
  const skillsRoot = path.resolve(options.skillsRoot);
  return SKILL_NAMES.reduce((content, name) => content
    .split(`~/.${runtime}/skills/${name}/`)
    .join(`${skillsRoot}/${name}/`), transformed);
}

module.exports = { SKILL_NAMES, contractFiles, runtimeIncludesEntry, transformContractFile, treeFiles };
