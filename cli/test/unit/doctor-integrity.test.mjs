import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIntegritySection, skillFreshnessSection } from "../../dist/doctor.js";
import { stateFixture } from "../helpers/implement-state.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

test("doctor reports active retire candidates and ended runs whose worktrees remain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-doctor-runs-"));
  const worktree = path.join(root, "leftover-worktree");
  fs.mkdirSync(worktree);
  const writeState = (slug, state) => {
    const file = path.join(root, "agents", "runs", slug, "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fixture = stateFixture(root);
    fs.writeFileSync(file, JSON.stringify(stateFixture(root, {
      topicSlug: slug,
      runDir: `agents/runs/${slug}`,
      prdPath: `agents/prd/${slug}/prd.md`,
      prd: { ...fixture.prd, snapshotPath: `agents/runs/${slug}/prd.md` },
      ...state,
    })));
  };
  writeState("active-run", { status: "active", ownerSessionId: "session-a", worktree: null });
  writeState("ended-run", { status: "retired", worktree: { path: worktree, branch: "sasu/ended-run" } });
  writeState("unknown-status", { status: "paused", worktree: null });
  writeState("missing-snapshot", { prd: { ...stateFixture(root).prd, snapshotPath: undefined } });
  writeState("retired-schema-active", { schema: "sasu.implement.state.v8", status: "active", worktree: null });
  writeState("future-active", { schema: "sasu.implement.state.v99", status: "active", worktree: null });

  const section = runIntegritySection(root, null);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes("retire candidate: active-run owner=session-a command=sasu implement retire --slug active-run --adopt \"<verbatim user approval>\""), section.lines.join("\n"));
  assert.ok(section.lines.includes(`orphan worktree: ended-run status=retired path=${worktree} branch=sasu/ended-run`));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: unknown-status") && line.includes("status must be one of active")));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: missing-snapshot") && line.includes("prd.snapshotPath")));
  for (const [slug, schema] of [["retired-schema-active", "v8"], ["future-active", "v99"]]) {
    assert.ok(section.lines.includes(
      `incompatible active run: ${slug} status=active schema=sasu.implement.state.${schema} installed-schema=sasu.implement.state.v9; last supported commit: 488d3cc7d6e99742e7f68a1680fcb101710c8e20; use that matching CLI to inspect or retire the old run, or start a new slug`,
    ));
    assert.ok(!section.lines.some((line) => line.startsWith(`retire candidate: ${slug} `)));
  }
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
