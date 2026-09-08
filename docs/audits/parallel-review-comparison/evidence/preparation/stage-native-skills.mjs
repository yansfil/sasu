#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const prepRoot = fs.realpathSync(path.dirname(import.meta.filename));
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const fail = (message) => { throw new Error(message); };

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--help" || name === "--check") { result[name.slice(2)] = true; continue; }
    if (!["--arm", "--target", "--manifest"].includes(name) || result[name.slice(2)] !== undefined) fail(`Unknown or duplicate argument: ${name}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
    result[name.slice(2)] = value;
  }
  return result;
}

function main() {
  const args = options(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node stage-native-skills.mjs --arm <unified|split> --target <absolute-existing-native-session-directory> [--check | --manifest <new-json-under-prep-root>]");
    console.log("Stages project-local Codex skills only. --check prints the complete plan without writing. Never calls prepare-run or a live backend.");
    return;
  }
  const experiment = JSON.parse(fs.readFileSync(path.join(prepRoot, "manifest.json"), "utf8"));
  if (!["unified", "split"].includes(args.arm)) fail("--arm must be unified or split");
  const arm = experiment.harnesses[args.arm];
  const sourceRoot = fs.realpathSync(arm.path);
  if (git(sourceRoot, "rev-parse", "HEAD") !== arm.requiredCommit) fail(`Arm HEAD is not the pinned ${arm.requiredCommit}`);
  if (git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all")) fail(`Arm source is dirty: ${sourceRoot}`);
  if (!args.target || !path.isAbsolute(args.target)) fail("--target must be an absolute existing directory");
  const target = fs.realpathSync(args.target);
  if (!fs.statSync(target).isDirectory()) fail("--target must name a directory");
  const sessionRoot = path.join(prepRoot, "native-sessions");
  if (!target.startsWith(`${sessionRoot}${path.sep}`)) fail(`--target must be an isolated directory under ${sessionRoot}`);
  const protectedRoots = [...Object.values(experiment.harnesses).map((entry) => entry.path), ...Object.values(experiment.launchers)].map((entry) => fs.realpathSync(entry));
  if (protectedRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) fail("Refusing to stage inside a harness checkout or product launcher");
  const localAgents = path.join(target, ".agents");
  const stagedSkillsRoot = path.join(localAgents, "skills");
  if (fs.existsSync(localAgents) && (!fs.lstatSync(localAgents).isDirectory() || fs.lstatSync(localAgents).isSymbolicLink())) fail("Refusing a non-directory or symlink .agents boundary");
  try { fs.lstatSync(stagedSkillsRoot); fail(`Refusing to replace existing staged skills: ${stagedSkillsRoot}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  let manifestPath;
  if (!args.check) {
    if (!args.manifest || !path.isAbsolute(args.manifest)) fail("--manifest must name a new absolute file under the prep root");
    const parent = fs.realpathSync(path.dirname(args.manifest));
    if (parent !== prepRoot && !parent.startsWith(`${prepRoot}${path.sep}`)) fail("Staging manifest must stay under the prep root");
    manifestPath = path.join(parent, path.basename(args.manifest));
    if (fs.existsSync(manifestPath)) fail(`Refusing to replace staging manifest: ${manifestPath}`);
  }

  const contractPath = path.join(sourceRoot, "cli/lib/skill-contract.js");
  const { SKILL_NAMES, contractFiles, transformContractFile } = createRequire(import.meta.url)(contractPath);
  const sourceSkillsRoot = path.join(sourceRoot, "skills");
  const files = SKILL_NAMES.flatMap((skill) => contractFiles(sourceSkillsRoot, skill, "codex").map((relative) => {
    const source = path.join(sourceSkillsRoot, skill, relative);
    const bytes = fs.readFileSync(source);
    const isProse = relative === "SKILL.md" || (relative.startsWith("references/") && relative.endsWith(".md"));
    const output = isProse ? Buffer.from(transformContractFile("codex", relative, bytes.toString("utf8"), { skillsRoot: stagedSkillsRoot })) : bytes;
    return { skill, relative, source, target: path.join(stagedSkillsRoot, skill, relative), sourceSha256: digest(bytes), outputSha256: digest(output), mode: fs.statSync(source).mode & 0o777, output };
  }));
  const reporter = path.join(sourceSkillsRoot, "benchmark-implement/scripts/benchmark_report.js");
  const cli = path.join(sourceRoot, "cli/dist/cli.js");
  const packageScope = Buffer.from('{"type":"commonjs"}\n');
  const plan = {
    schema: "sasu.parallel-native-skill-staging.v1", mode: args.check ? "check" : "staged", arm: args.arm,
    source: { root: sourceRoot, commit: arm.requiredCommit, tree: git(sourceRoot, "rev-parse", "HEAD^{tree}"), contractSha256: digest(fs.readFileSync(contractPath)) },
    target: { root: target, skillsRoot: stagedSkillsRoot },
    runtime: "codex", skillNames: [...SKILL_NAMES],
    packageScope: { path: path.join(stagedSkillsRoot, "package.json"), sha256: digest(packageScope) },
    invocation: { node: process.execPath, cli, cliSha256: digest(fs.readFileSync(cli)), reporter, reporterSha256: digest(fs.readFileSync(reporter)), ship: path.join(stagedSkillsRoot, "ship/scripts/prd_ship.js") },
    nativeSession: {
      startCwd: target,
      skill: path.join(stagedSkillsRoot, "benchmark-implement/SKILL.md"),
      launcherCwd: experiment.launchers[args.arm],
      preparation: [process.execPath, reporter, "prepare-run", "--case", "benchmarks/task-list-review-comparison/benchmark.json"],
      instructions: "Start the native session in startCwd to load project-local Codex skills. Invoke $benchmark-implement there; change to launcherCwd before the pinned preparation command. Use only the command's returned product coordinates afterward. Keep skill reads pinned to this external staged directory, and use the original reporter for every later benchmark command.",
    },
    limitations: [
      "The copied benchmark reporter derives its harness root from its script location and cannot run prepare-run from the staged layout. Invoke invocation.reporter from the pinned arm checkout for every benchmark command; the native handoff must explicitly override staged reporter command paths.",
      "This stages skill files only, not PATH, native session trust, benchmark worktrees, configuration or state. The coordinator must pin every sasu invocation to invocation.cli.",
      "External skills such as Herdr retain their existing installed references under the canonical arm transformer. No external skill is copied.",
    ],
    files: files.map(({ output, ...entry }) => entry),
  };
  if (args.check) { console.log(JSON.stringify(plan, null, 2)); return; }

  let created = false;
  try {
    fs.mkdirSync(localAgents, { recursive: true });
    fs.mkdirSync(stagedSkillsRoot); // Exclusive ownership; never merge into someone else's skill root.
    created = true;
    fs.writeFileSync(plan.packageScope.path, packageScope, { flag: "wx", mode: 0o644 });
    for (const entry of files) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      fs.writeFileSync(entry.target, entry.output, { flag: "wx", mode: entry.mode });
      fs.chmodSync(entry.target, entry.mode);
      if (!fs.lstatSync(entry.target).isFile() || fs.lstatSync(entry.target).isSymbolicLink() || digest(fs.readFileSync(entry.target)) !== entry.outputSha256) fail(`Staged file integrity failed: ${entry.target}`);
    }
    if (git(sourceRoot, "rev-parse", "HEAD") !== arm.requiredCommit || git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=all")) fail("Pinned source changed while staging");
    if (digest(fs.readFileSync(contractPath)) !== plan.source.contractSha256 || digest(fs.readFileSync(cli)) !== plan.invocation.cliSha256 || files.some((entry) => digest(fs.readFileSync(entry.source)) !== entry.sourceSha256)) fail("Pinned source or build bytes changed while staging");
    plan.generatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ mode: "staged", arm: args.arm, manifest: manifestPath, target, fileCount: files.length, invocation: plan.invocation, nativeSession: plan.nativeSession, limitations: plan.limitations }, null, 2));
  } catch (error) {
    if (created) fs.rmSync(stagedSkillsRoot, { recursive: true, force: true });
    throw error;
  }
}
try { main(); }
catch (error) { process.stderr.write(`stage-native-skills: ${error.message}\n`); process.exitCode = 2; }
