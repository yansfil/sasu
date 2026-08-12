"use strict";

const fs = require("fs");
const path = require("path");

const { toProjectRelative, readJson } = require("./util");
const { modeMatches, coverageFromText, expandCoverageIds } = require("./prd_parser");
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

/**
 * The one quote/escape state machine behind shellLikeTokens and
 * unquotedShellMetachars. Emits every content character with the quoting
 * context it reaches the executor in ({ quote, escaped }); structural
 * characters - the escaping backslash and the quote delimiters themselves -
 * are consumed here and never emitted. Both consumers used to carry a private
 * copy of this machine synchronized by comment only (the drift class that
 * already bit matchesScopeGlob), so "unquoted to the tokenizer" and "unquoted
 * to the metachar predicate" are now the same fact by construction.
 */
function scanShellChars(command, onChar) {
  let quote = null;
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      escaped = false;
      onChar(char, { quote, escaped: true });
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else onChar(char, { quote, escaped: false });
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    onChar(char, { quote: null, escaped: false });
  }
  // A trailing backslash escapes nothing: surface it as a literal, matching
  // the tokenizer's historical behavior.
  if (escaped) onChar("\\", { quote, escaped: true });
}

function shellLikeTokens(command) {
  const tokens = [];
  let current = "";
  scanShellChars(command, (char, context) => {
    if (!context.quote && !context.escaped && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      return;
    }
    current += char;
  });
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

/**
 * True when the command is an explicit shell wrapper (`bash -c "..."` and the
 * sh/zsh/-l variants). Detected via unwrapShellCommandTokens - which returns
 * the SAME array when no wrapper shape matched - so the wrapper grammar lives
 * in exactly one place and this predicate can never drift from it.
 */
function isShellWrapperCommand(command) {
  const tokens = shellLikeTokens(command);
  return unwrapShellCommandTokens(tokens) !== tokens;
}

/**
 * Shell metacharacters that would be inert when this command runs through
 * shellLikeTokens + spawn(shell:false) - i.e. the ones the author probably
 * expected a shell to interpret. Only unquoted, unescaped occurrences count:
 * both executors tokenize with shellLikeTokens above and spawn WITHOUT a
 * shell, so a metacharacter inside a quoted token (`--grep "a|b"`) is a
 * literal argument by construction and flagging it is a false positive
 * (reproduced live, 2026-08-11). The quote state comes from the same
 * scanShellChars scanner the tokenizer consumes, so "unquoted" means
 * "unquoted to the executor" without a second state machine to keep in sync.
 */
function unquotedShellMetachars(command) {
  const found = [];
  scanShellChars(command, (char, context) => {
    if (context.quote || context.escaped) return;
    if ("|&;<>$`".includes(char) && !found.includes(char)) found.push(char);
  });
  return found;
}

function normalizeCommandForCompare(command) {
  return unwrapShellCommandTokens(shellLikeTokens(command)).join(" ").trim();
}

function commandsMatchContract(actual, expected) {
  if (!expected) return true;
  return normalizeCommandForCompare(actual) === normalizeCommandForCompare(expected);
}

function artifactsForVerification(verification, category, mode = null) {
  const artifacts = new Set();
  if (category === "command" || category === "automated") artifacts.add("command-log");
  if (category === "browser") {
    artifacts.add("screenshot");
    artifacts.add("browser");
  }
  if (category === "server") artifacts.add("log");
  if (category === "api") artifacts.add("api");
  if (category === "db") artifacts.add("db");
  if (modeMatches(mode, [/visual/, /judgment/, /\bui\b/])) artifacts.add("screenshot");
  if (modeMatches(mode, [/build/, /static/, /automated/, /behavior/, /test/])) artifacts.add("command-log");
  if (modeMatches(mode, [/browser/, /runtime/])) {
    artifacts.add("screenshot");
    artifacts.add("browser");
  }
  if (modeMatches(mode, [/api/, /external/, /live/])) artifacts.add("api");
  if (modeMatches(mode, [/^db$/, /database/, /sql/])) artifacts.add("db");
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
  const { category, command, covers, artifacts } = details;
  if (!covers.requirements.length && !covers.acceptanceCriteria.length && !covers.tasks.length) return "needs_coverage_mapping";
  if (!artifacts.length) return "needs_evidence_strategy";
  if ((category === "command" || category === "automated") && !command) return "needs_binding";
  return "planned";
}

function artifactDerivableFromMode(mode, category, artifacts) {
  if (!mode || !artifacts || artifacts.length === 0) return false;
  if (category === "command" || category === "automated" || category === "browser" || category === "api" || category === "db" || category === "server") return true;
  if (modeMatches(mode, [/visual/, /judgment/, /\bui\b/])) return true;
  return false;
}

function plannerNotes(details) {
  const notes = [];
  const { verification, category, command, covers, signals, mode } = details;
  if ((category === "command" || category === "automated") && !command) notes.push("No repository command is bound yet; the first verify-run binds the exact command and cwd after implementation creates the verifier.");
  if (mode) notes.push(`Evidence kinds were derived from Test Mode Contract mode: ${mode.mode}.`);
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
  isShellWrapperCommand,
  unquotedShellMetachars,
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
  plannerNotes,
  hasAppStartupSignal,
};
