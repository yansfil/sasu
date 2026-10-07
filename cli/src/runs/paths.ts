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
