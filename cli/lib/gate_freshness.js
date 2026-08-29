"use strict";

const crypto = require("crypto");

// Bump this whenever gate-input validity changes so a PASS earned under an
// older prelint or semantic-source contract becomes STALE instead of being
// trusted by a newer CLI without revalidation.
const FRESHNESS_CONTRACT_VERSION = 3;

function sha256Of(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Freshness hashes the document substance, not its lifecycle bookkeeping.
 * Frontmatter (status/human_approval/updated_at flips) and the qa-log's
 * `## Audit History` section (where the gate's own result is recorded) change
 * legitimately AFTER a gate passes; hashing them would make every PASS
 * self-staling. Everything else in the body pins the PASS.
 *
 * `- decision_ids: ...` lines within the `## Raw Q&A` section of an INTERVIEW
 * QA-LOG document (PRD interview-anchor R4, D-06) are excluded too: `sasu
 * interview decision` now anchors consent onto a Raw Q&A turn at write time,
 * and a PASS sealed before that anchor was backfilled must stay PASS so a
 * qa-log under agents/interview/ can still be backfilled after the fact. The
 * tradeoff, accepted by the user over the agent's recommendation: an anchor
 * added after sealing is no longer provable against the sealed tree, so a
 * forged post-hoc anchor cannot be told apart from a real one by this hash
 * alone (audit falls back to the session transcript).
 *
 * `isQaLogDocument` is not guessed from content or path - it is the kind the
 * CALL SITE already knows: `readInputFile` in cli/src/gates/commands.ts is
 * always told which of its arguments is the qa-log (it also reads a PRD or a
 * contract through the same function), and that fact rides along on the
 * persisted GateInput as `kind: "qa-log"` so a later freshness recheck reads
 * the same fact rather than re-deriving it. A PRD or contract is never passed
 * `true` here, so a `- decision_ids:`-shaped line in one of those keeps
 * hashing normally (2026-08-29 fidelity review RF1/D1: a document-wide or
 * path-guessed exclusion would let a decision_ids mutation in ANY gate input
 * evade staleness, which is a materially wider exception than the one the
 * user approved - PRD 3장/11장 forbid exactly that expansion). No other line
 * and no other section is excluded, and only qa-log documents are eligible.
 *
 * Single source consumed by the TypeScript gate store (cli/src/gates/store.ts):
 * every reader of a pin must agree on the hash or a live PASS would read as
 * STALE.
 */
function stripRawQaDecisionIds(body) {
  const heading = "## Raw Q&A";
  const start = body.match(new RegExp(`^${heading}\\s*$`, "m"));
  if (!start) return body;
  const from = start.index;
  const rest = body.slice(from + start[0].length);
  const next = rest.match(/^## /m);
  const sectionEnd = next ? from + start[0].length + next.index : body.length;
  const section = body.slice(from, sectionEnd);
  const strippedSection = section.replace(/^-\s*decision_ids:.*$\n?/gm, "");
  return body.slice(0, from) + strippedSection + body.slice(sectionEnd);
}

function freshnessHash(content, isQaLogDocument) {
  let body = content;
  const frontmatter = body.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatter) body = body.slice(frontmatter[0].length);
  body = body.replace(/^## Audit History\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, "");
  if (isQaLogDocument) body = stripRawQaDecisionIds(body);
  return sha256Of(`sasu-gate-input-v${FRESHNESS_CONTRACT_VERSION}\n${body.trim()}`);
}

// The one input whose ABSENCE is a fact worth pinning: agents/config.json
// declares the mechanical commands a gate runs, so "no config" is a real
// declaration ("run the detected defaults"), not a missing file. Pinning only
// the present case left a hole of exactly the kind this harness exists to
// close: a config CREATED after a PASS was never compared against anything, so
// a freshly declared verify.commands.test rode to completion without ever
// running. A sentinel makes absent-vs-absent fresh and absent-vs-created
// stale, in both directions.
const ABSENT_INPUT = `sasu-gate-input-v${FRESHNESS_CONTRACT_VERSION}:absent`;

/**
 * Hash a recorded gate input as it sits on disk now, by its declared kind.
 * Evidence artifacts hash raw bytes (a screenshot has no markdown body to
 * strip, and every byte of a log is substance); "qa-log" and plain documents
 * both hash their markdown body, but only "qa-log" gets the Raw Q&A
 * decision_ids exclusion; config hashes raw bytes (JSON has no markdown body)
 * and has a sentinel for absence. Returns null when a file that must exist is
 * gone, which the caller reports as stale.
 */
function hashGateInput(absPath, kind) {
  const fs = require("fs");
  if (!fs.existsSync(absPath)) return kind === "config" ? ABSENT_INPUT : null;
  if (kind === "evidence" || kind === "config") return sha256Of(fs.readFileSync(absPath));
  return freshnessHash(fs.readFileSync(absPath, "utf8"), kind === "qa-log");
}

module.exports = { ABSENT_INPUT, FRESHNESS_CONTRACT_VERSION, freshnessHash, hashGateInput, sha256Of };
