import { changedPathsSince } from "./store";
import type {
  DeltaBasis,
  FindingOrigin,
  PriorDisposition,
  RegisteredArtifact,
  RiskDisposition,
  RiskFinding,
  RiskLaneResult,
  SourceEntry,
  SourceSnapshot,
  TrackedRiskFinding,
  UnifiedVerificationAttempt,
  VerificationInputManifest,
  VerificationRoundContext,
} from "./types";

export interface VerdictDeltaFields {
  priorDisposition?: PriorDisposition;
  origin?: FindingOrigin;
  deltaBasis?: DeltaBasis;
}

/**
 * Finds the newest successful result for one semantic unit, not merely the
 * newest attempt containing some other lane's result. Partial judge errors
 * are deliberately skipped: otherwise an ERROR in risk (or one acceptance
 * criterion) can erase an older unresolved finding from the next prompt.
 */
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

export function evidenceDeltaKey(entry: { verificationId: string; path: string }): string {
  return `${entry.verificationId}:${entry.path}`;
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
    .map((entry) => ({ verificationId: entry.verificationId, path: entry.path, sha256: entry.sha256 }))
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

function parsePriorDisposition(value: unknown, label: string): PriorDisposition | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${label}.priorDisposition must be an object`;
  }
  const record = value as Record<string, unknown>;
  if (record["status"] !== "resolved" && record["status"] !== "unresolved") {
    return `${label}.priorDisposition.status must be resolved or unresolved`;
  }
  const reason = nonEmptyString(record["reason"]);
  if (reason === null) return `${label}.priorDisposition.reason must be a non-empty string`;
  return { status: record["status"], reason };
}

function parseDeltaBasis(value: unknown, context: VerificationRoundContext, label: string): DeltaBasis | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${label}.deltaBasis must be an object`;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const held = nonEmptyString(record["value"]);
  if (kind !== "changed-path" && kind !== "new-evidence") {
    return `${label}.deltaBasis.kind must be changed-path or new-evidence`;
  }
  if (held === null) return `${label}.deltaBasis.value must be a non-empty string`;
  const allowed = kind === "changed-path"
    ? context.changedPaths
    : context.newEvidence.map(evidenceDeltaKey);
  if (!allowed.includes(held)) {
    return `${label}.deltaBasis.value must name an exact ${kind} from this round; got ${held}`;
  }
  return { kind, value: held };
}

/**
 * Mechanical half of the round-2 delta contract. A judge may still report a
 * real new blocker, but it cannot turn a prior PASS into FAIL or mint a new
 * blocker by inventing an unobserved change. The prompt asks; this validator
 * enforces (PRINCIPLES 7 and 13).
 */
export function validateVerdictDelta(
  raw: Record<string, unknown>,
  currentVerdict: "PASS" | "FAIL",
  priorVerdict: "PASS" | "FAIL" | null,
  context: VerificationRoundContext,
  label: string,
): VerdictDeltaFields | string {
  if (context.priorAttemptId === null) return {};
  let priorDisposition: PriorDisposition | undefined;
  if (priorVerdict === "FAIL") {
    const parsed = parsePriorDisposition(raw["priorDisposition"], label);
    if (typeof parsed === "string") return parsed;
    priorDisposition = parsed;
  }
  if (currentVerdict === "PASS") {
    if (priorVerdict === "FAIL" && priorDisposition?.status !== "resolved") {
      return `${label} must disposition the prior FAIL as resolved before returning PASS`;
    }
    return priorDisposition === undefined ? {} : { priorDisposition };
  }
  const origin = raw["origin"];
  if (origin !== "prior-unresolved" && origin !== "new") {
    return `${label}.origin must be prior-unresolved or new on round 2+ FAIL`;
  }
  if (origin === "prior-unresolved") {
    if (priorVerdict !== "FAIL" || priorDisposition?.status !== "unresolved") {
      return `${label} can use prior-unresolved only for an unresolved prior FAIL`;
    }
    return { priorDisposition, origin };
  }
  if (priorVerdict === "FAIL" && priorDisposition?.status !== "resolved") {
    return `${label} must resolve the prior FAIL before replacing it with a new blocker`;
  }
  const basis = parseDeltaBasis(raw["deltaBasis"], context, label);
  if (typeof basis === "string") return basis;
  return {
    ...(priorDisposition !== undefined ? { priorDisposition } : {}),
    origin,
    deltaBasis: basis,
  };
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

  const rerun = context.priorAttemptId !== null;
  const priorFindings = prior?.findings ?? [];
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
      findings.push({ id: `RF${nextId++}`, severity: finding["severity"], text });
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
        : `deltaBasis ${disposition.deltaBasis.kind}=${disposition.deltaBasis.value}`;
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
