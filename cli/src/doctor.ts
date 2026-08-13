import { spawnSync } from "node:child_process";
import { loadConfig, type SasuConfig } from "./config";
import { resolveMechanicalCommands } from "./mechanical";
import { contractVersion } from "./version";

export interface DoctorSection {
  section: "judge" | "verify" | "namespace" | "contract";
  ok: boolean;
  lines: string[];
}

function binaryVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? null;
}

export function runDoctor(projectRoot: string): { ok: boolean; sections: DoctorSection[] } {
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
      judgeLines.push(
        `${name}: primary=${profile.primary.backend}/${profile.primary.model ?? "default"}/${profile.primary.effort} fallback=${profile.fallback === null ? "none" : `${profile.fallback.backend}/${profile.fallback.model ?? "default"}/${profile.fallback.effort}`}`,
      );
    }
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
  // PRINCIPLES item 7); this makes the claim true. A probe under the runs
  // root is what check-ignore is asked about, so both `agents/runs/` and
  // glob-style ignore rules match; outside a git checkout there is nothing
  // to enforce and the section reports that honestly.
  const namespaceLines: string[] = [];
  let namespaceOk = true;
  const checkIgnore = spawnSync("git", ["check-ignore", "-q", "agents/runs/probe"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (checkIgnore.error !== undefined || checkIgnore.status === null || checkIgnore.status >= 2) {
    namespaceLines.push("agents/runs/ gitignore: not checkable (no git checkout)");
  } else if (checkIgnore.status === 0) {
    namespaceLines.push("agents/runs/ is gitignored");
  } else {
    namespaceOk = false;
    namespaceLines.push('agents/runs/ is NOT gitignored: run state would enter commits and PRs. Add the line "agents/runs/" to .gitignore');
  }
  sections.push({ section: "namespace", ok: namespaceOk, lines: namespaceLines });

  sections.push({
    section: "contract",
    ok: true,
    lines: [`sasu contract version: ${contractVersion()}`],
  });

  return { ok: sections.every((s) => s.ok || s.section === "verify"), sections };
}
