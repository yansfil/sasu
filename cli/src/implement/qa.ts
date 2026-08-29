import { sha256 } from "./store";
import type {
  AcceptanceCriterionItem,
  DriverRole,
  ImplementState,
  QaBrief,
  QaBriefStep,
  TrailRecord,
} from "./types";

/**
 * The briefing channel for judged, driven criteria (R11).
 *
 * Two things live here and they are deliberately different in kind. Deriving
 * the script is STRUCTURAL: it reads the sealed PRD's own sentence and
 * enumeration structure and never tries to understand what a criterion means.
 * Judging coverage is a SET COMPARISON of step ids and nothing else - no
 * prose matching, no string similarity (D-31, AGENTS.md Review Guide 7/11).
 * The meaning of a step is left to the driver who reads its text.
 */

export class TrailRejected extends Error {
  constructor(readonly check: "arguments" | "authority" | "transition", message: string) {
    super(message);
    this.name = "TrailRejected";
  }
}

/** Roles that may register a trail (D-43). */
const DRIVER_ROLES: DriverRole[] = ["human", "observer", "qa-agent"];

/**
 * Roles that may not, named individually so the refusal can say why rather
 * than only "unknown role". The implementor is barred because a criterion
 * driven by the agent that built it proves nothing; the solver is barred
 * because it diagnoses and never acts (AC33).
 */
const BARRED_DRIVERS: Record<string, string> = {
  implementor: "the implementor may not drive the criterion it built; a driven criterion needs a driver independent of the implementation",
  solver: "the solver diagnoses and never drives or writes state",
};

export function resolveDriverRole(declared: string | undefined): DriverRole {
  const value = (declared ?? "").trim().toLowerCase();
  if (value === "") throw new TrailRejected("arguments", `trail requires --driver <${DRIVER_ROLES.join("|")}>`);
  const barred = BARRED_DRIVERS[value];
  if (barred !== undefined) {
    throw new TrailRejected("authority", `driver role ${value} is refused: ${barred}. Eligible roles are ${DRIVER_ROLES.join(", ")}. The role is a self-declaration recorded for audit, not an authenticated identity.`);
  }
  const match = DRIVER_ROLES.find((entry) => entry === value);
  if (match === undefined) {
    throw new TrailRejected("arguments", `unknown --driver ${value}; use one of ${DRIVER_ROLES.join(", ")}`);
  }
  return match;
}

// Enumerators a PRD author writes to mark separate things to do: circled
// numerals (used throughout this repository's PRDs), "(1)" and "1)". Keyed on
// structure the author chose, not on how a sentence happens to be phrased -
// a similarity heuristic here would look like a guard and behave like a coin
// flip (AGENTS.md Review Guide 11).
const ENUMERATOR = /[①-⑳]|\((?:\d{1,2})\)|(?:(?<=\s)|^)\d{1,2}\)/gu;

/** The trailing `Covers R1, AC2.` clause is bookkeeping, not a step. */
const COVERS_CLAUSE = /\s*Covers\s+[^.]*\.\s*$/i;

function sentences(text: string): string[] {
  return text
    .replace(COVERS_CLAUSE, "")
    .split(/(?<=[.。])\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Split one sentence at the author's own enumerators, if it has at least two.
 * One marker is a reference ("see ①"), not a list; two or more is a list.
 */
function enumeratedParts(sentence: string): string[] {
  const marks = [...sentence.matchAll(ENUMERATOR)];
  if (marks.length < 2) return [sentence];
  const parts: string[] = [];
  const head = sentence.slice(0, marks[0]!.index).trim();
  if (head !== "") parts.push(head);
  for (const [index, mark] of marks.entries()) {
    const end = index + 1 < marks.length ? marks[index + 1]!.index : sentence.length;
    const part = sentence.slice(mark.index, end).trim();
    if (part !== "") parts.push(part);
  }
  return parts;
}

/**
 * Derive the numbered script from the sealed criterion row (AC30).
 *
 * The whole row is the source: the criterion says what must be true and the
 * evidence declaration says what must be captured, and a driver who does the
 * first without the second has not finished. Steps are numbered in reading
 * order so `S3` means the same thing to everyone holding the same brief.
 */
export function deriveBriefSteps(criterion: AcceptanceCriterionItem): QaBriefStep[] {
  const parts = [
    ...sentences(criterion.text).flatMap(enumeratedParts),
    ...sentences(criterion.evidenceDeclaration ?? "").flatMap(enumeratedParts),
  ];
  if (parts.length === 0) {
    throw new TrailRejected("arguments", `${criterion.id} has no criterion text to derive a script from; the sealed PRD row is empty`);
  }
  return parts.map((text, index) => ({ id: `S${index + 1}`, text }));
}

/**
 * Issue a brief.
 *
 * The id is content-addressed over the criterion, the PRD snapshot, the
 * issue time and the sequence number, so a reissue for the same criterion is
 * necessarily a different id even when the script text is identical (AC30).
 * That is what makes a stale echo detectable rather than indistinguishable.
 */
export function issueQaBrief(
  state: ImplementState,
  criterion: AcceptanceCriterionItem,
  at: string,
): QaBrief {
  if (criterion.judgment !== "judged") {
    throw new TrailRejected("arguments", `${criterion.id} is ${criterion.judgment ?? "untagged"}; qa-brief issues scripts for judged criteria only. A machine criterion is proven by its Check, not by a driver.`);
  }
  const sequence = state.qaBriefs.filter((entry) => entry.criterionId === criterion.id).length + 1;
  const brief: QaBrief = {
    briefId: `${criterion.id}-B${sequence}-${sha256([criterion.id, state.prd.sha256, at, String(sequence)].join("\x00")).slice(0, 12)}`,
    criterionId: criterion.id,
    issuedAt: at,
    prdSha256: state.prd.sha256,
    steps: deriveBriefSteps(criterion),
  };
  state.qaBriefs.push(brief);
  return brief;
}

export function latestBriefFor(state: ImplementState, criterionId: string): QaBrief | null {
  return [...state.qaBriefs].reverse().find((entry) => entry.criterionId === criterionId) ?? null;
}

export interface TrailInput {
  criterionId: string;
  briefId: string;
  driverRole: DriverRole;
  coveredStepIds: string[];
  artifactPaths: string[];
}

/**
 * Register a drive against the brief that authorised it (AC31).
 *
 * Three checks, in the order that gives the most useful refusal first: is
 * this the brief we issued, did the drive cover the script, and is the
 * driver eligible. All three are exact comparisons over ids - the point of
 * D-31 is that nothing here reads prose.
 */
export function registerTrail(
  state: ImplementState,
  input: TrailInput,
  at: string,
): TrailRecord {
  const brief = state.qaBriefs.find((entry) => entry.briefId === input.briefId);
  if (brief === undefined) {
    const latest = latestBriefFor(state, input.criterionId);
    throw new TrailRejected("arguments", `no brief ${input.briefId} was issued for this run; ${latest === null ? `issue one with \`sasu implement qa-brief --ac ${input.criterionId}\`` : `the current brief for ${input.criterionId} is ${latest.briefId}`}. qa-brief is the only briefing channel, so a drive with no brief behind it cannot be registered.`);
  }
  if (brief.criterionId !== input.criterionId) {
    throw new TrailRejected("arguments", `brief ${brief.briefId} was issued for ${brief.criterionId}, not ${input.criterionId}`);
  }
  const current = latestBriefFor(state, input.criterionId)!;
  if (current.briefId !== brief.briefId) {
    throw new TrailRejected("transition", `brief ${brief.briefId} is superseded; ${input.criterionId} was rebriefed as ${current.briefId}. Drive the current script - a trail against an old one proves the old question.`);
  }

  const covered = new Set(input.coveredStepIds.map((id) => id.trim().toUpperCase()).filter((id) => id !== ""));
  const scripted = new Set(brief.steps.map((step) => step.id));
  const unknown = [...covered].filter((id) => !scripted.has(id));
  if (unknown.length > 0) {
    throw new TrailRejected("arguments", `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in brief ${brief.briefId}; it scripts ${[...scripted].join(", ")}`);
  }
  const uncovered = [...scripted].filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    throw new TrailRejected("arguments", `brief ${brief.briefId} has uncovered steps: ${uncovered.map((id) => `${id} (${brief.steps.find((step) => step.id === id)!.text})`).join("; ")}. Cover every scripted step, then register again.`);
  }

  const registered = new Set(state.artifacts.map((entry) => entry.path));
  const missing = input.artifactPaths.filter((entry) => !registered.has(entry));
  if (missing.length > 0) {
    throw new TrailRejected("arguments", `trail names unregistered artifact(s): ${missing.join(", ")}; register the capture with \`sasu implement artifact\` first so the record points at something the run vouches for`);
  }

  // A later accepted trail replaces the earlier one rather than deleting it:
  // the record of what was driven, and against which brief, stays readable.
  const superseded: TrailRecord[] = [];
  for (const entry of state.trails) {
    if (entry.criterionId === input.criterionId && entry.status === "accepted") {
      entry.status = "superseded";
      superseded.push(entry);
    }
  }
  const record: TrailRecord = {
    id: Math.max(0, ...state.trails.map((entry) => entry.id)) + 1,
    at,
    criterionId: input.criterionId,
    briefId: brief.briefId,
    driverRole: input.driverRole,
    coveredStepIds: brief.steps.map((step) => step.id),
    artifactPaths: [...input.artifactPaths],
    status: "accepted",
  };
  state.trails.push(record);
  // AC40: the resubmission itself is the record. A superseded trail is
  // PRESERVED - unlike a replaced artifact it vouches for a drive that really
  // happened, and nothing about the new drive makes the old one untrue.
  for (const earlier of superseded) {
    state.evidenceReplacements.push({
      id: Math.max(0, ...state.evidenceReplacements.map((existing) => existing.id)) + 1,
      at,
      criterionId: input.criterionId,
      kind: "trail",
      previous: `trail ${earlier.id} against brief ${earlier.briefId}, driven by ${earlier.driverRole}`,
      next: `trail ${record.id} against brief ${record.briefId}, driven by ${record.driverRole}`,
      priorDisposition: "preserved",
    });
  }
  return record;
}
