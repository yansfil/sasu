import fs from "node:fs";
import path from "node:path";

/**
 * Single authority for where a run lives inside a target project. One slug
 * names one run, and the two state models share its directory without sharing
 * a file:
 *
 *   agents/runs/<slug>/
 *     gates/gates.json     gate verdicts (gates state model)
 *     gates/artifacts/     gate run artifacts
 *     state.json           implement state model (schema v3, unchanged)
 *     artifacts/ review/   implement outputs, derived from state.runDir
 *   agents/runs/.prd-implement-active.json
 *
 * Gates may run before an implement run exists: a run directory holding only
 * gates/ is a valid pre-implementation run, and `implement start` later joins
 * it under the same slug.
 *
 * Runs recorded before the unified layout stay readable where they are:
 * resolution prefers the unified path and falls back to the legacy namespace
 * (agents/gates/<slug>, agents/implement/<slug>) only when the legacy record
 * exists and the unified one does not. A legacy run keeps writing in place so
 * its record stays singular (PRINCIPLES item 10); nothing migrates silently,
 * and every new run lands unified.
 */
export const RUNS_ROOT = "agents/runs";

/** Project-relative run directory for a NEW run (posix separators, state.runDir format). */
export function runDirRel(slug: string): string {
  return `${RUNS_ROOT}/${slug}`;
}

/** Absolute gates directory for a slug, honoring an existing legacy record. */
export function gatesDirFor(projectRoot: string, slug: string): string {
  const unified = path.join(projectRoot, "agents", "runs", slug, "gates");
  const legacy = path.join(projectRoot, "agents", "gates", slug);
  if (!fs.existsSync(path.join(unified, "gates.json")) && fs.existsSync(path.join(legacy, "gates.json"))) {
    return legacy;
  }
  return unified;
}

/** Absolute implement state.json path for a slug, honoring an existing legacy record. */
export function implementStatePathFor(projectRoot: string, slug: string): string {
  const unified = path.join(projectRoot, "agents", "runs", slug, "state.json");
  const legacy = path.join(projectRoot, "agents", "implement", slug, "state.json");
  if (!fs.existsSync(unified) && fs.existsSync(legacy)) return legacy;
  return unified;
}

export const ACTIVE_POINTER_REL = path.join("agents", "runs", ".prd-implement-active.json");
export const LEGACY_ACTIVE_POINTER_REL = path.join("agents", "implement", ".prd-implement-active.json");
export const SESSION_POINTER_DIR_REL = path.join("agents", "runs", ".active");

/**
 * The active pointer is per session: one shared singleton meant one project-
 * wide "current run", so a second session's `implement start` silently stole
 * every bare `status`/`verify`/`finalize` from the first. A session writes
 * its own bookmark under `.active/<sessionId>.json`; the singleton remains
 * only for sessionless contexts (bare shell, CI) and legacy runs.
 */
export function sessionPointerRel(sessionId: string): string {
  return path.join(SESSION_POINTER_DIR_REL, `${sessionId}.json`);
}

/** Where this invocation WRITES its active pointer. */
export function activePointerWriteRel(sessionId: string | null): string {
  return sessionId === null ? ACTIVE_POINTER_REL : sessionPointerRel(sessionId);
}

/**
 * Where to READ the active pointer: this session's own bookmark first, then
 * the sessionless singleton, then a surviving legacy pointer. The singleton
 * fallback keeps runs started without a session identity reachable from any
 * session; runs started by another session are never resolved implicitly.
 */
export function activePointerReadPath(projectRoot: string, sessionId: string | null): string {
  const candidates = [
    ...(sessionId === null ? [] : [path.join(projectRoot, sessionPointerRel(sessionId))]),
    path.join(projectRoot, ACTIVE_POINTER_REL),
    path.join(projectRoot, LEGACY_ACTIVE_POINTER_REL),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(projectRoot, ACTIVE_POINTER_REL);
}
