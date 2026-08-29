import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  IMPLEMENT_ACTIVE_SCHEMA,
  IMPLEMENT_SCHEMA,
  type ImplementActivePointer,
  type ImplementState,
  type DirtyAttribution,
  type SourceEntry,
  type SourceSnapshot,
  type IssuedCommand,
} from "./types";
import { ISSUED_COMMANDS } from "./verbs";
import { ACTIVE_POINTER_REL, activePointerReadPath, activePointerWriteRel, implementStatePathFor } from "../runs/paths";
import { currentSessionId } from "../runs/session";

export const ACTIVE_POINTER = ACTIVE_POINTER_REL;

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function normalizeProjectPath(projectRoot: string, input: string): { absolute: string; relative: string } {
  const absolute = path.resolve(projectRoot, input);
  const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`path escapes project root: ${input}`);
  }
  return { absolute, relative: relative || "." };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, file);
}

export function statePathFor(projectRoot: string, slug: string): string {
  return implementStatePathFor(projectRoot, slug);
}

export function writeActivePointer(projectRoot: string, state: ImplementState, sessionId: string | null = currentSessionId()): void {
  const statePathRel = path.relative(projectRoot, statePathFor(projectRoot, state.topicSlug)).split(path.sep).join("/");
  const pointer: ImplementActivePointer = {
    schema: IMPLEMENT_ACTIVE_SCHEMA,
    statePath: statePathRel,
    topicSlug: state.topicSlug,
    updatedAt: nowIso(),
  };
  writeJsonAtomic(path.join(projectRoot, activePointerWriteRel(sessionId)), pointer);
  // A worktree run gets a second bookmark inside its judged tree, carrying an
  // explicit record-tree root: bare commands typed from either tree then
  // resolve the same record. Bookmarks are navigation, not authority, so the
  // duplicate is harmless; ownership lives in state.json alone.
  const worktreePath = state.worktree?.path;
  if (worktreePath !== undefined && fs.existsSync(worktreePath)) {
    writeJsonAtomic(path.join(worktreePath, activePointerWriteRel(sessionId)), { ...pointer, projectRoot });
  }
}

/** Slugs with a recorded run, unified or legacy - the `--slug` menu for a session with no pointer. */
function runCandidates(projectRoot: string): string[] {
  const slugs = new Set<string>();
  for (const namespace of [path.join("agents", "runs"), path.join("agents", "implement")]) {
    const dir = path.join(projectRoot, namespace);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "state.json"))) slugs.add(entry.name);
    }
  }
  return [...slugs].sort();
}

export function resolveStatePath(projectRoot: string, options: { slug?: string; state?: string } = {}): string {
  if (options.state !== undefined) return normalizeProjectPath(projectRoot, options.state).absolute;
  if (options.slug !== undefined) return statePathFor(projectRoot, options.slug);
  const pointerPath = activePointerReadPath(projectRoot, currentSessionId());
  if (!fs.existsSync(pointerPath)) {
    const candidates = runCandidates(projectRoot);
    const menu = candidates.length === 0 ? "" : ` (existing runs: ${candidates.join(", ")})`;
    throw new Error(`no active implement run for this session; pass --slug <topic>${menu} or start one with \`sasu implement start --prd <path>\``);
  }
  const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8")) as Partial<ImplementActivePointer>;
  if (parsed.schema !== IMPLEMENT_ACTIVE_SCHEMA || typeof parsed.statePath !== "string") {
    throw new Error(`unsupported active pointer schema in ${ACTIVE_POINTER}; start a new run with \`sasu implement start --prd <path>\``);
  }
  // A redirect bookmark (inside a run's worktree) names its record tree.
  const recordRoot = typeof parsed.projectRoot === "string" && parsed.projectRoot !== "" ? parsed.projectRoot : projectRoot;
  return normalizeProjectPath(recordRoot, parsed.statePath).absolute;
}

/**
 * The tree whose bytes are judged: the run's worktree when isolated, else
 * the record tree. Fails loudly when the worktree is gone - a silently
 * substituted record tree would judge the wrong bytes and stale every proof.
 */
export function requireWorkRoot(state: ImplementState): string {
  const worktree = state.worktree ?? null;
  if (worktree === null) return state.projectRoot;
  if (!fs.existsSync(worktree.path)) {
    throw new Error(
      `worktree missing: ${worktree.path}. Recreate it with \`git worktree add ${worktree.path} ${worktree.branch}\` ` +
        "(uncommitted work in the removed worktree is lost) and continue, or close the run honestly",
    );
  }
  return worktree.path;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`malformed implement state: ${label} must be a non-empty string`);
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null) assertString(value, label);
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`malformed implement state: ${label} must be an ISO timestamp`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`malformed implement state: ${label} must be a SHA-256 hex digest`);
  }
}

function assertStringArray(value: unknown, label: string, nonEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || !value.every((entry) => typeof entry === "string" && entry !== "")) {
    throw new Error(`malformed implement state: ${label} must be ${nonEmpty ? "a non-empty" : "a"} string array`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`malformed implement state: ${label} must be an object`);
  }
}

function assertSourceEntries(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`malformed implement state: ${label} must be an array`);
  for (const [index, entry] of value.entries()) {
    assertRecord(entry, `${label}[${index}]`);
    assertString(entry["path"], `${label}[${index}].path`);
    assertString(entry["state"], `${label}[${index}].state`);
    assertNullableString(entry["sha256"], `${label}[${index}].sha256`);
  }
}

function assertInputManifest(value: unknown, label: string): void {
  assertRecord(value, label);
  assertSourceEntries(value["source"], `${label}.source`);
  if (!Array.isArray(value["evidence"])) throw new Error(`malformed implement state: ${label}.evidence must be an array`);
  for (const [index, entry] of value["evidence"].entries()) {
    assertRecord(entry, `${label}.evidence[${index}]`);
    if (entry["verificationId"] === undefined && entry["acceptanceCriterionId"] === undefined) {
      throw new Error(`malformed implement state: ${label}.evidence[${index}] must name verificationId or acceptanceCriterionId`);
    }
    if (entry["verificationId"] !== undefined) assertString(entry["verificationId"], `${label}.evidence[${index}].verificationId`);
    if (entry["acceptanceCriterionId"] !== undefined) assertString(entry["acceptanceCriterionId"], `${label}.evidence[${index}].acceptanceCriterionId`);
    assertString(entry["path"], `${label}.evidence[${index}].path`);
    assertString(entry["sha256"], `${label}.evidence[${index}].sha256`);
  }
  assertRecord(value["checkLedger"], `${label}.checkLedger`);
  assertSha256(value["checkLedger"]["sha256"], `${label}.checkLedger.sha256`);
  if (!Array.isArray(value["checkLedger"]["bindings"])) {
    throw new Error(`malformed implement state: ${label}.checkLedger.bindings must be an array`);
  }
  for (const [index, binding] of value["checkLedger"]["bindings"].entries()) {
    assertRecord(binding, `${label}.checkLedger.bindings[${index}]`);
    for (const field of ["criterionId", "bindingId", "command", "cwd"] as const) {
      assertString(binding[field], `${label}.checkLedger.bindings[${index}].${field}`);
    }
    assertStringArray(binding["argv"], `${label}.checkLedger.bindings[${index}].argv`, true);
    if (binding["classification"] !== "asset" && binding["classification"] !== "labor") {
      throw new Error(`malformed implement state: ${label}.checkLedger.bindings[${index}].classification is invalid`);
    }
  }
}

function assertRoundContext(value: unknown, label: string): void {
  assertRecord(value, label);
  assertNullableString(value["priorAttemptId"], `${label}.priorAttemptId`);
  if (!Array.isArray(value["changedPaths"]) || !value["changedPaths"].every((entry) => typeof entry === "string")) {
    throw new Error(`malformed implement state: ${label}.changedPaths must be a string array`);
  }
  if (!Array.isArray(value["newEvidence"])) throw new Error(`malformed implement state: ${label}.newEvidence must be an array`);
  for (const [index, entry] of value["newEvidence"].entries()) {
    assertRecord(entry, `${label}.newEvidence[${index}]`);
    if (entry["verificationId"] === undefined && entry["acceptanceCriterionId"] === undefined) {
      throw new Error(`malformed implement state: ${label}.newEvidence[${index}] must name verificationId or acceptanceCriterionId`);
    }
    if (entry["verificationId"] !== undefined) assertString(entry["verificationId"], `${label}.newEvidence[${index}].verificationId`);
    if (entry["acceptanceCriterionId"] !== undefined) assertString(entry["acceptanceCriterionId"], `${label}.newEvidence[${index}].acceptanceCriterionId`);
    assertString(entry["path"], `${label}.newEvidence[${index}].path`);
    assertString(entry["sha256"], `${label}.newEvidence[${index}].sha256`);
  }
}

function assertAcceptanceCriteria(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`malformed implement state: ${label} must be an array`);
  const criterionIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    assertRecord(entry, `${label}[${index}]`);
    assertString(entry["id"], `${label}[${index}].id`);
    if (criterionIds.has(entry["id"])) throw new Error(`malformed implement state: duplicate acceptance criterion ${entry["id"]}`);
    criterionIds.add(entry["id"]);
    if (entry["judgment"] !== "machine" && entry["judgment"] !== "judged" && entry["judgment"] !== "machine+gate:human") {
      throw new Error(`malformed implement state: ${label}[${index}].judgment is invalid`);
    }
    if (entry["judgment"] === "judged") assertString(entry["evidenceDeclaration"], `${label}[${index}].evidenceDeclaration`);
    assertRecord(entry["check"], `${label}[${index}].check`);
    if (entry["check"]["status"] !== "pending" && entry["check"]["status"] !== "green" && entry["check"]["status"] !== "parked") {
      throw new Error(`malformed implement state: ${label}[${index}].check.status is invalid`);
    }
    for (const field of ["bindings", "attempts", "decisionPoints", "parks"] as const) {
      if (!Array.isArray(entry["check"][field])) throw new Error(`malformed implement state: ${label}[${index}].check.${field} must be an array`);
    }
    if (!Number.isInteger(entry["check"]["consecutiveFailures"]) || Number(entry["check"]["consecutiveFailures"]) < 0) {
      throw new Error(`malformed implement state: ${label}[${index}].check.consecutiveFailures must be a non-negative integer`);
    }

    const check = entry["check"];
    const bindings = check["bindings"] as unknown[];
    const bindingIds = new Set<string>();
    for (const [bindingIndex, binding] of bindings.entries()) {
      const bindingLabel = `${label}[${index}].check.bindings[${bindingIndex}]`;
      assertRecord(binding, bindingLabel);
      if (binding["id"] !== `B${bindingIndex + 1}`) throw new Error(`malformed implement state: ${bindingLabel}.id must be B${bindingIndex + 1}`);
      bindingIds.add(binding["id"] as string);
      assertString(binding["command"], `${bindingLabel}.command`);
      assertStringArray(binding["argv"], `${bindingLabel}.argv`, true);
      assertString(binding["cwd"], `${bindingLabel}.cwd`);
      if (binding["classification"] !== "asset" && binding["classification"] !== "labor") {
        throw new Error(`malformed implement state: ${bindingLabel}.classification is invalid`);
      }
      assertIsoTimestamp(binding["boundAt"], `${bindingLabel}.boundAt`);
      if (bindingIndex === 0) {
        if (binding["reason"] !== null) throw new Error(`malformed implement state: ${bindingLabel}.reason must be null for the first binding`);
      } else {
        assertString(binding["reason"], `${bindingLabel}.reason`);
      }
    }

    const attempts = check["attempts"] as unknown[];
    const attemptIds = new Set<string>();
    const consumedHumanWindows = new Set<string>();
    let lastAttemptBindingIndex = -1;
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const attemptLabel = `${label}[${index}].check.attempts[${attemptIndex}]`;
      assertRecord(attempt, attemptLabel);
      if (attempt["id"] !== `A${attemptIndex + 1}`) throw new Error(`malformed implement state: ${attemptLabel}.id must be A${attemptIndex + 1}`);
      attemptIds.add(attempt["id"] as string);
      assertString(attempt["bindingId"], `${attemptLabel}.bindingId`);
      if (!bindingIds.has(attempt["bindingId"] as string)) throw new Error(`malformed implement state: ${attemptLabel}.bindingId names no binding`);
      const attemptBindingIndex = bindings.findIndex((binding) => (binding as Record<string, unknown>)["id"] === attempt["bindingId"]);
      if (attemptBindingIndex < lastAttemptBindingIndex) throw new Error(`malformed implement state: ${attemptLabel}.bindingId moves backward in append-only binding history`);
      lastAttemptBindingIndex = attemptBindingIndex;
      assertIsoTimestamp(attempt["startedAt"], `${attemptLabel}.startedAt`);
      assertIsoTimestamp(attempt["finishedAt"], `${attemptLabel}.finishedAt`);
      if (!Number.isInteger(attempt["durationMs"]) || Number(attempt["durationMs"]) < 0) {
        throw new Error(`malformed implement state: ${attemptLabel}.durationMs must be a non-negative integer`);
      }
      if (!Number.isInteger(attempt["exitCode"])) throw new Error(`malformed implement state: ${attemptLabel}.exitCode must be an integer`);
      if (typeof attempt["timedOut"] !== "boolean") throw new Error(`malformed implement state: ${attemptLabel}.timedOut must be boolean`);
      if (attempt["signal"] !== null && (typeof attempt["signal"] !== "string" || !/^SIG[A-Z0-9]+$/.test(attempt["signal"]))) {
        throw new Error(`malformed implement state: ${attemptLabel}.signal is invalid`);
      }
      if (attempt["outcome"] !== "green" && attempt["outcome"] !== "failed") {
        throw new Error(`malformed implement state: ${attemptLabel}.outcome is invalid`);
      }
      const isGreen = attempt["exitCode"] === 0 && attempt["timedOut"] === false && attempt["signal"] === null;
      if ((attempt["outcome"] === "green") !== isGreen) throw new Error(`malformed implement state: ${attemptLabel}.outcome contradicts the recorded process result`);
      assertSha256(attempt["outputFingerprint"], `${attemptLabel}.outputFingerprint`);
      if (isGreen) {
        if (attempt["failureClass"] !== null) throw new Error(`malformed implement state: ${attemptLabel}.failureClass must be null for green`);
      } else {
        assertSha256(attempt["failureClass"], `${attemptLabel}.failureClass`);
      }
      assertRecord(attempt["tree"], `${attemptLabel}.tree`);
      for (const field of ["all", "product", "bookkeeping"] as const) assertSha256(attempt["tree"][field], `${attemptLabel}.tree.${field}`);
      if (entry["judgment"] === "machine+gate:human") {
        assertRecord(attempt["humanWindow"], `${attemptLabel}.humanWindow`);
        assertString(attempt["humanWindow"]["evidence"], `${attemptLabel}.humanWindow.evidence`);
        assertIsoTimestamp(attempt["humanWindow"]["recordedAt"], `${attemptLabel}.humanWindow.recordedAt`);
        if (attempt["humanWindow"]["criterionId"] !== entry["id"]) throw new Error(`malformed implement state: ${attemptLabel}.humanWindow.criterionId must match ${entry["id"]}`);
        if (consumedHumanWindows.has(attempt["humanWindow"]["evidence"] as string)) throw new Error(`malformed implement state: ${attemptLabel}.humanWindow.evidence was consumed more than once`);
        consumedHumanWindows.add(attempt["humanWindow"]["evidence"] as string);
      } else if (attempt["humanWindow"] !== null) {
        throw new Error(`malformed implement state: ${attemptLabel}.humanWindow is valid only for machine+gate:human`);
      }
    }

    const parks = check["parks"] as unknown[];
    let activePark = false;
    let latestResume: string | null = null;
    for (const [parkIndex, park] of parks.entries()) {
      const parkLabel = `${label}[${index}].check.parks[${parkIndex}]`;
      assertRecord(park, parkLabel);
      assertIsoTimestamp(park["parkedAt"], `${parkLabel}.parkedAt`);
      if (park["parkedBy"] !== "human" && park["parkedBy"] !== "observer") throw new Error(`malformed implement state: ${parkLabel}.parkedBy must be human or observer`);
      // A human park quotes the approval that authorised it; an observer park
      // has no quote to give and stands on the harness's own open decision
      // point instead (AC20). Demanding a non-empty string from both wrote a
      // state the next read refused - the write path and the read path
      // disagreeing about one field, the same species as the verb vocabulary.
      if (park["parkedBy"] === "human") {
        assertString(park["approval"], `${parkLabel}.approval`);
      } else if (typeof park["approval"] !== "string" || park["approval"] !== "") {
        throw new Error(`malformed implement state: ${parkLabel}.approval must be empty for an observer park`);
      }
      assertString(park["reason"], `${parkLabel}.reason`);
      assertNullableString(park["evidence"], `${parkLabel}.evidence`);
      if (park["resumedAt"] === null) {
        if (parkIndex !== parks.length - 1) throw new Error(`malformed implement state: only the latest park may be active`);
        activePark = true;
      } else {
        assertIsoTimestamp(park["resumedAt"], `${parkLabel}.resumedAt`);
        latestResume = park["resumedAt"] as string;
      }
    }
    if (check["bookkeeping"] !== undefined) {
      if (!Array.isArray(check["bookkeeping"])) {
        throw new Error(`malformed implement state: ${label}[${index}].check.bookkeeping must be an array`);
      }
      const seen = new Set<string>();
      for (const [targetIndex, target] of check["bookkeeping"].entries()) {
        const targetLabel = `${label}[${index}].check.bookkeeping[${targetIndex}]`;
        assertRecord(target, targetLabel);
        assertString(target["path"], `${targetLabel}.path`);
        if (!String(target["path"]).startsWith("agents/")) {
          throw new Error(`malformed implement state: ${targetLabel}.path must be under agents/`);
        }
        // A duplicate would carry a second baseline for one file, and the
        // proof is "moved from THE baseline" - two baselines is no baseline.
        if (seen.has(String(target["path"]))) {
          throw new Error(`malformed implement state: duplicate bookkeeping target ${target["path"]}`);
        }
        seen.add(String(target["path"]));
        if (target["baselineSha256"] !== null) assertSha256(target["baselineSha256"], `${targetLabel}.baselineSha256`);
        assertIsoTimestamp(target["declaredAt"], `${targetLabel}.declaredAt`);
      }
    }
    if ((check["status"] === "parked") !== activePark) throw new Error(`malformed implement state: ${label}[${index}].check.status contradicts park history`);

    const decisions = check["decisionPoints"] as unknown[];
    for (const [decisionIndex, decision] of decisions.entries()) {
      const decisionLabel = `${label}[${index}].check.decisionPoints[${decisionIndex}]`;
      assertRecord(decision, decisionLabel);
      if (decision["id"] !== `DP${decisionIndex + 1}`) throw new Error(`malformed implement state: ${decisionLabel}.id must be DP${decisionIndex + 1}`);
      if (decision["kind"] !== "same-class" && decision["kind"] !== "five-failures" && decision["kind"] !== "tools-only") {
        throw new Error(`malformed implement state: ${decisionLabel}.kind is invalid`);
      }
      assertIsoTimestamp(decision["openedAt"], `${decisionLabel}.openedAt`);
      assertString(decision["attemptId"], `${decisionLabel}.attemptId`);
      if (!attemptIds.has(decision["attemptId"] as string)) throw new Error(`malformed implement state: ${decisionLabel}.attemptId names no attempt`);
      assertString(decision["message"], `${decisionLabel}.message`);
      const resolution = decision["resolution"];
      if (decision["resolvedAt"] === null || resolution === null) {
        if (decision["resolvedAt"] !== null || resolution !== null) throw new Error(`malformed implement state: ${decisionLabel} must resolve time and outcome together`);
      } else {
        assertIsoTimestamp(decision["resolvedAt"], `${decisionLabel}.resolvedAt`);
        if (resolution !== "green" && resolution !== "parked" && resolution !== "rebound") throw new Error(`malformed implement state: ${decisionLabel}.resolution is invalid`);
      }
    }

    const currentBinding = bindings.at(-1) as Record<string, unknown> | undefined;
    const currentAttempts = currentBinding === undefined
      ? []
      : attempts.filter((attempt) => (attempt as Record<string, unknown>)["bindingId"] === currentBinding["id"]) as Array<Record<string, unknown>>;
    const latestAttempt = currentAttempts.at(-1);
    const attemptAfterResume = latestAttempt !== undefined && (latestResume === null || (latestAttempt["finishedAt"] as string) >= latestResume);
    const derivedStatus = activePark ? "parked" : attemptAfterResume && latestAttempt?.["outcome"] === "green" ? "green" : "pending";
    if (check["status"] !== derivedStatus) throw new Error(`malformed implement state: ${label}[${index}].check.status ${String(check["status"])} contradicts the harness-owned attempt ledger (expected ${derivedStatus})`);
    const attemptsAfterResume = currentAttempts.filter((attempt) => latestResume === null || (attempt["finishedAt"] as string) >= latestResume);
    let derivedFailures = 0;
    for (const attempt of attemptsAfterResume.slice().reverse()) {
      if (attempt["outcome"] === "green") break;
      derivedFailures += 1;
    }
    if (check["consecutiveFailures"] !== derivedFailures) {
      throw new Error(`malformed implement state: ${label}[${index}].check.consecutiveFailures contradicts the harness-owned attempt ledger (expected ${derivedFailures})`);
    }
  }
}

function assertRoundContexts(value: unknown, label: string): void {
  assertRecord(value, label);
  assertRecord(value["acceptance"], `${label}.acceptance`);
  for (const [criterionId, context] of Object.entries(value["acceptance"])) {
    assertRoundContext(context, `${label}.acceptance.${criterionId}`);
  }
  assertRoundContext(value["fidelity"], `${label}.fidelity`);
  if (value["risk"] !== null) assertRoundContext(value["risk"], `${label}.risk`);
}

const ISSUER_LABELS = new Set(["implementor", "observer", "human"]);

/**
 * v7's six append-only ledgers. Validated as required fields rather than
 * normalized-if-missing (the way riskFindings was in v5): a v7 state that
 * lacks its sealed suite list cannot be told apart from one whose suite was
 * genuinely empty, and completion authority must never guess (PRINCIPLES 10).
 */
function assertSupervisionLedgers(candidate: Partial<ImplementState>): void {
  if (!Array.isArray(candidate.events)) throw new Error("malformed implement state: events must be an array");
  let previousEventId = 0;
  for (const [index, entry] of candidate.events.entries()) {
    assertRecord(entry, `events[${index}]`);
    const id = entry["id"];
    if (typeof id !== "number" || !Number.isInteger(id) || id <= previousEventId) {
      throw new Error(`malformed implement state: events[${index}].id must be an integer greater than the previous event id`);
    }
    previousEventId = id;
    assertString(entry["at"], `events[${index}].at`);
    assertString(entry["kind"], `events[${index}].kind`);
    if (!ISSUER_LABELS.has(String(entry["actor"]))) {
      throw new Error(`malformed implement state: events[${index}].actor must be implementor, observer, or human`);
    }
    assertNullableString(entry["subject"], `events[${index}].subject`);
    assertString(entry["summary"], `events[${index}].summary`);
  }

  if (!Array.isArray(candidate.verbs)) throw new Error("malformed implement state: verbs must be an array");
  for (const [index, entry] of candidate.verbs.entries()) {
    assertRecord(entry, `verbs[${index}]`);
    if (!ISSUED_COMMANDS.includes(String(entry["verb"]) as IssuedCommand)) {
      throw new Error(`malformed implement state: verbs[${index}].verb must be one of ${ISSUED_COMMANDS.join(", ")}`);
    }
    if (!ISSUER_LABELS.has(String(entry["issuer"]))) {
      throw new Error(`malformed implement state: verbs[${index}].issuer must be implementor, observer, or human`);
    }
    const outcome = entry["outcome"];
    if (outcome !== "accepted" && outcome !== "rejected") {
      throw new Error(`malformed implement state: verbs[${index}].outcome must be accepted or rejected`);
    }
    // The rejection detail is the record of WHICH of the three checks refused
    // (R7). An accepted verb carrying one, or a rejected verb missing one,
    // would make the ledger unable to answer that question honestly.
    if (outcome === "rejected") {
      assertRecord(entry["rejection"], `verbs[${index}].rejection`);
      if (!["arguments", "authority", "transition"].includes(String((entry["rejection"] as Record<string, unknown>)["check"]))) {
        throw new Error(`malformed implement state: verbs[${index}].rejection.check must be arguments, authority, or transition`);
      }
    } else if (entry["rejection"] !== null) {
      throw new Error(`malformed implement state: verbs[${index}].rejection must be null when outcome is accepted`);
    }
  }

  if (!Array.isArray(candidate.amendments)) throw new Error("malformed implement state: amendments must be an array");
  for (const [index, entry] of candidate.amendments.entries()) {
    assertRecord(entry, `amendments[${index}]`);
    // Human-only issuance is the whole point of R5. A supervisor-issued
    // amendment is refused before it reaches the ledger, so any other value
    // here means the record itself is corrupt.
    if (entry["issuer"] !== "human") {
      throw new Error(`malformed implement state: amendments[${index}].issuer must be human`);
    }
    assertString(entry["approval"], `amendments[${index}].approval`);
    assertString(entry["reason"], `amendments[${index}].reason`);
    assertString(entry["prdSha256"], `amendments[${index}].prdSha256`);
    assertString(entry["snapshotPath"], `amendments[${index}].snapshotPath`);
    // The archive path is what makes "this amendment replaced that text"
    // checkable rather than asserted; a record without it cannot be audited.
    assertString(entry["previousSnapshotPath"], `amendments[${index}].previousSnapshotPath`);
    for (const field of ["invalidatedCriteria", "addedCriteria", "unparkedCriteria"]) {
      if (!Array.isArray(entry[field])) {
        throw new Error(`malformed implement state: amendments[${index}].${field} must be an array`);
      }
    }
  }

  assertRecord(candidate.suite, "suite");
  assertString(candidate.suite["sealedAt"], "suite.sealedAt");
  const suiteCommands = candidate.suite["commands"];
  if (!Array.isArray(suiteCommands)) throw new Error("malformed implement state: suite.commands must be an array");
  const suiteIds = new Set<string>();
  for (const [index, entry] of suiteCommands.entries()) {
    assertRecord(entry, `suite.commands[${index}]`);
    assertString(entry["id"], `suite.commands[${index}].id`);
    if (suiteIds.has(entry["id"] as string)) {
      throw new Error(`malformed implement state: duplicate suite command id ${String(entry["id"])}`);
    }
    suiteIds.add(entry["id"] as string);
    assertString(entry["command"], `suite.commands[${index}].command`);
    assertString(entry["cwd"], `suite.commands[${index}].cwd`);
    if (!Array.isArray(entry["argv"])) throw new Error(`malformed implement state: suite.commands[${index}].argv must be an array`);
  }
  for (const field of ["exclusions", "results"]) {
    if (!Array.isArray(candidate.suite[field])) {
      throw new Error(`malformed implement state: suite.${field} must be an array`);
    }
  }
  for (const [index, entry] of (candidate.suite["exclusions"] as unknown[]).entries()) {
    assertRecord(entry, `suite.exclusions[${index}]`);
    assertString(entry["commandId"], `suite.exclusions[${index}].commandId`);
    // An exclusion without a verbatim human approval is the exact thing AC6
    // refuses. Storing one would launder a refused action into the record.
    assertString(entry["approval"], `suite.exclusions[${index}].approval`);
    assertString(entry["reason"], `suite.exclusions[${index}].reason`);
  }
  for (const [index, entry] of (candidate.suite["results"] as unknown[]).entries()) {
    assertRecord(entry, `suite.results[${index}]`);
    assertString(entry["commandId"], `suite.results[${index}].commandId`);
    assertString(entry["attemptId"], `suite.results[${index}].attemptId`);
    if (entry["status"] !== "GREEN" && entry["status"] !== "RED") {
      throw new Error(`malformed implement state: suite.results[${index}].status must be GREEN or RED`);
    }
    if (!Array.isArray(entry["attributedCriteria"])) {
      throw new Error(`malformed implement state: suite.results[${index}].attributedCriteria must be an array`);
    }
  }

  if (!Array.isArray(candidate.qaBriefs)) throw new Error("malformed implement state: qaBriefs must be an array");
  const briefIds = new Set<string>();
  for (const [index, entry] of candidate.qaBriefs.entries()) {
    assertRecord(entry, `qaBriefs[${index}]`);
    assertString(entry["briefId"], `qaBriefs[${index}].briefId`);
    // Reissuing for the same criterion must mint a distinct id, or a trail
    // echoing a stale brief could not be told from a current one (AC30).
    if (briefIds.has(entry["briefId"] as string)) {
      throw new Error(`malformed implement state: duplicate qa brief id ${String(entry["briefId"])}`);
    }
    briefIds.add(entry["briefId"] as string);
    assertString(entry["criterionId"], `qaBriefs[${index}].criterionId`);
    assertString(entry["prdSha256"], `qaBriefs[${index}].prdSha256`);
    const steps = entry["steps"];
    if (!Array.isArray(steps)) throw new Error(`malformed implement state: qaBriefs[${index}].steps must be an array`);
    for (const [stepIndex, step] of steps.entries()) {
      assertRecord(step, `qaBriefs[${index}].steps[${stepIndex}]`);
      assertString(step["id"], `qaBriefs[${index}].steps[${stepIndex}].id`);
      assertString(step["text"], `qaBriefs[${index}].steps[${stepIndex}].text`);
    }
  }

  if (!Array.isArray(candidate.trails)) throw new Error("malformed implement state: trails must be an array");
  for (const [index, entry] of candidate.trails.entries()) {
    assertRecord(entry, `trails[${index}]`);
    assertString(entry["criterionId"], `trails[${index}].criterionId`);
    assertString(entry["briefId"], `trails[${index}].briefId`);
    // The implementor and the solver are absent from this set on purpose:
    // a criterion proven by driving must not be driven by the agent whose
    // work it judges (AC32). The check is of the declaration, not identity.
    if (!["human", "observer", "qa-agent"].includes(String(entry["driverRole"]))) {
      throw new Error(`malformed implement state: trails[${index}].driverRole must be human, observer, or qa-agent`);
    }
    if (!Array.isArray(entry["coveredStepIds"])) {
      throw new Error(`malformed implement state: trails[${index}].coveredStepIds must be an array`);
    }
    if (entry["status"] !== "accepted" && entry["status"] !== "superseded") {
      throw new Error(`malformed implement state: trails[${index}].status must be accepted or superseded`);
    }
  }

  if (!Array.isArray(candidate.escalations)) throw new Error("malformed implement state: escalations must be an array");
  for (const [index, entry] of candidate.escalations.entries()) {
    assertRecord(entry, `escalations[${index}]`);
    assertString(entry["reason"], `escalations[${index}].reason`);
    const outcome = entry["outcome"];
    if (outcome !== "diagnosed" && outcome !== "summon-failed") {
      throw new Error(`malformed implement state: escalations[${index}].outcome must be diagnosed or summon-failed`);
    }
    // A failed summon has no diagnosis and no handoff; a successful one has
    // both. Recording a handoff for a failed summon would claim a
    // replacement was briefed when none was (AC35, AC41).
    if (outcome === "summon-failed") {
      if (entry["handoff"] !== null) {
        throw new Error(`malformed implement state: escalations[${index}].handoff must be null when the summon failed`);
      }
      assertString(entry["error"], `escalations[${index}].error`);
    } else {
      assertRecord(entry["handoff"], `escalations[${index}].handoff`);
      assertString(entry["diagnosis"], `escalations[${index}].diagnosis`);
    }
  }
}

export function parseImplementState(text: string): ImplementState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`malformed implement state JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("malformed implement state: root must be an object");
  const candidate = parsed as Partial<ImplementState> & { schema?: unknown };
  if (candidate.schema !== IMPLEMENT_SCHEMA) {
    throw new Error(
      `unsupported implement state schema ${String(candidate.schema ?? "missing")}; this version accepts only ${IMPLEMENT_SCHEMA}. Start a new run with \`sasu implement start --prd <path>\``,
    );
  }
  if (candidate.status !== "active" && candidate.status !== "complete" && candidate.status !== "blocked" && candidate.status !== "retired") {
    throw new Error(`malformed implement state: status must be active, complete, blocked, or retired, got ${String(candidate.status ?? "missing")}`);
  }
  assertString(candidate.topicSlug, "topicSlug");
  assertString(candidate.projectRoot, "projectRoot");
  assertString(candidate.runDir, "runDir");
  assertString(candidate.prdPath, "prdPath");
  if (candidate.worktree !== null) {
    if (candidate.worktree === undefined || typeof candidate.worktree !== "object") {
      throw new Error("malformed implement state: worktree must be null or an object");
    }
    assertString(candidate.worktree.path, "worktree.path");
    assertString(candidate.worktree.branch, "worktree.branch");
  }

  assertRecord(candidate.prd, "prd");
  assertString(candidate.prd["sha256"], "prd.sha256");
  assertString(candidate.prd["snapshotPath"], "prd.snapshotPath");
  if (candidate.prd["reviewProfile"] !== "trivial" && candidate.prd["reviewProfile"] !== "standard" && candidate.prd["reviewProfile"] !== "high-risk") {
    throw new Error("malformed implement state: prd.reviewProfile must be trivial, standard, or high-risk");
  }

  assertRecord(candidate.initialSource, "initialSource");
  assertNullableString(candidate.initialSource["head"], "initialSource.head");
  assertString(candidate.initialSource["digest"], "initialSource.digest");
  assertSourceEntries(candidate.initialSource["entries"], "initialSource.entries");

  assertRecord(candidate.baselineAttribution, "baselineAttribution");
  if (candidate.baselineAttribution["disposition"] !== "clean"
    && candidate.baselineAttribution["disposition"] !== "pre-existing"
    && candidate.baselineAttribution["disposition"] !== "run-owned"
    && candidate.baselineAttribution["disposition"] !== "mixed") {
    throw new Error("malformed implement state: baselineAttribution.disposition must be clean, pre-existing, run-owned, or mixed");
  }
  assertString(candidate.baselineAttribution["baselineDigest"], "baselineAttribution.baselineDigest");
  assertNullableString(candidate.baselineAttribution["head"], "baselineAttribution.head");
  const attributionPaths = candidate.baselineAttribution["paths"];
  if (!Array.isArray(attributionPaths)) throw new Error("malformed implement state: baselineAttribution.paths must be an array");
  for (const [index, entry] of attributionPaths.entries()) {
    assertRecord(entry, `baselineAttribution.paths[${index}]`);
    assertString(entry["path"], `baselineAttribution.paths[${index}].path`);
    if (entry["disposition"] !== "pre-existing" && entry["disposition"] !== "run-owned") {
      throw new Error(`malformed implement state: baselineAttribution.paths[${index}].disposition must be pre-existing or run-owned`);
    }
  }

  if (!Array.isArray(candidate.tasks) || !Array.isArray(candidate.requirements)
    || !Array.isArray(candidate.acceptanceCriteria) || !Array.isArray(candidate.verification)
    || !Array.isArray(candidate.deviations)) {
    throw new Error("malformed implement state: tasks, requirements, acceptanceCriteria, verification, and deviations must be arrays");
  }
  assertAcceptanceCriteria(candidate.acceptanceCriteria, "acceptanceCriteria");
  if (!Array.isArray(candidate.artifacts) || !Array.isArray(candidate.verificationAttempts)) {
    throw new Error("malformed implement state: artifacts and verificationAttempts must be arrays");
  }
  // riskFindings was added without a schema bump. Early v5 runs therefore
  // load as an empty ledger; every subsequent persist writes the field.
  if (candidate.riskFindings === undefined) candidate.riskFindings = [];
  if (!Array.isArray(candidate.riskFindings)) {
    throw new Error("malformed implement state: riskFindings must be an array");
  }
  const riskFindingIds = new Set<string>();
  for (const [index, entry] of candidate.riskFindings.entries()) {
    assertRecord(entry, `riskFindings[${index}]`);
    assertString(entry["id"], `riskFindings[${index}].id`);
    if (!/^RF[1-9]\d*$/.test(entry["id"])) {
      throw new Error(`malformed implement state: riskFindings[${index}].id must match RF<n>`);
    }
    if (riskFindingIds.has(entry["id"])) {
      throw new Error(`malformed implement state: duplicate risk finding id ${entry["id"]}`);
    }
    riskFindingIds.add(entry["id"]);
    if (entry["severity"] !== "blocking" && entry["severity"] !== "advisory") {
      throw new Error(`malformed implement state: riskFindings[${index}].severity must be blocking or advisory`);
    }
    assertString(entry["text"], `riskFindings[${index}].text`);
    assertString(entry["originAttemptId"], `riskFindings[${index}].originAttemptId`);
    if (entry["status"] !== "open" && entry["status"] !== "fixed" && entry["status"] !== "accepted") {
      throw new Error(`malformed implement state: riskFindings[${index}].status must be open, fixed, or accepted`);
    }
    if (entry["resolution"] !== undefined) {
      assertRecord(entry["resolution"], `riskFindings[${index}].resolution`);
      assertString(entry["resolution"]["at"], `riskFindings[${index}].resolution.at`);
      assertString(entry["resolution"]["evidence"], `riskFindings[${index}].resolution.evidence`);
    }
    if (entry["nonConvergence"] !== undefined) {
      const label = `riskFindings[${index}].nonConvergence`;
      assertRecord(entry["nonConvergence"], label);
      for (const field of ["at", "approval", "reason"] as const) {
        assertString(entry["nonConvergence"][field], `${label}.${field}`);
      }
      // The declaration is human-only by authority; a state claiming any
      // other declarer is a record the gate could not have produced.
      if (entry["nonConvergence"]["declaredBy"] !== "human") {
        throw new Error(`malformed implement state: ${label}.declaredBy must be human`);
      }
      if (typeof entry["nonConvergence"]["roundsUnchanged"] !== "number") {
        throw new Error(`malformed implement state: ${label}.roundsUnchanged must be a number`);
      }
    }
  }
  for (const [index, attempt] of candidate.verificationAttempts.entries()) {
    assertRecord(attempt, `verificationAttempts[${index}]`);
    assertString(attempt["id"], `verificationAttempts[${index}].id`);
    assertInputManifest(attempt["inputManifest"], `verificationAttempts[${index}].inputManifest`);
    assertRoundContexts(attempt["roundContexts"], `verificationAttempts[${index}].roundContexts`);
    if (!Array.isArray(attempt["skippedAcceptanceCriteria"])) {
      throw new Error(`malformed implement state: verificationAttempts[${index}].skippedAcceptanceCriteria must be an array`);
    }
    for (const [skipIndex, skipped] of attempt["skippedAcceptanceCriteria"].entries()) {
      assertRecord(skipped, `verificationAttempts[${index}].skippedAcceptanceCriteria[${skipIndex}]`);
      assertString(skipped["id"], `verificationAttempts[${index}].skippedAcceptanceCriteria[${skipIndex}].id`);
      assertString(skipped["reason"], `verificationAttempts[${index}].skippedAcceptanceCriteria[${skipIndex}].reason`);
    }
  }

  assertSupervisionLedgers(candidate);

  if (candidate.retirement === undefined) throw new Error("malformed implement state: retirement must be null or an object");
  if (candidate.retirement !== null) {
    assertRecord(candidate.retirement, "retirement");
    assertString(candidate.retirement["retiredAt"], "retirement.retiredAt");
    assertNullableString(candidate.retirement["retiredBySessionId"], "retirement.retiredBySessionId");
  }
  if (candidate.completion === undefined) throw new Error("malformed implement state: completion must be null or an object");
  if (candidate.completion !== null) {
    assertRecord(candidate.completion, "completion");
    assertString(candidate.completion["fingerprint"], "completion.fingerprint");
    assertString(candidate.completion["completedAt"], "completion.completedAt");
    assertString(candidate.completion["receiptPath"], "completion.receiptPath");
    assertString(candidate.completion["implementationResultPath"], "completion.implementationResultPath");
  }
  return candidate as ImplementState;
}

export function loadState(projectRoot: string, options: { slug?: string; state?: string } = {}): { statePath: string; state: ImplementState } {
  const statePath = resolveStatePath(projectRoot, options);
  if (!fs.existsSync(statePath)) throw new Error(`implement state not found: ${path.relative(projectRoot, statePath)}`);
  return { statePath, state: parseImplementState(fs.readFileSync(statePath, "utf8")) };
}

export function persistState(statePath: string, state: ImplementState): void {
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath, state);
  writeActivePointer(state.projectRoot, state);
}

const SNAPSHOT_EXCLUDES = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);

function repositoryHead(projectRoot: string): string | null {
  // `git rev-parse` covers both a normal checkout (.git directory) and a
  // linked worktree (.git file). Reading .git/HEAD directly made every
  // isolated run look non-git and erased the committed baseline provenance.
  const resolved = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (resolved.error !== undefined || resolved.status !== 0) return null;
  return resolved.stdout.trim() || null;
}

function isGitWorkTree(projectRoot: string): boolean {
  const resolved = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  return resolved.status === 0 && resolved.stdout.trim() === "true";
}

function sourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SNAPSHOT_EXCLUDES.has(entry.name) || (relativeDir === "" && entry.name === "agents")) continue;
        visit(path.join(absoluteDir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  visit(projectRoot, "");
  return files.sort();
}

export function captureSourceSnapshot(projectRoot: string): SourceSnapshot {
  const head = repositoryHead(projectRoot);
  const entries: SourceEntry[] = sourceFiles(projectRoot).map((relative) => ({
    path: relative,
    state: "present",
    sha256: sha256(fs.readFileSync(path.join(projectRoot, relative))),
  }));
  // A commit of unchanged bytes must not stale proof. HEAD remains useful
  // provenance, while the freshness digest names the judged content only.
  return { head, entries, digest: sha256(JSON.stringify({ entries })) };
}

function snapshotExcluded(relative: string): boolean {
  const segments = relative.split("/");
  if (segments[0] === "agents") return true;
  return segments.some((segment) => SNAPSHOT_EXCLUDES.has(segment));
}

/**
 * The baseline a run's "run-owned changes" are diffed against. A declared
 * run-owned dirty tree resolves those paths against committed HEAD: otherwise
 * a restarted run snapshots the finished tree and every judge sees "No
 * run-owned source changes" (2026-08-13 creator-assist: four restarted runs).
 * A dirty path declared pre-existing deliberately keeps its working bytes in
 * the baseline, while a run-owned path resolves against HEAD. This per-path
 * split represents mixed-ownership trees without adding another CLI handle.
 * Only dirty paths need attribution; clean files already match HEAD byte-for-byte.
 * Without git (or when git fails) the working tree is the only baseline there
 * is, which restores the old behavior for non-repository projects.
 */
export function dirtySourcePaths(projectRoot: string): string[] {
  // An unborn repository has no HEAD but still has meaningful staged and
  // untracked ownership. Treating HEAD absence as "not git" absorbed every
  // pre-first-commit file into a false clean baseline.
  if (!isGitWorkTree(projectRoot)) return [];
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (status.error !== undefined || status.status !== 0) {
    throw new Error(`git status failed while resolving dirty source attribution: ${(status.stderr || status.error?.message || "unknown error").trim()}`);
  }
  const dirty = new Set<string>();
  const tokens = status.stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const relative = token.slice(3);
    if (relative !== "" && !snapshotExcluded(relative)) dirty.add(relative);
    // Renames and copies carry the origin as the next NUL token. Either index
    // position may carry R/C depending on whether the index or worktree owns it.
    if (/[RC]/.test(token.slice(0, 2))) {
      index += 1;
      const origin = tokens[index];
      if (origin !== undefined && !snapshotExcluded(origin)) dirty.add(origin);
    }
  }
  return [...dirty].sort();
}

export function captureBaselineSnapshot(
  projectRoot: string,
  attributions: Array<{ path: string; disposition: DirtyAttribution }>,
): SourceSnapshot {
  const working = captureSourceSnapshot(projectRoot);
  // `implement start` already presented this exact path set for ownership.
  // Re-scan only to prove the set stayed stable while the working snapshot was
  // captured; never let the second scan silently choose a different baseline.
  const expectedDirty = [...new Set(attributions.map((entry) => entry.path))].sort();
  if (expectedDirty.length !== attributions.length) {
    throw new Error("dirty source attribution contains a duplicate path");
  }
  const dispositionByPath = new Map(attributions.map((entry) => [entry.path, entry.disposition]));
  const observedDirty = dirtySourcePaths(projectRoot);
  if (JSON.stringify(observedDirty) !== JSON.stringify(expectedDirty)) {
    const expected = new Set(expectedDirty);
    const observed = new Set(observedDirty);
    const added = observedDirty.filter((entry) => !expected.has(entry));
    const removed = expectedDirty.filter((entry) => !observed.has(entry));
    const changes = [
      ...(added.length > 0 ? [`added: ${added.join(", ")}`] : []),
      ...(removed.length > 0 ? [`removed: ${removed.join(", ")}`] : []),
    ].join("; ");
    throw new Error(
      `dirty source paths changed while binding baseline attribution (${changes}); `
      + "re-run `sasu implement start` against a stable tree so every path receives an explicit disposition",
    );
  }
  if (!isGitWorkTree(projectRoot)) return working;
  const entries = new Map(working.entries.map((entry) => [entry.path, entry]));
  for (const relative of expectedDirty) {
    if (dispositionByPath.get(relative) === "pre-existing") continue;
    if (snapshotExcluded(relative)) continue;
    if (working.head === null) {
      // No committed tree exists, so every dirty judged path is run-owned and
      // absent from the baseline. This is the unborn equivalent of a failed
      // `git show HEAD:path` below.
      entries.delete(relative);
      continue;
    }
    const show = spawnSync("git", ["show", `HEAD:${relative}`], {
      cwd: projectRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (show.error === undefined && show.status === 0) {
      entries.set(relative, { path: relative, state: "present", sha256: sha256(show.stdout) });
    } else {
      // Absent at HEAD: the file is run-owned work, not baseline content.
      entries.delete(relative);
    }
  }
  const sorted = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { head: working.head, entries: sorted, digest: sha256(JSON.stringify({ entries: sorted })) };
}

export function changedPathsSince(initial: SourceSnapshot, current: SourceSnapshot): string[] {
  const before = new Map(initial.entries.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const after = new Map(current.entries.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((entry) => before.get(entry) !== after.get(entry)).sort();
}

/**
 * Artifact integrity is file identity only. In the 2026-08-25 creator-studio
 * run, coupling every artifact to the whole judged tree staled 28 records at
 * once and let an unchanged 06:14 log be re-dated after 06:37 code changes.
 * Semantic freshness belongs to the judges; the attempt-level source pin still
 * blocks finalize after any later source edit.
 */
export function artifactIntegrityProblems(projectRoot: string, state: ImplementState): string[] {
  const problems: string[] = [];
  for (const artifact of state.artifacts) {
    const target = [artifact.verificationId, artifact.acceptanceCriterionId].filter(Boolean).join("+");
    let absolute: string;
    try {
      absolute = normalizeProjectPath(projectRoot, artifact.path).absolute;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!fs.existsSync(absolute)) {
      problems.push(`${target}: artifact missing: ${artifact.path}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size <= 0) {
      problems.push(`${target}: artifact is empty or not a file: ${artifact.path}`);
      continue;
    }
    const actual = sha256(fs.readFileSync(absolute));
    if (actual !== artifact.sha256) problems.push(`${target}: artifact hash changed: ${artifact.path}`);
  }
  return problems;
}
