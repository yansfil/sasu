import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const libDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "lib");
const {
  vouchedTreeFingerprint,
  vouchedTreeFingerprintForState,
  vouchedFingerprintsMatch,
  vouchedFingerprintDiff,
  summarizeFingerprintDiff,
  stripFingerprintEntries,
} = require(path.join(libDir, "git.js"));
const { reviewWorktreeSnapshotViolations, prdSnapshotViolations } = require(path.join(libDir, "reviews.js"));
const { sha256Text } = require(path.join(libDir, "util.js"));

function git(dir, ...args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-vouched-"));
  git(dir, "init", "-q");
  write(dir, "src/app.js", "console.log('app')\n");
  write(dir, "docs/readme.md", "# readme\n");
  write(dir, "agents/prd/demo/prd.md", "# PRD: demo\n");
  write(dir, "agents/prd/other/prd.md", "# PRD: other\n");
  commit(dir, "base");
  return dir;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commit(dir, message) {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
}

test("vouched fingerprint: committing dirty work does not move it (commit-invariance)", () => {
  const dir = makeRepo();
  write(dir, "src/app.js", "console.log('edited')\n"); // modify tracked
  write(dir, "src/new-module.js", "export {}\n"); // add untracked
  fs.rmSync(path.join(dir, "docs/readme.md")); // delete tracked
  const dirty = vouchedTreeFingerprint({ projectRoot: dir });
  commit(dir, "land the work");
  const committed = vouchedTreeFingerprint({ projectRoot: dir });
  assert.equal(dirty.vouched, committed.vouched,
    "the same content dirty and committed must fingerprint identically - this is what deletes the materialized-in-head rescue");
  assert.equal(dirty.entryCount, committed.entryCount);
  assert.ok(vouchedFingerprintsMatch(dirty, committed));
});

test("vouched fingerprint: scoped mode sees in-scope changes and new files, not out-of-scope ones", () => {
  const dir = makeRepo();
  const options = { projectRoot: dir, slug: "demo", scopeGlobs: ["src/**"] };
  const base = vouchedTreeFingerprint(options);
  assert.equal(base.mode, "scoped");
  assert.deepEqual(base.scopeGlobs, ["src/**"]);

  write(dir, "docs/readme.md", "# out of scope edit\n");
  assert.equal(vouchedTreeFingerprint(options).vouched, base.vouched, "out-of-scope change must not move the fingerprint");

  write(dir, "src/app.js", "console.log('in scope')\n");
  const inScope = vouchedTreeFingerprint(options);
  assert.notEqual(inScope.vouched, base.vouched, "in-scope change must move the fingerprint");

  write(dir, "src/created.js", "new\n");
  const withNewFile = vouchedTreeFingerprint(options);
  assert.notEqual(withNewFile.vouched, inScope.vouched, "a NEW file appearing in scope must move the fingerprint");
  assert.equal(withNewFile.entryCount, inScope.entryCount + 1);
});

test("vouched fingerprint: harness bookkeeping never moves it, in both modes", () => {
  const dir = makeRepo();
  const fallbackOptions = { projectRoot: dir, slug: "demo", runDir: "agents/implement/demo" };
  const scopedOptions = { ...fallbackOptions, scopeGlobs: ["src/**", "agents/**"] };
  const fallbackBase = vouchedTreeFingerprint(fallbackOptions);
  const scopedBase = vouchedTreeFingerprint(scopedOptions);
  assert.equal(fallbackBase.mode, "fallback");

  write(dir, "agents/gates/demo/gates.json", "{}");
  write(dir, "agents/gates/demo/artifacts/verify-1.json", "{}");
  write(dir, "agents/implement/demo/state.json", "{}");
  write(dir, "agents/implement/.prd-implement-active.json", "{}");
  write(dir, "agents/quick/demo/contract.md", "x");
  write(dir, "agents/quick/.quick-active.json", "{}");

  assert.equal(vouchedTreeFingerprint(fallbackOptions).vouched, fallbackBase.vouched,
    "fallback mode must be blind to gates/implement/quick bookkeeping - the circular-invalidation killer");
  assert.equal(vouchedTreeFingerprint(scopedOptions).vouched, scopedBase.vouched,
    "scoped mode must exclude bookkeeping even when a glob would cover it");
});

// This test replaced two that pinned the OPPOSITE rule: spec docs used to ride
// the fingerprint as "judged inputs" (the run's own always, another run's only
// when `slug` was passed). That carve-out made the exclusion depend on who was
// asking, so the same tree fingerprinted differently per caller, and loose
// `agents/*` files rode the fallback set with no carve-out at all - reproduced
// 2026-08-11: churn under agents/ moved the fingerprint and disarmed the verify
// rerun short-circuit. The namespace-wide rule is the AGENTS.md invariant, and
// the judged documents lose nothing because they are pinned by content hash
// somewhere stronger (see the compensating-pin test below).
test("vouched fingerprint: the ENTIRE agents/ namespace is out, whoever asks and in either mode", () => {
  const dir = makeRepo();
  const cases = {
    "fallback, no slug": { projectRoot: dir },
    "fallback, own slug": { projectRoot: dir, slug: "demo", runDir: "agents/implement/demo" },
    "fallback, other slug": { projectRoot: dir, slug: "other" },
    // A glob that explicitly names agents/** still must not pull it in: the
    // exclusion is not a default a Scope declaration can override.
    "scoped, glob names agents": { projectRoot: dir, slug: "demo", scopeGlobs: ["src/**", "agents/**"] },
  };
  const before = Object.fromEntries(Object.entries(cases).map(([name, options]) => [name, vouchedTreeFingerprint(options)]));

  write(dir, "agents/prd/demo/prd.md", "# PRD: demo (edited)\n");
  write(dir, "agents/prd/other/prd.md", "# PRD: other (concurrent session edit)\n");
  write(dir, "agents/interview/demo/qa-log.md", "# qa-log\n");
  write(dir, "agents/config.json", '{"judge":{"retryBudget":9}}');
  write(dir, "agents/rules/custom.md", "# rule\n");
  write(dir, "agents/gates/demo/gates.json", "{}");
  write(dir, "agents/implement/demo/state.json", "{}");
  write(dir, "agents/stray.json", "{}");

  for (const [name, options] of Object.entries(cases)) {
    assert.equal(vouchedTreeFingerprint(options).vouched, before[name].vouched, `${name}: agents/ churn must not move the fingerprint`);
    assert.equal(vouchedTreeFingerprint(options).entryCount, before[name].entryCount, `${name}: no agents/ path may enter the vouched set`);
  }

  // Source is still watched, so the fingerprint has not simply gone blind.
  write(dir, "src/app.js", "console.log('real change')\n");
  for (const [name, options] of Object.entries(cases)) {
    assert.notEqual(vouchedTreeFingerprint(options).vouched, before[name].vouched, `${name}: an in-scope source edit must still move it`);
  }
});

test("vouched fingerprint: spec-doc drift is caught by content pins, not by the fingerprint", () => {
  // The compensating proof for the exclusion above. A PRD/contract edit still
  // invalidates every recorded verdict that depended on it, through two pins
  // the fingerprint never owned:
  //   - the gate's own sha256 `inputs` list (cli/src/gates/store.ts staleInputsFor,
  //     driven end to end by cli/test/unit/store.test.mjs "editing the input
  //     document after a PASS turns the gate STALE")
  //   - the implement run's prdSnapshot.sha256 (reviews.js prdSnapshotViolations)
  // Asserted here on the second one, so the two halves of the argument live in
  // the same file as the exclusion they justify.
  const dir = makeRepo();
  const prdRel = "agents/prd/demo/prd.md";
  const before = vouchedTreeFingerprint({ projectRoot: dir, slug: "demo" });
  const state = {
    projectRoot: dir,
    prdPath: prdRel,
    prdSnapshot: { sha256: sha256Text(fs.readFileSync(path.join(dir, prdRel), "utf8")) },
    tasks: [],
    acceptanceCriteria: [],
    verification: [],
  };
  assert.deepEqual(prdSnapshotViolations(path.join(dir, "agents/implement/demo/state.json"), state), [],
    "an unedited PRD is clean");

  write(dir, prdRel, "# PRD: demo (rewritten mid-run)\n");
  assert.equal(vouchedTreeFingerprint({ projectRoot: dir, slug: "demo" }).vouched, before.vouched,
    "the fingerprint is deliberately blind to this");
  const violations = prdSnapshotViolations(path.join(dir, "agents/implement/demo/state.json"), state);
  assert.equal(violations.length, 1, "the content pin is what notices");
  assert.match(violations[0], /PRD file changed after implementation state was initialized/);
});

test("vouched fingerprint: state derivation unions full Scope declarations and falls back on partial ones", () => {
  const dir = makeRepo();
  const stateFor = tasks => ({ projectRoot: dir, runDir: "agents/implement/demo", topicSlug: "demo", tasks });

  const full = vouchedTreeFingerprintForState(stateFor([
    { id: "T1", scopeGlobs: ["src/**"] },
    { id: "T2", scopeGlobs: ["docs/**"] },
  ]));
  assert.equal(full.mode, "scoped");
  assert.deepEqual(full.scopeGlobs.sort(), ["docs/**", "src/**"]);

  // One Scope-less task would leave that task's writes invisible to a partial
  // union, so the whole run drops to fallback.
  for (const tasks of [
    [{ id: "T1", scopeGlobs: ["src/**"] }, { id: "T2" }],
    [{ id: "T1", scopeGlobs: ["src/**"] }, { id: "T2", scopeGlobs: [] }],
    [],
    undefined,
  ]) {
    assert.equal(vouchedTreeFingerprintForState(stateFor(tasks)).mode, "fallback",
      `${JSON.stringify(tasks)} must derive fallback mode`);
  }
});

test("vouched fingerprint: deletions and executable-bit flips move it", () => {
  const dir = makeRepo();
  const base = vouchedTreeFingerprint({ projectRoot: dir });
  fs.rmSync(path.join(dir, "docs/readme.md"));
  const afterDelete = vouchedTreeFingerprint({ projectRoot: dir });
  assert.notEqual(afterDelete.vouched, base.vouched);
  assert.equal(afterDelete.entryCount, base.entryCount - 1);

  fs.chmodSync(path.join(dir, "src/app.js"), 0o755);
  // git only tracks the executable bit as a mode change when core.filemode is
  // honored; the chmod makes the file dirty, and the dirty hash carries the
  // x flag, so the fingerprint moves.
  assert.notEqual(vouchedTreeFingerprint({ projectRoot: dir }).vouched, afterDelete.vouched);
});

test("vouched fingerprint: unborn HEAD and non-git directories degrade cleanly", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-vouched-empty-"));
  git(empty, "init", "-q");
  write(empty, "seed.txt", "first file, no commit yet\n");
  const unborn = vouchedTreeFingerprint({ projectRoot: empty });
  assert.ok(unborn && typeof unborn.vouched === "string", "an unborn HEAD still fingerprints the untracked tree");
  assert.equal(unborn.entryCount, 1);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-vouched-plain-"));
  assert.equal(vouchedTreeFingerprint({ projectRoot: plain }), null, "a non-git directory has no fingerprint");
});

test("fingerprint entries are opt-in, hash-neutral, and diffable into named paths", () => {
  const dir = makeRepo();
  const plain = vouchedTreeFingerprint({ projectRoot: dir });
  assert.ok(!("entries" in plain), "the default return shape must stay entry-free (byte-identical to before)");
  const before = vouchedTreeFingerprint({ projectRoot: dir, includeEntries: true });
  assert.ok(Array.isArray(before.entries) && before.entries.length === before.entryCount);
  assert.equal(before.vouched, plain.vouched, "retaining entries must not move the hash");

  write(dir, "src/app.js", "console.log('edited')\n"); // change
  write(dir, "src/new.js", "export {}\n"); // add
  fs.rmSync(path.join(dir, "docs/readme.md")); // remove
  const after = vouchedTreeFingerprint({ projectRoot: dir, includeEntries: true });
  assert.deepEqual(vouchedFingerprintDiff(before, after), {
    added: ["src/new.js"],
    removed: ["docs/readme.md"],
    changed: ["src/app.js"],
  });
  const summary = summarizeFingerprintDiff(before, after);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.paths, ["~src/app.js", "+src/new.js", "-docs/readme.md"]);
  assert.equal(summary.text, "~src/app.js, +src/new.js, -docs/readme.md");

  // Unknown must stay distinguishable from clean: an entry-free side yields
  // null, never an empty diff a guard could mistake for "nothing moved".
  assert.equal(vouchedFingerprintDiff(plain, after), null);
  assert.equal(summarizeFingerprintDiff(plain, after), null);

  // The persistable shape drops entries and nothing else.
  const stripped = stripFingerprintEntries(before);
  assert.ok(!("entries" in stripped));
  assert.equal(stripped.vouched, before.vouched);
  assert.equal(stripped.entryCount, before.entryCount);
  assert.equal(stripFingerprintEntries(null), null, "null passes through for non-git projects");
});

test("summarizeFingerprintDiff bounds its message and its persistable path list", () => {
  const dir = makeRepo();
  const before = vouchedTreeFingerprint({ projectRoot: dir, includeEntries: true });
  for (let i = 0; i < 7; i += 1) write(dir, `src/gen-${i}.js`, `// ${i}\n`);
  const after = vouchedTreeFingerprint({ projectRoot: dir, includeEntries: true });
  const summary = summarizeFingerprintDiff(before, after);
  assert.equal(summary.total, 7);
  assert.match(summary.text, /\(\+2 more\)$/, "the message shows 5 paths and counts the rest");
  assert.equal(summary.paths.length, 7, "the stored list keeps up to 20 paths");
});

test("vouchedFingerprintsMatch: legacy, missing, and malformed shapes never match and never throw", () => {
  const dir = makeRepo();
  const current = vouchedTreeFingerprint({ projectRoot: dir });
  for (const recorded of [
    { headSha: "abc", statusHash: "h1" }, // pre-consolidation record
    { headSha: null, statusHash: "h1" },
    null,
    undefined,
    {},
    { vouched: "" },
    { vouched: 7 },
    "just-a-string",
    42,
    [],
  ]) {
    assert.equal(vouchedFingerprintsMatch(recorded, current), false,
      `${JSON.stringify(recorded)} must read as not-matching (stale)`);
  }
  assert.equal(vouchedFingerprintsMatch(current, null), false);
  assert.equal(vouchedFingerprintsMatch(current, { headSha: "abc", statusHash: "h1" }), false);
  assert.equal(vouchedFingerprintsMatch(current, { ...current }), true);
});

test("review freshness: bookkeeping writes no longer stale a recorded review (deadlock killer), source writes do", () => {
  const dir = makeRepo();
  // The FINAL adversarial review is the axis that still watches the source tree:
  // reading the code is its mandate. The requirements fidelity review left this
  // check on purpose - it is pinned to what it actually reads (the PRD, the
  // interview log, registered evidence), because pinning it to the tree made
  // every bug fix invalidate a review whose subject had not moved.
  const state = {
    projectRoot: dir,
    runDir: "agents/implement/demo",
    topicSlug: "demo",
    tasks: [{ id: "T1" }],
    requirementsFidelityReview: null,
    finalReview: {
      status: "pass",
      worktreeSnapshot: { statusHash: "audit-only", entries: [] },
      vouchedTreeFingerprint: vouchedTreeFingerprintForState({ projectRoot: dir, runDir: "agents/implement/demo", topicSlug: "demo", tasks: [{ id: "T1" }] }),
    },
  };
  assert.deepEqual(reviewWorktreeSnapshotViolations(state), [], "an unchanged tree is fresh");

  // The old deadlock: verify re-run writes agents/gates/**, review goes stale,
  // review re-record moves the tree, verify goes stale, forever. Bookkeeping
  // is out of the vouched set, so this loop is now structurally impossible.
  write(dir, "agents/gates/demo/gates.json", JSON.stringify({ gates: { verify: { verdict: "PASS" } } }));
  write(dir, "agents/implement/demo/state.json", "{}");
  assert.deepEqual(reviewWorktreeSnapshotViolations(state), [], "verify/gate bookkeeping must not stale the review");

  write(dir, "src/app.js", "console.log('changed after review')\n");
  const violations = reviewWorktreeSnapshotViolations(state);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Final review is stale/);

  // And the fidelity axis is untouched by all of it - no source pin to move.
  const fidelityState = {
    ...state,
    finalReview: null,
    requirementsFidelityReview: { status: "pass", inputs: [] },
  };
  assert.deepEqual(reviewWorktreeSnapshotViolations(fidelityState), [],
    "the fidelity review carries no source pin for this rule to compare");
});

test("review freshness: legacy review records (snapshot only, no vouched fingerprint) read as stale, not fresh, not a crash", () => {
  const dir = makeRepo();
  const legacyReview = {
    status: "pass",
    worktreeSnapshot: { headSha: "deadbeef", statusHash: "h1", entries: [] },
  };
  const state = { projectRoot: dir, tasks: [], requirementsFidelityReview: null, finalReview: legacyReview };
  const violations = reviewWorktreeSnapshotViolations(state);
  assert.equal(violations.length, 1, "a legacy record cannot prove freshness and must re-review");
  assert.match(violations[0], /stale/);

  // A record that never pinned anything (non-git era) was never checked.
  const unpinned = { projectRoot: dir, tasks: [], requirementsFidelityReview: null, finalReview: { status: "pass" } };
  assert.deepEqual(reviewWorktreeSnapshotViolations(unpinned), []);
});
