import { changedPathsSince } from "./store";
import type { ReviewResult } from "../judge/types";
import type {
  DeltaBasis,
  RegisteredArtifact,
  RiskDisposition,
  RiskFinding,
  RiskLaneResult,
  SourceEntry,
  SourceSnapshot,
  TrackedRiskFinding,
  TrackedReviewFinding,
  UnifiedVerificationAttempt,
  VerificationInputManifest,
  VerificationRoundContext,
} from "./types";

/** Latest completed independent result; backend errors never erase open findings. */
export function latestAttemptResult<T>(
  attempts: readonly UnifiedVerificationAttempt[],
  select: (attempt: UnifiedVerificationAttempt) => T | null | undefined,
): { attempt: UnifiedVerificationAttempt; result: T } | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    const result = select(attempt);
    if (result !== null && result !== undefined) return { attempt, result };
  }
  return null;
}

export function evidenceDeltaKey(entry: { path: string }): string {
  return entry.path;
}

export function verificationInputManifest(
  initial: SourceSnapshot,
  current: SourceSnapshot,
  artifacts: RegisteredArtifact[],
): VerificationInputManifest {
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const source: SourceEntry[] = changedPathsSince(initial, current).map((relative) =>
    currentByPath.get(relative) ?? { path: relative, state: "absent", sha256: null },
  );
  const evidence = artifacts
    .filter((entry) => entry.command === undefined)
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    }))
    .sort((left, right) => evidenceDeltaKey(left).localeCompare(evidenceDeltaKey(right)));
  return { source, evidence };
}

export function verificationRoundContext(
  current: VerificationInputManifest,
  prior: UnifiedVerificationAttempt | null,
): VerificationRoundContext {
  if (prior === null) return { priorAttemptId: null, changedPaths: [], newEvidence: [] };
  const priorSource = new Map(prior.inputManifest.source.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const currentSource = new Map(current.source.map((entry) => [entry.path, `${entry.state}\0${entry.sha256 ?? ""}`]));
  const changedPaths = [...new Set([...priorSource.keys(), ...currentSource.keys()])]
    .filter((relative) => priorSource.get(relative) !== currentSource.get(relative))
    .sort();
  const priorEvidence = new Map(prior.inputManifest.evidence.map((entry) => [evidenceDeltaKey(entry), entry.sha256]));
  const newEvidence = current.evidence.filter((entry) => priorEvidence.get(evidenceDeltaKey(entry)) !== entry.sha256);
  return { priorAttemptId: prior.id, changedPaths, newEvidence };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseDeltaBasis(value: unknown, context: VerificationRoundContext, label: string): DeltaBasis | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${label}.deltaBasis must be an object`;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const held = nonEmptyString(record["value"]);
  if (kind !== "changed-path" && kind !== "new-evidence" && kind !== "contract-counterevidence") {
    return `${label}.deltaBasis.kind must be changed-path, new-evidence or contract-counterevidence`;
  }
  if (held === null) return `${label}.deltaBasis.value must be a non-empty string`;
  if (kind === "contract-counterevidence") {
    const validRefs = (refs: unknown, allowed: readonly string[]): refs is string[] =>
      Array.isArray(refs) && refs.length > 0 && refs.every((ref) => typeof ref === "string" && allowed.includes(ref)) && new Set(refs).size === refs.length;
    if (!validRefs(record["requirementRefs"], context.requirementRefs ?? [])) {
      return `${label}.deltaBasis.requirementRefs must name approved contract references`;
    }
    if (!validRefs(record["evidenceRefs"], context.evidenceRefs ?? [])) {
      return `${label}.deltaBasis.evidenceRefs must name actual allowed source or evidence references`;
    }
    return { kind, value: held, requirementRefs: record["requirementRefs"], evidenceRefs: record["evidenceRefs"] };
  }
  const allowed = kind === "changed-path"
    ? context.changedPaths
    : context.newEvidence.map(evidenceDeltaKey);
  if (!allowed.includes(held)) {
    return `${label}.deltaBasis.value must name an exact ${kind} from this round; got ${held}`;
  }
  return { kind, value: held };
}

/**
 * An omitted finding remains open. Only a validated explicit disposition can
 * resolve a defect, while human authority is retained until confirm or amend.
 * The 2026-09-08 contract deliberately allows new omissions in unchanged files:
 * path deltas guide reading, never decide whether a real defect is admissible.
 */
export function reconcileReviewFindings(
  tracked: readonly TrackedReviewFinding[],
  result: ReviewResult,
  attemptId: string,
  at: string,
): TrackedReviewFinding[] {
  const next = structuredClone(tracked) as TrackedReviewFinding[];
  const byId = new Map(next.map((entry) => [entry.id, entry]));
  const dispositionIds = new Set<string>();
  const continuedIds = new Set<string>();
  for (const disposition of result.priorDispositions) {
    const entry = byId.get(disposition.findingId);
    if (entry === undefined || entry.status !== "open") {
      throw new Error(`review disposition ${disposition.findingId} does not name an open ledger finding`);
    }
    if (dispositionIds.has(entry.id)) throw new Error(`duplicate review disposition ${entry.id}`);
    dispositionIds.add(entry.id);
    if (disposition.reason.trim() === "" || disposition.evidenceRefs.length === 0) {
      throw new Error(`review disposition ${entry.id} requires a reason and evidence references`);
    }
    if (entry.kind === "human-confirmation" && disposition.status === "resolved") {
      throw new Error(`human confirmation ${entry.id} can only be closed by a human response or approved amendment`);
    }
    if (disposition.status === "resolved") entry.status = "resolved";
    entry.history.push({ at, attemptId, status: disposition.status, reason: disposition.reason, evidenceRefs: [...disposition.evidenceRefs] });
  }
  let nextId = next.reduce((high, entry) => Math.max(high, Number(entry.id.replace(/^F/, "")) || 0), 0) + 1;
  for (const finding of result.findings) {
    if (finding.priorFindingId !== undefined) {
      const entry = byId.get(finding.priorFindingId);
      if (entry === undefined || entry.status !== "open") {
        throw new Error(`continued review finding ${finding.priorFindingId} does not name an open ledger finding`);
      }
      if (continuedIds.has(entry.id)) throw new Error(`review finding ${entry.id} was continued twice`);
      continuedIds.add(entry.id);
      // A reviewer cannot launder an unfixed defect into advice or transfer it
      // to the human. Resolve the old defect with evidence before changing kind.
      if (entry.kind !== finding.kind) throw new Error(`unresolved review finding ${entry.id} cannot change kind`);
      if (entry.kind === "human-confirmation") {
        if (entry.human?.sourceRef !== finding.human?.sourceRef || entry.human?.quote !== finding.human?.quote || entry.human?.timing !== finding.human?.timing) {
          throw new Error(`human confirmation ${entry.id} cannot change its authority source or timing in review; use an approved amendment`);
        }
      }
      const copy = structuredClone(finding);
      delete copy.priorFindingId;
      Object.assign(entry, copy);
      continue;
    }
    const copy = structuredClone(finding);
    const entry: TrackedReviewFinding = {
      ...copy, id: `F${nextId++}`, originAttemptId: attemptId, status: "open",
      history: [{ at, attemptId, status: "open", reason: finding.problem, evidenceRefs: [...finding.evidenceRefs] }],
      responses: [],
    };
    next.push(entry);
    byId.set(entry.id, entry);
  }
  return next;
}

function parseRiskDisposition(
  value: unknown,
  index: number,
  context: VerificationRoundContext,
  priorById: Map<string, RiskFinding>,
): RiskDisposition | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `priorDispositions[${index}] must be an object`;
  }
  const record = value as Record<string, unknown>;
  const id = nonEmptyString(record["id"]);
  const reason = nonEmptyString(record["reason"]);
  if (id === null) return `priorDispositions[${index}].id must be a non-empty string`;
  if (record["status"] !== "resolved" && record["status"] !== "unresolved") {
    return `priorDispositions[${index}].status must be resolved or unresolved`;
  }
  if (reason === null) return `priorDispositions[${index}].reason must be a non-empty string`;
  const previous = priorById.get(id);
  if (previous === undefined) return `priorDispositions[${index}].id must name a prior finding`;
  if (record["status"] === "resolved" && (previous.severity === "blocking" || record["deltaBasis"] !== undefined)) {
    const basis = parseDeltaBasis(record["deltaBasis"], context, `priorDispositions[${index}]`);
    if (typeof basis === "string") return `resolving prior blocking ${id} requires ${basis}`;
    return { id, status: record["status"], reason, deltaBasis: basis };
  }
  return { id, status: record["status"], reason };
}

export function validateRiskVerdict(
  value: unknown,
  prior: RiskLaneResult | null,
  context: VerificationRoundContext,
  nextFindingNumber?: number,
): RiskLaneResult | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "output is not an object";
  const raw = value as Record<string, unknown>;
  if (raw["verdict"] !== "PASS" && raw["verdict"] !== "FAIL") return "verdict must be PASS or FAIL";
  if (!Array.isArray(raw["findings"])) return "findings must be an array";

  const priorFindings = prior?.findings ?? [];
  const rerun = context.priorAttemptId !== null || priorFindings.length > 0;
  const priorById = new Map(priorFindings.map((entry) => [entry.id, entry]));
  let priorDispositions: RiskDisposition[] | undefined;
  if (rerun) {
    if (!Array.isArray(raw["priorDispositions"])) return "priorDispositions must be an array on round 2+";
    const parsed: RiskDisposition[] = [];
    for (const [index, entry] of raw["priorDispositions"].entries()) {
      const disposition = parseRiskDisposition(entry, index, context, priorById);
      if (typeof disposition === "string") return disposition;
      parsed.push(disposition);
    }
    const returned = parsed.map((entry) => entry.id);
    if (new Set(returned).size !== returned.length) return "priorDispositions must name each prior finding once";
    const missing = priorFindings.filter((entry) => !returned.includes(entry.id)).map((entry) => entry.id);
    const unknown = returned.filter((id) => !priorById.has(id));
    if (missing.length > 0 || unknown.length > 0) {
      return `priorDispositions must exactly cover prior findings (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`;
    }
    priorDispositions = parsed;
  }

  const dispositionById = new Map((priorDispositions ?? []).map((entry) => [entry.id, entry]));
  const reusedPriorIds = new Set<string>();
  let nextId = Math.max(
    priorFindings.reduce((high, entry) => Math.max(high, Number(entry.id.replace(/^RF/, "")) || 0), 0) + 1,
    nextFindingNumber ?? 1,
  );
  const findings: RiskFinding[] = [];
  for (const [index, entry] of raw["findings"].entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `findings[${index}] must be an object with severity and text`;
    }
    const finding = entry as Record<string, unknown>;
    if (finding["severity"] !== "blocking" && finding["severity"] !== "advisory") {
      return `findings[${index}].severity must be blocking or advisory`;
    }
    const text = nonEmptyString(finding["text"]);
    if (text === null) return `findings[${index}].text must be a non-empty string`;
    if (!rerun) {
      let deltaBasis: DeltaBasis | undefined;
      if (finding["severity"] === "blocking" || finding["deltaBasis"] !== undefined) {
        const basis = parseDeltaBasis(finding["deltaBasis"], context, `findings[${index}]`);
        if (typeof basis === "string") return basis;
        deltaBasis = basis;
      }
      findings.push({ id: `RF${nextId++}`, severity: finding["severity"], text, ...(deltaBasis === undefined ? {} : { deltaBasis }) });
      continue;
    }
    const origin = finding["origin"];
    if (origin !== "prior-unresolved" && origin !== "new") {
      return `findings[${index}].origin must be prior-unresolved or new on round 2+`;
    }
    if (origin === "prior-unresolved") {
      const priorFindingId = nonEmptyString(finding["priorFindingId"]);
      const previous = priorFindingId === null ? undefined : priorById.get(priorFindingId);
      if (priorFindingId === null || previous === undefined) return `findings[${index}].priorFindingId must name a prior finding`;
      if (dispositionById.get(priorFindingId)?.status !== "unresolved") {
        return `findings[${index}] references ${priorFindingId}, but its disposition is not unresolved`;
      }
      if (previous.severity === "blocking" && finding["severity"] !== "blocking") {
        return `unresolved prior blocking ${priorFindingId} must remain blocking`;
      }
      if (reusedPriorIds.has(priorFindingId)) return `prior finding ${priorFindingId} was reported more than once`;
      reusedPriorIds.add(priorFindingId);
      let deltaBasis: DeltaBasis | undefined;
      if (finding["severity"] === "blocking" && previous.severity !== "blocking") {
        const basis = parseDeltaBasis(finding["deltaBasis"], context, `findings[${index}]`);
        if (typeof basis === "string") return basis;
        deltaBasis = basis;
      }
      findings.push({
        id: priorFindingId,
        severity: finding["severity"],
        text,
        origin,
        priorFindingId,
        ...(deltaBasis !== undefined ? { deltaBasis } : {}),
      });
      continue;
    }
    let deltaBasis: DeltaBasis | undefined;
    if (finding["severity"] === "blocking") {
      const basis = parseDeltaBasis(finding["deltaBasis"], context, `findings[${index}]`);
      if (typeof basis === "string") return basis;
      deltaBasis = basis;
    }
    findings.push({
      id: `RF${nextId++}`,
      severity: finding["severity"],
      text,
      origin,
      ...(deltaBasis !== undefined ? { deltaBasis } : {}),
    });
  }
  for (const disposition of priorDispositions ?? []) {
    if (disposition.status === "unresolved" && !reusedPriorIds.has(disposition.id)) {
      return `unresolved prior finding ${disposition.id} must remain in findings`;
    }
    if (disposition.status === "resolved" && reusedPriorIds.has(disposition.id)) {
      return `resolved prior finding ${disposition.id} cannot remain prior-unresolved`;
    }
  }
  const blocking = findings.some((entry) => entry.severity === "blocking");
  if (raw["verdict"] === "PASS" && blocking) return "PASS cannot carry a blocking finding";
  if (raw["verdict"] === "FAIL" && !blocking) return "FAIL requires at least one blocking finding";
  return {
    verdict: raw["verdict"],
    findings,
    ...(priorDispositions !== undefined ? { priorDispositions } : {}),
  };
}

/**
 * Applies one successful risk-lane result to the state-owned ledger.
 *
 * The judge may prove that an open item was fixed, or keep it open. Only a
 * finding marked `new` (or any first-round finding) can append an entry. A
 * risk ERROR never reaches this function, which leaves the ledger untouched.
 */
export function reconcileRiskFindings(
  tracked: readonly TrackedRiskFinding[],
  result: RiskLaneResult,
  attemptId: string,
  at: string,
): TrackedRiskFinding[] {
  const next = tracked.map((entry) => ({
    ...entry,
    ...(entry.resolution !== undefined ? { resolution: { ...entry.resolution } } : {}),
  }));
  const byId = new Map(next.map((entry) => [entry.id, entry]));

  for (const disposition of result.priorDispositions ?? []) {
    const entry = byId.get(disposition.id);
    if (entry === undefined || entry.status !== "open") {
      throw new Error(`risk disposition ${disposition.id} does not name an open ledger finding`);
    }
    if (disposition.status === "resolved") {
      if (entry.severity === "blocking" && disposition.deltaBasis === undefined) {
        throw new Error(`resolved risk disposition ${disposition.id} is missing deltaBasis`);
      }
      const deltaEvidence = disposition.deltaBasis === undefined
        ? "deltaBasis=none (advisory resolution)"
        : `deltaBasis ${JSON.stringify(disposition.deltaBasis)}`;
      entry.status = "fixed";
      entry.resolution = {
        at,
        evidence: `risk lane attempt ${attemptId}: ${disposition.reason}; ${deltaEvidence}`,
      };
    }
  }

  for (const finding of result.findings) {
    if (finding.origin === "prior-unresolved") {
      const priorId = finding.priorFindingId;
      const entry = priorId === undefined ? undefined : byId.get(priorId);
      if (entry === undefined || entry.status !== "open") {
        throw new Error(`unresolved risk finding ${priorId ?? finding.id} does not name an open ledger finding`);
      }
      entry.severity = finding.severity;
      entry.text = finding.text;
      continue;
    }
    if (byId.has(finding.id)) throw new Error(`new risk finding reuses ledger id ${finding.id}`);
    const entry: TrackedRiskFinding = {
      id: finding.id,
      severity: finding.severity,
      text: finding.text,
      originAttemptId: attemptId,
      status: "open",
    };
    next.push(entry);
    byId.set(entry.id, entry);
  }

  return next;
}
