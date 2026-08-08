"use strict";

const fs = require("fs");
const path = require("path");

const { toProjectRelative, readJson, uniqueMatches } = require("./util");
const { modeMatches } = require("./prd_parser");
const { RUNNER_PATTERN } = require("./runners");

function repoSignals(projectRoot) {
  const rootPackagePath = path.join(projectRoot, "package.json");
  const appPackagePath = path.join(projectRoot, "app", "package.json");
  const packagePath = fs.existsSync(rootPackagePath)
    ? rootPackagePath
    : fs.existsSync(appPackagePath)
      ? appPackagePath
      : rootPackagePath;
  const packageRoot = path.dirname(packagePath);
  const packageJson = fs.existsSync(packagePath) ? readJson(packagePath) : null;
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  const composeFiles = [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "app/docker-compose.yml",
    "app/docker-compose.yaml",
    "app/compose.yml",
    "app/compose.yaml",
  ].filter(file => fs.existsSync(path.join(projectRoot, file)));
  const packageManager = fs.existsSync(path.join(packageRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(packageRoot, "yarn.lock"))
      ? "yarn"
      : fs.existsSync(path.join(packageRoot, "bun.lockb")) || fs.existsSync(path.join(packageRoot, "bun.lock"))
        ? "bun"
        : fs.existsSync(path.join(packageRoot, "package-lock.json"))
          ? "npm"
          : packageJson ? "npm" : null;
  return {
    packageRoot: toProjectRelative(packageRoot, projectRoot),
    packageManager,
    packageScripts: Object.keys(scripts).sort(),
    dockerComposeFiles: composeFiles,
    hasAppRouter: fs.existsSync(path.join(projectRoot, "app")),
    hasPagesRouter: fs.existsSync(path.join(projectRoot, "pages")),
    hasSupabase: fs.existsSync(path.join(projectRoot, "supabase")),
    hasPlaywrightConfig: [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
      "app/playwright.config.ts",
      "app/playwright.config.js",
      "app/playwright.config.mjs",
    ].some(file => fs.existsSync(path.join(projectRoot, file))),
  };
}

function classifyVerification(verification, mode = null) {
  const text = `${mode && mode.mode ? mode.mode : ""} ${verification.level} ${verification.text}`.toLowerCase();
  const command = commandFromText(verification.text);
  if (command && hasCommandLogArtifact(verification)) {
    if (modeMatches(mode, [/automated/, /behavior/, /test/])) return "automated";
    return "command";
  }
  if (modeMatches(mode, [/build/, /static/])) return "command";
  if (modeMatches(mode, [/automated/, /behavior/, /test/])) return "automated";
  if (modeMatches(mode, [/browser/, /runtime/])) return "browser";
  if (modeMatches(mode, [/^db$/, /database/, /sql/])) return "db";
  if (modeMatches(mode, [/api/, /external/, /live/])) return "api";
  if (command && /level\s*2|test|spec|e2e|integration|unit|regression/.test(text)) return "automated";
  if (command && !/(chromux|browser|screenshot|viewport|click|dom|console|network)/.test(text)) return "command";
  if (/(chromux|browser|screenshot|viewport|click|dom|console|network|page|route|url)/.test(text)) return "browser";
  if (/\b(docker|compose|service|server|healthcheck|localhost|port)\b/.test(text)) return "server";
  if (/(db|database|postgres|supabase|sql|query|row|migration|rls)/.test(text)) return "db";
  if (/(api|endpoint|request|response|status code|webhook)/.test(text)) return "api";
  if (/level\s*2|test|spec|e2e|integration|unit|regression/.test(text)) return "automated";
  if (command) return "command";
  return "manual-agent";
}

function hasCommandLogArtifact(verification) {
  const artifact = verification && verification.matrix && verification.matrix.artifact
    ? verification.matrix.artifact
    : "";
  return /\bcommand-log\b/i.test(`${artifact} ${verification && verification.text ? verification.text : ""}`);
}

function commandFromText(text) {
  const runnerCommands = `(?:${RUNNER_PATTERN})`;
  const envAssignment = "(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S+)\\s+)*";
  const commandPrefix = new RegExp(`^${envAssignment}${runnerCommands}\\b`, "i");
  for (const backtick of String(text).matchAll(/`([^`]+)`/g)) {
    const candidate = backtick[1].trim();
    if (commandPrefix.test(candidate)) return candidate;
  }
  const command = String(text).match(new RegExp(`\\b(${envAssignment}${runnerCommands}\\s+[^\\n.;]+)`, "i"));
  return command ? command[1].trim() : null;
}

function commandForMode(mode, category, signals) {
  if (!mode) return null;
  const modeText = `${mode.mode || ""} ${mode.normalizedMode || ""}`.toLowerCase();
  if (category === "command" || /build|static|repo health/.test(modeText)) {
    return bestPackageScriptCommand(signals, ["verify", "check", "build", "typecheck", "type-check", "lint", "test"]);
  }
  if (category === "automated" || /automated|behavior|test|regression/.test(modeText)) {
    return bestPackageScriptCommand(signals, ["test", "test:unit", "test:integration", "test:e2e", "e2e"]);
  }
  return null;
}

function bestPackageScriptCommand(signals, candidates) {
  const scripts = new Set(signals.packageScripts || []);
  const script = candidates.find(candidate => scripts.has(candidate));
  if (!script || !signals.packageManager) return null;
  return scriptCommand(signals.packageManager, script);
}

function scriptCommand(packageManager, script) {
  if (packageManager === "npm") {
    if (script === "test") return "npm test";
    return `npm run ${script}`;
  }
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} ${script}`;
}

function shellLikeTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function unwrapShellCommandTokens(tokens) {
  if (tokens.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-c") {
    return shellLikeTokens(tokens.slice(2).join(" "));
  }
  if (tokens.length >= 4 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-l" && tokens[2] === "-c") {
    return shellLikeTokens(tokens.slice(3).join(" "));
  }
  if (tokens.length >= 3 && /^(?:bash|sh|zsh)$/.test(path.basename(tokens[0])) && tokens[1] === "-lc") {
    return shellLikeTokens(tokens.slice(2).join(" "));
  }
  return tokens;
}

function normalizeCommandForCompare(command) {
  return unwrapShellCommandTokens(shellLikeTokens(command)).join(" ").trim();
}

function commandsMatchContract(actual, expected) {
  if (!expected) return true;
  return normalizeCommandForCompare(actual) === normalizeCommandForCompare(expected);
}

function coverageFromText(text) {
  return {
    requirements: expandCoverageIds(text, "R"),
    acceptanceCriteria: expandCoverageIds(text, "AC"),
    tasks: expandCoverageIds(text, "T"),
  };
}

function expandCoverageIds(text, prefix) {
  const source = String(text || "");
  const ids = uniqueMatches(source, new RegExp(`\\b${prefix}\\d+\\b`, "gi"));
  const seen = new Set(ids);
  const ranges = new RegExp(`\\b${prefix}(\\d+)\\s*-\\s*(?:${prefix})?(\\d+)\\b`, "gi");
  for (const match of source.matchAll(ranges)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start <= 0 || end <= 0 || Math.abs(end - start) > 100) continue;
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      seen.add(`${prefix}${value}`);
    }
  }
  return Array.from(seen).sort((left, right) => {
    const a = Number(left.replace(/^\D+/, ""));
    const b = Number(right.replace(/^\D+/, ""));
    return a - b || left.localeCompare(right);
  });
}

function artifactsForVerification(verification, category, mode = null) {
  const text = `${verification.level} ${verification.text}`.toLowerCase();
  const artifacts = new Set();
  if (category === "command" || category === "automated") artifacts.add("command-log");
  if (category === "browser") {
    artifacts.add("screenshot");
    artifacts.add("console-log");
  }
  if (category === "server") artifacts.add("server-log");
  if (category === "api") artifacts.add("api-log");
  if (category === "db") artifacts.add("db-log");
  if (/screenshot/.test(text)) artifacts.add("screenshot");
  if (/console/.test(text)) artifacts.add("console-log");
  if (/network/.test(text)) artifacts.add("network-log");
  if (/dom/.test(text)) artifacts.add("dom-log");
  if (/(^|[^A-Za-z-])log\b/.test(text) && !Array.from(artifacts).some(kind => kind.endsWith("-log"))) artifacts.add("log");
  if (modeMatches(mode, [/build/, /static/, /automated/, /behavior/, /test/])) artifacts.add("command-log");
  if (modeMatches(mode, [/browser/, /runtime/])) {
    artifacts.add("screenshot");
    artifacts.add("console-log");
  }
  if (modeMatches(mode, [/api/, /external/, /live/])) artifacts.add("api-log");
  if (modeMatches(mode, [/^db$/, /database/, /sql/])) artifacts.add("db-log");
  if (artifacts.size === 0) artifacts.add("log");
  return Array.from(artifacts);
}

function passCriteriaFromText(text, category) {
  const explicit = String(text).match(/(?:pass criteria|pass|then|expected):\s*([^.;\n]+)/i);
  if (explicit) return explicit[1].trim();
  if (category === "command" || category === "automated") return "command exits 0 and log artifact is recorded";
  if (category === "browser") return "target user-visible state is proven by screenshot/DOM evidence and console has no new errors";
  if (category === "server") return "service starts or healthcheck/API call succeeds with log artifact";
  if (category === "api") return "API response status/body matches expected contract and response log is recorded";
  if (category === "db") return "query/migration result matches expected row/schema state and DB log is recorded";
  return "agent-verifiable evidence artifact proves the check";
}

function toolForVerification(category, signals) {
  if (category === "browser") return "chromux";
  if (category === "server" && signals.dockerComposeFiles.length) return "docker-compose";
  if (category === "db" && signals.hasSupabase) return "supabase/local-db";
  if (category === "command" || category === "automated") return "verify-run";
  return "record-artifact";
}

function targetForVerification(category, signals) {
  if (category === "browser") return signals.packageScripts.includes("dev") ? "local dev server route from PRD" : "browser target URL must be supplied";
  if (category === "server") return signals.dockerComposeFiles.length ? signals.dockerComposeFiles.join(", ") : "repo dev/service command";
  if (category === "db") return signals.hasSupabase ? "local/sandbox Supabase" : "non-production DB target if required";
  return null;
}

function plannedCheckStatus(details) {
  const { verification, category, command, covers, artifacts, mode } = details;
  if ((category === "command" || category === "automated") && !command) return "needs_command";
  if (!hasDeclaredArtifact(verification) && !artifactDerivableFromMode(mode, category, artifacts)) return "needs_artifact";
  if (!artifacts.length) return "needs_artifact";
  if (!covers.requirements.length && !covers.acceptanceCriteria.length && !covers.tasks.length) return "needs_coverage_mapping";
  return "planned";
}

function artifactDerivableFromMode(mode, category, artifacts) {
  if (!mode || !artifacts || artifacts.length === 0) return false;
  if (category === "command" || category === "automated" || category === "browser" || category === "api" || category === "db" || category === "server") return true;
  return false;
}

function hasDeclaredArtifact(verification) {
  if (verification.matrix) return Boolean(verification.matrix.artifact);
  return /\bartifacts?:\s*\S/i.test(verification.text);
}

function plannerNotes(details) {
  const notes = [];
  const { verification, category, command, covers, signals, mode } = details;
  if ((category === "command" || category === "automated") && !command) notes.push("No concrete command found; planner must bind this to an existing script or add an approved verifier.");
  if (!hasDeclaredArtifact(verification) && !artifactDerivableFromMode(mode, category, artifactsForVerification(verification, category, mode))) notes.push("No explicit Artifact field found; the PRD must declare the evidence file type to record.");
  if (mode && !hasDeclaredArtifact(verification)) notes.push(`Artifact kinds were derived from Test Mode Contract mode: ${mode.mode}.`);
  if (!covers.requirements.length && !covers.acceptanceCriteria.length && !covers.tasks.length) notes.push("No R/AC/T coverage IDs found in the PRD verification item.");
  if (category === "browser" && !signals.packageScripts.includes("dev")) notes.push("No package.json dev script detected; target URL/server startup must be supplied before runtime QA.");
  if (category === "server" && !signals.dockerComposeFiles.length) notes.push("No docker-compose file detected; use repo-local service command or ask for service startup instructions.");
  if (/human|manual/i.test(verification.text)) notes.push("Check text includes manual language; ensure the agent-verifiable part is explicit.");
  return notes;
}

function hasAppStartupSignal(signals) {
  const startupScripts = ["dev", "start", "serve", "preview", "dev:web", "start:dev", "web", "develop"];
  if ((signals.packageScripts || []).some(script => startupScripts.includes(script))) return true;
  if ((signals.dockerComposeFiles || []).length) return true;
  return false;
}

module.exports = {
  repoSignals,
  classifyVerification,
  hasCommandLogArtifact,
  commandFromText,
  commandForMode,
  bestPackageScriptCommand,
  scriptCommand,
  shellLikeTokens,
  unwrapShellCommandTokens,
  normalizeCommandForCompare,
  commandsMatchContract,
  coverageFromText,
  expandCoverageIds,
  artifactsForVerification,
  passCriteriaFromText,
  toolForVerification,
  targetForVerification,
  plannedCheckStatus,
  artifactDerivableFromMode,
  hasDeclaredArtifact,
  plannerNotes,
  hasAppStartupSignal,
};
