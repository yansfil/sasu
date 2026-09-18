import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config";
import { readGateStatus } from "../gates/commands";
import { prelintPrd } from "../gates/prelint";
import { runJudge, judgeCallRecordFrom } from "../judge/runner";
import { JudgeError, judgeFailureCause } from "../judge/types";
import { runDirRel } from "../runs/paths";
import { currentHerdrRole, currentSessionId } from "../runs/session";
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
import { herdrCapabilities, isAgentAlive, readPane, spawnImplementor, type SpawnPlacement } from "./herdr";
import { DispatchRejected, assertDispatchablePrd, assertNotImplementor, dispatchImplementor, parseEnvPairs, placementFor } from "./dispatch";
import { intentSource } from "./intent";
import { pinnedPrd, PrdDriftError, prdSnapshotPath, requirePinnedPrd, writePrdSnapshot } from "./prd-snapshot";
import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, normalizeProjectPath, nowIso, persistState, persistClose, jsonText, requireWorkRoot, sha256, statePathFor, writeActivePointer, writeJsonAtomic, writeTextAtomic, parseImplementState, StateConflictError } from "./store";
import { IMPLEMENT_SCHEMA, type DirtyAttribution, type PrdJudgeRecord, type ImplementCommandResult, type ImplementState, type LaneRecord, type MechanicalRunRecord, type RegisteredArtifact, type ReviewProfile, type SolverHandoff, type DispatchRecord, type UnifiedVerificationAttempt, type VerificationStatus, type IssuedCommand, type EvidenceReplacement, type IssuerLabel, ESCALATE_LIMIT_PER_RUN, STALL_THRESHOLD_MS } from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
  /** Every value of a repeated flag, in order; absent when the caller parsed none. */
  values?: Map<string, string[]>;
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
      artifacts: [],
      verificationAttempts: [],
      deviations: [],
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
      verificationReport: null,
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
  // Under Herdr the unmarked session that started the run is the Observer,
  // and the run's next step is a pane of its own for the implementor.
  const nextSteps = process.env["HERDR_ENV"] === "1" && currentHerdrRole() === "unmarked"
    ? [`Dispatch the implementor with \`sasu implement dispatch --name <unique-agent-name> --prd ${prd.relative} --json <<'SASU_HANDOFF' ... SASU_HANDOFF\`; it opens ${startedWorktree === null ? "a new tab in this workspace" : `a workspace on ${startedWorktree.path}`}.`]
    : undefined;
  return result("start", true, message, publicState(state), nextSteps);
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
  const evidence = flag(args, "adopt")?.trim() ?? "";
  const dispatched = lastDispatch(state);
  if (owner === null) {
    // `dispatch` releases the run so the implementor it started can claim it
    // on its first write. Until that write the run is unowned, and the
    // 2026-08-12 incident says what an unowned run invites: a bystander's
    // bare command claiming it. The marker the dispatch injected is what
    // tells the implementor apart, so only a marked pane claims a dispatched
    // run silently; anyone else needs the same approval a takeover needs.
    if (dispatched !== null && currentHerdrRole() !== "implementor" && evidence === "") {
      throw new Error(
        `run '${state.topicSlug}' was dispatched to implementor ${dispatched.agent} (${dispatched.paneId}) and is its to claim; ` +
          `if the user approved taking it over, re-run with --adopt "<the user's verbatim words>"`,
      );
    }
    state.ownerSessionId = sessionId;
    return;
  }
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
}

function lastDispatch(state: ImplementState): DispatchRecord | null {
  return state.dispatches?.at(-1) ?? null;
}

/**
 * A replacement lands beside the implementor it replaces: a tab in the
 * workspace the dispatch opened, so hide keeps it under the same checkout.
 * A run that was never dispatched is placed as a first dispatch would be.
 */
function replacementPlacement(state: ImplementState, escalationId: number): { placement: SpawnPlacement | null; problem: string | null } {
  const previous = lastDispatch(state);
  if (previous === null) return placementFor(state);
  return { placement: { kind: "tab", workspaceId: previous.workspaceId, cwd: previous.cwd, label: `${state.topicSlug} r${escalationId}` }, problem: null };
}

/**
 * Hand the run to the implementor a pane was just opened for: record the
 * pane, release ownership so the implementor's first write claims it, and
 * bookmark the run without a session key in the tree the implementor works
 * in, so its bare `sasu implement ...` commands resolve this record without
 * knowing the slug. Bookmarks are navigation, not authority (store.ts).
 */
function recordDispatch(
  projectRoot: string,
  statePath: string,
  state: ImplementState,
  started: { agent: string; kind: string; paneId: string; workspaceId: string; tabId: string; cwd: string },
  actor: IssuerLabel,
  summary: string,
): DispatchRecord {
  const at = nowIso();
  const record: DispatchRecord = {
    id: (lastDispatch(state)?.id ?? 0) + 1,
    at,
    agent: started.agent,
    kind: started.kind,
    paneId: started.paneId,
    workspaceId: started.workspaceId,
    tabId: started.tabId,
    cwd: started.cwd,
    fromSessionId: state.ownerSessionId ?? null,
  };
  state.dispatches = [...(state.dispatches ?? []), record];
  state.ownerSessionId = null;
  recordEvent(state, { kind: "dispatch", actor, subject: started.agent, summary, at });
  persistState(statePath, state);
  writeActivePointer(projectRoot, state, null);
  return record;
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
  state.verificationReport = null;
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
    assertNotImplementor();
    const { statePath, state } = loadState(projectRoot, stateOptions(args));
    assertRunOpenForMutation(state);
    assertRunOwnership(statePath, state, args);
    const prd = assertDispatchablePrd(projectRoot, requiredFlag(args, "prd"));
    if (prd.relative !== state.prdPath) {
      throw new DispatchRejected(`${prd.relative} is not the PRD run '${state.topicSlug}' started from (${state.prdPath}); pass --slug for the run that PRD belongs to`);
    }
    // One implementor per run. The last one dispatched has to be positively
    // gone before another pane is opened for the same run; "unknown" is not
    // "gone", because an agent herdr cannot list may still be writing.
    const previous = lastDispatch(state);
    if (previous !== null) {
      const alive = isAgentAlive({ name: previous.agent });
      if (alive.value === true) {
        throw new DispatchRejected(`implementor ${previous.agent} is still running in ${previous.paneId}; this run already has an implementor`);
      }
      if (alive.value !== false) {
        throw new DispatchRejected(`cannot tell whether implementor ${previous.agent} (${previous.paneId}) is still running: ${alive.problem}; inspect it before dispatching a replacement`);
      }
    }
    const placed = placementFor(state);
    if (placed.placement === null) throw new DispatchRejected(placed.problem ?? "no placement");
    const dispatched = dispatchImplementor(projectRoot, {
      name: requiredFlag(args, "name"),
      prdPath: prd.relative,
      handoff: readHandoffPacket(),
      placement: placed.placement,
      kind: flag(args, "kind")?.trim() || undefined,
      model: flag(args, "model")?.trim() || undefined,
      effort: flag(args, "effort")?.trim() || undefined,
      env: parseEnvPairs(args.values?.get("env") ?? []),
    });
    const where = placed.placement.kind === "workspace"
      ? `a new workspace on ${dispatched.cwd}`
      : `a new tab of workspace ${dispatched.workspaceId} at ${dispatched.cwd}`;
    const record = recordDispatch(projectRoot, statePath, state, dispatched, "observer",
      `implementor ${dispatched.agent} (${dispatched.kind}) started in ${dispatched.paneId}, ${where}`);
    return result(
      "dispatch",
      true,
      `implementor ${dispatched.agent} (${dispatched.kind}) started in ${dispatched.paneId}, ${where}, from ${dispatched.prd}`,
      { ...dispatched, dispatchId: record.id, slug: state.topicSlug },
      [
        ...(dispatched.parentLineage === "reported" ? [] : [`Lineage was not recorded: ${dispatched.parentLineage.unreported}`]),
        `Wake on its events with \`sasu implement await --slug ${state.topicSlug} --agent ${dispatched.agent}\`.`,
        `Read its pane with \`herdr agent read ${dispatched.agent} --source recent-unwrapped --lines 120\` for diagnosis only.`,
      ],
    );
  } catch (error) {
    // A refused dispatch created nothing, so it is a message and an exit code,
    // not a recorded run event.
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
  const agent = flag(args, "agent")?.trim() || null;

  // Read-only preparation. `readPane` is diagnosis input and nothing else: a
  // missing pane degrades the envelope, it does not stop the escalation (R9).
  const prd = requirePinnedPrd(projectRoot, state);
  const ledger = JSON.stringify({ attempts: state.verificationAttempts.map(attemptSummary), currentReport: state.verificationReport }, null, 2);
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
      verification: ledger,
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
    verificationPath: `${solverDir}/verification-${id}.json`,
  };
  fs.mkdirSync(path.join(projectRoot, solverDir), { recursive: true });
  writeTextAtomic(path.join(projectRoot, handoff.diagnosisPath), renderDiagnosis({ id, at, target, reason }, diagnosis));
  writeTextAtomic(path.join(projectRoot, handoff.verificationPath), `${ledger}\n`);

  const briefing = buildHandoffBriefing(handoff);
  const replacement = replacementPlacement(state, id);
  const reset = agent === null
    ? { ok: false, value: null, problem: "no --agent given; reset the implementor's context yourself and hand it the three artifacts below" }
    : replacement.placement === null
      ? { ok: false, value: null, problem: replacement.problem ?? "no placement" }
      : spawnImplementor({ name: `${agent}-r${id}`, placement: replacement.placement, prompt: briefing });

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
  if (reset.ok && reset.value !== null) {
    recordDispatch(projectRoot, statePath, state, { ...reset.value, agent: reset.value.name, cwd: replacement.placement!.cwd }, issuer,
      `replacement implementor ${reset.value.name} started in ${reset.value.paneId} for escalation ${record.id}`);
  }
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
    || relative === `${state.runDir}/verification-report.json`
    || relative === `${state.runDir}/verification-report.md`
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

function writeMechanicalLog(
  projectRoot: string,
  state: ImplementState,
  run: Omit<MechanicalRunRecord, "logPath">,
  stdout: string,
  stderr: string,
  tmpdir: string,
): string {
  const key = sha256(`${run.startedAt}\0${run.cwd}\0${run.command}`).slice(0, 16);
  const relative = `${state.runDir}/artifacts/logs/mechanical-${key}.log`;
  const absolute = path.join(projectRoot, relative);
  writeTextAtomic(absolute, [
    `command: ${run.command}`,
    `cwd: ${run.cwd}`,
    `tmpdir: ${tmpdir}`,
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

function upsertCommandArtifacts(state: ImplementState, run: MechanicalRunRecord, projectRoot: string, sourceDigest: string): void {
  const inspected = inspectArtifactFile(path.join(projectRoot, run.logPath), "log");
  const artifact: RegisteredArtifact = {
    kind: "command-log",
    path: run.logPath,
    description: `mechanical ${run.status}: ${run.command}`,
    ...inspected,
    registeredAt: run.finishedAt,
    observedAt: run.finishedAt,
    sourceDigest,
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

/**
 * Compare committed baseline bytes with the already frozen source, never with
 * the live tree a second time. The no-index diff also covers an unborn repo
 * and untracked additions without changing the project's index.
 */
/**
 * One diff per changed file, generated per file rather than by splitting one
 * whole-tree diff. The header of that combined output is genuinely ambiguous
 * here - `--no-prefix` emits `diff --git b/x b/x` for a new file, `a/x a/x`
 * for a deletion, and an unquoted `a/spaced name.txt b/spaced name.txt` for a
 * path with a space - so a regex splitter would be keyed on how one
 * repository's output happens to look (PRINCIPLES item 11). The baseline and
 * current trees are already staged per file, so asking git once per file
 * needs no parser at all.
 */
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


/** One digest covers every reproducible input to deterministic verification. */
function inputIdentity(state: ImplementState, sourceDigest: string, intentInput: UnifiedVerificationAttempt["intentInput"]): string {
  const artifacts = state.artifacts.filter((entry) => entry.command === undefined)
    .map(({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }) => ({ path, sha256, description, provenance, observedAt, target, environment, requirementRefs }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sourcePath = state.prd.sourceIntake && state.prd.sourceIntake != "current conversation" ? normalizeProjectPath(state.projectRoot, state.prd.sourceIntake).absolute : null;
  const sourceIntake = sourcePath === null ? null : sha256(fs.readFileSync(sourcePath));
  return sha256(JSON.stringify({ schema: state.schema, prd: state.prd.sha256, sourceDigest, artifacts, intentInput, sourceIntake, suite: { commands: state.suite.commands, exclusions: state.suite.exclusions }, amendments: state.amendments }));
}

function attemptSummary(attempt: UnifiedVerificationAttempt): Record<string, unknown> {
  return {
    id: attempt.id,
    prdSha256: attempt.prdSha256,
    verdict: attempt.verdict,
    phase: attempt.phase,
    inputFingerprint: attempt.inputFingerprint,
    sourceFingerprint: attempt.sourceFingerprint,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    durationMs: attempt.durationMs,
    prelint: attempt.prelint,
    mechanical: attempt.mechanical,
    error: attempt.error,
  };
}

function effectiveVerdict(attempt: UnifiedVerificationAttempt): VerificationStatus {
  if (attempt.error !== null) return attempt.verdict === "FAIL" ? "FAIL" : "ERROR";
  if (attempt.mechanical.some((entry) => entry.status !== "PASS")) return "FAIL";
  return attempt.verdict;
}

function nativeReviewNames(state: ImplementState): string {
  return state.prd.reviewProfile === "high-risk" ? "Fidelity, Code, and Security" : "Fidelity and Code";
}

function verificationNextActions(state: ImplementState, verdict: VerificationStatus): string[] {
  if (verdict !== "PASS") {
    return [
      "Next action: fix the deterministic failures in the report, then rerun sasu implement verify.",
      "Do not review or ship this head until deterministic verification passes.",
    ];
  }
  return [
    `Next action: spawn native ${nativeReviewNames(state)} review subagents in parallel from this runtime for this exact verified head.`,
    // The tool is named per runtime because "native subagent" alone was read by Codex Implementors as the Herdr skill's `herdr agent start reviewer` example (2026-09-17), so reviews ran in split panes instead of subagents.
    "Subagent tool: Claude Code uses the Agent tool; Codex uses spawn_agent. Do not split a Herdr pane or start a Herdr agent for review.",
    "Review output: Fix now, Follow-up improvements, and What was checked. Sasu sets no reviewer turn limit; if a reviewer fails, record REVIEW_UNAVAILABLE with the visible cause.",
    "Then fix valid current-scope findings. If source or material evidence changes, commit it and rerun verify and review; otherwise continue to ship.",
  ];
}

function delivery(state: ImplementState, freshness: string[] = []) {
  const reasons = [...freshness];
  if (state.status === "retired") reasons.push("run is retired");
  if (state.verificationReport === null) reasons.push("current deterministic verification report is missing");
  else if (state.verificationReport.status !== "PASS") reasons.push(`deterministic verification is ${state.verificationReport.status}`);
  return { eligible: reasons.length === 0, reasons };
}

function publicState(state: ImplementState, currentSourceDigest?: string, currentInputFingerprint?: string): Record<string, unknown> {
  const latest = state.verificationAttempts.at(-1) ?? null;
  const stale = latest !== null && ((currentSourceDigest !== undefined && latest.sourceFingerprint !== currentSourceDigest) || (currentInputFingerprint !== undefined && latest.inputFingerprint !== currentInputFingerprint));
  return {
    schema: state.schema,
    status: state.status,
    topicSlug: state.topicSlug,
    prdPath: state.prdPath,
    prdSnapshotPath: state.prd.snapshotPath,
    baselineAttribution: state.baselineAttribution,
    workingRoot: state.worktree?.path ?? state.projectRoot,
    worktree: state.worktree ?? null,
    implementor: lastDispatch(state),
    reviewProfile: state.prd.reviewProfile,
    escalations: { used: state.escalations.length, limit: ESCALATE_LIMIT_PER_RUN, remaining: ESCALATE_LIMIT_PER_RUN - state.escalations.length },
    requirementCount: state.requirements.length,
    suite: suiteScore(state),
    verification: { verdict: stale ? "STALE" : latest ? effectiveVerdict(latest) : "NOT_RUN", attempts: state.verificationAttempts.length, latest: latest ? attemptSummary(latest) : null },
    activeVerification: state.activeVerification ?? null,
    artifacts: state.artifacts,
    retirement: state.retirement,
    verificationReport: state.verificationReport,
    delivery: delivery(state, stale ? ["verification is STALE"] : []),
  };
}

function currentInputs(state: ImplementState) {
  const source = captureSourceSnapshot(requireWorkRoot(state));
  const held = pinnedPrd(state.projectRoot, state);
  const contract = parseImplementContract(held.text);
  const context = intentSource(state.projectRoot, contract, specGateIsFresh(state.projectRoot, state));
  const intentInput = { routing: context.routing, contentSha256: sha256(context.content) };
  const fingerprint = inputIdentity(state, source.digest, intentInput);
  return { source, held, contract, context, intentInput, fingerprint };
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { state } = loadState(projectRoot, stateOptions(args));
  const herdr = herdrCapabilities();
  let sourceDigest: string | undefined, fingerprint: string | undefined;
  const problems = artifactIntegrityProblems(state.projectRoot, state);
  try {
    const inputs = currentInputs(state);
    sourceDigest = inputs.source.digest; fingerprint = inputs.fingerprint;
    if (inputs.held.drift !== null) { problems.push("PRD changed after the sealed snapshot"); fingerprint = "PRD_DRIFT"; }
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); fingerprint = "INPUT_ERROR"; }
  if (problems.length > 0) fingerprint = "INPUT_ERROR";
  const detail = publicState(state, sourceDigest, fingerprint);
  const verificationVerdict = (detail.verification as {verdict:string}).verdict;
  const currentDelivery = delivery(state, problems.concat((detail.verification as {verdict:string}).verdict === "STALE" ? ["verification is STALE"] : []));
  return result("status", true, `${state.topicSlug}: ${state.status}`, { ...detail, delivery: currentDelivery, artifactProblems: problems,
    herdr: { available: herdr.available, unavailableHoles: (["spawn", "read", "alive"] as const).filter((hole) => !herdr.holes[hole]), reason: herdr.reason } }, [
      `${state.topicSlug}: ${state.status}; ${(detail.verification as {verdict:string}).verdict}`,
      `Source: ${sourceDigest ?? "unavailable"}; ${state.requirements.length} requirements retained in the contract`,
      `Required suite: ${JSON.stringify(suiteScore(state))}`,
      `Verification report: ${state.verificationReport?.markdownPath ?? "not generated"}`,
      `Agent Review: ${verificationVerdict === "PASS" && currentDelivery.eligible ? `spawn native ${nativeReviewNames(state)} subagents in parallel (Claude Code: Agent tool; Codex: spawn_agent; never a Herdr pane); record Fix now and Follow-up improvements in the PR` : "wait for a current deterministic PASS"}`,
      `escalations: ${state.escalations.length} of ${ESCALATE_LIMIT_PER_RUN} used${state.escalations.length >= ESCALATE_LIMIT_PER_RUN ? "; bound spent" : ""}`,
      ...currentDelivery.reasons.map((reason) => `Delivery: ${reason}`),
      ...(state.activeVerification ? [`Verification in progress: ${state.activeVerification.attemptId}`] : []),
      `Next: ${state.status !== "active" ? "start a new run if more work is required" : verificationVerdict === "PASS" && currentDelivery.eligible ? "run native agent review, fix in-scope findings, rerun deterministic verify after source changes, then deliver" : "resolve the reported deterministic or freshness failure and rerun verify"}`,
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
  // One digest for the whole registration: the reviewer later compares it
  // with the source under review to tell "observed on this source" from
  // "observed on an earlier one" (issue #2, a baseline note read as current).
  const sourceDigest = captureSourceSnapshot(requireWorkRoot(state)).digest;
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
      registeredAt: nowIso(), observedAt, sourceDigest, provenance: typeof input.source === "string" && input.source.trim() ? input.source : `registered by ${resolveIssuer(flag(args, "issuer"))}; collection is self-reported`,
      ...(typeof input.target === "string" ? { target: input.target } : {}), ...(typeof input.environment === "string" ? { environment: input.environment } : {}), ...(refs ? { requirementRefs: refs as string[] } : {}) };
    if (previous) recordEvidenceReplacement(state, { kind: "artifact", previous: `${previous.path}@${previous.sha256} observed ${previous.observedAt}`, next: `${entry.path}@${entry.sha256}`, priorDisposition: "invalidated" });
    state.artifacts = state.artifacts.filter((held) => held.path !== entry.path); state.artifacts.push(entry); registered.push(entry);
  }
  recordEvent(state, { kind: "artifact", actor: resolveIssuer(flag(args, "issuer")), subject: null, summary: `${registered.length} run evidence file(s) registered`, at: nowIso() });
  persistState(statePath, state);
  return result("artifact", true, `${registered.length} run evidence file(s) registered; unchanged bytes retain their original observation time`, { artifacts: registered });
}

function verificationReportData(state: ImplementState, attempt: UnifiedVerificationAttempt) {
  const jsonPath = `${state.runDir}/verification-report.json`;
  const markdownPath = `${state.runDir}/verification-report.md`;
  const generatedAt = nowIso();
  const status: "PASS" | "FAIL" | "ERROR" = attempt.verdict === "PASS" ? "PASS" : attempt.verdict === "FAIL" ? "FAIL" : "ERROR";
  const current = captureSourceSnapshot(requireWorkRoot(state));
  const sourceChanged = current.digest !== attempt.sourceFingerprint;
  if (status === "PASS" && sourceChanged) {
    throw new Error("source changed before the verification report could be published");
  }
  const reportFields = {
    schema: "sasu.verification-report.v1" as const,
    inputFingerprint: attempt.inputFingerprint,
    prdSha256: attempt.prdSha256,
    baseSha: state.initialSource.head,
    headSha: current.head,
    sourceFingerprint: attempt.sourceFingerprint,
    generatedAt,
    status,
    jsonPath,
    markdownPath,
  };
  const nextActions = verificationNextActions(state, status);
  const evidence = state.artifacts
    .filter((entry) => entry.command === undefined)
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      description: entry.description,
      sha256: entry.sha256,
      observedAt: entry.observedAt,
      sourceFingerprint: entry.sourceDigest,
      provenance: entry.provenance,
      target: entry.target ?? null,
      environment: entry.environment ?? null,
    }));
  const requiredCommands = state.suite.commands.map((command) => ({
    id: command.id,
    command: command.command,
    cwd: command.cwd,
    excluded: state.suite.exclusions.some((entry) => entry.commandId === command.id),
    result: state.suite.results.find((entry) => entry.commandId === command.id && entry.attemptId === attempt.id) ?? null,
  }));
  const data = {
    ...reportFields,
    ownedFiles: changedPathsSince(state.initialSource, current),
    observedSourceFingerprint: current.digest,
    sourceChangedAfterVerification: sourceChanged,
    requiredCommands,
    evidence,
    error: attempt.error,
    agentReview: {
      status: "NOT_RUN",
      authority: "advisory",
      instruction: nextActions.join(" "),
    },
  };
  const commandLines = requiredCommands.length === 0
    ? ["- No required commands configured."]
    : requiredCommands.map((entry) => `- ${entry.excluded ? "EXCLUDED" : entry.result?.status ?? "NOT_RUN"}: \`${entry.command}\` (cwd \`${entry.cwd}\`)`);
  const evidenceLines = evidence.length === 0
    ? ["- No runtime evidence registered."]
    : evidence.map((entry) => `- ${entry.kind}: \`${entry.path}\` - ${entry.description} (observed ${entry.observedAt})`);
  const markdown = [
    "# Verification report",
    "",
    `Status: **${status}**`,
    `Generated: ${generatedAt}`,
    `Base: ${reportFields.baseSha ?? "unavailable"}`,
    `Head: ${reportFields.headSha ?? "unavailable"}`,
    "",
    "## Required commands",
    "",
    ...commandLines,
    "",
    "## Runtime evidence",
    "",
    ...evidenceLines,
    "",
    "## Agent Review",
    "",
    ...nextActions,
    "",
  ].join("\n");
  const json = jsonText(data);
  const identity = { ...reportFields, reportSha256: sha256(json) };
  return { identity, json, markdown };
}

async function verify(projectRoot: string, args: ImplementArgs): Promise<ImplementCommandResult> {
  let { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state);
  assertRunOwnership(statePath, state, args);
  const config = loadConfig(state.projectRoot);
  const issuer = resolveIssuer(flag(args, "issuer"));
  if (args.flags.has("grant-budget")) throw new Error("--grant-budget is retired; deterministic verification has no reviewer or correction budget");

  let inputs: ReturnType<typeof currentInputs> | undefined;
  let preflightError: unknown;
  try { inputs = currentInputs(state); } catch (error) { preflightError = error; }
  const source = inputs?.source ?? state.initialSource;
  const attempt: UnifiedVerificationAttempt = {
    id: crypto.randomUUID(),
    inputFingerprint: inputs?.fingerprint ?? sha256(JSON.stringify({ prd: state.prd.sha256, source: source.digest, invalid: true })),
    prdSha256: state.prd.sha256,
    sourceFingerprint: source.digest,
    intentInput: inputs?.intentInput ?? { routing: "full-qa-log", contentSha256: sha256("") },
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    phase: "preflight",
    verdict: "NOT_RUN",
    prelint: { ok: false, findings: [] },
    mechanical: [],
    error: null,
  };
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
    const lint = prelintPrd(inputs.held.text);
    update((_fresh, held) => { held.prelint = { ok: lint.ok, findings: lint.findings }; });
    if (!lint.ok) throw new Error(`PRD prelint failed: ${JSON.stringify(lint.findings)}`);
    if (changedPathsSince(state.initialSource, source).length === 0) throw new VerifyInvariantError("empty-run-owned-change-set", "run-owned change set is empty; start before implementation or attribute existing implementation as run-owned");
    const problems = artifactIntegrityProblems(state.projectRoot, state);
    if (problems.length > 0) throw new Error(`evidence integrity failed: ${problems.join("; ")}`);

    phase = "mechanical";
    update((_fresh, held) => { held.phase = phase; });
    const units = planRunUnits(state);
    progress(units.length === 0 ? "no required project suites are configured or detected" : `running ${units.length} required command(s)`);
    const batch = await runBatch(state, requireWorkRoot(state), units, config.verify.commandTimeoutMs, (completed) => {
      const base: Omit<MechanicalRunRecord, "logPath"> = {
        command: completed.unit.command,
        cwd: completed.unit.cwd,
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt,
        durationMs: completed.durationMs,
        exitCode: completed.exitCode,
        mutatedTree: completed.mutatedTree,
        status: completed.outcome === "green" ? "PASS" : "FAIL",
      };
      const logPath = writeMechanicalLog(state.projectRoot, state, base, completed.stdout, completed.stderr, completed.tmpdir);
      update((fresh, held) => {
        const run = { ...base, logPath };
        held.mechanical.push(run);
        upsertCommandArtifacts(fresh, run, fresh.projectRoot, completed.tree.product);
        attributeToSuite(fresh, completed, attempt.id, logPath);
      });
      progress(`${base.status}: ${base.command} (${(base.durationMs / 1000).toFixed(1)}s)`);
    }, executionHooks());
    if (batch.treeMoved !== null || batch.results.some((entry) => entry.outcome !== "green")) {
      update((_fresh, held) => {
        held.verdict = "FAIL";
        held.error = { stage: "mechanical", code: batch.treeMoved ? "source-moved" : "suite-failed", message: "required suite failed or changed the source under verification" };
      });
    } else {
      phase = "evidence";
      update((_fresh, held) => { held.phase = phase; });
      const integrity = artifactIntegrityProblems(state.projectRoot, state);
      if (integrity.length > 0) throw new Error(integrity.join("; "));
      update((_fresh, held) => { held.verdict = "PASS"; held.error = null; });
    }
    const after = currentInputs(state);
    if (after.held.drift !== null || after.fingerprint !== attempt.inputFingerprint || artifactIntegrityProblems(state.projectRoot, state).length > 0) throw new Error("verification inputs changed while verification was running");
  } catch (error) {
    update((_fresh, held) => {
      if (held.verdict !== "FAIL") {
        held.verdict = "ERROR";
        held.error = { stage: phase, code: error instanceof VerifyInvariantError ? error.reason : "verification-input-error", message: error instanceof Error ? error.message : String(error) };
      }
    });
  }
  let report: ReturnType<typeof verificationReportData> | undefined;
  state = finishVerification(statePath, state, (fresh) => {
    const held = fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!;
    held.phase = "complete";
    held.finishedAt = nowIso();
    held.durationMs = Date.now() - started;
    if (held.verdict === "NOT_RUN") {
      held.verdict = "ERROR";
      held.error = { stage: phase, code: "verification-unfinished", message: "verification ended without a result" };
    }
    recordVerb(fresh, { verb: "verify", issuer, target: null, reason: held.verdict, at: nowIso(), outcome: "accepted" });
    recordEvent(fresh, { kind: "verify", actor: issuer, subject: null, summary: `verify ${held.verdict} (${held.id})`, at: nowIso() });
  }, (fresh) => {
    const held = fresh.verificationAttempts.find((entry) => entry.id === attempt.id)!;
    report = verificationReportData(fresh, held);
    fresh.verificationReport = report.identity;
    return [
      { file: path.join(fresh.projectRoot, report.identity.jsonPath), text: report.json },
      { file: path.join(fresh.projectRoot, report.identity.markdownPath), text: report.markdown },
    ];
  });
  if (report === undefined) throw new Error("verification report was not generated");
  const final = state.verificationAttempts.find((entry) => entry.id === attempt.id)!;
  progress(`verification ${final.verdict}; ${(final.durationMs / 1000).toFixed(1)}s`);
  const message = `deterministic verification ${final.verdict}; report ${report.identity.markdownPath}`;
  const nextActions = verificationNextActions(state, final.verdict);
  return result("verify", final.verdict === "PASS", message, { attempt: attemptSummary(final), report: report.identity, agentReview: nextActions.join(" ") }, nextActions);
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
    if (["check", "park", "resume", "qa-brief", "trail", "design", "risk", "finalize", "confirm"].includes(subcommand ?? "")) throw new Error(`implement ${subcommand} is retired in contract 0.11.0; last support commit 9149d9826fad2af3ba7200761e674b5228ef9b7d. Use autonomous implementation, collect evidence, run deterministic verify, then deliver.`);
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
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, dispatch, status, await, artifact, amend, escalate, retire, or verify" };
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
