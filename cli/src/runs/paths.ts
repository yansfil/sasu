import fs from "node:fs";
import path from "node:path";

// A single namespace for new and existing current-contract runs. Historical
// namespaces are never opened as current completion authority.
export const RUNS_ROOT = "agents/runs";
const LAST_LEGACY_SUPPORT = "488d3cc7d6e99742e7f68a1680fcb101710c8e20";
export function runDirRel(slug: string): string { return `${RUNS_ROOT}/${slug}`; }
function rejectLegacy(file: string, current: string): void {
  if (!fs.existsSync(current) && fs.existsSync(file)) throw new Error(`retired run namespace: ${file}; expected ${current}. Last support commit ${LAST_LEGACY_SUPPORT}; create a new current-contract run.`);
}
export function gatesDirFor(projectRoot: string, slug: string): string {
  const current = path.join(projectRoot, RUNS_ROOT, slug, "gates");
  rejectLegacy(path.join(projectRoot, "agents/gates", slug, "gates.json"), path.join(current, "gates.json"));
  return current;
}
export function implementStatePathFor(projectRoot: string, slug: string): string {
  const current = path.join(projectRoot, RUNS_ROOT, slug, "state.json");
  rejectLegacy(path.join(projectRoot, "agents/implement", slug, "state.json"), current);
  return current;
}
export const ACTIVE_POINTER_REL = path.join(RUNS_ROOT, ".prd-implement-active.json");
export const SESSION_POINTER_DIR_REL = path.join(RUNS_ROOT, ".active");
export function sessionPointerRel(sessionId: string): string { return path.join(SESSION_POINTER_DIR_REL, `${sessionId}.json`); }
export function activePointerWriteRel(sessionId: string | null): string { return sessionId === null ? ACTIVE_POINTER_REL : sessionPointerRel(sessionId); }
export function activePointerReadPath(projectRoot: string, sessionId: string | null): string {
  const candidates = [...(sessionId === null ? [] : [path.join(projectRoot, sessionPointerRel(sessionId))]), path.join(projectRoot, ACTIVE_POINTER_REL)];
  const current = candidates.find((file) => fs.existsSync(file));
  if (current) return current;
  rejectLegacy(path.join(projectRoot, "agents/implement/.prd-implement-active.json"), candidates.at(-1)!);
  return candidates.at(-1)!;
}
