// Lifecycle transitions are CLI verbs, not text surgery (2026-08-30). The
// 2026-08-29 audit found agents flipping `status:`/`human_approval:` with
// python/sed - one $please run marked a document approved that no human had
// read - because the rule lived only in skill prose. These tests pin the
// coded guard: ready requires a passing readiness gate, approve requires the
// user's verbatim and a ready document, and neither transition is repeatable
// over an existing record.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPrdCommand } from "../../dist/prd/commands.js";

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "prelint");

function makeProject(prdContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-prd-verbs-"));
  fs.writeFileSync(path.join(dir, "prd.md"), prdContent);
  return dir;
}

function draftClean() {
  return fs.readFileSync(path.join(FIXTURES, "prd-clean.md"), "utf8")
    .replace('status: "ready"', 'status: "draft"')
    .replace(/^human_approval: "approved".*$/m, 'human_approval: "pending"');
}

const flags = (entries) => new Map(Object.entries(entries));

test("prd ready: flips draft to ready when readiness passes, and is idempotent", () => {
  const dir = makeProject(draftClean());
  const first = runPrdCommand(dir, "ready", flags({ prd: "prd.md" }));
  assert.equal(first.ok, true, first.message);
  assert.match(fs.readFileSync(path.join(dir, "prd.md"), "utf8"), /^status: "ready"$/m);
  const again = runPrdCommand(dir, "ready", flags({ prd: "prd.md" }));
  assert.equal(again.ok, true);
  assert.match(again.message, /already ready/);
});

test("prd ready: refused while the readiness gate has blocking gaps", () => {
  const broken = draftClean().replace("## Behaviors", "## Behaviours");
  const dir = makeProject(broken);
  const result = runPrdCommand(dir, "ready", flags({ prd: "prd.md" }));
  assert.equal(result.ok, false);
  assert.match(result.message, /blocking gaps/);
  assert.match(fs.readFileSync(path.join(dir, "prd.md"), "utf8"), /^status: "draft"$/m, "a refused flip writes nothing");
});

test("prd approve: requires the verbatim, requires ready, records the quote, and refuses a second approval", () => {
  const dir = makeProject(draftClean());
  const noEvidence = runPrdCommand(dir, "approve", flags({ prd: "prd.md" }));
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.message, /verbatim/);

  const notReady = runPrdCommand(dir, "approve", flags({ prd: "prd.md", evidence: "승인!" }));
  assert.equal(notReady.ok, false);
  assert.match(notReady.message, /prd ready first/);

  runPrdCommand(dir, "ready", flags({ prd: "prd.md" }));
  const approved = runPrdCommand(dir, "approve", flags({ prd: "prd.md", evidence: "레스고\n승인!" }));
  assert.equal(approved.ok, true, approved.message);
  const text = fs.readFileSync(path.join(dir, "prd.md"), "utf8");
  assert.match(text, /^human_approval: "approved"  # user \d{4}-\d{2}-\d{2} verbatim: 레스고 승인!$/m);

  const twice = runPrdCommand(dir, "approve", flags({ prd: "prd.md", evidence: "다시 승인" }));
  assert.equal(twice.ok, false);
  assert.match(twice.message, /already approved/);
  assert.match(fs.readFileSync(path.join(dir, "prd.md"), "utf8"), /verbatim: 레스고 승인!$/m, "the original record stands");
});

test("prd readiness: unchanged contract for the existing subcommand", () => {
  const dir = makeProject(draftClean());
  const result = runPrdCommand(dir, "readiness", flags({ prd: "prd.md" }));
  assert.equal(result.ok, true);
  assert.equal(result.detail.status, "ready");
  assert.deepEqual(result.detail.parsed, { behaviorCount: 3, decisionCount: 1 });
  const unknown = runPrdCommand(dir, "nope", flags({ prd: "prd.md" }));
  assert.equal(unknown.exitCode, 2);
});

// AC14: a five-axis PRD is refused as the old format before anything else,
// with start's own words, and never with a pre-work complaint.
test("prd readiness: a five-axis PRD reports the old-format refusal", () => {
  const legacy = draftClean().replace("## Behaviors", "## 7. Acceptance Criteria") + "\n## 4. Pre-Work And Required Decisions\n\n### 4.1 Required Decisions\n\n- [ ] decide\n";
  const dir = makeProject(legacy);
  const result = runPrdCommand(dir, "readiness", flags({ prd: "prd.md" }));
  assert.equal(result.ok, false);
  assert.match(result.detail.contractError, /구 형식/);
  assert.doesNotMatch(JSON.stringify(result.detail), /[Pp]re-?[Ww]ork/);
});
