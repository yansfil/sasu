import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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
import { closePreparedSpawn, getAgent, herdrCapabilities, isAgentAlive, promptAgent, readPane, spawnImplementor, type SpawnPlacement } from "./herdr";
import { currentObserverIdentity, newRunInstanceId } from "../supervisor/commands";
import { captureEnrollmentGeneration, readIndex, reconcileEnrollmentAuthority, recipientAuthorityKey, type SupervisorIndex } from "../supervisor/index";
import { indexPath, RUN_INSTANCE_ENV_KEY } from "../supervisor/paths";
import { buildDigest, renderDigest } from "../supervisor/digest";
import { parsePatrolMinutes, parseRecoveryOwner } from "../supervisor/policy";
import { sasuEnabledPath } from "../hcoord/store";
import { guardedDeliveryAvailable } from "../hcoord/herdr";
import { DispatchRejected, assertDispatchablePrd, assertNotImplementor, dispatchImplementor, parseEnvPairs, placementFor } from "./dispatch";
import { intentSource } from "./intent";
import { pinnedPrd, PrdDriftError, prdSnapshotPath, requirePinnedPrd, writePrdSnapshot } from "./prd-snapshot";
import { artifactIntegrityProblems, captureBaselineSnapshot, captureSourceSnapshot, changedPathsSince, dirtySourcePaths, loadState, normalizeProjectPath, nowIso, persistState, persistClose, jsonText, repositoryHead, requireWorkRoot, sha256, statePathFor, writeActivePointer, writeJsonAtomic, writeTextAtomic, StateConflictError } from "./store";
import { IMPLEMENT_SCHEMA, type DirtyAttribution, type PrdJudgeRecord, type ImplementCommandResult, type ImplementState, type LaneRecord, type MechanicalRunRecord, type RegisteredArtifact, type ReviewProfile, type SolverHandoff, type DispatchRecord, type UnifiedVerificationAttempt, type VerificationStatus, type IssuedCommand, type EvidenceReplacement, type IssuerLabel, type PendingDispatch, type SupervisionRecord, ESCALATE_LIMIT_PER_RUN } from "./types";

export interface ImplementArgs {
  positional: string[];
  flags: Map<string, string | true>;
  /** Every value of a repeated flag, in order; absent when the caller parsed none. */
  values?: Map<string, string[]>;
}

const ARTIFACT_KINDS = new Set(["screenshot", "image", "browser", "api", "db", "log", "file", "command-log"]);

function hcoordCommand(argv: string[]): Record<string, unknown> {
  const executable = path.resolve(__dirname, "..", "hcoord", "cli.js");
  const run = spawnSync(process.execPath, [executable, ...argv, "--json"], { encoding: "utf8", timeout: 15_000 });
  if (run.status !== 0) throw new DispatchRejected(`hcoord ${argv[0]} ${argv[1] ?? ""} failed: ${(run.stderr || run.stdout).trim().slice(0, 300)}; no legacy wake fallback was selected`);
  try { return JSON.parse(run.stdout) as Record<string, unknown>; }
  catch { throw new DispatchRejected("hcoord returned invalid JSON; no legacy wake fallback was selected"); }
}

function assertHcoordReady(observer: NonNullable<ReturnType<typeof currentObserverIdentity>["identity"]>): void {
  const status = hcoordCommand(["daemon", "status"]);
  if (status["ok"] !== true || (status["value"] as Record<string, unknown> | undefined)?.["stale"] === true) throw new DispatchRejected("hcoord is enabled but its daemon is stopped; start it before dispatch; no legacy wake fallback was selected");
  const capability = guardedDeliveryAvailable({ machine: "local", hostScope: observer.hostScope, session: observer.sessionId, instance: observer.terminalId, pane: observer.paneId });
  if (!capability.ready) throw new DispatchRejected(`hcoord cannot safely wake the exact Observer: ${capability.reason}; no legacy wake fallback was selected`);
}

function registerHcoordRun(run: string, project: string, observer: NonNullable<ReturnType<typeof currentObserverIdentity>["identity"]>, observerName: string, implementor: { paneId: string; name: string; sessionId: string; terminalId: string; hostScope: string }): void {
  const registered = hcoordCommand(["sasu", "register", "--run", run, "--project", project,
    "--observer-name", observerName, "--observer-pane", observer.paneId, "--observer-session", observer.sessionId, "--observer-instance", observer.terminalId, "--observer-host-scope", observer.hostScope,
    "--implementor-name", implementor.name, "--implementor-pane", implementor.paneId, "--implementor-session", implementor.sessionId, "--implementor-instance", implementor.terminalId, "--implementor-host-scope", implementor.hostScope]);
  if (registered["ok"] !== true) throw new DispatchRejected(`hcoord refused Sasu registration: ${JSON.stringify(registered["error"] ?? "unknown error")}; no legacy wake fallback was selected`);
}

function herdrEnvironmentForHostScope(hostScope: string): { env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (hostScope === "default") delete env["HERDR_SOCKET_PATH"];
  else env["HERDR_SOCKET_PATH"] = hostScope;
  return { env };
}

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
    // The dispatched pane carries the run instance the dispatch minted, so a
    // marked pane opened for another run (same slug in another repository,
    // another worktree, an earlier dispatch) cannot claim this record (D-04).
    const carried = process.env[RUN_INSTANCE_ENV_KEY]?.trim() ?? "";
    const expected = state.supervision?.runInstanceId ?? null;
    if (currentHerdrRole() === "implementor" && expected !== null && carried === "") {
      throw new Error(`this pane is marked implementor but carries no ${RUN_INSTANCE_ENV_KEY}; it cannot prove it owns run instance ${expected}`);
    }
    if (currentHerdrRole() === "implementor" && carried !== "" && expected !== null && carried !== expected) {
      throw new Error(`this pane was dispatched for run instance ${carried}, but '${state.topicSlug}' is instance ${expected}; it is not this pane's run`);
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
  supervision: SupervisionRecord | null,
): DispatchRecord {
  const at = nowIso();
  if (supervision !== null) state.supervision = supervision;
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
 * The repository identity behind a worktree: the realpath of its common git
 * directory. Two worktrees of one repository share it, two repositories that
 * happen to use one slug do not, and neither can be confused with the other
 * in the supervisor's records (B4).
 */
function canonicalRepository(cwd: string): string {
  const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 15_000 });
  if (common.error !== undefined || common.status !== 0) return fs.realpathSync(cwd);
  const resolved = path.resolve(cwd, common.stdout.trim());
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function readHandoffPacket(): string {
  if (process.stdin.isTTY === true) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function revalidatePendingHandoff(
  projectRoot: string,
  statePath: string,
  expected: PendingDispatch,
  changedMessage: string,
): { state: ImplementState; pending: PendingDispatch } {
  const loaded = loadState(projectRoot, { state: statePath });
  assertRunOpenForMutation(loaded.state);
  if (loaded.state.activeVerification !== undefined) {
    throw new DispatchRejected(`verification still active: ${loaded.state.activeVerification.attemptId}; no handoff input was sent`);
  }
  const pending = loaded.state.pendingDispatch ?? null;
  if (loaded.statePath !== statePath || pending === null || !isDeepStrictEqual(pending, expected)) {
    throw new DispatchRejected(`${changedMessage}; no handoff input was sent`);
  }
  return { state: loaded.state, pending };
}

function restoreSupervisionAfterPartialDispatch(state: ImplementState, pending: PendingDispatch): void {
  const previous = state.supervision ?? null;
  if (previous === null || previous.runInstanceId === pending.runInstanceId) {
    if (previous?.runInstanceId === pending.runInstanceId) state.supervision = null;
    return;
  }
}

function desiredEnrollment(state: ImplementState): { runInstanceId: string; recoveryOwner: "supervisor" | "task-factory"; recipientAuthorityKey: string } | null {
  const pending = state.pendingDispatch ?? null;
  // A run chooses one coordinator before a child pane exists. The legacy
  // scheduler must never enroll a run whose supervision belongs to hcoord.
  if (pending?.coordinationOwner === "hcoord" || state.supervision?.coordinationOwner === "hcoord") return null;
  if (pending !== null) return { runInstanceId: pending.runInstanceId, recoveryOwner: pending.recoveryOwner, recipientAuthorityKey: recipientAuthorityKey(pending.observer) };
  const supervision = state.supervision ?? null;
  return supervision === null ? null : { runInstanceId: supervision.runInstanceId, recoveryOwner: supervision.recoveryOwner, recipientAuthorityKey: recipientAuthorityKey(supervision.observer) };
}

function enrollmentAt(index: SupervisorIndex, statePath: string): SupervisorIndex["entries"][number] | undefined {
  return index.entries.find((entry) => entry.statePath === statePath);
}

function enrollmentMatches(index: SupervisorIndex, statePath: string, desired: ReturnType<typeof desiredEnrollment>): boolean {
  const current = enrollmentAt(index, statePath);
  return desired === null ? current === undefined : current?.runInstanceId === desired.runInstanceId
    && current.recoveryOwner === desired.recoveryOwner
    && current.recipientAuthorityKey === desired.recipientAuthorityKey;
}

function prerequisiteFingerprint(state: ImplementState): string {
  return JSON.stringify({
    status: state.status,
    activeVerification: state.activeVerification?.token ?? null,
    ownerSessionId: state.ownerSessionId ?? null,
    pendingDispatch: state.pendingDispatch ?? null,
    supervision: state.supervision ?? null,
  });
}

export function reconcileCurrentDispatchPrerequisites(projectRoot: string, statePath: string, cause: string, afterAuthoritySnapshot?: () => void): ImplementState {
  // state.json and the scheduler index are deliberately separate authority
  // domains. Re-read after reconciliation so a handover between their writes
  // is applied again instead of losing the newer enrollment, as happened in
  // the round-two absent-child recovery review. Capture the generation first:
  // the later review reproduced a replacement with active verification that
  // otherwise left state on the new run and the index on the stale run.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const expectedEnrollmentId = captureEnrollmentGeneration(indexPath(), statePath);
    const before = loadState(projectRoot, { state: statePath }).state;
    assertRunOpenForMutation(before);
    if (before.activeVerification !== undefined) throw new DispatchRejected(`verification still active: ${before.activeVerification.attemptId}; dispatch prerequisites changed nothing`);
    const observerSession = before.pendingDispatch?.observer.sessionId
      ?? before.supervision?.observer.sessionId
      ?? before.ownerSessionId
      ?? currentSessionId();
    afterAuthoritySnapshot?.();
    writeActivePointer(projectRoot, before, observerSession);
    const desired = desiredEnrollment(before);
    const reconciled = reconcileEnrollmentAuthority(indexPath(), {
      statePath,
      expectedEnrollmentId,
      readAuthority: () => desiredEnrollment(loadState(projectRoot, { state: statePath }).state),
      at: nowIso(),
      cause,
    }).index;
    const after = loadState(projectRoot, { state: statePath }).state;
    if (prerequisiteFingerprint(after) === prerequisiteFingerprint(before) && enrollmentMatches(reconciled, statePath, desired)) return after;
  }
  throw new DispatchRejected("dispatch authority kept changing while navigation and enrollment were reconciled; retry against the current Observer");
}

export function repairPendingDispatchPrerequisites(projectRoot: string, statePath: string, state: ImplementState, pending: PendingDispatch, afterEnrollmentSnapshot?: () => void): { state: ImplementState; pending: PendingDispatch } {
  const expectedEnrollmentId = captureEnrollmentGeneration(indexPath(), statePath);
  // The review reproduced a replacement that landed before generation
  // capture: stale pending authority then claimed the replacement's token.
  // Capture the token first and validate the exact pending intent afterward,
  // so the two snapshots either describe one authority or no write occurs.
  afterEnrollmentSnapshot?.();
  const authoritative = revalidatePendingHandoff(projectRoot, statePath, pending, "dispatch authority changed before navigation or enrollment restoration");
  state = authoritative.state;
  pending = authoritative.pending;
  writeActivePointer(projectRoot, state, pending.observer.sessionId);
  // The child receives no Observer session id. Its bare implement commands
  // resolve through the sessionless bookmark, which must exist before the
  // executable handoff can tell the child to use them.
  writeActivePointer(projectRoot, state, null);
  const reconciled = reconcileEnrollmentAuthority(indexPath(), {
    statePath,
    expectedEnrollmentId,
    readAuthority: () => desiredEnrollment(loadState(projectRoot, { state: statePath }).state),
    at: nowIso(),
    cause: `partial dispatch ${pending.runInstanceId} restored before executable handoff`,
  }).index;
  const validated = revalidatePendingHandoff(projectRoot, statePath, pending, "dispatch authority changed while navigation or enrollment was restored");
  if (!enrollmentMatches(reconciled, statePath, { runInstanceId: pending.runInstanceId, recoveryOwner: pending.recoveryOwner, recipientAuthorityKey: recipientAuthorityKey(pending.observer) })) {
    throw new DispatchRejected("dispatch enrollment changed while navigation was restored; no handoff input was sent");
  }
  return validated;
}

function dispatch(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  try {
    assertNotImplementor();
    const loadedState = loadState(projectRoot, stateOptions(args));
    const statePath = loadedState.statePath;
    let state = loadedState.state;
    assertRunOpenForMutation(state);
    if (args.flags.get("resume-handoff") === true) {
      let pending = state.pendingDispatch ?? null;
      const recoverAbsentChild = args.flags.get("recover-absent-child") === true;
      if (pending === null) {
        const recordedObserver = state.supervision?.observer.sessionId ?? state.ownerSessionId ?? null;
        if (recordedObserver !== null && currentSessionId() !== recordedObserver) throw new DispatchRejected(`only recorded Observer ${recordedObserver} may reconcile this handoff`);
        if (recoverAbsentChild) {
          reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "idempotent absent-child recovery reconciled the current run");
          return result("dispatch", true, "no partial dispatch remains; absent-child recovery and its prerequisites are converged", { recovered: "already-clear" });
        }
        if (state.supervision !== undefined && state.supervision !== null) {
          reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "completed handoff prerequisites reconciled on retry");
          return result("dispatch", true, "no partial dispatch remains; the handoff and its prerequisites are already converged", { recovered: "already-complete" });
        }
        throw new DispatchRejected("there is no partial dispatch whose handoff can be resumed");
      }
      if (currentSessionId() !== pending.observer.sessionId) throw new DispatchRejected(`only recorded Observer ${pending.observer.sessionId} may resume this handoff`);
      if (recoverAbsentChild) {
        if (pending.phase !== "started" || pending.implementor === null) throw new DispatchRejected(`--recover-absent-child requires a started partial dispatch; current phase is ${pending.phase}`);
        const implementor = pending.implementor;
        const recoveryHerdr = herdrEnvironmentForHostScope(implementor.hostScope);
        const looked = getAgent(implementor.paneId, recoveryHerdr);
        if (looked.kind === "unavailable") throw new DispatchRejected(`cannot prove recorded child ${implementor.sessionId} is absent: ${looked.detail}; recovery changed nothing`);
        if (looked.kind === "found") throw new DispatchRejected(`recorded child ${implementor.sessionId} is still present in ${implementor.paneId}; use --resume-handoff with the packet instead`);
        const refreshed = revalidatePendingHandoff(projectRoot, statePath, pending, "the partial dispatch or recovery authority changed while the recorded child was inspected");
        state = refreshed.state;
        pending = refreshed.pending;
        const ready = repairPendingDispatchPrerequisites(projectRoot, statePath, state, pending);
        state = ready.state;
        pending = ready.pending;
        restoreSupervisionAfterPartialDispatch(state, pending);
        state.pendingDispatch = null;
        state.ownerSessionId = pending.observer.sessionId;
        persistState(statePath, state);
        reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "started partial dispatch recovered after the recorded child was positively absent");
        return result("dispatch", true, `recorded child ${implementor.sessionId} is absent; partial dispatch ${pending.runInstanceId} was cleared and Observer navigation restored`, { runInstanceId: pending.runInstanceId, recovered: "started-absent", implementor });
      }
      if (pending.phase === "planned") {
        restoreSupervisionAfterPartialDispatch(state, pending);
        state.pendingDispatch = null;
        state.ownerSessionId = pending.observer.sessionId;
        persistState(statePath, state);
        reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "planned partial dispatch recovered before any agent was started");
        return result("dispatch", true, `planned partial dispatch ${pending.runInstanceId} was cleared before any agent started; run dispatch again to create a fresh pane`, { runInstanceId: pending.runInstanceId, recovered: "planned", possibleEmptyPane: true });
      }
      let resumeHerdr = herdrEnvironmentForHostScope(pending.implementor?.hostScope ?? pending.prepared?.hostScope ?? pending.observer.hostScope);
      if (pending.phase === "prepared") {
        const prepared = pending.prepared!;
        const observed = getAgent(prepared.paneId, resumeHerdr);
        if (observed.kind === "absent") {
          const inspected = revalidatePendingHandoff(projectRoot, statePath, pending, "the prepared dispatch or recovery authority changed while its pane was inspected");
          state = inspected.state;
          pending = inspected.pending;
          const cleaned = closePreparedSpawn({ ...prepared, name: pending.plannedAgent }, resumeHerdr);
          if (!cleaned.ok) return result("dispatch", false, `prepared dispatch could not be cleaned safely: ${cleaned.problem}`, { pendingDispatch: pending });
          const refreshed = revalidatePendingHandoff(projectRoot, statePath, pending, "the prepared dispatch or recovery authority changed while its empty pane was closed");
          state = refreshed.state;
          pending = refreshed.pending;
          restoreSupervisionAfterPartialDispatch(state, pending);
          state.pendingDispatch = null;
          state.ownerSessionId = pending.observer.sessionId;
          persistState(statePath, state);
          reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "empty prepared pane cleaned before retry");
          return result("dispatch", true, `empty prepared pane ${prepared.paneId} was closed and partial dispatch ${pending.runInstanceId} was cleared; run dispatch again`, { runInstanceId: pending.runInstanceId, recovered: "prepared-empty", paneId: prepared.paneId });
        }
        if (observed.kind === "unavailable") throw new DispatchRejected(`cannot inspect prepared pane ${prepared.paneId}: ${observed.detail}; no input was sent`);
        throw new DispatchRejected(`prepared pane ${prepared.paneId} now contains a live agent, but its exact identity was not durably recorded before it started; refusing to adopt it or send input. Inspect and close that pane explicitly, then recover the partial dispatch`);
      }
      if (pending.implementor === null) throw new DispatchRejected("partial dispatch has no implementor identity after recovery; no input was sent");
      // stdin can wait indefinitely for the operator. Acquire the packet
      // before the final identity lookup, then reload the CLI-owned record so
      // a handover or replacement during that wait cannot inherit this input.
      const packet = readHandoffPacket().trim();
      if (packet === "") throw new DispatchRejected("resume-handoff requires the handoff packet on stdin");
      const refreshed = revalidatePendingHandoff(projectRoot, statePath, pending, "the partial dispatch changed while the handoff packet was read");
      state = refreshed.state;
      pending = refreshed.pending;
      const implementor = pending.implementor!;
      resumeHerdr = herdrEnvironmentForHostScope(implementor.hostScope);
      const looked = getAgent(implementor.paneId, resumeHerdr);
      if (looked.kind !== "found" || looked.agent.paneId !== implementor.paneId || looked.agent.name !== implementor.agent
        || looked.agent.sessionId !== implementor.sessionId || looked.agent.terminalId !== implementor.terminalId) {
        const mismatch = looked.kind === "found"
          ? `found ${looked.agent.name ?? "unnamed"} in ${looked.agent.paneId}, session ${looked.agent.sessionId ?? "missing"}, terminal ${looked.agent.terminalId ?? "missing"}`
          : looked.detail;
        throw new DispatchRejected(`the partial dispatch target no longer has recorded implementor ${implementor.sessionId}: ${mismatch}; no input was sent`);
      }
      // The exact agent lookup can also block. Re-read every authority fact
      // once more after it returns so retirement, verification, handover or
      // redispatch cannot race ahead of the external prompt.
      const ready = revalidatePendingHandoff(projectRoot, statePath, pending, "run, recovery authority or implementor identity changed during the final target lookup");
      state = ready.state;
      pending = ready.pending;
      const repaired = repairPendingDispatchPrerequisites(projectRoot, statePath, state, pending);
      state = repaired.state;
      pending = repaired.pending;
      const finalLooked = getAgent(implementor.paneId, resumeHerdr);
      if (finalLooked.kind !== "found" || finalLooked.agent.paneId !== implementor.paneId || finalLooked.agent.name !== implementor.agent
        || finalLooked.agent.sessionId !== implementor.sessionId || finalLooked.agent.terminalId !== implementor.terminalId) {
        throw new DispatchRejected(`the partial dispatch target changed while navigation and enrollment were restored; no input was sent`);
      }
      const executable = revalidatePendingHandoff(projectRoot, statePath, pending, "run, recovery authority or implementor identity changed while handoff prerequisites were restored");
      state = executable.state;
      pending = executable.pending;
      const sent = promptAgent({ target: implementor.paneId, text: packet, expectedInputGuard: finalLooked.agent.inputGuard }, resumeHerdr);
      if (sent.outcome !== "accepted") return result("dispatch", false, `handoff was not confirmed (${sent.outcome}, ${sent.code}): ${sent.detail}; pending dispatch remains for an explicit retry`, { pendingDispatch: pending, prompt: sent });
      state.pendingDispatch = null;
      persistState(statePath, state);
      reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "completed handoff prerequisites reconciled after accepted input");
      return result("dispatch", true, `handoff resumed to ${pending.plannedAgent} in ${implementor.paneId}; dispatch ${pending.runInstanceId} is complete`, { runInstanceId: pending.runInstanceId, implementor, prompt: sent });
    }
    assertRunOwnership(statePath, state, args);
    if (state.pendingDispatch !== undefined && state.pendingDispatch !== null) {
      throw new DispatchRejected(`run has a ${state.pendingDispatch.phase} partial dispatch for ${state.pendingDispatch.plannedAgent}; re-run with --resume-handoff${state.pendingDispatch.phase === "started" || state.pendingDispatch.phase === "prepared" ? " and the packet on stdin" : " to clear the pre-start intent"}`);
    }
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
    // Supervision inputs are settled before any pane exists (B2): the
    // Observer's identity from herdr, the patrol interval and the recovery
    // owner. A pane whose Observer cannot be identified would never receive
    // a verified wake, so that refusal comes first.
    const patrolIntervalMs = parsePatrolMinutes(flag(args, "patrol"));
    const recoveryOwner = parseRecoveryOwner(flag(args, "recovery-owner"));
    const extraEnv = parseEnvPairs(args.values?.get("env") ?? []);
    if (RUN_INSTANCE_ENV_KEY in extraEnv) throw new DispatchRejected(`${RUN_INSTANCE_ENV_KEY} is minted by the dispatch; it cannot be passed as --env`);
    const observer = currentObserverIdentity();
    if (observer.identity === null) throw new DispatchRejected(`the Observer cannot be recorded: ${observer.problem}`);
    const coordinationOwner = state.supervision?.coordinationOwner ?? (state.supervision ? "legacy" : fs.existsSync(sasuEnabledPath()) ? "hcoord" : "legacy");
    if (coordinationOwner === "hcoord") assertHcoordReady(observer.identity);
    const observedAgent = getAgent(observer.identity.paneId);
    const observerName = observedAgent.kind === "found" ? observedAgent.agent.name ?? "observer" : "observer";
    const runInstanceId = newRunInstanceId();
    const name = requiredFlag(args, "name");
    const dispatchedAt = nowIso();
    let pending: PendingDispatch = {
      runInstanceId, observer: observer.identity, plannedAgent: name, phase: "planned", prepared: null, implementor: null,
      canonicalRepository: canonicalRepository(placed.placement.cwd), prdPath: state.prdPath,
      dispatchHead: repositoryHead(placed.placement.cwd), dispatchedAt, patrolIntervalMs, recoveryOwner, coordinationOwner, handovers: [],
    };
    // The durable intent and enrollment exist before a pane is created. A
    // tick during this short window reports the partial dispatch rather than
    // silently missing a child that may already be starting.
    state.pendingDispatch = pending;
    persistState(statePath, state);
    try { reconcileCurrentDispatchPrerequisites(projectRoot, statePath, `planned dispatch ${runInstanceId} enrolled before child start`); }
    catch (error) {
      state.pendingDispatch = null;
      persistState(statePath, state);
      // An immutable revision is committed before old-revision pruning. The
      // round-two review injected an EIO after that commit and found the new
      // enrollment orphaning the previous supervised run even though no child
      // started. Reconcile from durable state on every error outcome so an
      // uncertain external write converges instead of repeating its effect.
      let reconciliationProblem: string | null = null;
      try { reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "failed pre-start enrollment reconciled to current dispatch authority"); }
      catch (reconcileError) { reconciliationProblem = reconcileError instanceof Error ? reconcileError.message : String(reconcileError); }
      const failure = error instanceof Error ? error.message : String(error);
      throw new DispatchRejected(`supervision enrollment failed before child start: ${failure}${reconciliationProblem === null ? "" : `; current authority reconciliation also failed: ${reconciliationProblem}; retry dispatch to reconcile it`}`);
    }
    let recordId: number | null = null;
    let dispatched;
    try {
      dispatched = dispatchImplementor(projectRoot, {
      name,
      prdPath: prd.relative,
      handoff: readHandoffPacket(),
      placement: placed.placement,
      kind: flag(args, "kind")?.trim() || undefined,
      model: flag(args, "model")?.trim() || undefined,
      effort: flag(args, "effort")?.trim() || undefined,
      env: { ...extraEnv, [RUN_INSTANCE_ENV_KEY]: runInstanceId },
      afterCreate: (created) => {
        pending.phase = "prepared";
        pending.prepared = {
          paneId: created.paneId, workspaceId: created.workspaceId, tabId: created.tabId, cwd: created.cwd,
          kind: created.kind, placement: created.placement, hostScope: created.hostScope,
          parentPaneId: created.parentPaneId, preparedAt: created.preparedAt,
        };
        state.pendingDispatch = pending;
        persistState(statePath, state);
      },
      beforeHandoff: (started) => {
        const implementor = { paneId: started.paneId, agent: started.name, sessionId: started.sessionId, terminalId: started.terminalId, hostScope: started.hostScope, recordedAt: started.recordedAt };
        if (coordinationOwner === "hcoord") registerHcoordRun(runInstanceId, placed.placement!.cwd, observer.identity!, observerName, { ...started, name: started.name });
        pending.phase = "started";
        pending.implementor = implementor;
        state.pendingDispatch = pending;
        const supervision: SupervisionRecord = {
          runInstanceId, observer: observer.identity!, implementor,
          canonicalRepository: pending.canonicalRepository, prdPath: pending.prdPath, dispatchHead: pending.dispatchHead,
          dispatchedAt, patrolIntervalMs, recoveryOwner, coordinationOwner, handovers: pending.handovers ?? [],
        };
        recordId = recordDispatch(projectRoot, statePath, state, { ...started, agent: started.name, cwd: placed.placement!.cwd }, "observer",
          `implementor ${started.name} (${started.kind}) started in ${started.paneId}; exact identity recorded before handoff`, supervision).id;
        reconcileCurrentDispatchPrerequisites(projectRoot, statePath, `started dispatch ${runInstanceId} reconciled before executable handoff`);
      },
      beforeSubmit: () => {
        const ready = revalidatePendingHandoff(projectRoot, statePath, pending, "run or dispatch authority changed during the final target lookup");
        state = ready.state;
        pending = ready.pending;
      },
      });
    } catch (error) {
      return result("dispatch", false, `dispatch is incomplete: ${error instanceof Error ? error.message : String(error)}. The durable ${state.pendingDispatch?.phase ?? "planned"} record remains; no unrecorded handoff was submitted.`, { runInstanceId, pendingDispatch: state.pendingDispatch ?? pending });
    }
    if (recordId === null) throw new Error("dispatch returned without its pre-handoff record");
    state.pendingDispatch = null;
    persistState(statePath, state);
    const where = placed.placement.kind === "workspace"
      ? `a new workspace on ${dispatched.cwd}`
      : `a new tab of workspace ${dispatched.workspaceId} at ${dispatched.cwd}`;
    const supervised = `supervised as instance ${runInstanceId} (patrol every ${Math.round(patrolIntervalMs / 60_000)} min, recovery owner ${recoveryOwner})`;
    return result(
      "dispatch",
      true,
      `implementor ${dispatched.agent} (${dispatched.kind}) started in ${dispatched.paneId}, ${where}, from ${dispatched.prd}; ${supervised}`,
      { ...dispatched, dispatchId: recordId, slug: state.topicSlug, runInstanceId, observer: observer.identity, patrolIntervalMs, recoveryOwner, enrolled: true, enrollProblem: null },
      [
        ...(dispatched.parentLineage === "reported" ? [] : [`Lineage was not recorded: ${dispatched.parentLineage.unreported}`]),
        `The supervisor tick wakes this session when the implementor settles, blocks, escalates, registers a plan, stalls, disappears or finishes, and on patrol; nothing else needs arming.`,
        `On a wake, read \`sasu implement status --slug ${state.topicSlug} --digest\` and \`herdr agent read ${dispatched.agent} --source recent-unwrapped --lines 120\` for diagnosis only.`,
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
  const replacementInstanceId = newRunInstanceId();
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
    summary: `escalation ${record.id} diagnosed${agent === null ? "; the context reset is the supervisor's to perform" : "; replacement dispatch planned"}`,
    at,
  });
  persistState(statePath, state);

  let reset: ReturnType<typeof spawnImplementor> = { ok: false, value: null, problem: "no --agent given; reset the implementor's context yourself and hand it the three artifacts below" };
  let enrollProblem: string | null = null;
  const previous = state.supervision ?? null;
  if (agent !== null && replacement.placement === null) {
    reset = { ok: false, value: null, problem: replacement.problem ?? "no placement" };
  } else if (agent !== null && previous === null) {
    reset = { ok: false, value: null, problem: "the run has no supervision record, so a replacement cannot be addressed or recovered safely" };
  } else if (agent !== null && replacement.placement !== null && previous !== null) {
    const replacementName = `${agent}-r${id}`;
    const dispatchedAt = nowIso();
    let pending: PendingDispatch = {
      runInstanceId: replacementInstanceId,
      observer: previous.observer,
      plannedAgent: replacementName,
      phase: "planned",
      prepared: null,
      implementor: null,
      canonicalRepository: canonicalRepository(replacement.placement.cwd),
      prdPath: state.prdPath,
      dispatchHead: repositoryHead(replacement.placement.cwd),
      dispatchedAt,
      patrolIntervalMs: previous.patrolIntervalMs,
      recoveryOwner: previous.recoveryOwner,
    };
    state.pendingDispatch = pending;
    persistState(statePath, state);
    try {
      reconcileCurrentDispatchPrerequisites(projectRoot, statePath, `planned replacement ${replacementInstanceId} enrolled before child start`);
      reset = spawnImplementor({
        name: replacementName,
        placement: replacement.placement,
        prompt: briefing,
        env: { [RUN_INSTANCE_ENV_KEY]: replacementInstanceId },
        afterCreate: (created) => {
          pending.phase = "prepared";
          pending.prepared = {
            paneId: created.paneId, workspaceId: created.workspaceId, tabId: created.tabId, cwd: created.cwd,
            kind: created.kind, placement: created.placement, hostScope: created.hostScope,
            parentPaneId: created.parentPaneId, preparedAt: created.preparedAt,
          };
          state.pendingDispatch = pending;
          persistState(statePath, state);
        },
        beforePrompt: (started) => {
          const implementor = { paneId: started.paneId, agent: started.name, sessionId: started.sessionId, terminalId: started.terminalId, hostScope: started.hostScope, recordedAt: started.recordedAt };
          pending.phase = "started";
          pending.implementor = implementor;
          state.pendingDispatch = pending;
          const refreshed: SupervisionRecord = {
            ...previous,
            runInstanceId: replacementInstanceId,
            implementor,
            canonicalRepository: pending.canonicalRepository,
            prdPath: pending.prdPath,
            dispatchHead: pending.dispatchHead,
            dispatchedAt,
          };
          recordDispatch(projectRoot, statePath, state, { ...started, agent: started.name, cwd: replacement.placement!.cwd }, issuer,
            `replacement implementor ${started.name} started in ${started.paneId} for escalation ${record.id}; exact identity recorded before handoff`, refreshed);
          reconcileCurrentDispatchPrerequisites(projectRoot, statePath, `started replacement ${replacementInstanceId} reconciled before executable handoff`);
        },
        beforeSubmit: () => {
          const ready = revalidatePendingHandoff(projectRoot, statePath, pending, "run or replacement authority changed during the final target lookup");
          state = ready.state;
          pending = ready.pending;
        },
      });
      if (reset.ok) {
        state.pendingDispatch = null;
        persistState(statePath, state);
      } else if (pending.phase === "planned") {
        restoreSupervisionAfterPartialDispatch(state, pending);
        state.pendingDispatch = null;
        persistState(statePath, state);
        reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "replacement dispatch failed before a pane was created");
      }
    } catch (error) {
      enrollProblem = error instanceof Error ? error.message : String(error);
      if (pending.phase === "planned") {
        try { restoreSupervisionAfterPartialDispatch(state, pending); }
        catch (restoreError) { enrollProblem = `${enrollProblem}; prior supervision restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`; }
        state.pendingDispatch = null;
        persistState(statePath, state);
        reconcileCurrentDispatchPrerequisites(projectRoot, statePath, "replacement enrollment failed before a pane was created");
      }
      reset = { ok: false, value: null, problem: enrollProblem };
    }
  }
  return result("escalate", true, `escalation ${record.id} diagnosed: ${diagnosis.summary}. ${reset.ok ? "A replacement implementor was started with the three handoff artifacts." : `Context reset not performed automatically (${reset.problem}).`}${state.pendingDispatch === undefined || state.pendingDispatch === null ? "" : ` A durable ${state.pendingDispatch.phase} replacement record remains for dispatch --resume-handoff.`}${enrollProblem === null ? "" : ` Supervision setup failed (${enrollProblem}).`}`, {
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
    "Review context: give reviewers the approved PRD, current base/head, source, verification report, and evidence. If a previous review exists, also provide its actual reviewed HEAD (not merely a verified HEAD), findings, coverage, dispositions, the diff to this HEAD, and approved contract or material evidence changes.",
    "Re-review: check unresolved findings, fix closure, and affected flows first while retaining complete reviewer scope. Identify reused evidence; inspect missing or invalidated coverage. Without applicable prior review context, perform the full-scope review.",
    "Review output: Fix now, Follow-up improvements, and What was checked. Sasu sets no reviewer turn limit; if a reviewer fails, record REVIEW_UNAVAILABLE with the visible cause.",
    "Fix now items need concrete failure evidence or a traceable failure path, the affected approved behavior, and an observable closure condition. Explain new evidence when reopening a resolved item; nonessential expansion belongs in Follow-up improvements.",
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
    supervision: state.supervision ?? null,
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

/**
 * `status --digest`: the deterministic facts an Observer reads on a wake
 * (B16). Addressed to the run's recorded Observer alone: a wake that lands in
 * another session stops here with an ownership refusal and no state change
 * (B10). Everything else about `status` stays open and unchanged.
 */
function digest(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { state } = loadState(projectRoot, stateOptions(args));
  const supervision = state.supervision ?? null;
  if (supervision === null) throw new Error(`run ${state.topicSlug} has no digest: it was never dispatched under Herdr`);
  const expectedInstance = flag(args, "instance");
  if (expectedInstance !== undefined && expectedInstance !== supervision.runInstanceId) {
    throw new Error(`digest refused: expected run instance ${expectedInstance}, but the record is ${supervision.runInstanceId}`);
  }
  const expectedObserver = flag(args, "observer");
  if (expectedObserver !== undefined && expectedObserver !== supervision.observer.sessionId) {
    throw new Error(`digest refused: expected Observer ${expectedObserver}, but the record names ${supervision.observer.sessionId}`);
  }
  const session = currentSessionId();
  if (session !== supervision.observer.sessionId) {
    throw new Error(`digest refused: run '${state.topicSlug}' is observed by session ${supervision.observer.sessionId}, and this session is ${session ?? "unidentified"}; nothing was changed. \`sasu implement status --json\` remains readable`);
  }
  const built = buildDigest(state, supervision);
  return result("status", true, `${state.topicSlug}: digest since dispatch`, { digest: built }, renderDigest(built));
}

function status(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  if (args.flags.get("digest") === true) return digest(projectRoot, args);
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

/**
 * Register the execution plan the Implementor wrote before its first source
 * change. The only effect is a `plan` event: the supervisor tick wakes the
 * Observer once per plan event, so the plan reaches the Observer within one
 * tick interval without the Implementor ending its turn. This is the one
 * runtime-agnostic path from a working Implementor to the Observer, because
 * herdr's own `agent prompt` is keystrokes into whatever the Observer is
 * typing (2026-09-21). Absence is not a signal: the tick reads nothing into
 * a run that never registers a plan (D-11).
 */
function plan(projectRoot: string, args: ImplementArgs): ImplementCommandResult {
  const { statePath, state } = loadState(projectRoot, stateOptions(args));
  assertRunOpenForMutation(state); assertRunOwnership(statePath, state, args);
  const target = normalizeProjectPath(requireWorkRoot(state), requiredFlag(args, "path"));
  if (!fs.existsSync(target.absolute) || !fs.statSync(target.absolute).isFile()) throw new Error(`plan file not found: ${target.relative}`);
  const bytes = fs.readFileSync(target.absolute);
  if (bytes.toString("utf8").trim() === "") throw new Error(`plan file is empty: ${target.relative}`);
  const digest = sha256(bytes).slice(0, 12);
  const event = recordEvent(state, { kind: "plan", actor: resolveIssuer(flag(args, "issuer")), subject: target.relative, summary: `execution plan ${target.relative} (${digest})`, at: nowIso() });
  persistState(statePath, state);
  return result("plan", true, `plan ${event.id} registered: ${target.relative}; the supervisor tick wakes the Observer once for it`, { event });
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
    if (subcommand === "artifact") return artifact(projectRoot, args);
    if (subcommand === "plan") return plan(projectRoot, args);
    if (subcommand === "amend") return amend(projectRoot, args);
    if (subcommand === "escalate") return await escalate(projectRoot, args);
    if (subcommand === "retire") return retire(projectRoot, args);
    if (subcommand === "verify") return await verify(projectRoot, args);
    return { ok: false, action: subcommand ?? "unknown", exitCode: 2, message: "unknown implement subcommand; use intake, start, dispatch, status, artifact, plan, amend, escalate, retire, or verify" };
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
