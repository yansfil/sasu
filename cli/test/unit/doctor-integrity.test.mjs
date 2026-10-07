import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIntegritySection, skillFreshnessSection } from "../../dist/doctor.js";
import { stateFixture } from "../helpers/implement-state.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

test("doctor reports current retire candidates without claiming checkout ownership", () => {
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
  writeState("active-run", { status: "active" });
  writeState("ended-run", { status: "retired", retirement: { retiredAt: "2026-10-07T00:00:00.000Z" } });
  writeState("unknown-status", { status: "paused" });
  writeState("missing-snapshot", { prd: { ...stateFixture(root).prd, snapshotPath: undefined } });
  writeState("retired-schema-active", { schema: "sasu.implement.state.v8", status: "active" });
  writeState("previous-coordination-active", { schema: "sasu.implement.state.v11.stateless-verification", status: "active" });
  writeState("future-active", { schema: "sasu.implement.state.v99", status: "active" });
  writeState("experimental-active", { schema: "sasu.implement.state.v9.parallel-review", status: "active" });

  const section = runIntegritySection(root);
  assert.equal(section.ok, false);
  assert.ok(section.lines.includes("retire candidate: active-run command=sasu implement retire --slug active-run"), section.lines.join("\n"));
  assert.ok(!section.lines.some((line) => line.startsWith("orphan worktree:")));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: unknown-status") && line.includes("status must be one of active")));
  assert.ok(section.lines.some((line) => line.startsWith("malformed run state: missing-snapshot") && line.includes("prd.snapshotPath")));
  for (const [slug, schema, support] of [
    ["retired-schema-active", "v8", "9149d9826fad2af3ba7200761e674b5228ef9b7d"],
    ["previous-coordination-active", "v11.stateless-verification", "fbdf62913b4fbe5fde1ebce26c3e290c8eac0e92"],
    ["future-active", "v99", "9149d9826fad2af3ba7200761e674b5228ef9b7d"],
    ["experimental-active", "v9.parallel-review", "2b1f638dd587261be7e7b0e600db16657421971d"],
  ]) {
    assert.ok(section.lines.includes(
      `incompatible active run: ${slug} status=active schema=sasu.implement.state.${schema} installed-schema=sasu.implement.state.v14.current-git; last supported commit: ${support}; use that matching CLI to inspect or retire the old run, or start a new slug`,
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
