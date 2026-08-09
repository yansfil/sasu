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

/**
 * Hash a recorded gate input as it sits on disk now, by its declared kind.
 * Evidence artifacts hash raw bytes (a screenshot has no markdown body to
 * strip, and every byte of a log is substance); documents hash their body.
 * Returns null when the file is gone, which the caller reports as stale.
 */
function hashGateInput(absPath, kind) {
  const fs = require("fs");
  if (!fs.existsSync(absPath)) return null;
  if (kind === "evidence") return sha256Of(fs.readFileSync(absPath));
  return freshnessHash(fs.readFileSync(absPath, "utf8"));
}

module.exports = { FRESHNESS_CONTRACT_VERSION, freshnessHash, hashGateInput, sha256Of };
