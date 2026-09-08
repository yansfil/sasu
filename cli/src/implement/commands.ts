import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { readGateStatus } from "../gates/commands";
import { prelintPrd } from "../gates/prelint";
import type { CheckResult, EvidenceMaterial } from "../gates/prompts";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import { JUDGE_ERROR_LOOP_THRESHOLD, JudgeError, describeJudgeFailureCause, judgeFailureCause, validateReviewResult, type JudgeFailureCause, type ReviewResult } from "../judge/types";
import { runDirRel } from "../runs/paths";
import { currentSessionId } from "../runs/session";
import { reconcileReviewFindings, reconcileRiskFindings, validateRiskVerdict, verificationInputManifest, verificationRoundContext } from "./convergence";
import { provisionWorktree, type WorktreeProvision } from "./worktree";
import { parseImplementContract, reviewProfile, suiteCommands } from "./contract";
import { planRunUnits, runBatch, parseCommandArgv, type RunUnit, type RunUnitResult } from "./runner";
import { suiteScore } from "./suite";
import { assertCommandAuthority, isIssuedCommand, recordVerb, resolveIssuer, VerbRejected } from "./verbs";
import { recordEvent } from "./events";
import { AmendmentRejected, applyAmendment } from "./amend";
import { assertNoActiveVerification, recoverVerification, cancelVerificationExecution, completeVerificationExecution, beginVerification, progressVerification, prepareVerificationExecution, recordVerificationExecution, finishVerification } from "./verification-activity";
import { assertEscalateBudget, buildHandoffBriefing, EscalateRejected, recordEscalation, renderDiagnosis, solverPrompt, validateDiagnosis } from "./solver";
import { waitForEvent } from "./waiter";
import { herdrCapabilities, readPane, spawnImplementor } from "./herdr";
import { DispatchRejected, dispatchImplementor } from "./dispatch";
import { reviewPrompt, intentSource, riskPrompt, type ChangeFile, type ReviewPromptMaterial } from "./prompts";
import { pinnedPrd, PrdDriftError, prdSnapshotPath, requirePinnedPrd, writePrdSnapshot } from "./prd-snapshot";
import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, normalizeProjectPath, nowIso, persistState, persistClose, jsonText, requireWorkRoot, sha256, statePathFor, writeActivePointer, writeJsonAtomic, writeTextAtomic, parseImplementState, StateConflictError } from "./store";
import { IMPLEMENT_SCHEMA, type DirtyAttribution, type PrdJudgeRecord, type ImplementCommandResult, type ImplementState, type LaneRecord, type MechanicalRunRecord, type RegisteredArtifact, type ReviewProfile, type RiskLaneResult, type SolverHandoff, type TrackedRiskFinding, type UnifiedVerificationAttempt, type VerificationStatus, type IssuedCommand, type EvidenceReplacement, type IssuerLabel, ESCALATE_LIMIT_PER_RUN, STALL_THRESHOLD_MS } from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const ARTIFACT_KINDS = new Set(["screenshot", "image", "browser", "api", "db", "log", "file", "command-log"]);

export const DIRTY_INTAKE_QUESTION = "커밋되지 않은 판정 대상 파일이 있습니다. 이 작업을 어떻게 시작할까요?";
export const DIRTY_INTAKE_OPTIONS = [
  {
    value: "commit-first",
    label: "먼저 커밋하고 시작",
    description: "표시된 변경을 먼저 커밋한 뒤 그 커밋을 깨끗한 기준선으로 사용합니다.",
  },
  {
    value: "pre-existing",
    label: "기존 작업으로 이어서 시작",
    description: "현재 바이트는 기준선에 포함하고 이번 런의 변경에서는 제외합니다.",
  },
  {
    value: "run-owned",
    label: "이번 작업에 포함",
    description: "현재 바이트부터 이번 런이 만든 변경으로 검증합니다.",
  },
] as const;

function result(
  action: string,
  ok: boolean,
  message: string,
  detail?: Record<string, unknown>,
  summary?: string[],
): ImplementCommandResult {
  return {
    ok,
    action,
    exitCode: ok ? 0 : 1,
    message,
    ...(detail !== undefined ? { detail } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

class VerifyInvariantError extends Error {
  constructor(readonly reason: "empty-run-owned-change-set", message: string) {
    super(message);
    this.name = "VerifyInvariantError";
  }
}

function flag(args: ImplementArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(args: ImplementArgs, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.trim() === "") throw new Error(`missing required --${name} <value>`);
  return value;
}

function stateOptions(args: ImplementArgs): { slug?: string; state?: string } {
  const slug = flag(args, "slug");
  const state = flag(args, "state");
  return { ...(slug !== undefined ? { slug } : {}), ...(state !== undefined ? { state } : {}) };
}

function slugFromPrd(prdPath: string): string {
  const slug = path.basename(path.dirname(prdPath)).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`PRD directory must be a lowercase slug: ${slug}`);
  return slug;
}

function activeInPlaceRun(projectRoot: string): string | null {
  const runsDir = path.join(projectRoot, "agents", "runs");
  if (!fs.existsSync(runsDir)) return null;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(runsDir, entry.name, "state.json");
    if (!fs.existsSync(statePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<ImplementState>;
      if (parsed.schema === IMPLEMENT_SCHEMA && parsed.status === "active" && (parsed.worktree ?? null) === null) return entry.name;
    } catch {
      // A malformed state is not an occupancy signal.
    }
  }
  return null;
}

function dirtyAttributionRefusal(paths: string[]): Error {
  const mixedExample = Object.fromEntries(paths.map((entry, index) => [
    entry,
    index === 0 ? "pre-existing" : "run-owned",
  ]));
  return new Error(
    `implement start found dirty judged paths and will not guess their ownership:\n` +
    `${paths.map((entry) => `- ${entry}`).join("\n")}\n` +
    `Use \`sasu implement intake\` in the specification-owning session and ask once. Commit the listed changes first for a clean committed baseline, ` +
    `or re-run with --dirty-attribution pre-existing to exclude all of these bytes from this run, or --dirty-attribution run-owned to include all of them as this run's work. ` +
    `For mixed ownership, map every listed path exactly: --dirty-attribution '${JSON.stringify(mixedExample)}'.`,
  );
}

function intake(projectRoot: string): ImplementCommandResult {
  const paths = dirtySourcePaths(projectRoot);
  return result(
    "intake",
    true,
    paths.length === 0 ? "judged source tree is clean; no dirty disposition is required" : "dirty source disposition is required before implementation dispatch",
    paths.length === 0
      ? { required: false, paths: [], question: null, options: [] }
      : { required: true, paths, question: DIRTY_INTAKE_QUESTION, options: DIRTY_INTAKE_OPTIONS },
  );
}

function resolveDirtyAttributions(
  paths: string[],
  input: string | undefined,
): Array<{ path: string; disposition: DirtyAttribution }> {
  // The disposition is answered by a person at the pipeline's pre-dispatch
  // intake (DIRTY_INTAKE_QUESTION) and carried into the run. Only someone who
  // watched the tree can say whether uncommitted bytes are a sibling's work or
  // this run's own earlier attempt; the harness cannot tell those apart from
  // content, and guessing is what misattributed a sibling's 16 files to the
  // 2026-08-24 x-twitter run and failed its fidelity lane three rounds running.
  // This function only expands and validates that answer, so the enforceable
  // boundary here is exact path coverage and value validation, including
  // mixed-ownership trees. Cross-session retirement, not attribution, is the
  // surface that requires verbatim user evidence.
  if (input === undefined) return [];
  if (input === "pre-existing" || input === "run-owned") {
    return paths.map((entry) => ({ path: entry, disposition: input }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("--dirty-attribution must be pre-existing, run-owned, or a JSON object mapping every dirty path to one of those values");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--dirty-attribution JSON must be an object mapping every dirty path to pre-existing or run-owned");
  }
  const record = parsed as Record<string, unknown>;
  const expected = new Set(paths);
  const unknown = Object.keys(record).filter((entry) => !expected.has(entry)).sort();
  const missing = paths.filter((entry) => !Object.prototype.hasOwnProperty.call(record, entry));
  const invalid = Object.entries(record)
    .filter(([, value]) => value !== "pre-existing" && value !== "run-owned")
    .map(([entry]) => entry)
    .sort();
  if (unknown.length > 0 || missing.length > 0 || invalid.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(unknown.length > 0 ? [`unknown: ${unknown.join(", ")}`] : []),
      ...(invalid.length > 0 ? [`invalid value: ${invalid.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`--dirty-attribution JSON must map every dirty path exactly to pre-existing or run-owned (${details})`);
  }
  return paths.map((entry) => ({ path: entry, disposition: record[entry] as DirtyAttribution }));
}

function start(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const config = loadConfig(projectRoot);
  const prdInput = requiredFlag(args, "prd");
  const prd = normalizeProjectPath(projectRoot, prdInput);
  if (!fs.existsSync(prd.absolute)) throw new Error(`PRD not found: ${prd.relative}`);
  const text = fs.readFileSync(prd.absolute, "utf8");
  const contract = parseImplementContract(text);
  if ((contract.frontmatter["status"] ?? "") !== "ready") throw new Error(`PRD status must be ready, got ${contract.frontmatter["status"] ?? "missing"}`);
  const frontmatterApproval = (contract.frontmatter["human_approval"] ?? "").toLowerCase();
  const approval = flag(args, "allow-unapproved-prd")?.trim() ?? "";
  if (frontmatterApproval !== "approved" && approval === "") {
    throw new Error("PRD human_approval is pending; pass --allow-unapproved-prd with the user's verbatim approval");
  }
  const slug = slugFromPrd(prd.absolute);
  const sourceIntake = contract.frontmatter["source_intake"] ?? "";
  const gateViews = readGateStatus(projectRoot, config, slug);
  const activePrdGates = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].inFlight);
  if (activePrdGates.length > 0) {
    throw new Error(
      `implement start refused: PRD review still in flight (${activePrdGates.join(", ")}); wait for the gate to finish and inspect its final status`,
    );
  }
  const qaLogBacked = sourceIntake !== "" && path.basename(sourceIntake) === "qa-log.md";
  if (qaLogBacked) {
    const incomplete = (["gap-audit", "spec"] as const).filter((gate) => gateViews[gate].effective !== "PASS");
    if (incomplete.length > 0) {
      const statuses = incomplete.map((gate) => `${gate}=${gateViews[gate].effective}`).join(", ");
      throw new Error(
        `implement start refused: qa-log-backed PRD requires live PASS for gap-audit and spec; got ${statuses}`,
      );
    }
  }
  const prdJudge: PrdJudgeRecord = qaLogBacked
    ? { required: true, skippedReason: null, gapAudit: gateViews["gap-audit"].effective, spec: gateViews.spec.effective }
    : {
        required: false,
        skippedReason: `judge not run: no user utterances to judge against (source_intake is ${sourceIntake === "" ? "empty" : JSON.stringify(sourceIntake)}, not an interview qa-log)`,
        gapAudit: null,
        spec: null,
      };
  const statePath = statePathFor(projectRoot, slug);
  if (fs.existsSync(statePath)) {
    let existingSchema = "unknown";
    try {
      existingSchema = String((JSON.parse(fs.readFileSync(statePath, "utf8")) as { schema?: unknown }).schema ?? "missing");
    } catch {
      existingSchema = "malformed";
    }
    throw new Error(`implement state already exists for ${slug} (${existingSchema}); choose a new slug or remove the obsolete run explicitly`);
  }
  // Isolation decision: worktree.enabled isolates every run; otherwise a run
  // only diverts when this tree already hosts an active in-place run.
  const occupant = activeInPlaceRun(projectRoot);
  const isolate = config.worktree.enabled || occupant !== null;
  const requestedAttribution = flag(args, "dirty-attribution");
  // In-place runs can reject before provisioning. An isolated worktree starts
  // from committed bytes but configured copy/setup steps may dirty it, so the
  // provisioner validates the prepared tree inside its all-or-nothing cleanup
  // boundary. Either way ownership is explicit before state exists
  // (PRINCIPLES 4, 10, 11).
  const sourceDirty = dirtySourcePaths(projectRoot);
  if (sourceDirty.length > 0 && requestedAttribution === undefined) {
    throw dirtyAttributionRefusal(sourceDirty);
  }
  const initializeState = (
    worktree: WorktreeProvision | null,
    pathAttributions: Array<{ path: string; disposition: DirtyAttribution }>,
  ): ImplementState => {
    const workRoot = worktree?.path ?? projectRoot;
    const baseline = captureBaselineSnapshot(workRoot, pathAttributions);
    const dispositions = new Set(pathAttributions.map((entry) => entry.disposition));
    const aggregateAttribution = pathAttributions.length === 0
      ? "clean"
      : dispositions.size === 1
        ? pathAttributions[0]!.disposition
        : "mixed";
    const snapshotPath = prdSnapshotPath(runDirRel(slug));
    const createdAt = nowIso();
    const state: ImplementState = {
      schema: IMPLEMENT_SCHEMA,
      status: "active",
      topicSlug: slug,
      projectRoot,
      worktree,
      runDir: runDirRel(slug),
      prdPath: prd.relative,
      prd: {
        sha256: sha256(text),
        snapshotPath,
        status: contract.frontmatter["status"] ?? null,
        approval: frontmatterApproval === "approved"
          ? { source: "frontmatter", evidence: "human_approval: approved" }
          : { source: "conversation", evidence: approval },
        reviewProfile: reviewProfile(contract),
        reviewRationale: contract.frontmatter["review_rationale"] ?? "",
        sourceIntake,
        judge: prdJudge,
      },
      initialSource: baseline,
      baselineAttribution: {
        disposition: aggregateAttribution,
        paths: pathAttributions,
        baselineDigest: baseline.digest,
        head: baseline.head,
      },
      ownerSessionId: currentSessionId(),
      adoptions: [],
      requirements: contract.rows.map(({ id, behavior, decisionIds }) => ({ id, behavior, decisionIds })),
      findings: [],
      artifacts: [],
      verificationAttempts: [],
      budgetGrants: [],
      deviations: [],
      riskFindings: [],
      events: [],
      verbs: [],
      amendments: [],
      evidenceReplacements: [],
      // Sealed here, at start, and never re-derived: a mid-run edit of
      // agents/config.json must not change what this run is measured
      // against (AC5). From this point the sealed list is the authority and
      // the config file is only the source it was taken from.
      suite: {
        sealedAt: createdAt,
        commands: suiteCommands(projectRoot, workRoot).map((entry, index) => ({
          id: `S${index + 1}`,
          command: entry.command,
          argv: parseCommandArgv(entry.command),
          cwd: entry.cwd,
        })),
        exclusions: [],
        results: [],
      },
      escalations: [],
      retirement: null,
      completion: null,
      createdAt,
      updatedAt: createdAt,
    };
    fs.mkdirSync(path.join(projectRoot, state.runDir, "artifacts", "logs"), { recursive: true });
    writePrdSnapshot(projectRoot, snapshotPath, text);
    // state.json is the commit point. Until this atomic write succeeds, an
    // isolated provision remains inside the cleanup boundary. Navigation
    // pointers are written afterward because they are not run authority.
    writeJsonAtomic(statePath, state);
    return state;
  };
  const runDirAbsolute = path.join(projectRoot, runDirRel(slug));
  const state = isolate
    ? provisionWorktree(
        projectRoot,
        slug,
        runDirAbsolute,
        config.worktree,
        config.verify.commandTimeoutMs,
        sourceDirty,
        (prepared) => {
          const dirtyPaths = dirtySourcePaths(prepared.path);
          if (dirtyPaths.length > 0 && requestedAttribution === undefined) throw dirtyAttributionRefusal(dirtyPaths);
          return initializeState(prepared, resolveDirtyAttributions(dirtyPaths, requestedAttribution));
        },
      )
    : initializeState(null, resolveDirtyAttributions(sourceDirty, requestedAttribution));
  writeActivePointer(projectRoot, state);
  const startedWorktree = state.worktree ?? null;
  const message = startedWorktree === null
    ? `implement run started: ${slug}`
    : `implement run started: ${slug} in isolated worktree ${startedWorktree.path} (branch ${startedWorktree.branch})` +
      `${occupant !== null ? ` because run '${occupant}' is active in this tree` : ""} - implement the contract there; records stay in this tree's agents/`;
  return result("start", true, message, publicState(state, config.judge.retryBudget));
}

/**
 * Ownership guard for every mutating command; `status` stays open. The run's
 * owner is `state.ownerSessionId` alone (see types.ts for the incident that
 * bans a second copy). An unowned run is claimed by the first mutating
 * session - the claim rides the command's own persist, so a command that
 * fails leaves no trace. A run owned by another session is refused unless
 * the user's approval arrives verbatim via --adopt, the same shape as every
 * other user-granted waiver (--grant-budget, --allow-unapproved-prd). These
 * strings are durable audit evidence supplied by the trusted orchestrating
 * session, not an authentication factor: the CLI has no authoritative chat
 * identity to validate. Adding transcript attestation or a nonce would change
 * that trust contract rather than strengthen this local ownership guard.
 */
function assertRunOwnership(statePath: string, state: ImplementState, args: ImplementArgs): void {
  if (assertNoActiveVerification(state)) persistState(statePath, state);
  const sessionId = currentSessionId();
  const owner = state.ownerSessionId ?? null;
  if (owner === sessionId) return;
  if (owner === null) {
    state.ownerSessionId = sessionId;
    return;
  }
  const evidence = flag(args, "adopt")?.trim() ?? "";
  if (evidence === "") {
    throw new Error(
      `run '${state.topicSlug}' is owned by another session (${owner}); if the user approved taking it over, re-run with --adopt "<the user's verbatim words>"`,
    );
  }
  state.adoptions = [...(state.adoptions ?? []), { at: nowIso(), fromSessionId: owner, evidence }];
  state.ownerSessionId = sessionId;
  persistState(statePath, state);
}

function assertRunOpenForMutation(state: ImplementState): void {
  if (state.status === "retired") throw new Error("implement run is retired; start a new approved PRD under a new slug");
  if (state.status === "blocked") throw new Error("implement run is closed (blocked); start a new approved run");
  if (state.status === "complete") throw new Error("implement run is already complete");
  // Closed for implementation the moment finalize accepts it: only the
  // human's confirm may still write, and a closed run never reopens (R8).
  if (state.status === "complete-pending-human") throw new Error("implement run is closed (complete-pending-human); only `sasu implement confirm --id <F#>` may still write, and a closed run never reopens");
}

function retire(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") {
    return result("retire", true, `implement run is already retired: ${state.topicSlug}`, {
      status: state.status,
      retirement: state.retirement,
      occupancyReleased: true,
    });
  }
  if (state.status !== "active") {
    throw new Error(`only an active unfinished run can be retired; ${state.topicSlug} is ${state.status}`);
  }
  const previousOwner = state.ownerSessionId ?? null;
  const sessionId = currentSessionId();
  const adoptionEvidence = flag(args, "adopt")?.trim() ?? "";
  assertRunOwnership(statePath, state, args);
  state.status = "retired";
  state.retirement = {
    retiredAt: nowIso(),
    retiredBySessionId: sessionId,
    ...(previousOwner !== null && previousOwner !== sessionId
      ? { adoptedFromSessionId: previousOwner, adoptionEvidence }
      : {}),
  };
  state.completion = null;
  persistState(statePath, state);
  return result("retire", true, `implement run retired and tree occupancy released: ${state.topicSlug}`, {
    status: state.status,
    retirement: state.retirement,
    occupancyReleased: true,
  });
}

/**
 * Park is for `check:` rows only. Without this the attempt fails as "unknown
 * row S1", which is a refusal but not a reason - and the reason is the
 * point: a suite command has no row to prove later, so the only way to stop
 * running one is to remove it from the sealed list through an amendment.
 */
async function awaitEvent(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const { statePath } = loadState(projectRoot, stateOptions(args));
  const sinceFlag = flag(args, "since")?.trim();
  const since = sinceFlag === undefined || sinceFlag === "" ? null : Number(sinceFlag);
  if (since !== null && (!Number.isInteger(since) || since < 0)) {
    throw new Error(`--since must be a non-negative integer event id, got ${sinceFlag}`);
  }
  const pidFlag = flag(args, "pid")?.trim();
  const pid = pidFlag === undefined || pidFlag === "" ? null : Number(pidFlag);
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new Error(`--pid must be a positive integer, got ${pidFlag}`);
  const agent = flag(args, "agent")?.trim() || null;
  if (agent !== null && pid !== null) throw new Error("--agent and --pid are two answers to the same question; give one");
  const notifyFlag = flag(args, "notify-after");
  const notifyAfter = notifyFlag === undefined ? undefined : Number(notifyFlag);
  if (notifyAfter !== undefined && (!Number.isSafeInteger(notifyAfter) || notifyAfter < 0)) {
    throw new Error("--notify-after must be a non-negative integer timestamp from the previous re-arm command");
  }

  // Named targets use a long asynchronous wait; PID callers retain signal 0.
  // Environment checks do not probe agent list: a list outage must not close wait.
  const environment = agent === null ? null : (await import("./herdr")).environmentCapabilities({});
  const probe = pid !== null
      // signal 0 tests for the process's existence without touching it. ESRCH
      // is a real answer; any other errno is an observation failure, so it
      // degrades to null rather than declaring the process dead.
      ? {
        probe: "pid",
        isAlive: () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
          }
        },
      }
      : { probe: agent === null ? "unavailable"
          : environment?.holes.alive ? "herdr-wait" : `unavailable: ${environment?.reason}`, isAlive: null };

  const outcome = await waitForEvent({
    loadState: () => parseImplementState(fs.readFileSync(statePath, "utf8")),
    since,
    stallMs: STALL_THRESHOLD_MS,
    notifyAfter,
    isAlive: probe.isAlive,
    agent: agent !== null && environment?.holes.alive ? agent : undefined,
    observationProblem: environment?.reason ?? undefined,
  });

  // The supervision loop's one unguarded link: the waiter is a one-shot, so a
  // supervisor that wakes, handles the event, and forgets to re-arm leaves the
  // implementor working with nobody watching - silently, with no error to
  // notice. Nothing in the harness can force the re-arm (the waiter is a
  // detached process the CLI cannot see), so the cheapest real reduction is to
  // hand the next command back fully assembled, with the cursor already
  // advanced and the same probe flag carried over, instead of asking the
  // supervisor to remember and rebuild it. Omitted on `implementor-gone`:
  // the target must be inspected before deciding how to recover.
  const rearm = outcome.reason === "implementor-gone"
    ? null
    : [
      "sasu implement await",
      ...(flag(args, "slug") !== undefined ? [`--slug ${flag(args, "slug")}`] : []),
      ...(flag(args, "state") !== undefined ? [`--state ${flag(args, "state")}`] : []),
      `--since ${outcome.cursor}`,
      ...(outcome.notifyAfter !== undefined ? [`--notify-after ${outcome.notifyAfter}`] : []),
      ...(agent !== null ? [`--agent ${agent}`] : pid !== null ? [`--pid ${pid}`] : []),
    ].join(" ");

  const message = `woke on ${outcome.reason}: ${outcome.detail}`;
  return result("await", true, rearm === null ? message : `${message}; re-arm in the background with: ${rearm}`, {
    reason: outcome.reason,
    cursor: outcome.cursor,
    waitedMs: outcome.waitedMs,
    events: outcome.events,
    livenessProbe: outcome.observationProblem === undefined ? probe.probe : `unavailable: ${outcome.observationProblem}`,
    detail: outcome.detail,
    rearm,
  });
}

function readHandoffPacket(): string {
  if (process.stdin.isTTY === true) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function dispatch(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  try {
    const dispatched = dispatchImplementor(projectRoot, {
      name: requiredFlag(args, "name"),
      prdPath: requiredFlag(args, "prd"),
      handoff: readHandoffPacket(),
      cwd: projectRoot,
      kind: flag(args, "kind")?.trim() || undefined,
      model: flag(args, "model")?.trim() || undefined,
      effort: flag(args, "effort")?.trim() || undefined,
    });
    return result(
      "dispatch",
      true,
      `implementor ${dispatched.agent} (${dispatched.kind}) started in ${dispatched.paneId} from ${dispatched.prd}`,
      { ...dispatched },
      [
        `Wake on its events with \`sasu implement await --agent ${dispatched.agent}\`.`,
        `Read its pane with \`herdr agent read ${dispatched.agent} --source recent-unwrapped --lines 120\` for diagnosis only.`,
      ],
    );
  } catch (error) {
    // A refused dispatch created nothing, so it is a message and an exit code,
    // not a recorded run event: there is no run yet to record it against.
    if (error instanceof DispatchRejected) return { ok: false, action: "dispatch", exitCode: 1, message: `dispatch refused: ${error.message}` };
    throw error;
  }
}

async function escalate(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  let { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const config = loadConfig(state.projectRoot);
  const issuer = resolveIssuer(flag(args, "issuer"));
  assertEscalateBudget(state);
  const reason = flag(args, "reason")?.trim() ?? "";
  if (reason === "") throw new EscalateRejected("arguments", "escalate requires --reason <what the implementor is stuck on>");
  const target = flag(args, "target")?.trim().toUpperCase() || null;
  if (target !== null && !state.findings.some((entry) => entry.id === target) && !state.riskFindings.some((entry) => entry.id === target)) {
    throw new EscalateRejected("arguments", `unknown --target ${target}; name an open finding in this run`);
  }
  const agent = flag(args, "agent")?.trim() || null;

  // Read-only preparation. `readPane` is diagnosis input and nothing else: a
  // missing pane degrades the envelope, it does not stop the escalation (R9).
  const prd = requirePinnedPrd(projectRoot, state);
  const ledger = JSON.stringify({ findings: state.findings, risks: state.riskFindings, attempts: state.verificationAttempts.map(attemptSummary) }, null, 2);
  const pane = agent === null
    ? { ok: false, value: null, problem: "no --agent given, so there is no pane to read" }
    : readPane({ name: agent });

  const profile: ReviewProfile = "high-risk";
  const lane = await judgeLane(crypto.randomUUID(), () => runJudge(
    config,
    "implement:solver",
    // The solver reuses the high-risk profile's routing rather than adding a
    // model knob of its own (R12, D-46): one routing table, not two.
    profile,
    solverPrompt({
      target,
      reason,
      prd,
      findings: ledger,
      paneExcerpt: pane.value,
      paneProblem: pane.problem,
    }),
    (value) => validateDiagnosis(value),
  ));

  // A solver awaits an external process. Refresh ownership and the execution
  // lease before its result can write files or start a replacement.
  state = loadState(state.projectRoot, { state: statePath }).state;
  await recoverVerification(statePath, state);
  assertRunOpenForMutation(state); assertRunOwnership(statePath, state, args);
  const at = nowIso();
  if (lane.verdict === "ERROR" || lane.result === null) {
    const failure = lane.error?.message ?? "the solver returned nothing usable";
    const record = recordEscalation(state, {
      at, target, reason, profile,
      model: lane.judge?.model ?? null,
      judge: lane.judge,
      durationMs: lane.durationMs,
      outcome: "summon-failed",
      diagnosis: null,
      error: failure,
      handoff: null,
    });
    recordEvent(state, { kind: "escalate", actor: issuer, subject: target, summary: `escalation ${record.id} failed to summon a solver`, at });
    persistState(statePath, state);
    // A failed summon is a recorded outcome, not a thrown error: the
    // supervisor asked a question and the honest answer is "nobody came",
    // which belongs in the ledger where the next decision is made (AC35).
    return result("escalate", false, `escalation ${record.id} failed: ${failure}. The implementor was NOT reset. ${ESCALATE_LIMIT_PER_RUN - state.escalations.length} escalation(s) remain.`, {
      escalation: record,
      escalationsRemaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length,
    });
  }

  const diagnosis = lane.result;
  const solverDir = `${state.runDir}/artifacts/solver`;
  const id = Math.max(0, ...state.escalations.map((entry) => entry.id)) + 1;
  const handoff: SolverHandoff = {
    prdSnapshotPath: state.prd.snapshotPath,
    diagnosisPath: `${solverDir}/diagnosis-${id}.md`,
    findingsPath: `${solverDir}/findings-${id}.json`,
  };
  fs.mkdirSync(path.join(projectRoot, solverDir), { recursive: true });
  writeTextAtomic(path.join(projectRoot, handoff.diagnosisPath), renderDiagnosis({ id, at, target, reason }, diagnosis));
  writeTextAtomic(path.join(projectRoot, handoff.findingsPath), `${ledger}\n`);

  const briefing = buildHandoffBriefing(handoff);
  const reset = agent === null
    ? { ok: false, value: null, problem: "no --agent given; reset the implementor's context yourself and hand it the three artifacts below" }
    : spawnImplementor({ name: `${agent}-r${id}`, cwd: state.worktree?.path ?? projectRoot, prompt: briefing });

  const record = recordEscalation(state, {
    at, target, reason, profile,
    model: lane.judge?.model ?? null,
    judge: lane.judge,
    durationMs: lane.durationMs,
    outcome: "diagnosed",
    diagnosis: diagnosis.summary,
    error: null,
    handoff,
  });
  recordEvent(state, {
    kind: "escalate",
    actor: issuer,
    subject: target,
    summary: `escalation ${record.id} diagnosed${reset.ok ? " and the implementor was reset" : "; the context reset is the supervisor's to perform"}`,
    at,
  });
  persistState(statePath, state);
  return result("escalate", true, `escalation ${record.id} diagnosed: ${diagnosis.summary}. ${reset.ok ? "A replacement implementor was started with the three handoff artifacts." : `Context reset not performed automatically (${reset.problem}).`}`, {
    escalation: record,
    handoff,
    briefing,
    contextReset: reset.ok,
    contextResetProblem: reset.problem,
    escalationsRemaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length,
  });
}

function inspectArtifactFile(absolute: string, kind: string): { sha256: string; bytes: number } {
  if (!fs.existsSync(absolute)) throw new Error(`artifact not found: ${absolute}`);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact must be a non-empty file: ${absolute}`);
  const buffer = fs.readFileSync(absolute);
  if (kind === "screenshot" || kind === "image") {
    const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
    if (!png && !jpeg) throw new Error("image artifact must contain valid PNG or JPEG bytes");
  }
  return { sha256: sha256(buffer), bytes: stat.size };
}

/** Append one resubmission to the run's evidence history (AC40). */
export function recordEvidenceReplacement(
  state: ImplementState,
  entry: Omit<EvidenceReplacement, "id" | "at">,
): EvidenceReplacement {
  const record: EvidenceReplacement = {
    id: Math.max(0, ...state.evidenceReplacements.map((existing) => existing.id)) + 1,
    at: nowIso(),
    ...entry,
  };
  state.evidenceReplacements.push(record);
  return record;
}

/**
 * Refuse an agent-supplied evidence path whose real target leaves the project.
 *
 * `normalizeProjectPath` is lexical only: `agents/proof.txt` symlinked to a
 * credential file outside the project satisfies it, and `inspectArtifactFile`
 * then statSync/readFileSync through the link and hand those bytes to an
 * external judge. Registration is the only place to stop that, because after
 * it the path is hash-pinned and indistinguishable from honest evidence.
 *
 * The containment test is the check-binding idiom from checks.ts: walk to the
 * nearest existing ancestor, realpath it, and refuse a relative that escapes.
 * The ancestor walk is what still admits a bookkeeping declaration for a file
 * this run has not written yet, while refusing a link that already escapes.
 */
function assertEvidencePathInsideProject(projectRoot: string, target: { absolute: string; relative: string }): void {
  const realRoot = fs.realpathSync(projectRoot);
  let existingAncestor = target.absolute;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const real = fs.realpathSync(existingAncestor);
  const relative = path.relative(realRoot, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `evidence path resolves outside the project: ${target.relative} -> ${real}.`
        + " Registration reads the file and hands its bytes to the judge, so the real target must stay inside the record tree.",
    );
  }
}

function harnessOwnedRunPath(state: ImplementState, relative: string): boolean {
  return relative === `${state.runDir}/state.json`
    || relative === state.prd.snapshotPath
    || relative === `${state.runDir}/receipt.json`
    || relative === `${state.runDir}/implementation-result.md`
    || relative.startsWith(`${state.runDir}/artifacts/logs/`)
    || relative.startsWith(`${state.runDir}/gates/`)
    || relative === "agents/config.json"
    || relative.startsWith("agents/gates/");
}

/**
 * The registration path resolved through realpath and re-expressed relative
 * to the run dir, so a symlink alias to a harness-owned file is judged by
 * where it actually points. Falls back to the string-normalized relative
 * when the file sits outside the run dir.
 */
function canonicalRunRelative(state: ImplementState, target: { absolute: string; relative: string }): string {
  try {
    const realRunDir = fs.realpathSync(path.join(state.projectRoot, state.runDir));
    const realTarget = fs.realpathSync(target.absolute);
    if (realTarget === realRunDir) return state.runDir;
    if (realTarget.startsWith(`${realRunDir}${path.sep}`)) {
      return `${state.runDir}/${path.relative(realRunDir, realTarget).split(path.sep).join("/")}`;
    }
  } catch {
    // A vanished path falls through to the string form; inspectArtifactFile
    // rejects missing files with its own message.
  }
  return target.relative;
}

function riskNonConvergent(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const approval = requiredFlag(args, "approval");
  const reason = requiredFlag(args, "reason");
  const entry = state.riskFindings.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = openRiskFindings(state).map((candidate) => candidate.id);
    throw new Error(`unknown risk finding: ${id}${known.length === 0 ? "" : ` (open: ${known.join(", ")})`}`);
  }
  if (entry.status !== "open") {
    throw new Error(`${id} is ${entry.status}, not open: only an open finding can be declared non-convergent`);
  }
  // The structural fact the harness owns: how many judged attempts this
  // finding has already survived. Corroboration in the record, never the gate.
  const originIndex = state.verificationAttempts.findIndex((attempt) => attempt.id === entry.originAttemptId);
  const roundsUnchanged = originIndex === -1 ? 0 : state.verificationAttempts.length - originIndex - 1;
  entry.nonConvergence = { at: nowIso(), approval, reason, declaredBy: "human", roundsUnchanged };
  persistState(statePath, state);
  return result(
    "risk",
    true,
    `${id} declared non-convergent after ${roundsUnchanged} judged round(s) unchanged; it stays open and `
      + `\`finalize --status complete\` stays refused, but \`--status blocked\` no longer waits for the judge budget`,
    { finding: entry, open: openRiskFindings(state) },
  );
}

function risk(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  if (args.flags.get("non-convergent") === true) return riskNonConvergent(projectRoot, args);
  if (args.flags.get("accept") !== true) throw new Error("risk requires --accept or --non-convergent");
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id").toUpperCase();
  const evidence = requiredFlag(args, "evidence");
  const entry = state.riskFindings.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = openRiskFindings(state).map((candidate) => candidate.id);
    throw new Error(`unknown risk finding: ${id}${known.length === 0 ? "" : ` (open: ${known.join(", ")})`}`);
  }
  if (entry.status === "accepted") {
    if (entry.resolution?.evidence !== evidence) throw new Error(`${id} is already accepted with different evidence`);
    // Ownership adoption is itself state even when the finding transition is
    // already settled, so the idempotent path must not discard it.
    persistState(statePath, state);
    return result("risk", true, `${id} was already accepted with the same evidence`, {
      finding: entry,
      open: openRiskFindings(state),
    });
  }
  if (entry.status === "fixed") throw new Error(`${id} is already fixed by a later risk review`);
  entry.status = "accepted";
  entry.resolution = { at: nowIso(), evidence };
  persistState(statePath, state);
  const open = openRiskFindings(state);
  return result("risk", true, `${id} accepted; ${open.length} risk finding(s) remain open`, {
    finding: entry,
    open,
  });
}

function writeMechanicalLog(
  projectRoot: string,
  state: ImplementState,
  run: Omit<MechanicalRunRecord, "logPath">,
  stdout: string,
  stderr: string,
): string {
  const key = sha256(`${run.startedAt}\0${run.cwd}\0${run.command}`).slice(0, 16);
  const relative = `${state.runDir}/artifacts/logs/mechanical-${key}.log`;
  const absolute = path.join(projectRoot, relative);
  writeTextAtomic(absolute, [
    `command: ${run.command}`,
    `cwd: ${run.cwd}`,
    `startedAt: ${run.startedAt}`,
    `finishedAt: ${run.finishedAt}`,
    `durationMs: ${run.durationMs}`,
    `exitCode: ${run.exitCode}`,
    "",
    "--- stdout ---",
    stdout,
    "",
    "--- stderr ---",
    stderr,
    "",
  ].join("\n"));
  return relative;
}

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, projectRoot: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  const artifact: RegisteredArtifact = {
    kind: "command-log",
    path: run.logPath,
    description: `mechanical ${run.status}: ${run.command}`,
    ...inspected,
    registeredAt: run.finishedAt,
    observedAt: run.finishedAt,
    provenance: `CLI executed ${run.command} in ${run.cwd}`,
    command: run.command,
    cwd: run.cwd,
    exitCode: run.exitCode,
  };
  state.artifacts = state.artifacts.filter((entry) => !(entry.command === run.command && entry.cwd === run.cwd));
  state.artifacts.push(artifact);
}

// Progress lines go to stderr so --json stdout stays parseable. Verify runs
// minutes of judge work; silent, it forces callers to invent their own
// polling (2026-08-13 creator-assist: 31 minutes of agent wall-clock spent on
// nohup + sleep + ps loops watching an opaque verify).
function progress(line: string): void {
  process.stderr.write(`[implement:verify] ${line}\n`);
}

/**
 * Record each actual execution from the sealed suite on the pinned tree.
 * Required commands share one executor and no shell or inherited environment.
 * A command that did not run never receives a successful suite result.
 */
/** The execution, recorded on the suite axis. */
function attributeToSuite(state: ImplementState, result: RunUnitResult, attemptId: string, logPath: string): void {
  const entry = {
    commandId: result.unit.suiteCommandId,
    attemptId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    mutatedTree: result.mutatedTree,
    status: result.outcome === "green" ? ("GREEN" as const) : ("RED" as const),
    logPath,
  };
  // Latest result per command, replaced whole: the suite axis reports the
  // current tree, not a history. History lives in verificationAttempts.
  state.suite.results = state.suite.results.filter((existing) => existing.commandId !== entry.commandId);
  state.suite.results.push(entry);
}

function changeMaterial(projectRoot: string, state: ImplementState, current: ReturnType<typeof captureSourceSnapshot>): ChangeFile[] {
  return changedPathsSince(state.initialSource, current).map((relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return { path: relative, body: "[deleted]" };
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) return { path: relative, body: `[binary ${buffer.length} bytes]` };
    const text = buffer.toString("utf8");
    return { path: relative, body: text };
  });
}

/**
 * The selected changed paths as a diff against the initial commit.
 * Current file bodies alone cannot identify deleted behavior or distinguish
 * newly introduced code from behavior already present at the baseline.
 *
 * Bounded by `--stat`-free plain diff over exactly the changed paths, so
 * generated trees excluded from the snapshot stay excluded here too. Without
 * git (or when git fails), explicitly report that the diff is unavailable;
 * the reviewer must assess whether current bodies are sufficient evidence.
 */
function runOwnedDiff(projectRoot: string, state: ImplementState, paths: string[]): string {
  const head = state.initialSource.head;
  if (head === null || paths.length === 0) return "No diff available (the project is not a git repository, or nothing changed).";
  const tracked = spawnSync("git", ["ls-tree", "-r", "--name-only", head], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.error !== undefined || tracked.status !== 0) return `No diff available (git ls-tree ${head} failed).`;
  const atHead = new Set(tracked.stdout.split("\n").filter((entry) => entry !== ""));
  const sections: string[] = [];
  const known = paths.filter((entry) => atHead.has(entry));
  if (known.length > 0) {
    const executed = spawnSync("git", ["diff", head, "--", ...known], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (executed.error !== undefined || executed.status !== 0) return `No diff available (git diff against ${head} failed).`;
    if (executed.stdout.trim() !== "") sections.push(executed.stdout.trimEnd());
  }
  // Files absent from the pre-run commit are the run's newest work and the
  // most likely place for accretion, yet `git diff <head>` never shows them:
  // untracked paths are invisible to it, and `git add -N` would buy their
  // visibility by mutating the index of a tree under judgment. --no-index
  // against /dev/null reads the same diff without touching any repository state.
  for (const relative of paths) {
    if (atHead.has(relative)) continue;
    if (!fs.existsSync(path.join(projectRoot, relative))) continue;
    const added = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", relative], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    // --no-index exits 1 when the inputs differ, which is the normal case here.
    if (added.error === undefined && added.stdout.trim() !== "") sections.push(added.stdout.trimEnd());
  }
  return sections.length === 0 ? "The changed files are byte-identical to the pre-run commit." : sections.join("\n");
}

async function judgeLane<T>(
  invocationId: string,
  run: () => Promise<{ value: T; record: LaneRecord<T>["judge"] }>,
  derive?: (value: T) => VerificationStatus,
): Promise<LaneRecord<T>> {
  const started = Date.now();
  const startedAt = nowIso();
  try {
    const outcome = await run();
    const value = outcome.value as T & { verdict?: string };
    const verdict: VerificationStatus = derive ? derive(outcome.value) : value.verdict === "PASS" ? "PASS" : "FAIL";
    return {
      invocationId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      verdict,
      result: outcome.value,
      judge: outcome.record,
      error: null,
    };
  } catch (error) {
    const code = error instanceof JudgeError ? error.code : "judge-runtime";
    const cause = error instanceof JudgeError
      ? judgeFailureCause(error)
      : { code, backend: "unknown", reason: null };
    return {
      invocationId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - started,
      verdict: "ERROR",
      result: null,
      judge: judgeCallRecordFrom(error),
      error: { code, message: error instanceof Error ? error.message : String(error), cause },
    };
  }
}

function specGateIsFresh(projectRoot: string, state: ImplementState): boolean {
  try {
    const view = readGateStatus(projectRoot, loadConfig(projectRoot), state.topicSlug).spec;
    return view.effective === "PASS" && view.staleInputs.length === 0 && !view.overridden;
  } catch {
    return false;
  }
}


function inputFingerprint(state: ImplementState, sourceDigest: string, intentInput: UnifiedVerificationAttempt["intentInput"]): string {
  const artifacts = state.artifacts.filter((entry) => entry.command === undefined)
    .map(({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }) => ({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sourcePath = state.prd.sourceIntake && state.prd.sourceIntake != "current conversation" ? normalizeProjectPath(state.projectRoot, state.prd.sourceIntake).absolute : null;
  const sourceIntake = sourcePath === null ? null : sha256(fs.readFileSync(sourcePath));
  return sha256(JSON.stringify({ schema: state.schema, prd: state.prd.sha256, sourceDigest, artifacts, intentInput, sourceIntake, suite: { commands: state.suite.commands, exclusions: state.suite.exclusions }, amendments: state.amendments }));
}

function attemptSummary(attempt: UnifiedVerificationAttempt): Record<string, unknown> {
  const slim = <T>(lane: LaneRecord<T> | null) => lane === null ? null : {
    invocationId: lane.invocationId, verdict: lane.verdict, result: lane.result,
    startedAt: lane.startedAt, finishedAt: lane.finishedAt, durationMs: lane.durationMs, error: lane.error,
  };
  return { id: attempt.id, verdict: attempt.verdict, phase: attempt.phase, inputFingerprint: attempt.inputFingerprint,
    sourceFingerprint: attempt.sourceFingerprint, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
    durationMs: attempt.durationMs, prelint: attempt.prelint, mechanical: attempt.mechanical,
    review: slim(attempt.review), risk: slim(attempt.risk), error: attempt.error };
}

// Repeating the same preparation failure is bounded separately: it made no
// semantic review call and must never inflate the recorded judge round count.
const PREJUDGE_FAILURE_LIMIT = 3;
function verificationBudget(state: ImplementState, budget: number) {
  let fixAttempts = 0, consecutiveErrors = 0, prejudgeFailures = 0;
  let lastPrejudgeKey: string | null = null;
  let judgeErrorCause: string | null = null, lastErrorKey: string | null = null;
  const grants = state.budgetGrants ?? [];
  for (const attempt of state.verificationAttempts.slice(grants.at(-1)?.attemptCountBefore ?? 0)) {
    if (attempt.verdict === "NOT_RUN") continue;
    if (attempt.verdict === "PASS") { fixAttempts = 0; consecutiveErrors = 0; prejudgeFailures = 0; lastPrejudgeKey = null; lastErrorKey = null; judgeErrorCause = null; continue; }
    if (attempt.review === null && attempt.risk === null && attempt.error !== null) {
      const key = JSON.stringify([attempt.inputFingerprint, attempt.error.stage, attempt.error.code, attempt.error.message]);
      prejudgeFailures = key === lastPrejudgeKey ? prejudgeFailures + 1 : 1;
      lastPrejudgeKey = key;
    } else { prejudgeFailures = 0; lastPrejudgeKey = null; }
    const failures = [attempt.review, attempt.risk].flatMap((lane) => lane?.error?.cause ? [lane.error.cause] : []);
    if (attempt.verdict === "ERROR" && failures.length > 0) {
      const key = failures.map((cause) => `${cause.backend}:${cause.code}:${cause.reason ?? ""}`).sort().join("|");
      consecutiveErrors = key === lastErrorKey ? consecutiveErrors + 1 : 1;
      lastErrorKey = key; judgeErrorCause = failures.map(describeJudgeFailureCause).join(", ");
      continue;
    }
    consecutiveErrors = 0; lastErrorKey = null; judgeErrorCause = null;
    // Count actual non-completing semantic rounds, including a routine PASS
    // with an open blocking risk. Preflight and suite failures called no judge.
    if (attempt.review?.result || attempt.risk?.result) fixAttempts += 1;
  }
  return { fixAttempts, totalAttempts: state.verificationAttempts.length, budget,
    budgetExhausted: fixAttempts >= budget, consecutiveErrors, judgeErrorThreshold: JUDGE_ERROR_LOOP_THRESHOLD,
    judgeErrorCause, judgeErrorLoop: consecutiveErrors >= JUDGE_ERROR_LOOP_THRESHOLD,
    prejudgeFailures, prejudgeFailureLimit: PREJUDGE_FAILURE_LIMIT, prejudgeFailureLoop: prejudgeFailures >= PREJUDGE_FAILURE_LIMIT, grants: grants.length };
}

function terminalBudgetMessage(view: ReturnType<typeof verificationBudget>): string | null {
  const next = 'close honestly with `sasu implement finalize --status blocked`, or record explicit user approval with `verify --grant-budget "<user words>"`';
  return view.budgetExhausted ? `verification fix budget exhausted (${view.fixAttempts}/${view.budget}); ${next}`
    : view.judgeErrorLoop ? `judge error loop (${view.consecutiveErrors}/${view.judgeErrorThreshold}, ${view.judgeErrorCause}); ${next}`
    : view.prejudgeFailureLoop ? `repeated preparation failure (${view.prejudgeFailures}/${view.prejudgeFailureLimit}); ${next}` : null;
}

function blockedReason(state: ImplementState): string | null {
  const view = verificationBudget(state, loadConfig(state.projectRoot).judge.retryBudget);
  if (view.budgetExhausted) return "budget-exhausted";
  if (view.judgeErrorLoop) return "judge-error-loop";
  if (view.prejudgeFailureLoop) return "prejudge-failure-loop";
  const blocking = openRiskFindings(state).filter((entry) => entry.severity === "blocking");
  const latest = state.verificationAttempts.at(-1);
  // Human risk authority cannot waive product defects or an uncompleted
  // review/suite. All remaining blockers must be the declared risk findings.
  return blocking.length > 0 && blocking.every((entry) => entry.nonConvergence !== undefined)
    && latest?.error === null && latest.review?.result != null && latest.risk?.result != null
    && latest.mechanical.every((entry) => entry.status === "PASS")
    && !openFindings(state).some((entry) => entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing !== "post-completion"))
    && openHumanRejections(state).length === 0 ? "non-convergent-findings" : null;
}

export function openRiskFindings(state: ImplementState): TrackedRiskFinding[] { return state.riskFindings.filter((entry) => entry.status === "open"); }
function openFindings(state: ImplementState) { return state.findings.filter((entry) => entry.status === "open"); }
function humanConfirmations(state: ImplementState) { return state.findings.filter((entry) => entry.kind === "human-confirmation"); }
function openHumanRejections(state: ImplementState) {
  return humanConfirmations(state).filter((entry) => entry.status !== "amended" && entry.responses.at(-1)?.response === "rejected");
}
function effectiveVerdict(state: ImplementState, attempt: UnifiedVerificationAttempt): VerificationStatus {
  if (attempt.verdict !== "FAIL") return attempt.verdict;
  if (attempt.error !== null || attempt.review?.result == null || attempt.mechanical.some((entry) => entry.status !== "PASS")) return attempt.verdict;
  if (state.prd.reviewProfile === "high-risk" && attempt.risk?.result == null) return attempt.verdict;
  if (openFindings(state).some((entry) => entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing !== "post-completion"))) return "FAIL";
  if (openRiskFindings(state).some((entry) => entry.severity === "blocking")) return "FAIL";
  return "PASS";
}
function delivery(state: ImplementState, freshness: string[] = []) {
  const reasons = [...freshness];
  if (state.status !== "complete" && state.status !== "complete-pending-human") reasons.push(`run is ${state.status}`);
  reasons.push(...openFindings(state).filter((entry) => entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing !== "post-completion")).map((entry) => `${entry.id}: ${entry.problem}`));
  reasons.push(...openRiskFindings(state).filter((entry) => entry.severity === "blocking").map((entry) => `${entry.id}: ${entry.text}`));
  reasons.push(...openHumanRejections(state).map((entry) => `${entry.id}: human rejected: ${entry.responses.at(-1)!.evidence}`));
  return { eligible: reasons.length === 0, reasons };
}

function publicState(state: ImplementState, retryBudget: number, currentSourceDigest?: string, currentInputFingerprint?: string): Record<string, unknown> {
  const latest = state.verificationAttempts.at(-1) ?? null;
  const stale = latest !== null && ((currentSourceDigest !== undefined && latest.sourceFingerprint !== currentSourceDigest) || (currentInputFingerprint !== undefined && latest.inputFingerprint !== currentInputFingerprint));
  return { schema: state.schema, status: state.status, topicSlug: state.topicSlug, prdPath: state.prdPath, prdSnapshotPath: state.prd.snapshotPath,
    baselineAttribution: state.baselineAttribution, workingRoot: state.worktree?.path ?? state.projectRoot, worktree: state.worktree ?? null,
    reviewProfile: state.prd.reviewProfile, escalations: { used: state.escalations.length, limit: ESCALATE_LIMIT_PER_RUN, remaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length }, requirementCount: state.requirements.length, suite: suiteScore(state),
    findings: openFindings(state), humanConfirmations: humanConfirmations(state), riskFindings: { open: openRiskFindings(state), openCount: openRiskFindings(state).length },
    verification: { verdict: stale ? "STALE" : latest ? effectiveVerdict(state, latest) : "NOT_RUN", attempts: state.verificationAttempts.length, budget: verificationBudget(state, retryBudget), latest: latest ? attemptSummary(latest) : null },
    activeVerification: state.activeVerification ?? null, artifacts: state.artifacts, retirement: state.retirement, completion: state.completion,
    delivery: delivery(state, stale ? ["verification is STALE"] : []) };
}

function currentInputs(state: ImplementState) {
  const source = captureSourceSnapshot(requireWorkRoot(state));
  const held = pinnedPrd(state.projectRoot, state);
  const contract = parseImplementContract(held.text);
  const context = intentSource(state.projectRoot, contract, specGateIsFresh(state.projectRoot, state));
  const intentInput = { routing: context.routing, contentSha256: sha256(context.content) };
  return { source, held, contract, context, intentInput, fingerprint: inputFingerprint(state, source.digest, intentInput) };
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { state } = loadState(projectRoot, stateOptions(args));
  const config = loadConfig(state.projectRoot), herdr = herdrCapabilities();
  let sourceDigest: string | undefined, fingerprint: string | undefined;
  const problems = artifactIntegrityProblems(state.projectRoot, state);
  try {
    const inputs = currentInputs(state);
    sourceDigest = inputs.source.digest; fingerprint = inputs.fingerprint;
    if (inputs.held.drift !== null) { problems.push("PRD changed after the sealed snapshot"); fingerprint = "PRD_DRIFT"; }
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); fingerprint = "INPUT_ERROR"; }
  if (problems.length > 0) fingerprint = "INPUT_ERROR";
  const detail = publicState(state, config.judge.retryBudget, sourceDigest, fingerprint);
  const currentDelivery = delivery(state, problems.concat((detail.verification as {verdict:string}).verdict === "STALE" ? ["verification is STALE"] : []));
  return result("status", true, `${state.topicSlug}: ${state.status}`, { ...detail, delivery: currentDelivery, artifactProblems: problems,
    herdr: { available: herdr.available, unavailableHoles: (["spawn", "read", "alive"] as const).filter((hole) => !herdr.holes[hole]), reason: herdr.reason } }, [
      `${state.topicSlug}: ${state.status}; ${(detail.verification as {verdict:string}).verdict}`,
      `Source: ${sourceDigest ?? "unavailable"}; ${state.requirements.length} requirements retained in the contract`,
      `Required suite: ${JSON.stringify(suiteScore(state))}`,
      `escalations: ${state.escalations.length} of ${ESCALATE_LIMIT_PER_RUN} used${state.escalations.length >= ESCALATE_LIMIT_PER_RUN ? "; bound spent; amend with human approval or finalize blocked" : ""}`,
      ...openFindings(state).map((entry) => `${entry.id} [${entry.kind}] ${entry.problem} - ${entry.nextAction}`),
      ...openRiskFindings(state).map((entry) => `${entry.id} [risk ${entry.severity}] ${entry.text}`),
      ...currentDelivery.reasons.map((reason) => `Delivery: ${reason}`),
      ...(state.activeVerification ? [`Verification in progress: ${state.activeVerification.attemptId}`] : []),
      `Next: ${state.status === "active" ? "implement or fix findings, then verify and finalize" : state.status === "complete-pending-human" ? "confirm the remaining human item IDs using the user's words" : "inspect the current receipt"}`,
    ]);
}

function amend(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state); assertRunOwnership(statePath, state, args);
  const issuer = resolveIssuer(flag(args, "issuer"));
  const text = fs.readFileSync(normalizeProjectPath(state.projectRoot, state.prdPath).absolute, "utf8");
  const outcome = applyAmendment(state.projectRoot, state, { issuer, text, approval: requiredFlag(args, "approval"), reason: requiredFlag(args, "reason"), excludeSuite: (flag(args, "exclude-suite") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean) }, nowIso());
  recordVerb(state, { verb: "amend", issuer, target: null, reason: requiredFlag(args, "reason"), at: nowIso(), outcome: "accepted" });
  recordEvent(state, { kind: "amendment", actor: issuer, subject: null, summary: `amendment ${outcome.record.id} resealed the complete contract`, at: nowIso() });
  persistClose(statePath, state, outcome.derived);
  return result("amend", true, `amendment ${outcome.record.id} sealed; full review freshness invalidated`, { amendment: outcome.record });
}

function artifact(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state); assertRunOwnership(statePath, state, args);
  if (args.flags.has("row")) throw new Error("artifact --row is retired; register evidence for the run");
  let inputs: Array<Record<string, unknown>>;
  if (args.flags.has("manifest")) {
    const raw: unknown = JSON.parse(fs.readFileSync(normalizeProjectPath(state.projectRoot, requiredFlag(args, "manifest")).absolute, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) throw new Error("artifact --manifest must contain a non-empty JSON array of artifact objects");
    inputs = raw;
  } else inputs = [{ kind: requiredFlag(args, "kind"), path: requiredFlag(args, "path"), description: requiredFlag(args, "description"), source: flag(args, "source"), collectedAt: flag(args, "collected-at"), target: flag(args, "target"), environment: flag(args, "environment"), requirementRefs: flag(args, "refs")?.split(",").map((entry) => entry.trim()) }];
  const registered: RegisteredArtifact[] = [];
  for (const input of inputs) {
    for (const key of ["kind", "path", "description"]) if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`artifact ${key} must be a non-empty string`);
    if ("rowId" in input || "row" in input) throw new Error("per-requirement artifact fields are retired");
    const kind = (input.kind as string).toLowerCase();
    if (!ARTIFACT_KINDS.has(kind) || kind === "command-log") throw new Error("artifact kind must be screenshot, image, browser, api, db, log, or file");
    const target = normalizeProjectPath(state.projectRoot, input.path as string);
    assertEvidencePathInsideProject(state.projectRoot, target);
    if (harnessOwnedRunPath(state, canonicalRunRelative(state, target))) throw new Error(`artifact path is harness-owned: ${target.relative}; register actual runtime output`);
    const inspected = inspectArtifactFile(target.absolute, kind);
    const previous = state.artifacts.find((entry) => entry.path === target.relative);
    if (previous?.command !== undefined) throw new Error("cannot replace harness command evidence");
    if (previous?.sha256 === inspected.sha256) { registered.push(previous); continue; }
    const observedAt = typeof input.collectedAt === "string" ? input.collectedAt : nowIso();
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("artifact collectedAt must be a timestamp");
    const refs = input.requirementRefs;
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !state.requirements.some((entry) => entry.id === ref)))) throw new Error("artifact requirementRefs must name existing requirements");
    const entry: RegisteredArtifact = { kind, path: target.relative, description: input.description as string, ...inspected,
      registeredAt: nowIso(), observedAt, provenance: typeof input.source === "string" && input.source.trim() ? input.source : `registered by ${resolveIssuer(flag(args, "issuer"))}; collection is self-reported`,
      ...(typeof input.target === "string" ? { target: input.target } : {}), ...(typeof input.environment === "string" ? { environment: input.environment } : {}), ...(refs ? { requirementRefs: refs as string[] } : {}) };
    if (previous) recordEvidenceReplacement(state, { kind: "artifact", previous: `${previous.path}@${previous.sha256} observed ${previous.observedAt}`, next: `${entry.path}@${entry.sha256}`, priorDisposition: "invalidated" });
    state.artifacts = state.artifacts.filter((held) => held.path !== entry.path); state.artifacts.push(entry); registered.push(entry);
  }
  recordEvent(state, { kind: "artifact", actor: resolveIssuer(flag(args, "issuer")), subject: null, summary: `${registered.length} run evidence file(s) registered`, at: nowIso() });
  persistState(statePath, state);
  return result("artifact", true, `${registered.length} run evidence file(s) registered; unchanged bytes retain their original observation time`, { artifacts: registered });
}

function reviewInputs(state: ImplementState, attempt: UnifiedVerificationAttempt, inputs: ReturnType<typeof currentInputs>): { material: ReviewPromptMaterial; cwd: string; evidencePaths: string[]; images: string[]; refs: string[] } {
  const workRoot = requireWorkRoot(state);
  const changed = changedPathsSince(state.initialSource, inputs.source);
  const sourceCatalog = inputs.source.entries.map((entry) => entry.path);
  const currentSource = new Map(inputs.source.entries.map((entry) => [entry.path, entry.sha256]));
  // The existing judge isolation can only admit files beneath one root. Stage
  // exact product/evidence bytes together when record and work trees differ.
  const cwd = path.join(state.projectRoot, state.runDir, "review-inputs", attempt.id);
  fs.mkdirSync(cwd, { recursive: true });
  const paths = new Set<string>(), images: string[] = [];
  const copy = (root: string, relative: string) => {
    const from = normalizeProjectPath(root, relative); assertEvidencePathInsideProject(root, from);
    if (!fs.existsSync(from.absolute) || !fs.statSync(from.absolute).isFile()) return;
    const dest = normalizeProjectPath(cwd, relative); fs.mkdirSync(path.dirname(dest.absolute), { recursive: true });
    if (paths.has(relative) && sha256(fs.readFileSync(dest.absolute)) !== sha256(fs.readFileSync(from.absolute))) {
      throw new Error(`review input collision: evidence ${relative} differs from the current product source; register observations under a distinct path`);
    }
    fs.copyFileSync(from.absolute, dest.absolute); paths.add(relative);
  };
  for (const relative of changed) copy(workRoot, relative);
  const evidence: EvidenceMaterial[] = [];
  for (const artifact of state.artifacts) {
    // An existing run-wide source artifact can supply unchanged surroundings
    // for many requirements. Its registration must name the current bytes,
    // especially when the record root and implementation worktree differ.
    if (currentSource.has(artifact.path)) {
      if (currentSource.get(artifact.path) !== artifact.sha256) throw new Error(`registered source context ${artifact.path} differs from current product source; refresh the shared artifact`);
      copy(workRoot, artifact.path);
    }
    copy(state.projectRoot, artifact.path);
    const buffer = fs.readFileSync(path.join(state.projectRoot, artifact.path));
    const image = artifact.kind === "image" || artifact.kind === "screenshot";
    if (image) images.push(path.join(cwd, artifact.path));
    else if (buffer.includes(0)) throw new Error(`unsupported binary evidence: ${artifact.path}; provide a judge-readable actual capture`);
    else evidence.push({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes,
      text: buffer.toString("utf8"), provenance: `${artifact.provenance}; observed ${artifact.observedAt}; ${artifact.description}` });
  }
  const checks: Array<CheckResult & { logPath: string }> = attempt.mechanical.map((run) => ({ command: run.command, exitCode: run.exitCode, logPath: run.logPath,
    tail: fs.readFileSync(path.join(state.projectRoot, run.logPath), "utf8"), provenance: `CLI execution ${run.startedAt}; cwd=${run.cwd}; log=${run.logPath}` }));
  const refs = [...new Set(["PRD", "Decisions", "Risks", "instruction", ...state.requirements.map((entry) => entry.id), ...inputs.contract.decisions.map((entry) => entry.id), ...sourceCatalog, ...paths])];
  const priorRisk: RiskLaneResult | null = state.riskFindings.length === 0 ? null : { verdict: openRiskFindings(state).some((entry) => entry.severity === "blocking") ? "FAIL" : "PASS", findings: openRiskFindings(state).map(({ id, severity, text }) => ({ id, severity, text })) };
  const material: ReviewPromptMaterial = { prdText: inputs.held.text, contract: inputs.contract, intentSource: inputs.context,
    changeMaterial: changeMaterial(workRoot, state, inputs.source), runOwnedDiff: runOwnedDiff(workRoot, state, changed), checks, evidence,
    artifacts: state.artifacts, sourceCatalog, readablePaths: [...paths], evidenceRefs: refs, priorFindings: state.findings, priorRiskResult: priorRisk,
    roundContext: attempt.roundContext, facts: { suiteExclusions: state.suite.exclusions, amendments: state.amendments },
    claims: state.escalations.filter((entry) => entry.diagnosis !== null).map((entry) => ({ origin: "solver", subject: `escalation ${entry.id}`, text: entry.diagnosis! })) };
  return { material, cwd, evidencePaths: [...paths], images, refs };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  let { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state); assertRunOwnership(statePath, state, args);
  const config = loadConfig(state.projectRoot), issuer = resolveIssuer(flag(args, "issuer"));
  if (args.flags.has("grant-budget")) {
    const evidence = requiredFlag(args, "grant-budget");
    if (terminalBudgetMessage(verificationBudget(state, config.judge.retryBudget)) === null) throw new Error("--grant-budget requires an exhausted verification budget");
    state.budgetGrants = [...(state.budgetGrants ?? []), { at: nowIso(), evidence, attemptCountBefore: state.verificationAttempts.length }];
  }
  const beforeBudget = verificationBudget(state, config.judge.retryBudget), terminal = terminalBudgetMessage(beforeBudget);
  if (terminal) return result("verify", false, terminal, { verificationBudget: beforeBudget, judgeCalls: 0 });
  let inputs: ReturnType<typeof currentInputs> | undefined, preflightError: unknown;
  try { inputs = currentInputs(state); } catch (error) { preflightError = error; }
  const source = inputs?.source ?? state.initialSource;
  const manifest = verificationInputManifest(state.initialSource, source, state.artifacts);
  const attempt: UnifiedVerificationAttempt = { id: crypto.randomUUID(), inputFingerprint: inputs?.fingerprint ?? sha256(JSON.stringify({ prd: state.prd.sha256, source: source.digest, invalid: true })),
    sourceFingerprint: source.digest, inputManifest: manifest, roundContext: verificationRoundContext(manifest, state.verificationAttempts.at(-1) ?? null),
    intentInput: inputs?.intentInput ?? { routing: "full-qa-log", contentSha256: sha256("") }, startedAt: nowIso(), finishedAt: nowIso(), durationMs: 0,
    phase: "preflight", verdict: "NOT_RUN", prelint: { ok: false, findings: [] }, mechanical: [], review: null, risk: null, error: null };
  const started = Date.now();
  state = beginVerification(statePath, state, attempt);
  const update = (apply: (fresh: ImplementState, current: UnifiedVerificationAttempt) => void) => {
    state = progressVerification(statePath, state, (fresh) => apply(fresh, fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!));
  };
  const executionHooks = () => {
    let pending = false;
    let childPid: number | null = null;
    return {
      prepare: () => { prepareVerificationExecution(statePath, state); pending = true; },
      spawned: (pid: number) => { recordVerificationExecution(statePath, state, pid); childPid = pid; pending = false; },
      settled: () => {
        if (pending) { cancelVerificationExecution(statePath, state); pending = false; }
        if (childPid !== null) { completeVerificationExecution(statePath, state, childPid); childPid = null; }
      },
    };
  };
  let phase: UnifiedVerificationAttempt["phase"] = "preflight";
  try {
    if (preflightError) throw preflightError;
    if (!inputs) throw new Error("current verification inputs are unavailable");
    requirePinnedPrd(state.projectRoot, state);
    const lint = prelintPrd(inputs.held.text); update((_fresh, held) => { held.prelint = { ok: lint.ok, findings: lint.findings }; });
    if (!lint.ok) throw new Error(`PRD prelint failed: ${JSON.stringify(lint.findings)}`);
    if (changedPathsSince(state.initialSource, source).length === 0) throw new VerifyInvariantError("empty-run-owned-change-set", "run-owned change set is empty; start before implementation or attribute existing implementation as run-owned");
    const problems = artifactIntegrityProblems(state.projectRoot, state);
    if (problems.length > 0) throw new Error(`evidence integrity failed: ${problems.join("; ")}`);
    phase = "mechanical"; update((_fresh, held) => { held.phase = phase; });
    const units = planRunUnits(state);
    progress(units.length === 0 ? "no required project suites are configured or detected" : `running ${units.length} required command(s)`);
    const batch = await runBatch(state, requireWorkRoot(state), units, config.verify.commandTimeoutMs, (completed) => {
      const base: Omit<MechanicalRunRecord, "logPath"> = { command: completed.unit.command, cwd: completed.unit.cwd, startedAt: completed.startedAt, finishedAt: completed.finishedAt,
        durationMs: completed.durationMs, exitCode: completed.exitCode, mutatedTree: completed.mutatedTree, status: completed.outcome === "green" ? "PASS" : "FAIL" };
      const logPath = writeMechanicalLog(state.projectRoot, state, base, completed.stdout, completed.stderr);
      update((fresh, held) => { const run = { ...base, logPath }; held.mechanical.push(run); upsertCommandArtifacts(fresh, run, fresh.projectRoot); attributeToSuite(fresh, completed, attempt.id, logPath); });
      progress(`${base.status}: ${base.command} (${(base.durationMs / 1000).toFixed(1)}s)`);
    }, executionHooks());
    if (batch.treeMoved !== null || batch.results.some((entry) => entry.outcome !== "green")) {
      update((_fresh, held) => { held.verdict = "FAIL"; held.error = { stage: "mechanical", code: batch.treeMoved ? "source-moved" : "suite-failed", message: "required suite failed or changed the source under verification" }; });
    } else {
      phase = "evidence"; update((_fresh, held) => { held.phase = phase; });
      const integrity = artifactIntegrityProblems(state.projectRoot, state);
      if (integrity.length) throw new Error(integrity.join("; "));
      const active = state.verificationAttempts.find((entry) => entry.id === attempt.id)!;
      const prepared = reviewInputs(state, active, inputs);
      const requirementRefs = [...state.requirements.map((entry) => entry.id), ...inputs.contract.decisions.map((entry) => entry.id)];
      active.roundContext.requirementRefs = requirementRefs; active.roundContext.evidenceRefs = prepared.refs;
      const reviewText = reviewPrompt(prepared.material);
      const riskText = state.prd.reviewProfile === "high-risk" ? riskPrompt(prepared.material) : null;
      phase = "review"; update((_fresh, held) => { held.phase = phase; held.roundContext = active.roundContext; });
      const options = { cwd: prepared.cwd, agentic: true, evidencePaths: prepared.evidencePaths, images: prepared.images };
      const validate = (value: unknown): ReviewResult | string => {
        const parsed = validateReviewResult(value, { requirementRefs, evidenceRefs: prepared.refs, priorFindingIds: openFindings(state).map((entry) => entry.id) });
        if (typeof parsed === "string") return parsed;
        for (const finding of parsed.findings) {
          if (finding.kind !== "human-confirmation") continue;
          const held = finding.human!;
          const basis = held.sourceRef === "Decisions" ? inputs!.contract.decisions.map((entry) => `${entry.decision}\n${entry.rationale}`).join("\n")
            : held.sourceRef === "Risks" ? inputs!.contract.risks
            : held.sourceRef === "instruction" ? inputs!.context.content
            : inputs!.contract.decisions.find((entry) => entry.id === held.sourceRef)?.decision;
          if (!basis || !basis.includes(held.quote)) return `human-confirmation source ${held.sourceRef} does not contain its exact approval/confirmation quote`;
        }
        try { reconcileReviewFindings(state.findings, parsed, attempt.id, nowIso()); }
        catch (error) { return error instanceof Error ? error.message : String(error); }
        return parsed;
      };
      // Both reviews read the same fixed input; the distinct high-risk check
      // has no dependency on the routine verdict and runs concurrently.
      const [review, riskResult] = await Promise.all([
        judgeLane(crypto.randomUUID(), () => runJudge(config, "implement:review", "routine", reviewText, validate, { ...options, execution: executionHooks() }), (value) => value.findings.some((entry) => entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing === "prerequisite")) ? "FAIL" : "PASS"),
        riskText === null ? Promise.resolve(null) : judgeLane(crypto.randomUUID(), () => runJudge(config, "implement:risk", "high-risk", riskText,
          (value) => validateRiskVerdict(value, prepared.material.priorRiskResult ?? null, active.roundContext, Math.max(0, ...state.riskFindings.map((entry) => Number(entry.id.slice(2)))) + 1), { ...options, execution: executionHooks() })),
      ]);
      update((fresh, held) => {
        held.review = review; held.risk = riskResult;
        if (review.result) fresh.findings = reconcileReviewFindings(fresh.findings, review.result, attempt.id, nowIso());
        if (riskResult?.result) fresh.riskFindings = reconcileRiskFindings(fresh.riskFindings, riskResult.result, attempt.id, nowIso());
        const errors = [review.error, riskResult?.error].filter((entry) => entry != null);
        held.verdict = errors.length > 0 ? "ERROR" : openFindings(fresh).some((entry) => entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing === "prerequisite")) || openRiskFindings(fresh).some((entry) => entry.severity === "blocking") ? "FAIL" : "PASS";
        held.error = errors.length > 0 ? { stage: "review", code: "judge-error", message: errors.map((entry) => entry!.message).join("; ") } : null;
      });
    }
    // Recheck the actual inputs after every external process settles. State
    // bookkeeping never makes an old source or observation current.
    const after = currentInputs(state);
    if (after.held.drift !== null || after.fingerprint !== attempt.inputFingerprint || artifactIntegrityProblems(state.projectRoot, state).length > 0) throw new Error("verification inputs changed while verification was running");
  } catch (error) {
    update((_fresh, held) => { held.verdict = "ERROR"; held.error = { stage: phase, code: error instanceof VerifyInvariantError ? error.reason : "verification-input-error", message: error instanceof Error ? error.message : String(error) }; });
  }
  state = finishVerification(statePath, state, (fresh) => {
    const held = fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!;
    held.phase = "complete"; held.finishedAt = nowIso(); held.durationMs = Date.now() - started;
    if (held.verdict === "NOT_RUN") { held.verdict = "ERROR"; held.error = { stage: phase, code: "verification-unfinished", message: "verification ended without a result" }; }
    recordVerb(fresh, { verb: "verify", issuer, target: null, reason: held.verdict, at: nowIso(), outcome: "accepted" });
    recordEvent(fresh, { kind: "verify", actor: issuer, subject: null, summary: `verify ${held.verdict} (${held.id})`, at: nowIso() });
  });
  const final = state.verificationAttempts.find((entry) => entry.id === attempt.id)!;
  progress(`verification ${final.verdict}; ${(final.durationMs / 1000).toFixed(1)}s`);
  return result("verify", final.verdict === "PASS", `verification ${final.verdict}; ${state.status} run retained${terminalBudgetMessage(verificationBudget(state, config.judge.retryBudget)) ? `; ${terminalBudgetMessage(verificationBudget(state, config.judge.retryBudget))}` : ""}`, { attempt: attemptSummary(final), findings: openFindings(state), riskFindings: openRiskFindings(state), verificationBudget: verificationBudget(state, config.judge.retryBudget) });
}

const RECEIPT_SCHEMA = "sasu.implement.receipt.v5";
function completionFingerprint(state: ImplementState, sourceDigest: string | null, attempt: UnifiedVerificationAttempt): string {
  return sha256(JSON.stringify({ schema: RECEIPT_SCHEMA, input: attempt.inputFingerprint, sourceDigest, attempt: attempt.id }));
}
function closingStatus(state: ImplementState): "complete" | "complete-pending-human" {
  return openFindings(state).some((entry) => entry.kind === "human-confirmation") ? "complete-pending-human" : "complete";
}
function completionProblems(state: ImplementState): string[] {
  const problems = artifactIntegrityProblems(state.projectRoot, state);
  const latest = state.verificationAttempts.at(-1);
  if (!latest) return [...problems, "no verification attempt"];
  try {
    const inputs = currentInputs(state);
    if (inputs.held.drift) problems.push("PRD changed after the approved snapshot");
    if (latest.sourceFingerprint !== inputs.source.digest) problems.push("verification is STALE: source changed");
    if (latest.inputFingerprint !== inputs.fingerprint) problems.push("verification is STALE: PRD, linked intent, suite, or registered evidence changed");
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  if (effectiveVerdict(state, latest) !== "PASS") problems.push(`verification is ${latest.verdict}${latest.error ? ` at ${latest.error.stage}: ${latest.error.message}` : ""}`);
  const executed = new Set(latest.mechanical.filter((run) => run.status === "PASS").map((run) => `${run.cwd}\0${run.command}`));
  for (const unit of planRunUnits(state)) if (!executed.has(`${unit.cwd}\0${unit.command}`)) problems.push(`required suite was not passed in the current attempt: ${unit.command} (cwd ${unit.cwd})`);
  if (latest.review?.result == null) problems.push("independent contract review did not complete");
  if (state.prd.reviewProfile === "high-risk" && latest.risk?.result == null) problems.push("required high-risk review did not complete");
  for (const entry of openFindings(state)) {
    if (entry.kind === "defect" || (entry.kind === "human-confirmation" && entry.human?.timing !== "post-completion")) problems.push(`${entry.id}: ${entry.problem}`);
  }
  problems.push(...openRiskFindings(state).filter((entry) => entry.severity === "blocking").map((entry) => `${entry.id}: ${entry.text}`));
  problems.push(...openHumanRejections(state).map((entry) => `${entry.id}: human rejected: ${entry.responses.at(-1)!.evidence}`));
  return problems;
}
function receiptData(state: ImplementState, source: ReturnType<typeof captureSourceSnapshot> | null, openItems: string[] = []) {
  const latest = state.verificationAttempts.at(-1)!;
  const completion = state.completion!;
  return { schema: RECEIPT_SCHEMA, status: state.status, topicSlug: state.topicSlug, prdPath: state.prdPath, prdSnapshotPath: state.prd.snapshotPath,
    prdJudge: state.prd.judge, baselineAttribution: state.baselineAttribution, completedAt: completion.completedAt,
    completionFingerprint: completion.fingerprint, sourceFingerprint: source?.digest ?? null, sourceAvailability: source === null ? "unavailable" : "captured", inputFingerprint: latest.inputFingerprint,
    verificationAttemptId: latest.id, unifiedVerdict: latest.verdict, phase: latest.phase, error: latest.error,
    review: attemptSummary(latest).review, risk: attemptSummary(latest).risk,
    mechanical: latest.mechanical, artifacts: state.artifacts, findings: state.findings, humanConfirmations: humanConfirmations(state), riskFindings: state.riskFindings,
    suite: state.suite, ownedFiles: source ? changedPathsSince(state.initialSource, source) : [], requirementCount: state.requirements.length,
    verificationBudget: verificationBudget(state, loadConfig(state.projectRoot).judge.retryBudget), openItems,
    delivery: delivery(state, openItems), deviations: state.deviations, adoptions: state.adoptions ?? [], worktree: state.worktree ?? null,
    executionCallsDuringFinalize: 0,
    ...(state.status === "blocked" ? { terminalReason: blockedReason(state) } : {}) };
}
function implementationReport(state: ImplementState, receipt: ReturnType<typeof receiptData>): string {
  const latest = state.verificationAttempts.at(-1)!;
  return ["# Implementation result", "", `Status: ${state.status}.`, `PRD: ${state.prdPath}.`,
    `Source: ${receipt.sourceFingerprint}.`, `Verification attempt: ${latest.id}.`, "", "## Result", "",
    latest.review?.result?.summary ?? "Independent contract review was not completed.",
    "", "## Actual verification", "", ...(latest.mechanical.length === 0 ? ["No required project suite was configured or detected; no suite execution is claimed."] : latest.mechanical.map((entry) => `- ${entry.status}: ${entry.command} (cwd ${entry.cwd}, exit ${entry.exitCode}, ${entry.durationMs} ms); ${entry.logPath}`)),
    "", ...state.artifacts.filter((entry) => entry.command === undefined).map((entry) => `- [${entry.description}](${entry.path}), collected ${entry.observedAt}; ${entry.provenance}${entry.target ? `; target ${entry.target}` : ""}${entry.environment ? `; environment ${entry.environment}` : ""}`),
    "", "## Review and remaining findings", "", ...state.findings.map((entry) => `- ${entry.id} [${entry.kind}, ${entry.status}] ${entry.requirementRefs.join(", ")}: ${entry.problem} ${entry.nextAction}`),
    ...state.riskFindings.map((entry) => `- ${entry.id} [risk ${entry.severity}, ${entry.status}] ${entry.text}`),
    ...humanConfirmations(state).flatMap((entry) => entry.responses.map((response) => `- ${entry.id}: human ${response.response} at ${response.at}: ${response.evidence}`)),
    ...receipt.openItems.map((entry) => `- ${entry}`), "", `Delivery eligible: ${receipt.delivery.eligible}.`,
    "The CLI verifies execution facts, input identity, evidence integrity, and authority.",
    "Requirement satisfaction is the independent reviewer's semantic judgment against the complete contract and actual evidence.", ""].join("\n");
}
function writeCompletion(statePath: string, state: ImplementState, source: ReturnType<typeof captureSourceSnapshot> | null, openItems: string[]) {
  const receipt = receiptData(state, source, openItems), completion = state.completion!;
  persistClose(statePath, state, [
    { file: path.join(state.projectRoot, completion.receiptPath), text: jsonText(receipt) },
    { file: path.join(state.projectRoot, completion.implementationResultPath), text: implementationReport(state, receipt) },
  ]);
  return receipt;
}
function finalize(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const requested = flag(args, "status") ?? "complete";
  if (requested !== "complete" && requested !== "blocked") throw new Error("finalize --status must be complete or blocked");
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired") throw new Error("retired run cannot be finalized");
  assertRunOwnership(statePath, state, args);
  const latest = state.verificationAttempts.at(-1);
  if (!latest) throw new Error("finalize requires an actual verification attempt; retire a run cancelled before verification");
  const problems = completionProblems(state);
  if (requested === "complete" && problems.length) throw new Error(`finalize refused:\n- ${problems.join("\n- ")}`);
  if (requested === "blocked" && problems.length === 0) throw new Error("a verified complete result cannot be relabeled blocked without a remaining problem");
  if (requested === "blocked" && blockedReason(state) === null) throw new Error("finalize --status blocked refused: verification can still run; fix the recorded problems and re-run verify until the bounded terminal condition or recorded human non-convergence applies");
  if ((state.status === "complete" || state.status === "complete-pending-human") && requested === "blocked") throw new Error("closed implementation cannot be reopened; record human rejection or start a new run");
  let source: ReturnType<typeof captureSourceSnapshot> | null = null;
  try { source = captureSourceSnapshot(requireWorkRoot(state)); }
  catch (error) {
    if (requested !== "blocked") throw error;
    problems.push(`current source unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fingerprint = completionFingerprint(state, source?.digest ?? null, latest);
  if (state.completion && state.completion.fingerprint === fingerprint && state.status !== "active") {
    const receiptPath = path.join(state.projectRoot, state.completion.receiptPath);
    if (!fs.existsSync(receiptPath) || !fs.existsSync(path.join(state.projectRoot, state.completion.implementationResultPath))) throw new Error("closed state is missing a derived receipt or implementation result");
    return result("finalize", true, `already closed ${state.status} on the same inputs`, { completion: state.completion, receipt: JSON.parse(fs.readFileSync(receiptPath, "utf8")), executionCalls: 0 });
  }
  state.status = requested === "blocked" ? "blocked" : closingStatus(state);
  state.completion = { fingerprint, completedAt: nowIso(), receiptPath: `${state.runDir}/receipt.json`, implementationResultPath: `${state.runDir}/implementation-result.md` };
  recordVerb(state, { verb: "finalize", issuer: resolveIssuer(flag(args, "issuer")), target: null, reason: state.status, at: nowIso(), outcome: "accepted" });
  recordEvent(state, { kind: "finalize", actor: resolveIssuer(flag(args, "issuer")), subject: null, summary: `run closed ${state.status}`, at: nowIso() });
  const receipt = writeCompletion(statePath, state, source, problems);
  return result("finalize", true, `implementation closed ${state.status}; delivery ${receipt.delivery.eligible ? "eligible" : "ineligible"}`, { completion: state.completion, receipt, executionCalls: 0 });
}

function confirm(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  if (state.status === "retired" || state.status === "blocked") throw new Error(`confirm cannot modify a ${state.status} run`);
  assertRunOwnership(statePath, state, args);
  const id = requiredFlag(args, "id"), evidence = requiredFlag(args, "evidence");
  const finding = state.findings.find((entry) => entry.id === id && entry.kind === "human-confirmation");
  if (!finding || finding.status === "amended") throw new Error(`${id} is not a current human confirmation item`);
  const inputs = currentInputs(state), latest = state.verificationAttempts.at(-1);
  if (inputs.held.drift || !latest || inputs.fingerprint !== latest.inputFingerprint || artifactIntegrityProblems(state.projectRoot, state).length > 0) throw new Error("confirmation refused: reviewed source, PRD, intent, or evidence is STALE; fix closed implementations in a new run");
  const rejected = args.flags.get("reject") === true, at = nowIso();
  finding.responses.push({ at, response: rejected ? "rejected" : "confirmed", evidence });
  finding.status = rejected ? "open" : "confirmed";
  finding.history.push({ at, attemptId: null, status: finding.status, reason: evidence, evidenceRefs: [] });
  recordVerb(state, { verb: "confirm", issuer: "human", target: id, reason: evidence, at, outcome: "accepted" });
  recordEvent(state, { kind: "confirm", actor: "human", subject: id, summary: `${id} ${rejected ? "rejected" : "confirmed"}`, at });
  let receipt: ReturnType<typeof receiptData> | null = null;
  if (state.completion !== null) {
    state.status = closingStatus(state);
    receipt = writeCompletion(statePath, state, inputs.source, completionProblems(state));
  } else persistState(statePath, state);
  return result("confirm", true, `${id} ${rejected ? "remains open after rejection" : "confirmed"}; run ${state.status}`, { finding, runStatus: state.status, delivery: delivery(state), receipt });
}

function recordRefusal(projectRoot: string, args: ImplementArgs, subject: IssuedCommand, issuer: IssuerLabel, check: "authority" | "transition" | "arguments", message: string): void {
  const at = nowIso();
  for (let retry = 0; retry < 3; retry += 1) {
    let loaded: ReturnType<typeof loadState>;
    try { loaded = loadState(projectRoot, stateOptions(args)); } catch { return; }
    recordVerb(loaded.state, { at, verb: subject, issuer, target: flag(args, "id") ?? flag(args, "target") ?? null, reason: message, outcome: "rejected", rejection: { check, message } });
    try { persistState(loaded.statePath, loaded.state, { refusalOnly: true }); return; }
    catch (error) { if (!(error instanceof StateConflictError) || retry === 2) throw error; }
  }
}

export async function runImplementCommand(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  const subcommand = args.positional[1];
  const subject = subcommand === "risk" && args.flags.get("non-convergent") === true ? "risk-non-convergent" : subcommand;
  const issuer = resolveIssuer(flag(args, "issuer"));
  try {
    if (["check", "park", "resume", "qa-brief", "trail", "design"].includes(subcommand ?? "")) throw new Error(`implement ${subcommand} is retired in contract 0.9.0; last support commit 488d3cc7d6e99742e7f68a1680fcb101710c8e20. Use autonomous implementation, run evidence, verify, and finalize.`);
    if (args.flags.has("row")) throw new Error("--row is retired; requirements are references, not workflow state");
    if (subject !== undefined) assertCommandAuthority(subject, issuer);
    if (subject !== undefined && isIssuedCommand(subject)) {
      const loaded = loadState(projectRoot, stateOptions(args));
      // One structural guard protects every domain mutation, including
      // retirement, ownership transfer, and a solver that might spawn a peer.
      await recoverVerification(loaded.statePath, loaded.state);
    }
    if (subcommand === "intake") return intake(projectRoot);
    if (subcommand === "start") return start(projectRoot, args);
    if (subcommand === "dispatch") return dispatch(projectRoot, args);
    if (subcommand === "status") return status(projectRoot, args);
    if (subcommand === "await") return await awaitEvent(projectRoot, args);
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "amend") return amend(projectRoot, args);
    if (subcommand === "escalate") return await escalate(projectRoot, args);
    if (subcommand === "risk") return risk(projectRoot, args);
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    if (subcommand === "finalize") return finalize(projectRoot, args);
    if (subcommand === "confirm") return confirm(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, dispatch, status, await, artifact, amend, escalate, risk, retire, verify, finalize, or confirm" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const check = error instanceof VerbRejected || error instanceof AmendmentRejected || error instanceof EscalateRejected ? error.check : "transition";
    if (subject !== undefined && isIssuedCommand(subject)) {
      try { recordRefusal(projectRoot, args, subject, issuer, check, message); } catch (recordError) {
        return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: `${message}; refusal could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}` };
      }
    }
    return { ok: false, action: subcommand ?? "unknown", exitCode: error instanceof VerifyInvariantError ? 1 : 2, message, detail: { rejectedCheck: check, ...(error instanceof PrdDriftError ? { prdDrift: error.diagnostic } : {}) } };
  }
}
