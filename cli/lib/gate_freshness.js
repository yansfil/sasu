"use strict";

const crypto = require("crypto");

// Bump this whenever gate-input validity changes so a PASS earned under an
// older prelint or semantic-source contract becomes STALE instead of being
// trusted by a newer CLI without revalidation.
// v4 (2026-08-30): the qa-log decision_ids line exclusion is retired in favor
// of the structural Addendum section - see freshnessHash.
const FRESHNESS_CONTRACT_VERSION = 4;

function sha256Of(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Freshness hashes the document substance, not its lifecycle bookkeeping.
 * The rule is structural, and there is exactly one of it: the sealed hash
 * covers everything in the body EXCEPT the frontmatter lifecycle block and
 * the harness-owned append sections - `## Audit History` (where the gate's
 * own result is recorded) and `## Addendum` (where `sasu interview decision`
 * records decisions made after gap-audit sealed the log). Those change
 * legitimately AFTER a gate passes; hashing them would make every PASS
 * self-staling. Everything else pins the PASS, in every document kind.
 *
 * v4 retired the line-shaped exception this replaced (interview-anchor
 * R4/AC7, D-06: `- decision_ids:` lines inside `## Raw Q&A` of a qa-log were
 * unhashed so anchors could be backfilled into a sealed log). That exception
 * was patched twice and leaked twice: its first cut excluded the line in
 * every document kind (2026-08-29 fidelity review RF1), and its final cut
 * still let arbitrary prose ride the excluded line into a sealed document
 * unnoticed (2026-08-30 code review). The user re-decided the D-06 tradeoff
 * on 2026-08-29: post-seal decisions land in the Addendum as self-contained
 * entries, and an edit to sealed lines - anchors included - honestly stales
 * the PASS, which under the delta re-judgment contract costs one reopen
 * round instead of a fresh review cycle.
 *
 * Single source consumed by the TypeScript gate store (cli/src/gates/store.ts):
 * every reader of a pin must agree on the hash or a live PASS would read as
 * STALE.
 */
function freshnessHash(content) {
  let body = content;
  const frontmatter = body.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatter) body = body.slice(frontmatter[0].length);
  body = body.replace(/^## Audit History\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, "");
  body = body.replace(/^## Addendum\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, "");
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
 * strip, and every byte of a log is substance); documents - qa-log included -
 * hash their markdown body under the one structural rule above; config hashes
 * raw bytes (JSON has no markdown body) and has a sentinel for absence.
 * Returns null when a file that must exist is gone, which the caller reports
 * as stale.
 */
function hashGateInput(absPath, kind) {
  const fs = require("fs");
  if (!fs.existsSync(absPath)) return kind === "config" ? ABSENT_INPUT : null;
  if (kind === "evidence" || kind === "config") return sha256Of(fs.readFileSync(absPath));
  return freshnessHash(fs.readFileSync(absPath, "utf8"));
}

module.exports = { ABSENT_INPUT, FRESHNESS_CONTRACT_VERSION, freshnessHash, hashGateInput, sha256Of };
