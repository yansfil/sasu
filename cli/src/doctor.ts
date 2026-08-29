import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { laneEffortFor, loadConfig, type JudgeTarget, type SasuConfig } from "./config";
import { resolveMechanicalCommands } from "./mechanical";
import { contractVersion } from "./version";
import { RUNTIME_IGNORE_ROOTS, ignoreState } from "./support/ensure-setup";
import { loadState } from "./implement/store";
import { IMPLEMENT_SCHEMA } from "./implement/types";
import { currentSessionId } from "./runs/session";

const skillContract: {
  SKILL_NAMES: readonly string[];
  contractFiles: (skillsRoot: string, name: string, runtime: "codex" | "claude") => string[];
  transformContractFile: (runtime: "codex" | "claude", relative: string, text: string) => string;
  treeFiles: (root: string) => string[];
} = require("../lib/skill-contract.js");

export interface DoctorSection {
  section: "judge" | "verify" | "namespace" | "runs" | "skills" | "contract";
  ok: boolean;
  lines: string[];
}

export interface DoctorOptions {
  home?: string;
  harnessRoot?: string;
}

function binaryVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? null;
}

export function runIntegritySection(projectRoot: string, sessionId: string | null = currentSessionId()): DoctorSection {
  const runsDir = path.join(projectRoot, "agents", "runs");
  const retire: string[] = [];
  const orphans: string[] = [];
  const incompatibleActive: string[] = [];
  const malformed: string[] = [];
  if (fs.existsSync(runsDir)) {
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const statePath = path.join(runsDir, entry.name, "state.json");
      if (!fs.existsSync(statePath)) continue;
      let raw: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
        raw = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
        // The operator report must agree with the command surface about what
        // constitutes a readable run. Reusing the implementation parser keeps
        // malformed states observable instead of maintaining a permissive
        // second parser that can silently drop an unknown status.
        const state = loadState(projectRoot, { state: path.relative(projectRoot, statePath) }).state;
        if (state.status === "active") {
          const owner = state.ownerSessionId ?? null;
          const adoption = owner !== null && owner !== sessionId
            ? " --adopt \"<verbatim user approval>\""
            : "";
          retire.push(
            `retire candidate: ${entry.name} owner=${owner ?? "unowned"} command=sasu implement retire --slug ${entry.name}${adoption}`,
          );
        }
        if ((state.status === "complete" || state.status === "blocked" || state.status === "retired")
          && state.worktree !== null && state.worktree !== undefined && fs.existsSync(state.worktree.path)) {
          orphans.push(
            `orphan worktree: ${entry.name} status=${state.status} path=${state.worktree.path} branch=${state.worktree.branch}`,
          );
        }
      } catch (error) {
        if (raw?.["status"] === "active" && raw["schema"] !== IMPLEMENT_SCHEMA) {
          incompatibleActive.push(
            `incompatible active run: ${entry.name} status=active schema=${String(raw["schema"] ?? "missing")} installed-schema=${IMPLEMENT_SCHEMA}; use a matching CLI to inspect or retire it, or start a new slug`,
          );
        } else {
          malformed.push(`malformed run state: ${entry.name} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }
  return {
    section: "runs",
    ok: orphans.length === 0 && incompatibleActive.length === 0 && malformed.length === 0,
    lines: [
      ...(retire.length === 0 ? ["retire candidates: none"] : retire),
      ...(orphans.length === 0 ? ["orphan worktrees: none"] : orphans),
      ...incompatibleActive,
      ...malformed,
    ],
  };
}

export function skillFreshnessSection(home: string, harnessRoot: string): DoctorSection {
  const skillsRoot = path.join(harnessRoot, "skills");
  const lines: string[] = [];
  const differences: string[] = [];
  for (const runtime of ["codex", "claude"] as const) {
    const installedRoot = path.join(home, `.${runtime}`, "skills");
    const installed = skillContract.SKILL_NAMES.some((name) => fs.existsSync(path.join(installedRoot, name)));
    if (!installed) {
      lines.push(`${runtime}: harness skills not installed`);
      continue;
    }
    for (const name of skillContract.SKILL_NAMES) {
      const expectedFiles = skillContract.contractFiles(skillsRoot, name, runtime);
      const expectedSet = new Set(expectedFiles);
      const installedSkillRoot = path.join(installedRoot, name);
      if (fs.existsSync(installedSkillRoot)) {
        for (const relative of skillContract.treeFiles(installedSkillRoot)) {
          if (!expectedSet.has(relative)) {
            differences.push(`unexpected installed contract: ${runtime}:${name}/${relative}`);
          }
        }
      }
      for (const relative of expectedFiles) {
        const source = path.join(skillsRoot, name, relative);
        const target = path.join(installedSkillRoot, relative);
        const label = `${runtime}:${name}/${relative}`;
        if (!fs.existsSync(target)) {
          differences.push(`missing installed contract: ${label}`);
          continue;
        }
        const targetLink = fs.lstatSync(target);
        if (relative === "SKILL.md" && targetLink.isSymbolicLink()) {
          differences.push(`invalid installed contract: ${label} (SKILL.md must be a real file, not a symbolic link)`);
          continue;
        }
        if (!fs.statSync(target).isFile()) {
          differences.push(`missing installed contract: ${label}`);
          continue;
        }
        const sourceText = fs.readFileSync(source, "utf8");
        const expected = skillContract.transformContractFile(runtime, relative, sourceText);
        if (fs.readFileSync(target, "utf8") !== expected) differences.push(`stale installed contract: ${label}`);
      }
    }
    if (!differences.some((entry) => entry.includes(`${runtime}:`))) lines.push(`${runtime}: installed contracts match repository`);
  }
  return { section: "skills", ok: differences.length === 0, lines: [...lines, ...differences] };
}

export function runDoctor(projectRoot: string, options: DoctorOptions = {}): { ok: boolean; sections: DoctorSection[] } {
  let config: SasuConfig | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig(projectRoot);
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const sections: DoctorSection[] = [];

  const claudeVersion = binaryVersion("claude");
  const codexVersion = binaryVersion("codex");
  const judgeLines: string[] = [
    claudeVersion ? `claude: ${claudeVersion}` : "claude: NOT FOUND on PATH",
    codexVersion ? `codex: ${codexVersion}` : "codex: NOT FOUND on PATH",
  ];
  if (config) {
    for (const name of ["routine", "high-risk"] as const) {
      const profile = config.judge.profiles[name];
      // An `api` target's origin is part of "which judge answers": the same
      // model id behind a proxy is a different route, and a doctor that hides
      // it cannot answer the question it exists to answer.
      const target = (t: JudgeTarget): string =>
        `${t.backend}/${t.model ?? "default"}/${t.effort}${t.backend === "api" ? `@${t.baseUrl ?? "api.anthropic.com"}` : ""}`;
      judgeLines.push(
        `${name}: primary=${target(profile.primary)} fallback=${profile.fallback === null ? "none" : target(profile.fallback)}`,
      );
    }
    // Per-gate, because they are per-gate: a single line saying "high" would
    // hide that verify runs at a different measured budget.
    const efforts = (["gap-audit", "spec", "verify"] as const)
      .map((gate) => `${gate}=${laneEffortFor(config, gate)}`)
      .join(" ");
    judgeLines.push(`lane effort: ${efforts}${config.judge.laneEffort === null ? "" : " (all pinned by judge.laneEffort)"}`);
    judgeLines.push(`retry budget: ${config.judge.retryBudget}`);
  }
  sections.push({
    section: "judge",
    ok: Boolean(claudeVersion || codexVersion),
    lines: judgeLines,
  });

  const verifyLines: string[] = [];
  let verifyOk = false;
  if (configError) {
    verifyLines.push(`agents/config.json error: ${configError}`);
  } else if (config) {
    const { resolved, configSuggestion } = resolveMechanicalCommands(projectRoot, config);
    if (resolved.length === 0) {
      verifyLines.push("no verify commands: none declared in agents/config.json and none detected from manifests");
    } else {
      verifyOk = true;
      for (const cmd of resolved) verifyLines.push(`${cmd.kind}: ${cmd.command} (${cmd.source})`);
      if (configSuggestion) {
        verifyLines.push(
          `suggestion: pin detected commands in agents/config.json under verify.commands: ${JSON.stringify(configSuggestion)}`,
        );
      }
    }
    verifyLines.push(config.configPath ? `config: ${config.configPath}` : "config: agents/config.json not present (defaults in effect)");
  }
  sections.push({ section: "verify", ok: verifyOk, lines: verifyLines });

  // Run state must never enter commits or PRs. The skill docs claimed "the
  // doctor enforces this" while no code checked it (a prose-only rule,
  // PRINCIPLES item 7); this makes the claim true. A probe under each runtime
  // root is what check-ignore is asked about, so both `agents/runs/` and
  // glob-style ignore rules match; outside a git checkout there is nothing
  // to enforce and the section reports that honestly.
  const namespaceLines: string[] = [];
  let namespaceOk = true;
  for (const root of RUNTIME_IGNORE_ROOTS) {
    const state = ignoreState(projectRoot, root);
    if (state === null) {
      namespaceLines.push(`${root} gitignore: not checkable (no git checkout)`);
    } else if (state) {
      namespaceLines.push(`${root} is gitignored`);
    } else {
      namespaceOk = false;
      namespaceLines.push(`${root} is NOT gitignored: run state would enter commits and PRs. Any sasu command auto-provisions .git/info/exclude; a committed .gitignore line is a project decision.`);
    }
  }
  sections.push({ section: "namespace", ok: namespaceOk, lines: namespaceLines });

  sections.push(runIntegritySection(projectRoot));

  const home = options.home ?? os.homedir();
  const harnessRoot = options.harnessRoot ?? path.resolve(__dirname, "../..");
  sections.push(skillFreshnessSection(home, harnessRoot));

  sections.push({
    section: "contract",
    ok: true,
    lines: [`sasu contract version: ${contractVersion()}`],
  });

  return { ok: sections.every((s) => s.ok || s.section === "verify"), sections };
}
