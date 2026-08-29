import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIntegritySection, skillFreshnessSection } from "../../dist/doctor.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

test("doctor reports active retire candidates and ended runs whose worktrees remain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-runs-"));
  const worktree = path.join(root, "leftover-worktree");
  fs.mkdirSync(worktree);
  const writeState = (slug, state) => {
    const file = path.join(root, "agents", "runs", slug, "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: "sasu.implement.state.v7",
      topicSlug: slug,
      projectRoot: root,
      runDir: `agents/runs/${slug}`,
      prdPath: `agents/prd/${slug}/prd.md`,
      prd: { sha256: "prd-hash", snapshotPath: `agents/runs/${slug}/prd.md`, reviewProfile: "standard" },
      initialSource: { head: "head", digest: "source-hash", entries: [] },
      baselineAttribution: { disposition: "clean", paths: [], baselineDigest: "source-hash", head: "head" },
      tasks: [],
      requirements: [],
      acceptanceCriteria: [],
      verification: [],
      artifacts: [],
      verificationAttempts: [],
      deviations: [],
      events: [],
      verbs: [],
      amendments: [],
      suite: { sealedAt: "2026-08-29T00:00:00.000Z", commands: [], exclusions: [], results: [] },
      qaBriefs: [],
      trails: [],
      escalations: [],
      retirement: null,
      completion: null,
      ...state,
    }));
  };
  writeState("active-run", { status: "active", ownerSessionId: "session-a", worktree: null });
  writeState("ended-run", { status: "retired", worktree: { path: worktree, branch: "sasu/ended-run" } });
  writeState("unknown-status", { status: "paused", worktree: null });
  writeState("missing-snapshot", { status: "active", worktree: null, prd: { sha256: "prd-hash", reviewProfile: "standard" } });
  writeState("future-active", { schema: "sasu.implement.state.v99", status: "active", worktree: null });

  const section = runIntegritySection(root, null);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes("retire candidate: active-run owner=session-a command=sasu implement retire --slug active-run --adopt \"<verbatim user approval>\""));
  assert.ok(section.lines.includes(`orphan worktree: ended-run status=retired path=${worktree} branch=sasu/ended-run`));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: unknown-status") && line.includes("status must be active")));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: missing-snapshot") && line.includes("prd.snapshotPath")));
  assert.ok(section.lines.includes(
    "incompatible active run: future-active status=active schema=sasu.implement.state.v99 installed-schema=sasu.implement.state.v7; use a matching CLI to inspect or retire it, or start a new slug",
  ));
});

test("doctor names the exact installed skill contract that differs from the repository", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-skills-"));
  const target = path.join(home, ".codex", "skills", "implement", "SKILL.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "stale contract\n");

  const section = skillFreshnessSection(home, repoRoot);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes("stale installed contract: codex:implement/SKILL.md"));
});

test("doctor rejects a matching Codex SKILL.md when it is a symbolic link", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-symlinked-skill-"));
  const source = path.join(repoRoot, "skills", "implement", "SKILL.md");
  const target = path.join(home, ".codex", "skills", "implement", "SKILL.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);

  const section = skillFreshnessSection(home, repoRoot);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes(
    "invalid installed contract: codex:implement/SKILL.md (SKILL.md must be a real file, not a symbolic link)",
  ));
});

test("doctor includes executable skill scripts in the freshness contract", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-script-contract-"));
  const skillRoot = path.join(home, ".codex", "skills", "implement");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "skills", "implement", "SKILL.md"),
    path.join(skillRoot, "SKILL.md"),
  );
  fs.writeFileSync(path.join(skillRoot, "scripts", "prd_state_harness.js"), "stale helper\n");

  const section = skillFreshnessSection(home, repoRoot);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes(
    "stale installed contract: codex:implement/scripts/prd_state_harness.js",
  ));
});

test("doctor reports files left behind outside the current skill contract", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-unexpected-contract-"));
  const skillRoot = path.join(home, ".codex", "skills", "implement");
  fs.mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "skills", "implement", "SKILL.md"),
    path.join(skillRoot, "SKILL.md"),
  );
  fs.writeFileSync(path.join(skillRoot, "scripts", "removed-helper.js"), "obsolete helper\n");

  const section = skillFreshnessSection(home, repoRoot);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes(
    "unexpected installed contract: codex:implement/scripts/removed-helper.js",
  ));
});
