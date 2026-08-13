import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import type { ContractItem, MechanicalBinding, ReviewProfile, TaskItem, VerificationItem } from "./types";

interface ParsedItem {
  id: string;
  text: string;
  title: string;
  requirements?: string[];
  acceptanceCriteria?: string[];
  matrix?: {
    mode?: string;
    covers?: string;
    passCriteria?: string;
    requiredForDone?: boolean;
    canBeBlocked?: boolean;
  };
}

interface ParserLibrary {
  stripFrontmatter(markdown: string): { frontmatter: Record<string, string>; body: string };
  extractFirstSection(markdown: string, headings: string[]): string;
  extractFirstNestedSection(markdown: string, headings: string[]): string;
  parseMarkdownItems(markdown: string, prefix: string, label: string): ParsedItem[];
  parseVerification(markdown: string): ParsedItem[];
  parseTestModeContract(markdown: string): unknown[];
  applyTestModeDefaults(items: ParsedItem[], modes: unknown[]): void;
  coverageFromText(text: string): { requirements: string[]; acceptanceCriteria: string[] };
  extractSection(markdown: string, heading: string): string;
  extractNestedSection(markdown: string, heading: string): string;
}

// The Markdown grammar remains shared with the document gates. This is parsing
// reuse, not persistence compatibility: implement state has its own v3 schema.
const parser = require("../../lib/prd_parser.js") as ParserLibrary;

export interface ImplementContract {
  frontmatter: Record<string, string>;
  body: string;
  tasks: TaskItem[];
  requirements: ContractItem[];
  acceptanceCriteria: ContractItem[];
  verification: VerificationItem[];
  decisionTraceability: string;
  scope: string;
  risks: string;
}

function item(input: ParsedItem): ContractItem {
  return {
    id: input.id,
    text: input.text,
    title: input.title,
    requirements: [...(input.requirements ?? [])],
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    status: "pending",
    evidence: [],
  };
}

function profile(value: string | undefined): ReviewProfile {
  if (value === "trivial" || value === "standard" || value === "high-risk") return value;
  return "standard";
}

// Task lines may carry `Depends on: T1, T3` or `Depends on: none`. Absence
// means "the previous task", so a PRD written without the clause keeps the
// sequential behavior it always had; only explicit declarations unlock
// out-of-chain (including parallel) execution.
const DEPENDS_ON = /\bdepends\s+on:\s*(none\b|T\d+(?:\s*,\s*T\d+)*)/i;

function taskItems(parsed: ParsedItem[]): TaskItem[] {
  return parsed.map((entry, index): TaskItem => {
    const clause = entry.text.match(DEPENDS_ON);
    const dependsOn = clause === null
      ? (index === 0 ? [] : [parsed[index - 1]!.id])
      : clause[1]!.toLowerCase() === "none"
        ? []
        : [...new Set(clause[1]!.split(",").map((id) => id.trim().toUpperCase()))];
    return { ...item(entry), dependsOn };
  });
}

function validateTaskDependencies(tasks: TaskItem[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) throw new Error(`task ${task.id} cannot depend on itself`);
      if (!ids.has(dep)) throw new Error(`task ${task.id} depends on unknown task ${dep}`);
    }
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (settled.has(id)) return;
    if (visiting.has(id)) throw new Error(`task dependency cycle: ${[...trail, id].join(" -> ")}`);
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep, [...trail, id]);
    visiting.delete(id);
    settled.add(id);
  };
  for (const task of tasks) visit(task.id, []);
}

export function parseImplementContract(markdown: string): ImplementContract {
  const parsed = parser.stripFrontmatter(markdown);
  const requirements = parser
    .parseMarkdownItems(parser.extractFirstSection(parsed.body, ["6. Requirements", "Requirements"]), "R", "R")
    .map(item);
  const acceptanceCriteria = parser
    .parseMarkdownItems(parser.extractFirstSection(parsed.body, ["7. Acceptance Criteria", "Acceptance Criteria"]), "AC", "AC")
    .map(item);
  const tasks = taskItems(
    parser.parseMarkdownItems(parser.extractFirstSection(parsed.body, ["8. PRD-Level Tasks", "PRD-Level Tasks"]), "T", "Task"),
  );
  validateTaskDependencies(tasks);
  const verificationSection = parser.extractFirstSection(parsed.body, ["9. Verification Contract", "Verification Contract"]);
  const rawVerification = parser.parseVerification(verificationSection);
  const testModes = parser.parseTestModeContract(
    parser.extractFirstNestedSection(verificationSection, ["9.1 Test Mode Contract", "Test Mode Contract"]) || verificationSection,
  );
  parser.applyTestModeDefaults(rawVerification, testModes);

  const acById = new Map(acceptanceCriteria.map((entry) => [entry.id, entry]));
  for (const requirement of requirements) {
    for (const acId of requirement.acceptanceCriteria) {
      const ac = acById.get(acId);
      if (ac !== undefined && !ac.requirements.includes(requirement.id)) ac.requirements.push(requirement.id);
    }
  }
  for (const task of tasks) {
    const mapped = new Set(task.acceptanceCriteria);
    for (const requirementId of task.requirements) {
      const requirement = requirements.find((entry) => entry.id === requirementId);
      for (const acId of requirement?.acceptanceCriteria ?? []) mapped.add(acId);
    }
    task.acceptanceCriteria = [...mapped];
  }

  const verification = rawVerification.map((entry): VerificationItem => {
    const covers = parser.coverageFromText(entry.matrix?.covers ?? entry.text);
    const mappedAcs = new Set(covers.acceptanceCriteria);
    for (const requirementId of covers.requirements) {
      const requirement = requirements.find((candidate) => candidate.id === requirementId);
      for (const acId of requirement?.acceptanceCriteria ?? []) mappedAcs.add(acId);
    }
    return {
      id: entry.id,
      text: entry.text,
      title: entry.title,
      mode: entry.matrix?.mode ?? "automated behavior",
      covers: [...new Set([...covers.requirements, ...mappedAcs])],
      requiredForDone: entry.matrix?.requiredForDone ?? true,
      canBeBlocked: entry.matrix?.canBeBlocked ?? false,
      passIntent: entry.matrix?.passCriteria ?? entry.title,
      status: "NOT_RUN",
      evidence: [],
    };
  });

  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    tasks,
    requirements,
    acceptanceCriteria,
    verification,
    decisionTraceability: parser.extractNestedSection(parsed.body, "4.3 Decision Traceability For Fidelity Review"),
    scope: parser.extractFirstSection(parsed.body, ["3. Scope And Non-Goals", "Scope And Non-Goals"]),
    risks: parser.extractFirstSection(parsed.body, ["10. Risks And Open Decisions", "Risks And Open Decisions"]),
  };
}

export function reviewProfile(contract: ImplementContract): ReviewProfile {
  return profile(contract.frontmatter["review_profile"]);
}

interface DetectedCommand {
  kind: "test" | "e2e" | "build" | "typecheck";
  command: string;
  cwd: string;
}

function packageCommands(projectRoot: string, relativeDir: string): DetectedCommand[] {
  const file = path.join(projectRoot, relativeDir, "package.json");
  if (!fs.existsSync(file)) return [];
  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(fs.readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const cwd = relativeDir || ".";
  const commands: DetectedCommand[] = [];
  if (scripts["test"] !== undefined) commands.push({ kind: "test", command: "npm test", cwd });
  if (scripts["test:e2e"] !== undefined) commands.push({ kind: "e2e", command: "npm run test:e2e", cwd });
  if (scripts["build"] !== undefined) commands.push({ kind: "build", command: "npm run build", cwd });
  if (scripts["typecheck"] !== undefined) commands.push({ kind: "typecheck", command: "npm run typecheck", cwd });
  return commands;
}

function detectedCommands(projectRoot: string): DetectedCommand[] {
  const commands = packageCommands(projectRoot, "");
  const cliPackage = path.join(projectRoot, "cli", "package.json");
  if (fs.existsSync(cliPackage)) commands.push(...packageCommands(projectRoot, "cli"));
  const rootTests = path.join(projectRoot, "tests");
  if (fs.existsSync(rootTests) && fs.readdirSync(rootTests).some((name) => name.endsWith(".test.mjs"))) {
    commands.unshift({ kind: "test", command: "node --test tests/*.test.mjs", cwd: "." });
  }
  return commands;
}

function configuredCommands(projectRoot: string): DetectedCommand[] {
  const commands = loadConfig(projectRoot).verify.commands;
  return (["test", "build", "typecheck"] as const)
    .filter((kind) => typeof commands[kind] === "string" && commands[kind]!.trim() !== "")
    .map((kind) => ({ kind, command: commands[kind]!, cwd: "." }));
}

function commandsForVerification(entry: VerificationItem, commands: DetectedCommand[]): DetectedCommand[] {
  const mode = entry.mode.toLowerCase();
  const intent = entry.passIntent.toLowerCase();
  if (mode.includes("live judge")) return [];
  if (mode.includes("local runtime") || mode.includes("e2e")) return commands.filter((command) => command.kind === "e2e");
  if (mode.includes("build") || mode.includes("static")) {
    const staticCommands = commands.filter((command) => command.kind === "build" || command.kind === "typecheck");
    if (intent.includes("skill") || intent.includes("harness")) {
      staticCommands.unshift(...commands.filter((command) => command.kind === "test" && command.cwd === "."));
    }
    return staticCommands;
  }
  if (mode.includes("automated") || mode.includes("test")) return commands.filter((command) => command.kind === "test");
  return [];
}

export function mechanicalBindings(projectRoot: string, verification: VerificationItem[]): MechanicalBinding[] {
  const byKey = new Map<string, MechanicalBinding>();
  // An explicit project config is the only reliable way to bind a nested
  // product's checks when the repository also contains harness checks.
  const commands = configuredCommands(projectRoot);
  const resolvedCommands = commands.length > 0 ? commands : detectedCommands(projectRoot);
  for (const item of verification) {
    for (const command of commandsForVerification(item, resolvedCommands)) {
      const key = `${command.cwd}\0${command.command}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { command: command.command, cwd: command.cwd, verificationIds: [item.id] });
      } else if (!existing.verificationIds.includes(item.id)) {
        existing.verificationIds.push(item.id);
      }
    }
  }
  return [...byKey.values()];
}
