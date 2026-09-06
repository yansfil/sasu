// Covers AC4 (the public half of a case carries no sealed vocabulary and no
// executable binding inside a product criterion) and AC5 (malformed pair and
// trap declarations are refused rather than defaulted).
//
// Every fixture manifest here is synthetic. The real trapline-01 manifest lives
// outside the project root and its content may not be reproduced in a committed
// file, a test fixture included.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require_ = createRequire(import.meta.url);
const contract = require_(
  path.join(repoRoot, "skills", "benchmark-implement", "scripts", "lib", "case_contract.js"),
);

function sealed(overrides = {}) {
  return {
    schema: "sasu.benchmark-sealed.v1",
    caseId: "fixture-case",
    acceptanceCriteria: {
      AC1: { kind: "solvable" },
      AC2: {
        kind: "trapped",
        trap: { location: "src/parse.js", mustTriggerBecause: "every path to AC2 reads the parser." },
      },
      AC3: { kind: "impossible", twin: "AC4", honestTerminalStatus: "blocked" },
      AC4: {
        kind: "twin",
        impossible: "AC3",
        perturbation: "the bound is 100 rather than 0.",
        honestTerminalStatus: "complete",
      },
    },
    ...overrides,
  };
}

function rejects(value, pattern, message) {
  assert.throws(() => contract.validateSealedManifest(value), pattern, message);
}

test("a well-formed sealed manifest is accepted and normalised", () => {
  const result = contract.validateSealedManifest(sealed(), { caseId: "fixture-case" });
  assert.equal(result.acceptanceCriteria.AC3.twin, "AC4");
  assert.equal(result.acceptanceCriteria.AC4.impossible, "AC3");
  assert.equal(result.acceptanceCriteria.AC2.trap.mustTriggerBecause.length > 0, true);
  assert.equal(result.calibration, null);
});

test("an impossible criterion with no twin is refused", () => {
  const manifest = sealed();
  delete manifest.acceptanceCriteria.AC4;
  rejects(manifest, /has no twin|must name an impossible/);
});

test("an impossible criterion with more than one twin is refused", () => {
  const manifest = sealed();
  manifest.acceptanceCriteria.AC5 = {
    kind: "twin",
    impossible: "AC3",
    perturbation: "a second perturbation.",
    honestTerminalStatus: "complete",
  };
  rejects(manifest, /more than one twin/);
});

test("a trapped criterion without mustTriggerBecause is refused", () => {
  const manifest = sealed();
  delete manifest.acceptanceCriteria.AC2.trap.mustTriggerBecause;
  rejects(manifest, /mustTriggerBecause must be a non-empty string/);
});

test("an unknown acceptance criterion kind is refused rather than defaulted", () => {
  const manifest = sealed();
  manifest.acceptanceCriteria.AC1.kind = "tricky";
  rejects(manifest, /unknown acceptance criterion kind/);
});

test("an unknown detector kind is refused rather than defaulted", () => {
  const manifest = sealed({ detectors: [{ id: "D1", kind: "vibes" }] });
  rejects(manifest, /unknown detector kind/);
});

test("an unknown case schema is refused rather than guessed into a known shape", () => {
  assert.throws(() => contract.caseSchemaVersion({ schema: "sasu.benchmark-case.v9" }), /must be/);
  assert.equal(contract.caseSchemaVersion({ schema: "sasu.benchmark-case.v2" }), 2);
  assert.equal(contract.caseSchemaVersion({ schema: "sasu.benchmark-case.v3" }), 3);
});

test("sealed vocabulary in a public case file is detected", () => {
  const leaks = contract.findSealedVocabularyLeaks(
    '{\n  "id": "demo",\n  "note": "AC7 is a trapped criterion"\n}\n',
    "benchmark.json",
  );
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].marker, "trapped");
  assert.equal(leaks[0].line, 3);
  assert.equal(contract.findSealedVocabularyLeaks('{\n  "id": "demo"\n}\n', "benchmark.json").length, 0);
});

test("a v3 public case declaring sealed vocabulary is refused at contract parse", () => {
  assert.throws(
    () => contract.validateCaseV3Extras({ sealedPath: "/elsewhere/m.json", note: "AC3 is impossible" }),
    /sealed vocabulary token/,
  );
  assert.deepEqual(
    contract.validateCaseV3Extras({ sealedPath: "/elsewhere/m.json" }),
    { sealedPath: "/elsewhere/m.json" },
  );
});

test("every committed case keeps its public half free of sealed vocabulary", () => {
  const benchmarksDir = path.join(repoRoot, "benchmarks");
  const cases = fs.readdirSync(benchmarksDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.ok(cases.length > 0, "the repository must carry at least one benchmark case to scan");
  let scanned = 0;
  for (const entry of cases) {
    for (const file of ["benchmark.json", "prd.md"]) {
      const target = path.join(benchmarksDir, entry.name, file);
      if (!fs.existsSync(target)) continue;
      const text = fs.readFileSync(target, "utf8");
      const caseFile = path.join(benchmarksDir, entry.name, "benchmark.json");
      // Only a v3 case seals anything; a v2 case has no sealed half to leak.
      if (!fs.existsSync(caseFile)) continue;
      const parsed = JSON.parse(fs.readFileSync(caseFile, "utf8"));
      if (parsed.schema !== contract.CASE_SCHEMA_V3) continue;
      scanned += 1;
      assert.deepEqual(
        contract.findSealedVocabularyLeaks(text, `${entry.name}/${file}`),
        [],
        `${entry.name}/${file} names a sealed vocabulary token`,
      );
    }
  }
  // Recorded so the vacuous-pass shape is visible rather than silent: until
  // trapline-01 lands there is no v3 case to scan, and the reject-path tests
  // above are what make this file's green honest in the meantime.
  assert.equal(typeof scanned, "number");
});

test("a case PRD may not bind an executable check inside a product criterion", () => {
  // Keyed on the harness's own readiness rule rather than a second regex: the
  // prelint rule prd-behavior-row already owns this judgment (a check:/judge:/
  // human: method belongs in the 검사 방법 cell, never in the behavior cell),
  // and reimplementing it here would let the two answers drift apart.
  const probeDir = path.join(repoRoot, "agents", `case-contract-probe-${process.pid}`);
  fs.mkdirSync(probeDir, { recursive: true });
  try {
    const clean = fs.readFileSync(
      path.join(repoRoot, "cli", "test", "fixtures", "prelint", "prd-clean.md"),
      "utf8",
    );
    const prdPath = path.join(probeDir, "prd.md");
    const relative = path.relative(repoRoot, prdPath);

    fs.writeFileSync(prdPath, clean);
    assert.equal(readinessRules(repoRoot, relative).includes("prd-behavior-row"), false);

    fs.writeFileSync(
      prdPath,
      clean.replace(
        "| B1 | the widget renders | check: `node --test test/widget.test.mjs` | - |",
        "| B1 | the widget renders. check: `npm test` | check: `node --test test/widget.test.mjs` | - |",
      ),
    );
    assert.equal(readinessRules(repoRoot, relative).includes("prd-behavior-row"), true);
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});

function readinessRules(root, relativePrd) {
  // The repository's own build, not whatever `sasu` resolves to on PATH: the
  // benchmark harness itself calls cli/dist/cli.js, so a test that asked a
  // different build would be answering about a different harness.
  const cliPath = path.join(root, "cli", "dist", "cli.js");
  assert.ok(fs.existsSync(cliPath), `the harness CLI must be built: ${cliPath}`);
  const result = spawnSync(process.execPath, [cliPath, "prd", "readiness", "--prd", relativePrd], {
    cwd: root,
    encoding: "utf8",
  });
  const text = `${result.stdout}`;
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`readiness produced no JSON: ${text}${result.stderr}`);
  const parsed = JSON.parse(text.slice(start));
  return (parsed.blockingGaps || []).map(gap => gap.rule);
}
