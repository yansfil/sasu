import path from "node:path";
import type { BackendName, JudgeEffort, JudgeProfile, JudgeTarget, SasuConfig } from "../config";
import { BACKENDS, judgeProfileFor } from "../config";
import { AGENTIC_READ_MAX_OUTPUT_CHARS, assertJudgeInputFits, JUDGE_CORRECTION_MAX_CHARS, resolveBackend, type BackendRunResult, type JudgeBackend, type ExecutionLifecycle } from "./backends";
import { extractJsonObject, JudgeError, newJudgeActivity, type JudgeActivity, type JudgeAdvisory, type JudgeCallRecord, type DiscardedOutput, type JudgeErrorCode, type JudgeFailureReason, type JudgeRetry, type JudgeUsage, type VisualEvidenceRecord } from "./types";

/**
 * Backends that failed authentication or runtime in THIS process.
 *
 * Process-scoped on purpose: a weekly rate limit resets on a wall clock the
 * harness does not own, so persisting the verdict would outlive its truth.
 * Within one verify run (minutes) it is exactly right.
 *
 * Measured on the 2026-08-27 crawler-arena run: the design lane's Codex
 * primary was rejected, the Claude fallback answered "You've hit your weekly
 * limit", and the lane ERRORed after 648s. Nothing stopped the next 23 judge
 * calls in that same run from paying the identical discovery again.
 *
 * Two scopes, because the two failure classes have different blast radii:
 * `judge-auth` is a property of the CLI's login state, so it condemns the
 * backend for every model at one strike. `judge-auth-or-runtime` also covers
 * an ordinary non-zero exit, which one bad prompt or one misconfigured model
 * name can produce, so it is keyed on backend+model and takes two strikes -
 * a routine-profile model failing must never disable the high-risk profile's
 * different model on the same backend.
 *
 * A success clears both scopes for its target: a backend that answers is
 * healthy by observation. The clear rescues a transient blip only while
 * calls are still dialling the primary - typically the straggler successes
 * of the same concurrent wave; once the skip engages, nothing dials the
 * primary again this process, which is accepted (the fallback exists and
 * the run is minutes long).
 */
const UNHEALTHY_STRIKES = 2;
const judgeHealth = new Map<string, number>();

const authKey = (backend: BackendName): string => `auth:${backend}`;
const runtimeKey = (backend: BackendName, model: string | null): string => `runtime:${backend}\0${model ?? ""}`;

function recordBackendFailure(backend: BackendName, model: string | null, code: JudgeErrorCode): void {
  if (code === "judge-auth") {
    judgeHealth.set(authKey(backend), UNHEALTHY_STRIKES);
    return;
  }
  if (code !== "judge-auth-or-runtime") return;
  const key = runtimeKey(backend, model);
  judgeHealth.set(key, (judgeHealth.get(key) ?? 0) + 1);
}

function recordBackendSuccess(backend: BackendName, model: string | null): void {
  judgeHealth.delete(authKey(backend));
  judgeHealth.delete(runtimeKey(backend, model));
}

/** The strike class that condemned this target, or null while it is healthy. */
function unhealthyCode(backend: BackendName, model: string | null): "judge-auth" | "judge-auth-or-runtime" | null {
  if ((judgeHealth.get(authKey(backend)) ?? 0) >= UNHEALTHY_STRIKES) return "judge-auth";
  if ((judgeHealth.get(runtimeKey(backend, model)) ?? 0) >= UNHEALTHY_STRIKES) return "judge-auth-or-runtime";
  return null;
}

/** Test seam: the ledger is process-scoped, so a suite must be able to clear it. */
export function resetJudgeHealth(): void {
  judgeHealth.clear();
}

const CODEX_PREFLIGHT_PROMPT = "Reply with exactly: OK";
const CODEX_PREFLIGHT_TIMEOUT_MS = 30_000;
const codexPreflights = new Map<string, Promise<BackendRunResult>>();

function codexPreflightKey(target: JudgeTarget): string {
  // Scope the one-shot success to the command lookup context and exact target.
  // Failures are never cached, so an operator repair is immediately rechecked.
  return JSON.stringify([process.env["PATH"] ?? "", target.backend, target.model, target.effort]);
}

async function preflightBackend(
  backend: JudgeBackend,
  target: JudgeTarget,
  configuredTimeoutMs: number,
  execution?: ExecutionLifecycle,
): Promise<BackendRunResult | null> {
  if (backend.name !== "codex") return null;
  const key = codexPreflightKey(target);
  const existing = codexPreflights.get(key);
  if (existing !== undefined) return existing;
  const pending = backend.run(CODEX_PREFLIGHT_PROMPT, {
    model: target.model,
    effort: target.effort,
    timeoutMs: Math.min(configuredTimeoutMs, CODEX_PREFLIGHT_TIMEOUT_MS),
    purpose: "judge:preflight",
    ...(execution !== undefined ? { execution } : {}),
  }).then((result) => {
    if (result.text.trim() !== "OK") {
      throw new JudgeError(
        "judge-invalid-output",
        backend.name,
        "judge preflight did not reply with exactly OK",
        "invalid-contract",
      );
    }
    return result;
  }).catch((error) => {
    // A failure must be re-checkable after the operator repairs the backend in
    // the same host process. Only successful canaries are safe to cache.
    codexPreflights.delete(key);
    throw error;
  });
  codexPreflights.set(key, pending);
  return pending;
}

export type { JudgeActivity } from "./types";

export interface JudgeOutcome<T> {
  value: T;
  record: JudgeCallRecord;
}

function persistedFallbackReason(
  error: JudgeError,
): string {
  const outcome = error.code;
  if (error.reason === "turn-failed") return "backend-turn: codex reported turn.failed";
  if (error.reason === "missing-turn-completed") return "backend-turn: codex emitted no turn.completed event";
  if (outcome === "judge-auth") return "primary judge authentication failed";
  if (outcome === "judge-auth-or-runtime") return "primary judge authentication or runtime failed";
  if (outcome === "judge-timeout") return "primary judge timed out";
  if (outcome !== "judge-invalid-output") return "primary judge failed before producing a usable verdict";

  // The exact detail still reaches the one in-memory retry, but durable state
  // is formatted from a structured backend/validator category. Provider text,
  // commands, paths, and secrets never need message-prefix parsing here.
  switch (error.reason) {
    case "prompt-only-shell": return "command-audit: prompt-only judge executed a shell command";
    case "non-read-command": return "command-audit: isolated judge used a non-read command";
    case "shell-composition": return "command-audit: isolated judge used unsafe shell syntax or expansion";
    case "out-of-workspace": return "command-audit: isolated judge attempted an out-of-workspace path";
    case "missing-allowlisted-path": return "command-audit: isolated judge named no allowlisted evidence path";
    case "missing-json": return "response-validation: no JSON object found";
    case "empty-response": return "response-validation: judge returned no usable message";
    case "read-budget-exceeded": return "read-budget: isolated judge exceeded the harness read budget";
    case "unauditable-trace": return "command-audit: judge emitted a trace line too large to audit";
    default: break;
  }
  return "response-validation: judge output did not satisfy the required contract";
}

/** Effective project profile after the test/diagnostic backend override. */
export function effectiveJudgeProfile(config: SasuConfig, profile: JudgeProfile): { primary: JudgeTarget; fallback: JudgeTarget | null } {
  const configured = judgeProfileFor(config, profile);
  const override = process.env["SASU_JUDGE_BACKEND"] as BackendName | undefined;
  // Validated against the one exported backend list: a second hardcoded list
  // here is how a newly added backend becomes silently unselectable by the
  // diagnostic override while every other surface accepts it (PRINCIPLES 13).
  if (override !== undefined && !BACKENDS.includes(override)) {
    throw new Error(`SASU_JUDGE_BACKEND must be one of: ${BACKENDS.join(", ")}, got: ${override}`);
  }
  if (override === undefined) return configured;

  const configuredTargets = [configured.primary, configured.fallback].filter((target): target is JudgeTarget => target !== null);
  const overriddenPrimary = configuredTargets.find((target) => target.backend === override) ?? {
    ...configured.primary,
    backend: override,
    ...(override === "stub" ? { model: null } : {}),
  };
  // A diagnostic override is an operator pin, not a preference. Retaining a
  // fallback can re-enter the backend being bypassed and make the observed
  // failure depend on an unrelated CLI in PATH (PRINCIPLES items 3 and 11).
  return { primary: overriddenPrimary, fallback: null };
}

/**
 * Whether this backend can put this call's screenshots in front of the judge.
 *
 * Two capabilities answer that question and they are not the same guarantee,
 * which is exactly why recovery and first routing ask different things.
 * Attachment puts the image in the request whatever the judge decides;
 * a readable workspace copy only means the judge can open it, and a backend
 * with no command trace cannot show that it did. Recovery may accept the
 * weaker guarantee - the alternative is no review at all - so both fallback
 * decisions call this. The initial choice does not: a default must be the
 * strong guarantee, and reachability is what recovery falls back TO, never
 * what the run starts from.
 *
 * One predicate rather than the same boolean at both fallback sites: they are
 * one question, and 2026-09-10 they had answered it differently, so a visual
 * call whose primary was already known dead paid that primary's full latency
 * before crossing to the backend it could have started from.
 *
 * Reachability is a property of the call, not of the backend alone: the
 * workspace is built from cwd-relative evidence paths, so an image outside
 * cwd is not reachable however capable the backend is. Answering that here
 * keeps `workspace-readable` in the record true by construction instead of
 * true by whichever caller happened to register the screenshots.
 */
function carriesVisualEvidence(backend: JudgeBackend, agentic: boolean, images: readonly string[], cwd: string | undefined): boolean {
  if (backend.attachments) return true;
  if (!agentic || !backend.readableImages) return false;
  return cwd !== undefined && images.every((image) => insideRoot(cwd, image));
}

/** An absolute path strictly under `root`, the only shape a workspace copy can carry. */
function insideRoot(root: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Caller-scoped reasoning budget, applied to the primary and the fallback alike. */
function withEffortOverride(
  selected: { primary: JudgeTarget; fallback: JudgeTarget | null },
  effort: JudgeEffort | undefined,
): { primary: JudgeTarget; fallback: JudgeTarget | null } {
  if (effort === undefined) return selected;
  return {
    primary: { ...selected.primary, effort },
    fallback: selected.fallback === null ? null : { ...selected.fallback, effort },
  };
}

/**
 * Look at a reply the read-budget check is about to throw away.
 *
 * This rejection is the only one decided without reading the text, so four
 * production rejections discarded 533-596s of judge work each and nothing in
 * the records says whether any of them was a usable review (2026-09-10,
 * agents/benchmarks/paperwork-delivery-20260910/results). That question has no
 * answer today, which is why nobody can argue it either way.
 *
 * Recording, never acceptance: the rejection above is unchanged, and a reply
 * that parses and validates is still discarded. Only the record grows.
 *
 * The caller's validator runs here on text that will be thrown away, so it
 * must not change anything. Audited 2026-09-11 across all six call sites:
 * four are schema checks, one is a read-only comparison, and the implement
 * review validator's `reconcileReviewFindings` clones its input
 * (convergence.ts) and has its result discarded.
 *
 * `observation` is the live activity object, and arguments evaluate before
 * `retryOrFallback` clones it, so a validator that wrote to it would corrupt
 * the recorded observation rather than a copy. Five of the six call sites
 * declare `(value)` and never see it; `gates/commands.ts` takes it and passes
 * it to `readEvidence` (types.ts:106), which reads three counters and returns
 * a label. The signature permits a write that no caller makes - the first one
 * that wants to must re-check this call, not just its own lane.
 *
 * No validator can throw into the catch below today, and what holds that is a
 * layout rather than a property of the validators. Checked 2026-09-11 across
 * all four lanes: every validator returns `| string` for a rejection, and the
 * two reconciles that do throw sit on either side of the boundary - the review
 * one runs inside its validator and has its own catch (commands.ts:1397-1398),
 * the risk one is called after the lane settles (commands.ts:1425) and so
 * never sees this call at all. Move that second one inside its validator, for
 * atomicity or to save a pass, and this branch goes live - and whoever moves
 * it will not know they armed it. So the catch stays, a test exercises it with
 * a deliberately throwing validator, and the risk lane's missing catch is a
 * different layout rather than a defect to be repaired.
 *
 * Catching is not the silent failure engineering item 4 forbids. This call is
 * an observation, not a judgement, and an observation that comes back
 * "invalid" is its value, not a failure of the call. Letting it propagate
 * would replace `read-budget-exceeded` with an unhandled exception and lose
 * the fallback crossing with it.
 */
function inspectDiscarded<T>(
  text: string,
  observation: JudgeActivity,
  validate: (value: unknown, activity: JudgeActivity) => T | string,
): DiscardedOutput {
  const parsed = extractJsonObject(text);
  if (parsed === null) return { parsed: false };
  try {
    const validated = validate(parsed, observation);
    return typeof validated === "string"
      ? { parsed: true, contract: "rejected", problem: boundedProblem(validated) }
      : { parsed: true, contract: "accepted" };
  } catch (error) {
    return {
      parsed: true,
      contract: "rejected",
      problem: boundedProblem(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * `detail` next to it is bounded the same way and says so only in prose, which
 * leaves a cut message looking like a whole one. These records exist to be
 * counted later, and "the reply was invalid, reason unknown" is the one answer
 * that would waste the counting, so the cut is marked in the value itself.
 */
function boundedProblem(text: string): string {
  return text.length <= DISCARDED_PROBLEM_MAX_CHARS ? text : `${text.slice(0, DISCARDED_PROBLEM_MAX_CHARS - 1)}\u2026`;
}

/** Same order as `JudgeRetry.detail`: enough to tell two rejections apart, not a transcript. */
const DISCARDED_PROBLEM_MAX_CHARS = 300;

/**
 * A retry resends the same prompt to the same backend with one sentence of
 * correction prepended. It is worth its full latency only when that sentence
 * can change what the next attempt does.
 *
 * A read-budget rejection cannot be corrected that way. `backends.ts` recorded
 * the expectation as fact - "attempt 2 reads selectively instead of
 * exhaustively" - and the production records falsify it four times out of
 * four (agents/benchmarks/paperwork-delivery-20260910/results, 2026-09-10):
 * 35 rounds became 30 and was rejected again by one, 44 became 54. Those
 * second attempts cost 533s, 569s, 588s and 596s and ended exactly where the
 * first ones did. Nothing between the two attempts differs - same workspace,
 * same documents, same budget - and the retry is not failing for want of
 * being told: the rejection detail travels in the preamble verbatim, so the
 * judge is asked in as many words to batch its reads and open only the paths
 * the criterion needs. It read more anyway. Prompting the count down is dead
 * twice over; three batching-instruction cells moved it by nothing (9, 9, 10
 * rounds, agents/benchmarks/max-turns-20260910, 2026-09-10).
 * Refusing the retry does not remove recovery: `judge-invalid-output` is in
 * the fallback set below, so the call now crosses to a backend that is
 * actually different instead of paying ten minutes to fail where it stood.
 *
 * Other reasons have the same shape on paper and are deliberately left alone
 * until someone measures them: `evidence-access` must fail identically (the
 * path is missing or outside the root), and a refusal recorded as
 * `empty-response` has nothing to correct. Neither has an observation behind
 * it. An unnamed reason keeps the old behaviour, so this change is only as
 * wide as its evidence.
 */
function retryCanCorrect(reason: JudgeFailureReason | null): boolean {
  return reason !== "read-budget-exceeded";
}

/**
 * One-shot judge call with the D-16 output defense: schema validation plus
 * exactly one retry on invalid output. Backend/model/attempt counts are
 * returned for receipt recording; the caller persists them. Async so lane
 * fan-out can run several judges concurrently; the per-call timeout and
 * retry semantics are unchanged.
 */
export async function runJudge<T>(
  config: SasuConfig,
  purpose: string,
  profile: JudgeProfile,
  prompt: string,
  validate: (value: unknown, activity: JudgeActivity) => T | string,
  options: { execution?: ExecutionLifecycle; images?: string[]; agentic?: boolean; explore?: boolean; cwd?: string; evidencePaths?: string[]; effort?: JudgeEffort } = {},
): Promise<JudgeOutcome<T>> {
  // The caller's effort wins over the profile's for BOTH targets, applied once
  // here rather than at the backend.run call site: every downstream reader of
  // `target.effort` (the persisted record, the fallback record, the backend
  // health key) must report the effort actually spent, or an artifact claims a
  // budget the call never used. A caller-scoped budget is how a narrow lane
  // pays less than an exhaustive single judge for the same profile.
  const selected = withEffortOverride(effectiveJudgeProfile(config, profile), options.effort);
  let target: JudgeTarget = selected.primary;
  let backend = resolveBackend(target.backend);
  // An image must be an attachment, not bytes emitted by a Read tool. Claude
  // has no attachment surface, so choose the configured attachment-capable
  // fallback before the call rather than exposing a context-size lottery.
  const visualEvidence = (options.images?.length ?? 0) > 0;
  if (visualEvidence && !backend.attachments) {
    const attachmentFallback = selected.fallback !== null && resolveBackend(selected.fallback.backend).attachments
      ? selected.fallback
      : null;
    if (attachmentFallback === null) {
      throw new JudgeError("judge-invalid-output", backend.name, "visual evidence requires an attachment-capable judge; configure Codex for this profile");
    }
    target = attachmentFallback;
    backend = resolveBackend(target.backend);
  }
  let fallback: JudgeCallRecord["fallback"];
  // A backend that already failed auth/runtime in this process will fail the
  // same way again; starting there only pays its latency to rediscover that.
  // Same shape as the attachment swap above - choose before the call rather
  // than after N callers have each eaten the discovery.
  const primaryUnhealthy = unhealthyCode(target.backend, target.model);
  if (primaryUnhealthy !== null && selected.fallback !== null && unhealthyCode(selected.fallback.backend, selected.fallback.model) === null) {
    const candidate = resolveBackend(selected.fallback.backend);
    const capable = candidate.available()
      && (options.agentic !== true || candidate.agentic)
      && (!visualEvidence || carriesVisualEvidence(candidate, options.agentic === true, options.images ?? [], options.cwd));
    if (capable) {
      fallback = {
        at: new Date().toISOString(),
        backend: target.backend,
        model: target.model,
        effort: target.effort,
        durationMs: 0,
        attempts: 0,
        outcome: primaryUnhealthy,
        reason: primaryUnhealthy === "judge-auth"
          ? "primary judge skipped: it already failed authentication in this run"
          : "primary judge skipped: it already failed authentication or runtime in this run",
      };
      target = selected.fallback;
      backend = candidate;
    }
  }
  if (options.agentic === true && !backend.agentic) {
    throw new Error(`judge requires isolated read-only evidence access; ${backend.name} cannot provide it for profile ${profile}`);
  }
  let startedAt = Date.now();
  let attempts = 0;
  let lastProblem = "";
  // One sink per attempt, written by the backend while the attempt runs. It
  // replaces the old post-return assembly of a command list, which is why a
  // timeout used to record nothing: the observation only existed on the
  // success path (2026-09-10 verify-timeout benchmark).
  let observation: JudgeActivity = newJudgeActivity();
  /** The current backend's last attempt, or null while no attempt has run. */
  const attemptObservation = (): JudgeActivity | null => (attempts > 0 ? observation : null);
  /**
   * Recorded for every call that carried screenshots, not only for the
   * fallback that made it possible: "how did the pictures get there, and can
   * this record show the judge took them in" is a property of the call.
   * Reaching here with neither capability is unreachable - first routing and
   * both fallback predicates refuse it - so the delivery follows attachment.
   */
  const visualEvidenceRecord = (): VisualEvidenceRecord | undefined => {
    const images = options.images?.length ?? 0;
    if (images === 0) return undefined;
    return { images, delivery: backend.attachments ? "attached" : "workspace-readable", verifiedSeen: backend.attachments };
  };
  /**
   * Evidence paths for the backend about to run. A reachability-only delivery
   * needs the screenshots inside the copied workspace, and only the caller
   * that registered them as evidence puts them there: the implement lane does,
   * the quick gate resolves them from a separate lane. Adding them here makes
   * the delivery real wherever the images come from; containment was already
   * proved by carriesVisualEvidence, and an attachment backend never reaches
   * this branch, so no command-audit allowlist changes.
   */
  const evidencePathsForCall = (): string[] | undefined => {
    const base = options.evidencePaths;
    const images = options.images ?? [];
    if (options.agentic !== true || backend.attachments || images.length === 0 || options.cwd === undefined) return base;
    const root = options.cwd;
    return [...new Set([...(base ?? []), ...images.map((image) => path.relative(root, image))])];
  };
  const advisories: JudgeAdvisory[] = [];
  const advisoryKeys = new Set<string>();
  const addAdvisories = (incoming: JudgeAdvisory[] = []): void => {
    for (const advisory of incoming) {
      const key = `${advisory.code}\0${advisory.backend}\0${advisory.message}`;
      if (advisoryKeys.has(key)) continue;
      advisoryKeys.add(key);
      advisories.push(advisory);
      process.stderr.write(
        `sasu: WARNING: ${advisory.code} (${advisory.backend}, ${purpose}): ${advisory.message}\n`,
      );
    }
  };
  let fallbackUsed = target.backend !== selected.primary.backend;
  const useFallback = (error: JudgeError): boolean => {
    const fallbackTarget = !fallbackUsed ? selected.fallback : null;
    if (fallbackTarget === null) return false;
    const fallbackBackend = resolveBackend(fallbackTarget.backend);
    if (!fallbackBackend.available()) return false;
    // Refusing a known-dead fallback surfaces the primary's real error now
    // instead of after a second full-latency call proves what this process
    // already knows.
    if (unhealthyCode(fallbackTarget.backend, fallbackTarget.model) !== null) return false;
    // A fallback must be able to see the same proof surface. Dropping isolated
    // evidence access or image visibility would turn backend recovery into a
    // different judgment with missing inputs.
    if (options.agentic === true && !fallbackBackend.agentic) return false;
    if ((options.images?.length ?? 0) > 0 && !carriesVisualEvidence(fallbackBackend, options.agentic === true, options.images ?? [], options.cwd)) return false;
    fallbackUsed = true;
    fallback = {
      at: new Date(startedAt).toISOString(),
      backend: backend.name,
      model: target.model,
      effort: target.effort,
      durationMs: Date.now() - startedAt,
      attempts,
      outcome: error.code,
      reason: persistedFallbackReason(error),
    };
    target = fallbackTarget;
    backend = fallbackBackend;
    startedAt = Date.now();
    attempts = 0;
    lastProblem = "";
    observation = newJudgeActivity();
    return true;
  };
  // Persisted answer to "why attempts=N": one entry per rejected attempt,
  // across the primary and any fallback. The full detail still drives the
  // in-memory retry preamble; the record keeps a bounded copy.
  const retries: JudgeRetry[] = [];
  let usage: JudgeUsage | undefined;
  let attemptStartedAt = Date.now();
  const retryOrFallback = (error: JudgeError, discarded?: DiscardedOutput): void => {
    // Every unusable judge response crosses this one boundary. Backend
    // command-audit rejection, missing JSON, and schema rejection must not
    // acquire three subtly different attempt or fallback contracts - and it
    // is therefore also the one place the health ledger can learn anything.
    if (error.reason === "input-too-large") {
      throw Object.assign(error, {
        record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, attemptObservation(), retries, usage, advisories, visualEvidenceRecord()),
      });
    }
    recordBackendFailure(backend.name, target.model, error.code);
    // A rejected attempt's spend must never be persisted as the call's usage:
    // the field is documented as the answering attempt's.
    usage = undefined;
    retries.push({
      at: new Date(attemptStartedAt).toISOString(),
      backend: backend.name,
      model: target.model,
      code: error.code,
      reason: error.reason,
      attempt: attempts,
      detail: error.detail.slice(0, 300),
      durationMs: Date.now() - attemptStartedAt,
      // Copied, not referenced: this attempt is over, and its observation must
      // not move if anything still holds the live sink.
      observation: structuredClone(observation),
      ...(discarded !== undefined ? { discarded } : {}),
    });
    if (error.code === "judge-invalid-output" && attempts < 2 && retryCanCorrect(error.reason)) {
      lastProblem = error.detail.slice(0, JUDGE_CORRECTION_MAX_CHARS);
      return;
    }
    const canFallback = error.code === "judge-auth"
      || error.code === "judge-auth-or-runtime"
      || error.code === "judge-timeout"
      || error.code === "judge-invalid-output";
    if (canFallback && useFallback(error)) return;
    throw Object.assign(error, {
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, attemptObservation(), retries, usage, advisories, visualEvidenceRecord()),
    });
  };
  while (true) {
    try {
      assertJudgeInputFits(backend.name, prompt, { ...options, readMaxRounds: config.judge.readMaxRounds }, true);
    } catch (error) {
      if (!(error instanceof JudgeError)) throw error;
      throw Object.assign(error, {
        record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, attemptObservation(), retries, usage, advisories, visualEvidenceRecord()),
      });
    }
    try {
      const preflight = await preflightBackend(backend, target, config.judge.timeoutMs, options.execution);
      addAdvisories(preflight?.advisories);
    } catch (error) {
      if (!(error instanceof JudgeError)) throw error;
      // The canary is cheap but its failure is the same observation the health
      // ledger records for full calls: this target cannot answer right now.
      recordBackendFailure(backend.name, target.model, error.code);
      const canFallback = error.code === "judge-auth"
        || error.code === "judge-auth-or-runtime"
        || error.code === "judge-timeout"
        || error.code === "judge-invalid-output";
      if (canFallback && useFallback(error)) continue;
      throw Object.assign(error, {
        record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, error.code, fallback, attemptObservation(), retries, usage, advisories, visualEvidenceRecord()),
      });
    }
    attempts += 1;
    attemptStartedAt = Date.now();
    observation = newJudgeActivity();
    // Usage belongs to the answering attempt only; a stale value from an
    // attempt whose reply was later rejected must not be recorded as the
    // call's spend.
    usage = undefined;
    const retryPreamble =
      attempts === 1
        ? ""
        : `Your previous attempt was rejected: ${lastProblem}. Correct that specific problem, then reply with only the JSON object, no prose, no code fences.\n\n`;
    let text: string;
    try {
      const result = await backend.run(retryPreamble + prompt, {
        observation,
        model: target.model,
        ...(options.execution !== undefined ? { execution: options.execution } : {}),
        timeoutMs: config.judge.timeoutMs,
        purpose,
        effort: target.effort,
        ...(target.baseUrl !== undefined ? { baseUrl: target.baseUrl } : {}),
        ...(options.images !== undefined ? { images: options.images } : {}),
        ...(options.agentic !== undefined ? { agentic: options.agentic } : {}),
        ...(options.explore !== undefined ? { explore: options.explore } : {}),
        readMaxRounds: config.judge.readMaxRounds,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...((): { evidencePaths?: string[] } => {
          const paths = evidencePathsForCall();
          return paths !== undefined ? { evidencePaths: paths } : {};
        })(),
      });
      text = result.text;
      usage = result.usage;
      addAdvisories(result.advisories);
    } catch (error) {
      if (error instanceof JudgeError) {
        // The creator-assist baseline recorded 27/56 acceptance calls crossing
        // to the slower fallback after a command-audit rejection; none gave
        // the primary the repair attempt schema-invalid JSON already received.
        retryOrFallback(error);
        continue;
      }
      throw error;
    }
    // Preserve the same backend budget after the call, in the budget's own
    // unit. Codex exploration is bounded by streamed read-output volume plus
    // timeout, not command count: its 30-command/139.770s original-case review
    // was otherwise discarded.
    //
    // Only `readRounds` may be compared here, and every backend that fills it
    // fills it in this unit. This post-hoc check is load-bearing rather than
    // redundant: measured 2026-09-10 against claude 2.1.267, `--max-turns` is
    // real (a capped call arrives as exit 1, subtype error_max_turns, no
    // result field, at exactly cap + 1 turns) but does not always hold - two
    // runs of one 40-file fixture under the same cap of 30 ended at 31 turns
    // capped and 41 turns completed, and the production reviews leaked to 42,
    // 45 and 54. Whatever lets a call past the cap, this check is what
    // actually caught those.
    //
    // The exemption used to name codex. That said the true thing for the wrong
    // reason: what makes lifting the round budget safe is not which backend
    // answered but that a different budget is holding the call, and the two
    // halves of this predicate are the two separate facts it needs.
    // `explore` is the caller's intent - this call is expected to range wider
    // than a fixed path list - and `metersReadChars` is the precondition that
    // intent is granted under. Drop the second half and an exploring call on a
    // backend that meters nothing runs with no read bound at all.
    if (options.agentic === true && options.explore === true && backend.metersReadChars
      && observation.readOutputChars === null) {
      // The trade was made and the other side did not arrive. This is not a
      // satisfied budget, it is no budget - the one failure shape that looks
      // like success, because the call comes back with a verdict and nothing
      // in the record says what bounded it. Rejecting costs a real review when
      // a meter breaks; accepting spends the budget's whole purpose to save it
      // (principle 10, and engineering item 4: no silent skip over an invalid
      // state).
      retryOrFallback(new JudgeError(
        "judge-invalid-output",
        backend.name,
        `judge exploration lifted the ${config.judge.readMaxRounds}-round budget because this backend meters read output in chars, and it then metered none; the call ran unbounded`,
        "unauditable-trace",
      ));
      continue;
    }
    // The budget the exemption above is granted against, applied wherever the
    // backend did not already apply it itself. Codex kills its own call at the
    // limit, so a codex call that reaches here is inside it and this compares
    // a number to itself; claude is measured from its finished trace and this
    // is the only place its volume is ever checked. Before this existed, the
    // repository compared this limit in exactly one place - inside codex's
    // streaming audit - so lifting the round budget for any other backend
    // would have left the call with no read bound at all.
    if (options.agentic === true && backend.metersReadChars
      && observation.readOutputChars !== null && observation.readOutputChars > AGENTIC_READ_MAX_OUTPUT_CHARS) {
      retryOrFallback(new JudgeError(
        "judge-invalid-output",
        backend.name,
        `judge read ${observation.readOutputChars} chars of read output against a limit of ${AGENTIC_READ_MAX_OUTPUT_CHARS}; read narrower ranges of only the paths the criterion needs`,
        "read-budget-exceeded",
      ), inspectDiscarded(text, observation, validate));
      continue;
    }
    if (options.agentic === true && !(options.explore === true && backend.metersReadChars)
      && observation.readRounds !== null && observation.readRounds > config.judge.readMaxRounds) {
      retryOrFallback(new JudgeError(
        "judge-invalid-output",
        backend.name,
        // "batch reads" left this sentence. It is true for codex, where a round
      // is an audited command and joining reads with && makes one; it is not
      // true for claude, where a round is a `tool_use` block counted from the
      // trace, so 20 reads batched into 2 API turns are still 20. An
      // instruction that is inert for one
      // of the two backends that can receive it does not belong in a message
      // both receive - and this rejection no longer travels into a retry
      // prompt anyway (retryCanCorrect), so its only reader is a person.
      `judge used ${observation.readRounds} read rounds against a limit of ${config.judge.readMaxRounds}; inspect only the paths the criterion needs`,
        "read-budget-exceeded",
      ), inspectDiscarded(text, observation, validate));
      continue;
    }
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      retryOrFallback(new JudgeError("judge-invalid-output", backend.name, "no JSON object found in output", "missing-json"));
      continue;
    }
    const validated = validate(parsed, observation);
    if (typeof validated === "string") {
      retryOrFallback(new JudgeError("judge-invalid-output", backend.name, validated, "invalid-contract"));
      continue;
    }
    recordBackendSuccess(backend.name, target.model);
    return {
      value: validated,
      record: makeRecord(backend.name, target, profile, purpose, startedAt, attempts, "ok", fallback, attemptObservation(), retries, usage, advisories, visualEvidenceRecord()),
    };
  }
}

function makeRecord(
  backend: JudgeCallRecord["backend"],
  target: JudgeTarget,
  profile: JudgeProfile,
  purpose: string,
  startedAt: number,
  attempts: number,
  outcome: JudgeCallRecord["outcome"],
  fallback?: JudgeCallRecord["fallback"],
  activity: JudgeActivity | null = null,
  retries: JudgeRetry[] = [],
  usage?: JudgeUsage,
  advisories: JudgeAdvisory[] = [],
  visual?: VisualEvidenceRecord,
): JudgeCallRecord {
  return {
    at: new Date(startedAt).toISOString(),
    backend,
    model: target.model,
    profile,
    effort: target.effort,
    purpose,
    durationMs: Date.now() - startedAt,
    attempts,
    outcome,
    ...(advisories.length > 0 ? { advisories } : {}),
    // Recorded whenever an attempt ran, including when it observed nothing:
    // omitting an empty observation made "read nothing" and "never observed"
    // the same missing key, and that is what a failed call used to look like.
    ...(activity !== null ? { activity } : {}),
    ...(visual !== undefined ? { visualEvidence: visual } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(retries.length > 0 ? { retries } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

export function judgeCallRecordFrom(error: unknown): JudgeCallRecord | null {
  if (error instanceof JudgeError && "record" in error) {
    return (error as JudgeError & { record: JudgeCallRecord }).record;
  }
  return null;
}
