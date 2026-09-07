import fs from "node:fs";
import { normalizeProjectPath, sha256, writeTextAtomic } from "./store";
import type { ImplementState } from "./types";

export interface PrdDriftDiagnostic {
  code: "prd-drift";
  sourcePath: string;
  snapshotPath: string;
  snapshotSha256: string;
  currentSha256: string | null;
  firstChangedLine: number | null;
  recovery: string;
}

export class PrdDriftError extends Error {
  readonly diagnostic: PrdDriftDiagnostic;

  constructor(diagnostic: PrdDriftDiagnostic) {
    super(
      `PRD changed after implement start:\n` +
      `- source: ${diagnostic.sourcePath}\n` +
      `- pinned snapshot: ${diagnostic.snapshotPath}\n` +
      `- snapshot sha256: ${diagnostic.snapshotSha256}\n` +
      `- current sha256: ${diagnostic.currentSha256 ?? "missing"}\n` +
      `- first changed line: ${diagnostic.firstChangedLine ?? "unknown"}\n` +
      `- recovery: ${diagnostic.recovery}`,
    );
    this.diagnostic = diagnostic;
  }
}

export function prdSnapshotPath(runDir: string): string {
  return `${runDir}/prd.md`;
}

export function writePrdSnapshot(recordRoot: string, snapshotPath: string, text: string): void {
  const resolved = normalizeProjectPath(recordRoot, snapshotPath);
  writeTextAtomic(resolved.absolute, text);
}

function firstChangedLine(left: string, right: string): number | null {
  const before = left.split("\n");
  const after = right.split("\n");
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] !== after[index]) return index + 1;
  }
  return null;
}

export function pinnedPrd(recordRoot: string, state: ImplementState): {
  text: string;
  drift: PrdDriftDiagnostic | null;
} {
  const snapshot = normalizeProjectPath(recordRoot, state.prd.snapshotPath);
  if (!fs.existsSync(snapshot.absolute) || !fs.statSync(snapshot.absolute).isFile()) {
    throw new Error(`pinned PRD snapshot missing: ${state.prd.snapshotPath}`);
  }
  const text = fs.readFileSync(snapshot.absolute, "utf8");
  const snapshotHash = sha256(text);
  if (snapshotHash !== state.prd.sha256) {
    throw new Error(`pinned PRD snapshot hash changed: ${state.prd.snapshotPath}`);
  }
  const source = normalizeProjectPath(recordRoot, state.prdPath);
  const current = fs.existsSync(source.absolute) && fs.statSync(source.absolute).isFile()
    ? fs.readFileSync(source.absolute, "utf8")
    : null;
  const currentHash = current === null ? null : sha256(current);
  if (currentHash === state.prd.sha256) return { text, drift: null };
  return {
    text,
    drift: {
      code: "prd-drift",
      sourcePath: state.prdPath,
      snapshotPath: state.prd.snapshotPath,
      snapshotSha256: state.prd.sha256,
      currentSha256: currentHash,
      firstChangedLine: current === null ? null : firstChangedLine(text, current),
      recovery: "Restore the source PRD to the pinned snapshot bytes, or apply the correction with implement amend. An observer may amend check cells without adoption or human approval; other changes require --issuer human with --approval. The existing run and unaffected proofs are preserved.",
    },
  };
}

export function requirePinnedPrd(recordRoot: string, state: ImplementState): string {
  const held = pinnedPrd(recordRoot, state);
  if (held.drift !== null) throw new PrdDriftError(held.drift);
  return held.text;
}
