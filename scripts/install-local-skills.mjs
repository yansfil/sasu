#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const targetRoot = path.join(process.env.HOME || "", ".codex", "skills");
const skillNames = ["intake", "prd", "prd-implement", "prd-setup", "prd-ship", "please"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copySkillMd(sourceDir, targetDir) {
  const source = path.join(sourceDir, "SKILL.md");
  const target = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}`);
  fs.copyFileSync(source, target);
}

function symlinkAuxiliaryEntries(sourceDir, targetDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === "SKILL.md") continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    removePath(target);
    fs.symlinkSync(source, target, entry.isDirectory() ? "dir" : "file");
  }
}

function installSkill(name) {
  const sourceDir = path.join(skillsRoot, name);
  const targetDir = path.join(targetRoot, name);
  if (!fs.existsSync(sourceDir)) throw new Error(`Missing skill source: ${sourceDir}`);

  ensureDir(targetDir);
  for (const entry of fs.readdirSync(targetDir)) {
    removePath(path.join(targetDir, entry));
  }
  copySkillMd(sourceDir, targetDir);
  symlinkAuxiliaryEntries(sourceDir, targetDir);
  return { name, sourceDir, targetDir };
}

ensureDir(targetRoot);
const installed = skillNames.map(installSkill);

process.stdout.write(JSON.stringify({
  ok: true,
  repoRoot,
  targetRoot,
  installed,
  note: "SKILL.md files are real copies; auxiliary entries are symlinks.",
}, null, 2) + "\n");

