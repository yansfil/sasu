"use strict";

// Case contract schemas for the benchmark harness.
//
// A v3 case is split in two. The public half (`benchmark.json`, `prd.md`) is
// committed and copied into the run worktree like a v2 case. The sealed half -
// which acceptance criterion is a trap, which is impossible, which twin pairs
// with it - lives in a manifest outside the project root and is never
// committed. Deleting a committed file in the worktree is not sealing: the
// worktree `prepare-run` creates is `git worktree add --detach`
// (benchmark_report.js), so its .git points at the original object database and
// `git show HEAD:<path>` restores anything removed (measured 2026-08-30).
//
// v2 cases keep their own validation branch untouched. The only claim the v2
// path still has to support is that it fails where it always failed, so moving
// its checks would destroy the evidence rather than preserve the path.

const CASE_SCHEMA_V2 = "sasu.benchmark-case.v2";
const CASE_SCHEMA_V3 = "sasu.benchmark-case.v3";
const SEALED_SCHEMA = "sasu.benchmark-sealed.v1";

const AC_KINDS = new Set(["solvable", "trapped", "impossible", "twin"]);

// The detector list is owned here, not by a project config knob: a benchmark
// whose measuring instruments can be redefined per project measures nothing
// comparable across projects (AGENTS.md Review Guide 7).
const DETECTOR_KINDS = new Set(["command", "statePredicate", "eventOrder"]);

const TERMINAL_STATUSES = new Set(["complete", "partial", "blocked"]);

// Tokens that would tell the measured agent which criterion is which. They may
// not appear anywhere in the public half of a case.
const SEALED_VOCABULARY = ["impossible", "trapped", "twin", "mustTriggerBecause"];

const AC_ID = /^AC[1-9][0-9]*$/;

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function caseSchemaVersion(contract) {
  requirePlainObject(contract, "case");
  if (contract.schema === CASE_SCHEMA_V2) return 2;
  if (contract.schema === CASE_SCHEMA_V3) return 3;
  // No default branch: an unrecognised schema is refused rather than guessed
  // into the nearest known shape.
  throw new Error(`case.schema must be ${CASE_SCHEMA_V2} or ${CASE_SCHEMA_V3}`);
}

// The v3-only additions to the public case file. Everything a v2 case declares
// is still declared the same way; `validateCase` in the reporter runs the
// shared checks and then calls this.
function validateCaseV3Extras(contract) {
  const sealedPath = requireNonEmptyString(contract.sealedPath, "case.sealedPath");
  // Only presence and type here. Whether it actually resolves outside the
  // project root is a filesystem question, and it is answered at use time by
  // the sealing boundary check so that a manifest moved after authoring cannot
  // pass on a stale verdict.
  for (const marker of SEALED_VOCABULARY) {
    if (JSON.stringify(contract).toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`public case file must not carry the sealed vocabulary token: ${marker}`);
    }
  }
  return { sealedPath };
}

function validateTrap(entry, id) {
  const trap = requirePlainObject(entry.trap, `sealed.acceptanceCriteria.${id}.trap`);
  return {
    location: requireNonEmptyString(trap.location, `sealed.acceptanceCriteria.${id}.trap.location`),
    // The argument that the trap cannot be routed around is a sentence a person
    // judges. It is stored, never pattern-matched: scoring the plausibility of
    // prose with a regex would be a judgment pushed into code, which is exactly
    // what Review Guide 7 forbids.
    mustTriggerBecause: requireNonEmptyString(
      trap.mustTriggerBecause,
      `sealed.acceptanceCriteria.${id}.trap.mustTriggerBecause`,
    ),
  };
}

function validateSealedManifest(manifest, { caseId } = {}) {
  requirePlainObject(manifest, "sealed");
  if (manifest.schema !== SEALED_SCHEMA) {
    throw new Error(`sealed.schema must be ${SEALED_SCHEMA}`);
  }
  const declaredCaseId = requireNonEmptyString(manifest.caseId, "sealed.caseId");
  if (caseId !== undefined && declaredCaseId !== caseId) {
    throw new Error(`sealed.caseId ${declaredCaseId} does not match case id ${caseId}`);
  }

  const criteria = requirePlainObject(manifest.acceptanceCriteria, "sealed.acceptanceCriteria");
  const ids = Object.keys(criteria);
  if (ids.length === 0) throw new Error("sealed.acceptanceCriteria must not be empty");

  const kinds = new Map();
  const normalized = {};
  for (const id of ids) {
    if (!AC_ID.test(id)) throw new Error(`sealed.acceptanceCriteria key must be an AC id: ${id}`);
    const entry = requirePlainObject(criteria[id], `sealed.acceptanceCriteria.${id}`);
    const kind = requireNonEmptyString(entry.kind, `sealed.acceptanceCriteria.${id}.kind`);
    if (!AC_KINDS.has(kind)) {
      throw new Error(`unknown acceptance criterion kind for ${id}: ${kind}`);
    }
    kinds.set(id, kind);
    normalized[id] = { kind };
  }

  // Pair structure. An `impossible` with no twin, or with more than one twin,
  // is refused: the twin exists to deny a blanket-park or blanket-pass strategy
  // a full pair, and an unbalanced declaration silently removes that pressure.
  const twinsByImpossible = new Map();
  for (const [id, kind] of kinds) {
    if (kind !== "twin") continue;
    const entry = criteria[id];
    const partner = requireNonEmptyString(entry.impossible, `sealed.acceptanceCriteria.${id}.impossible`);
    if (kinds.get(partner) !== "impossible") {
      throw new Error(`sealed.acceptanceCriteria.${id}.impossible must name an impossible criterion`);
    }
    normalized[id].impossible = partner;
    normalized[id].perturbation = requireNonEmptyString(
      entry.perturbation,
      `sealed.acceptanceCriteria.${id}.perturbation`,
    );
    normalized[id].honestTerminalStatus = validateHonestTerminalStatus(entry, id);
    const seen = twinsByImpossible.get(partner) || [];
    seen.push(id);
    twinsByImpossible.set(partner, seen);
  }

  for (const [id, kind] of kinds) {
    if (kind === "impossible") {
      const declared = requireNonEmptyString(criteria[id].twin, `sealed.acceptanceCriteria.${id}.twin`);
      const backReferences = twinsByImpossible.get(id) || [];
      if (backReferences.length === 0) {
        throw new Error(`impossible criterion ${id} has no twin`);
      }
      if (backReferences.length > 1) {
        throw new Error(`impossible criterion ${id} has more than one twin: ${backReferences.join(", ")}`);
      }
      if (backReferences[0] !== declared) {
        throw new Error(`impossible criterion ${id} declares twin ${declared} but ${backReferences[0]} claims it`);
      }
      normalized[id].twin = declared;
      normalized[id].honestTerminalStatus = validateHonestTerminalStatus(criteria[id], id);
    }
    if (kind === "trapped") {
      normalized[id].trap = validateTrap(criteria[id], id);
    }
  }

  const detectors = validateDetectorDeclarations(manifest.detectors);
  const calibration = manifest.calibration === undefined
    ? null
    : validateCalibration(manifest.calibration);

  return {
    schema: SEALED_SCHEMA,
    caseId: declaredCaseId,
    acceptanceCriteria: normalized,
    detectors,
    calibration,
  };
}

function validateHonestTerminalStatus(entry, id) {
  const status = requireNonEmptyString(
    entry.honestTerminalStatus,
    `sealed.acceptanceCriteria.${id}.honestTerminalStatus`,
  );
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`unknown honest terminal status for ${id}: ${status}`);
  }
  return status;
}

function validateDetectorDeclarations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("sealed.detectors must be an array");
  const seen = new Set();
  return value.map((raw, index) => {
    const entry = requirePlainObject(raw, `sealed.detectors[${index}]`);
    const id = requireNonEmptyString(entry.id, `sealed.detectors[${index}].id`);
    if (seen.has(id)) throw new Error(`duplicate detector id: ${id}`);
    seen.add(id);
    const kind = requireNonEmptyString(entry.kind, `sealed.detectors[${index}].kind`);
    if (!DETECTOR_KINDS.has(kind)) {
      // Refused rather than defaulted. A detector whose kind the harness does
      // not know cannot be given a benefit-of-the-doubt pass without turning
      // the whole scoreboard into a guess (engineering principle 4).
      throw new Error(`unknown detector kind for ${id}: ${kind}`);
    }
    return { ...entry, id, kind };
  });
}

function validateCalibration(value) {
  const calibration = requirePlainObject(value, "sealed.calibration");
  return {
    hash: requireNonEmptyString(calibration.hash, "sealed.calibration.hash"),
    checkedAt: requireNonEmptyString(calibration.checkedAt, "sealed.calibration.checkedAt"),
    commands: requirePlainObject(calibration.commands, "sealed.calibration.commands"),
  };
}

// The public half of a case may not name the sealed vocabulary. This scans the
// raw bytes rather than a parsed view because a leak through a comment, a key
// name, or free prose is the same leak.
function findSealedVocabularyLeaks(text, label) {
  const leaks = [];
  for (const marker of SEALED_VOCABULARY) {
    const pattern = new RegExp(`\\b${marker}\\b`, "i");
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split("\n").length;
    leaks.push({ file: label, marker, line });
  }
  return leaks;
}

module.exports = {
  CASE_SCHEMA_V2,
  CASE_SCHEMA_V3,
  SEALED_SCHEMA,
  AC_KINDS,
  DETECTOR_KINDS,
  SEALED_VOCABULARY,
  caseSchemaVersion,
  validateCaseV3Extras,
  validateSealedManifest,
  validateDetectorDeclarations,
  findSealedVocabularyLeaks,
};
