import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const validator = path.join(repoRoot, "skills", "ho-interview", "scripts", "validate_intake.mjs");

function fixtureQaLog({ withUxCard = true, withLinkedDecisions = true } = {}) {
  return [
    "---",
    'selected_packs: "ux, verification"',
    "---",
    "",
    "# Interview Log: Settings retry",
    "",
    "## Decision Register",
    "",
    "| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "",
    "## Raw Q&A",
    "",
    "### Q1: Failed save behavior",
    "- decision_ids: D-01",
    "- needs_normalization: false",
    "",
    "## UX Scenario Cards",
    "",
    ...(withUxCard
      ? [
        "### UX-01: Change a setting",
        "- trigger: User opens the existing settings page.",
        "- happy path: User saves a valid setting and sees the persisted value.",
        "- state / failure: A failed save keeps the entered value and explains the error.",
        "- recovery: User retries without re-entering the value.",
        "- proof: Browser flow confirms error, retry, and persisted result.",
        ...(withLinkedDecisions ? ["- linked decisions: D-01"] : []),
      ]
      : []),
    "",
    "## Evidence From Code, Docs, Or Research",
    "",
    "- src/settings/page.tsx: existing entry route.",
  ].join("\n");
}

function fixtureHandoff({ traceDecision = "D-01", withUxSeeds = true } = {}) {
  return [
    "# PRD Handoff: Settings retry",
    "",
    "## Decision Trace And Requirement Mapping",
    "",
    "| Decision | User intent or evidence | Represented by | Remaining gap |",
    "| --- | --- | --- | --- |",
    "| " + traceDecision + " | Retry preserves input | R1, AC1, V1 | none |",
    "",
    "## UX Behavior And State Seeds",
    "",
    ...(withUxSeeds ? ["- UX-01 preserves input on save failure."] : []),
  ].join("\n");
}

function runValidator(qaLog, handoff) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ho-interview-validator-"));
  const qaPath = path.join(dir, "qa-log.md");
  fs.writeFileSync(qaPath, qaLog);
  const args = [validator, qaPath];
  if (handoff !== undefined) {
    const handoffPath = path.join(dir, "prd-handoff.md");
    fs.writeFileSync(handoffPath, handoff);
    args.push("--handoff", handoffPath);
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test("intake validator accepts traceable UX coverage", () => {
  const result = runValidator(fixtureQaLog(), fixtureHandoff());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Intake validation passed/);
});

test("intake validator rejects selected UX without a scenario card", () => {
  const result = runValidator(fixtureQaLog({ withUxCard: false }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no UX Scenario Card/);
});

test("intake validator rejects a handoff that loses a material decision trace", () => {
  const result = runValidator(fixtureQaLog(), fixtureHandoff({ traceDecision: "D-99" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not trace material decision D-01/);
});

test("intake validator scopes decision matching to the trace table", () => {
  const handoff = fixtureHandoff({ traceDecision: "D-99" }).replace(
    "- UX-01 preserves input on save failure.",
    "- UX-01 preserves input on save failure and mentions D-01.",
  );
  const result = runValidator(fixtureQaLog(), handoff);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not trace material decision D-01/);
});

test("intake validator requires scenario cards to link decisions", () => {
  const result = runValidator(fixtureQaLog({ withLinkedDecisions: false }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing 'linked decisions'/);
});

test("intake validator rejects a non-empty linked-decisions field without a Decision Register ID", () => {
  const qa = fixtureQaLog().replace("- linked decisions: D-01", "- linked decisions: none");
  const result = runValidator(qa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must link at least one Decision Register ID/);
});

test("intake validator rejects duplicate Decision Register IDs", () => {
  const duplicateQa = fixtureQaLog().replace(
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |\n| D-01 | fact | Technical | Existing settings route is present | P1 | repo: src/settings/page.tsx | resolved | informs R1 |",
  );
  const result = runValidator(duplicateQa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicates Decision Register ID D-01/);
});

test("intake validator accepts a reversible agent-owned assumption", () => {
  const qa = fixtureQaLog().replace(
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "| D-01 | assumption | UX/design | Retry uses the existing default delay | P1 | agent default from existing repo behavior | resolved | R1, AC1, V1; revisit if retry policy changes |",
  );
  const result = runValidator(qa, fixtureHandoff());
  assert.equal(result.status, 0, result.stderr);
});

test("intake validator blocks handoff while raw notes still need normalization", () => {
  const qa = fixtureQaLog().replace("- needs_normalization: false", "- needs_normalization: true");
  const inProgress = runValidator(qa);
  assert.equal(inProgress.status, 0, inProgress.stderr);
  const handoff = runValidator(qa, fixtureHandoff());
  assert.notEqual(handoff.status, 0);
  assert.match(handoff.stderr, /needs_normalization is true/);
});
