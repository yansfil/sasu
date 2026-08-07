"use strict";

const fs = require("fs");
const path = require("path");

const { cwd, resolveProjectPath, toProjectRelative, ensureDir, sha256File, listFilesRecursive } = require("./util");
const { isVerificationRequiredForDone } = require("./state_data");
const { inferVerificationMode } = require("./prd_parser");
const { classifyVerification } = require("./inference");

function artifactManifestPath(statePath) {
  return path.join(path.dirname(statePath), "artifacts", "manifest.jsonl");
}

function ensureRunDirs(runDirAbs) {
  ensureDir(runDirAbs);
  ensureDir(path.join(runDirAbs, "artifacts"));
  ensureDir(path.join(runDirAbs, "artifacts", "logs"));
  ensureDir(path.join(runDirAbs, "artifacts", "screenshots"));
  ensureDir(path.join(runDirAbs, "artifacts", "browser"));
  ensureDir(path.join(runDirAbs, "artifacts", "api"));
  ensureDir(path.join(runDirAbs, "artifacts", "db"));
  ensureDir(path.join(runDirAbs, "review"));
}

function collectArtifacts(state) {
  const artifacts = [];
  for (const group of [
    ["execution_node", state.executionPlan && state.executionPlan.nodes ? state.executionPlan.nodes : []],
    ["task", state.tasks || []],
    ["ac", state.acceptanceCriteria || []],
    ["verification", state.verification || []],
  ]) {
    const [kind, items] = group;
    for (const item of items) {
      for (const artifact of item.artifacts || []) {
        artifacts.push({ ownerKind: kind, ownerId: item.id, artifact });
      }
    }
  }
  return artifacts;
}

function inspectArtifact(absPath, kind) {
  if (!fs.existsSync(absPath)) throw new Error(`Artifact not found: ${absPath}`);
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) throw new Error(`Artifact is not a file: ${absPath}`);
  if (stat.size <= 0) throw new Error(`Artifact is empty: ${absPath}`);

  const buffer = fs.readFileSync(absPath);
  const lower = absPath.toLowerCase();
  const info = {
    bytes: stat.size,
    sha256: sha256File(absPath),
    mimeHint: "application/octet-stream",
  };

  const isPng = buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  const isJpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;

  if (isPng) {
    info.mimeHint = "image/png";
    info.width = buffer.readUInt32BE(16);
    info.height = buffer.readUInt32BE(20);
  } else if (isJpeg) {
    info.mimeHint = "image/jpeg";
  } else if (lower.endsWith(".log") || lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".md")) {
    info.mimeHint = "text/plain";
  }

  if (kind === "screenshot" || kind === "image") {
    if (!isPng && !isJpeg) throw new Error(`Screenshot artifact must be PNG or JPEG: ${absPath}`);
    if (!/\.(png|jpe?g)$/i.test(absPath)) throw new Error(`Screenshot artifact must use .png, .jpg, or .jpeg extension: ${absPath}`);
  }

  return info;
}

const REQUIRED_EVIDENCE_KINDS_BY_CATEGORY = {
  command: ["command-log"],
  automated: ["command-log"],
  browser: ["screenshot", "image", "browser"],
  server: ["log", "command-log", "api", "screenshot"],
  api: ["api", "command-log", "log"],
  db: ["db", "command-log", "log"],
  // A required check that classified as manual-agent still needs a concrete
  // captured artifact; a hand-authored file/markdown must not satisfy it.
  "manual-agent": ["screenshot", "image", "browser", "api", "db", "log", "command-log"],
};

function verificationCategory(state, verification) {
  const checks = (state.verificationPlan && state.verificationPlan.checks) || [];
  const check = checks.find(item => item.verificationId === verification.id);
  if (check && check.category) return check.category;
  const mode = inferVerificationMode(verification, state.testModeContract || []);
  return classifyVerification(verification, mode);
}

function verificationEvidenceKindViolations(state) {
  const violations = [];
  for (const verification of state.verification || []) {
    if (!isVerificationRequiredForDone(verification)) continue;
    if (verification.status !== "pass") continue;
    const category = verificationCategory(state, verification);
    const allowed = REQUIRED_EVIDENCE_KINDS_BY_CATEGORY[category];
    if (!allowed) continue;
    const qualifying = (verification.artifacts || []).filter(artifact => {
      if (!artifact || !artifact.path) return false;
      if (/\.(md|markdown)$/i.test(artifact.path)) return false;
      return allowed.includes(artifact.kind);
    });
    if (!qualifying.length) {
      violations.push(`Required verification ${verification.id} (${category}) has no qualifying evidence artifact: expected kind ${allowed.join("/")} captured from the actual run; markdown summaries and prose files do not count`);
    }
  }
  return violations;
}

function unregisteredArtifactViolations(statePath, state) {
  const violations = [];
  const projectRoot = state.projectRoot || cwd();
  const artifactsDir = path.join(path.dirname(statePath), "artifacts");
  if (!fs.existsSync(artifactsDir)) return violations;
  const registered = new Set();
  for (const entry of collectArtifacts(state)) {
    if (entry.artifact && entry.artifact.path) {
      registered.add(toProjectRelative(resolveProjectPath(entry.artifact.path, projectRoot), projectRoot));
    }
  }
  for (const rel of readManifestArtifactPaths(artifactManifestPath(statePath), projectRoot)) registered.add(rel);
  for (const abs of listFilesRecursive(artifactsDir)) {
    const rel = toProjectRelative(abs, projectRoot);
    if (rel === toProjectRelative(artifactManifestPath(statePath), projectRoot)) continue;
    if (!registered.has(rel)) violations.push(`Unregistered artifact file: ${rel}`);
  }
  return violations;
}

function readManifestArtifactPaths(file, projectRoot) {
  const paths = [];
  if (!fs.existsSync(file)) return paths;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.path) paths.push(toProjectRelative(resolveProjectPath(entry.path, projectRoot), projectRoot));
    } catch {
      // Ignore malformed historical lines; validateArtifacts handles state-backed evidence.
    }
  }
  return paths;
}

function assertArtifactPathIsEvidence(state, statePath, absPath) {
  const runDirAbs = path.dirname(statePath);
  const relToRunDir = path.relative(runDirAbs, absPath);
  const insideRunDir = relToRunDir && !relToRunDir.startsWith("..") && !path.isAbsolute(relToRunDir);
  if (!insideRunDir) return;
  const segments = relToRunDir.split(path.sep);
  if (segments[0] !== "artifacts") {
    throw new Error(`Run-dir file is not evidence: ${relToRunDir}. Harness state, plans, reviews, and self-authored run documents cannot be registered as artifacts; only captured evidence under ${state.runDir}/artifacts qualifies.`);
  }
  if (segments.length === 2 && segments[1] === "manifest.jsonl") {
    throw new Error("The artifact manifest itself cannot be registered as an artifact");
  }
}

module.exports = {
  artifactManifestPath,
  ensureRunDirs,
  collectArtifacts,
  inspectArtifact,
  REQUIRED_EVIDENCE_KINDS_BY_CATEGORY,
  verificationCategory,
  verificationEvidenceKindViolations,
  unregisteredArtifactViolations,
  readManifestArtifactPaths,
  assertArtifactPathIsEvidence,
};
