"use strict";

const crypto = require("crypto");

// Bump this whenever gate-input validity changes so a PASS earned under an
// older prelint or semantic-source contract becomes STALE instead of being
// trusted by a newer CLI without revalidation.
const FRESHNESS_CONTRACT_VERSION = 2;

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
 * Single source shared by the TypeScript gate store (cli/src/gates/store.ts)
 * and the Stop-hook quick guard (cli/lib/hooks.js): both sides must agree on
 * the hash or a live PASS would read as STALE from one of them.
 */
function freshnessHash(content) {
  let body = content;
  const frontmatter = body.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatter) body = body.slice(frontmatter[0].length);
  body = body.replace(/^## Audit History\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, "");
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
 * strip, and every byte of a log is substance); documents hash their body;
 * config hashes raw bytes (JSON has no markdown body) and has a sentinel for
 * absence. Returns null when a file that must exist is gone, which the caller
 * reports as stale.
 */
function hashGateInput(absPath, kind) {
  const fs = require("fs");
  if (!fs.existsSync(absPath)) return kind === "config" ? ABSENT_INPUT : null;
  if (kind === "evidence" || kind === "config") return sha256Of(fs.readFileSync(absPath));
  return freshnessHash(fs.readFileSync(absPath, "utf8"));
}

module.exports = { ABSENT_INPUT, FRESHNESS_CONTRACT_VERSION, freshnessHash, hashGateInput, sha256Of };
