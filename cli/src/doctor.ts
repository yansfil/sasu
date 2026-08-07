import { spawnSync } from "node:child_process";
import { loadConfig, type SasuConfig } from "./config";
import { resolveMechanicalCommands } from "./mechanical";
import { contractVersion } from "./version";

export interface DoctorSection {
  section: "judge" | "verify" | "contract";
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
    judgeLines.push(`configured backend: ${config.judge.backend}`);
    judgeLines.push(
      `tier models (claude): frugal=${config.judge.tierModels.claude.frugal} standard=${config.judge.tierModels.claude.standard} frontier=${config.judge.tierModels.claude.frontier}`,
    );
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

  sections.push({
    section: "contract",
    ok: true,
    lines: [`sasu contract version: ${contractVersion()}`],
  });

  return { ok: sections.every((s) => s.ok || s.section === "verify"), sections };
}
