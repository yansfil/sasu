import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgent, type HerdrEnvironment } from "../implement/herdr";
import { requireWorkRoot, snapshotExcluded } from "../implement/store";
import type { ImplementState, SupervisionRecord } from "../implement/types";
import type { WorkObservation } from "./decide";
import { runFacts } from "./facts";

/**
 * Deterministic facts about a run since its dispatch (D-11, B16). No
 * judgment words: the Observer reads these from a distance and decides
 * "fine", "one line of direction" or "stop" itself. The same input yields
 * the same output; only `generatedAt` moves, and every duration is derived
 * from it at render time so the JSON stays comparable across two reads.
 */
export interface RunDigest {
  slug: string;
  runInstanceId: string;
  /** Which loop replaces a vanished Observer (D-15); the supervisor only wakes the recorded one. */
  recoveryOwner: "supervisor" | "task-factory";
  generatedAt: string;
  dispatchedAt: string;
  dispatchHead: string | null;
  workRoot: string;
  implementor: {
    agent: string;
    paneId: string;
    sessionId: string;
    terminalId: string;
    hostScope: string;
    /** herdr's lifecycle state, or the reason it could not be read. */
    status: string;
    activityAt: string | null;
  };
  git: {
    available: boolean;
    problem: string | null;
    head: string | null;
    commitsSinceDispatch: number;
    recentCommits: Array<{ sha: string; at: string; subject: string }>;
    changedFiles: number;
    added: number;
    deleted: number;
    /** Highest added+deleted first; ties by path. */
    churn: Array<{ path: string; added: number; deleted: number }>;
    /** Changed paths the delivery boundary excludes (the agents/ namespace and anything escaping the tree). */
    outsideBoundary: string[];
    uncommitted: { files: number; newestChangeAt: string | null };
  };
  verify: {
    attempts: number;
    latestVerdict: string | null;
    latestAt: string | null;
    /** Suite commands RED in each of the last two attempts. */
    repeatedlyFailing: string[];
    reportStatus: string | null;
  };
  events: { count: number; lastAt: string | null; lastKind: string | null; sinceDispatch: number };
}

const RECENT_COMMITS = 10;
const CHURN_ROWS = 10;

function git(cwd: string, args: string[], timeoutMs = 15_000): { ok: boolean; stdout: string; detail: string } {
  const executed = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (executed.error !== undefined) return { ok: false, stdout: "", detail: String(executed.error) };
  return { ok: executed.status === 0, stdout: executed.stdout ?? "", detail: (executed.stderr ?? "").trim() || `git ${args[0]} exited ${executed.status ?? "without status"}` };
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/** Paths `git status --porcelain=v1 -z` reports, and which of them are untracked; a rename or copy carries its source as the next token. */
function statusPaths(stdout: string): { dirty: string[]; untracked: string[] } {
  const dirty: string[] = [];
  const untracked: string[] = [];
  const tokens = stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    dirty.push(token.slice(3));
    if (token.startsWith("??")) untracked.push(token.slice(3));
    if (/[RC]/.test(token.slice(0, 2))) index += 1;
  }
  return { dirty, untracked };
}

/** Modification times of the paths still on disk; a deleted path has none, and its deletion still counts as a change. */
function modificationTimes(workRoot: string, relatives: string[]): number[] {
  const times: number[] = [];
  for (const relative of relatives) {
    try { times.push(fs.statSync(path.join(workRoot, relative)).mtimeMs); } catch { /* deleted */ }
  }
  return times;
}

const newestOf = (times: number[]): number | null => times.reduce<number | null>((newest, time) => newest === null || time > newest ? time : newest, null);

/** Changed paths the delivery boundary excludes: the agents/ namespace and anything escaping the tree. */
function outsideDeliveryBoundary(paths: string[]): string[] {
  return paths.filter((relative) => snapshotExcluded(relative) || relative.startsWith("../") || path.isAbsolute(relative)).sort();
}

function gitFacts(workRoot: string, dispatchHead: string | null): RunDigest["git"] {
  const empty: RunDigest["git"] = { available: false, problem: null, head: null, commitsSinceDispatch: 0, recentCommits: [], changedFiles: 0, added: 0, deleted: 0, churn: [], outsideBoundary: [], uncommitted: { files: 0, newestChangeAt: null } };
  const head = git(workRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { ...empty, problem: `git unavailable in ${workRoot}: ${head.detail}` };
  const base = dispatchHead ?? head.stdout.trim();
  const log = git(workRoot, ["log", "--format=%H%x00%cI%x00%s", `${base}..HEAD`]);
  if (!log.ok) return { ...empty, head: head.stdout.trim(), problem: `git log ${base}..HEAD failed: ${log.detail}` };
  const commits = log.stdout.split("\n").filter(Boolean).map((line) => { const [sha, at, subject] = line.split("\0"); return { sha: sha ?? "", at: at ?? "", subject: subject ?? "" }; });
  const numstat = git(workRoot, ["diff", "--numstat", "-z", base]);
  if (!numstat.ok) return { ...empty, head: head.stdout.trim(), problem: `git diff --numstat ${base} failed: ${numstat.detail}` };
  const churn: Array<{ path: string; added: number; deleted: number }> = [];
  // -z numstat: "added\tdeleted\tpath\0", with renames as "added\tdeleted\t\0old\0new\0".
  const tokens = numstat.stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "") continue;
    const [addedText, deletedText, inline] = token.split("\t");
    let file = inline ?? "";
    if (file === "") { index += 2; file = tokens[index] ?? ""; }
    if (file === "") continue;
    churn.push({ path: file, added: addedText === "-" ? 0 : Number(addedText), deleted: deletedText === "-" ? 0 : Number(deletedText) });
  }
  const status = git(workRoot, STATUS_ARGS);
  if (!status.ok) return { ...empty, head: head.stdout.trim(), problem: `git status failed: ${status.detail}` };
  const { dirty, untracked } = statusPaths(status.stdout);
  for (const relative of untracked) {
    if (churn.some((entry) => entry.path === relative)) continue;
    let lines = 0;
    try { lines = fs.readFileSync(path.join(workRoot, relative), "utf8").split("\n").length - 1; } catch { lines = 0; }
    churn.push({ path: relative, added: lines, deleted: 0 });
  }
  churn.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted) || a.path.localeCompare(b.path));
  const newest = newestOf(modificationTimes(workRoot, dirty));
  return {
    available: true,
    problem: null,
    head: head.stdout.trim(),
    commitsSinceDispatch: commits.length,
    recentCommits: commits.slice(0, RECENT_COMMITS),
    changedFiles: churn.length,
    added: churn.reduce((sum, entry) => sum + entry.added, 0),
    deleted: churn.reduce((sum, entry) => sum + entry.deleted, 0),
    churn: churn.slice(0, CHURN_ROWS),
    outsideBoundary: outsideDeliveryBoundary(churn.map((entry) => entry.path)),
    uncommitted: { files: dirty.length, newestChangeAt: newest === null ? null : new Date(Math.round(newest)).toISOString() },
  };
}

/**
 * The slice of `gitFacts` the tick decides on, read on every tick for every
 * active run: the head, commits since dispatch, paths outside the delivery
 * boundary and uncommitted changes, from the same git calls and helpers the
 * digest uses so a wake and the digest the Observer then reads agree. It
 * leaves out what only the digest shows (the commit log, per-file line
 * counts) because the tick would pay for them every 30 seconds.
 *
 * All four calls share one budget, so one slow repository cannot hold the
 * tick past its deadline; running out is an unavailable read, never a guess.
 */
export function readWork(state: ImplementState, dispatchHead: string | null, budgetMs: number): WorkObservation {
  let workRoot: string;
  try { workRoot = requireWorkRoot(state); } catch (error) { return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) }; }
  const started = Date.now();
  const call = (args: string[]) => git(workRoot, args, Math.max(1, budgetMs - (Date.now() - started)));
  const head = call(["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return { kind: "unavailable", detail: `git unavailable in ${workRoot}: ${head.detail}` };
  const sha = head.stdout.trim();
  // Without a recorded dispatch head the digest measures from HEAD, so
  // nothing counts as committed since dispatch; the tick agrees with it.
  const base = dispatchHead ?? sha;
  const counted = call(["rev-list", "--count", `${base}..HEAD`]);
  const commits = Number(counted.stdout.trim());
  if (!counted.ok || !Number.isInteger(commits)) return { kind: "unavailable", detail: `git rev-list --count ${base}..HEAD failed in ${workRoot}: ${counted.ok ? `unreadable count ${counted.stdout.trim()}` : counted.detail}` };
  const changed = call(["diff", "--name-only", "-z", base]);
  if (!changed.ok) return { kind: "unavailable", detail: `git diff --name-only ${base} failed in ${workRoot}: ${changed.detail}` };
  const status = call(STATUS_ARGS);
  if (!status.ok) return { kind: "unavailable", detail: `git status failed in ${workRoot}: ${status.detail}` };
  const { dirty, untracked } = statusPaths(status.stdout);
  const outside = outsideDeliveryBoundary([...new Set([...changed.stdout.split("\0").filter((entry) => entry !== ""), ...untracked])]);
  const outsideTimes = modificationTimes(workRoot, outside);
  const dirtyTimes = modificationTimes(workRoot, dirty);
  return {
    kind: "read",
    head: sha,
    commitsSinceDispatch: commits,
    outsideBoundary: outside,
    outsideSince: outsideTimes.reduce<number | null>((oldest, time) => oldest === null || time < oldest ? time : oldest, null),
    uncommittedFiles: dirty.length,
    newestChangeAt: newestOf(dirtyTimes),
  };
}

function verifyFacts(state: ImplementState, dispatchedAt: string): RunDigest["verify"] {
  const boundary = Date.parse(dispatchedAt);
  const attempts = state.verificationAttempts.filter((attempt) => Date.parse(attempt.finishedAt) >= boundary);
  const latest = attempts.at(-1) ?? null;
  const lastTwo = attempts.slice(-2);
  const repeatedlyFailing = lastTwo.length < 2 ? [] : state.suite.commands
    .filter((command) => lastTwo.every((attempt) => attempt.mechanical.some((run) => run.command === command.command && run.cwd === command.cwd && run.status === "FAIL")))
    .map((command) => `${command.id} ${command.command}`);
  return {
    attempts: attempts.length,
    latestVerdict: latest?.verdict ?? null,
    latestAt: latest?.finishedAt ?? null,
    repeatedlyFailing,
    reportStatus: state.verificationReport !== null && Date.parse(state.verificationReport.generatedAt) >= boundary ? state.verificationReport.status : null,
  };
}

function scopedHerdr(environment: HerdrEnvironment, hostScope: string): HerdrEnvironment {
  if (environment.run !== undefined) return environment;
  const env = { ...(environment.env ?? process.env) };
  if (hostScope === "default") delete env["HERDR_SOCKET_PATH"];
  else env["HERDR_SOCKET_PATH"] = hostScope;
  return { ...environment, env };
}

export function buildDigest(state: ImplementState, supervision: SupervisionRecord, options: { herdr?: HerdrEnvironment; now?: () => number } = {}): RunDigest {
  const facts = runFacts(state, supervision);
  const now = options.now ?? (() => Date.now());
  const workRoot = requireWorkRoot(state);
  const looked = getAgent(supervision.implementor.paneId, scopedHerdr(options.herdr ?? {}, supervision.implementor.hostScope));
  const implementor = looked.kind === "found"
    ? { status: looked.agent.paneId !== supervision.implementor.paneId
      || looked.agent.name !== supervision.implementor.agent
      || looked.agent.sessionId !== supervision.implementor.sessionId
      || looked.agent.terminalId !== supervision.implementor.terminalId
      ? `identity mismatch: found ${looked.agent.name ?? "unnamed"} session ${looked.agent.sessionId ?? "missing"} terminal ${looked.agent.terminalId ?? "missing"} in ${looked.agent.paneId}`
      : looked.agent.status, activityAt: looked.agent.activityAt === null ? null : new Date(looked.agent.activityAt).toISOString() }
    : { status: looked.kind === "absent" ? "gone: no agent in the pane" : `unavailable: ${looked.detail}`, activityAt: null };
  const events = state.events.filter((event) => Date.parse(event.at) >= facts.dispatchedAt);
  return {
    slug: state.topicSlug,
    runInstanceId: supervision.runInstanceId,
    recoveryOwner: supervision.recoveryOwner,
    generatedAt: new Date(now()).toISOString(),
    dispatchedAt: supervision.dispatchedAt,
    dispatchHead: supervision.dispatchHead,
    workRoot,
    implementor: { agent: supervision.implementor.agent, paneId: supervision.implementor.paneId, sessionId: supervision.implementor.sessionId, terminalId: supervision.implementor.terminalId, hostScope: supervision.implementor.hostScope, ...implementor },
    git: gitFacts(workRoot, supervision.dispatchHead),
    verify: verifyFacts(state, supervision.dispatchedAt),
    events: { count: state.events.length, lastAt: state.events.at(-1)?.at ?? null, lastKind: state.events.at(-1)?.kind ?? null, sinceDispatch: events.length },
  };
}

function ago(from: string | null, now: number): string {
  if (from === null) return "never";
  const ms = now - Date.parse(from);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** The text form: one fact per line, durations relative to generatedAt. */
export function renderDigest(digest: RunDigest): string[] {
  const now = Date.parse(digest.generatedAt);
  const lines = [
    `${digest.slug} instance ${digest.runInstanceId}: dispatched ${ago(digest.dispatchedAt, now)} (${digest.dispatchedAt}), head at dispatch ${digest.dispatchHead ?? "unavailable"}; recovery owner ${digest.recoveryOwner}`,
    `Implementor ${digest.implementor.agent} in ${digest.implementor.paneId} on ${digest.implementor.hostScope}, session ${digest.implementor.sessionId}, terminal ${digest.implementor.terminalId}: ${digest.implementor.status}; last herdr activity ${ago(digest.implementor.activityAt, now)}`,
  ];
  if (!digest.git.available) lines.push(`Git: ${digest.git.problem}`);
  else {
    lines.push(`Commits since dispatch: ${digest.git.commitsSinceDispatch}${digest.git.recentCommits.length === 0 ? "" : `; recent: ${digest.git.recentCommits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`).join(" | ")}`}`);
    lines.push(`Changed since dispatch: ${digest.git.changedFiles} file(s), +${digest.git.added} -${digest.git.deleted}; outside delivery boundary: ${digest.git.outsideBoundary.length}${digest.git.outsideBoundary.length === 0 ? "" : ` (${digest.git.outsideBoundary.join(", ")})`}`);
    for (const entry of digest.git.churn) lines.push(`  ${entry.path} +${entry.added} -${entry.deleted}`);
    lines.push(`Uncommitted: ${digest.git.uncommitted.files} path(s); newest change ${ago(digest.git.uncommitted.newestChangeAt, now)}`);
  }
  lines.push(`Verify: ${digest.verify.attempts} attempt(s); latest ${digest.verify.latestVerdict ?? "none"} ${ago(digest.verify.latestAt, now)}; report ${digest.verify.reportStatus ?? "none"}; repeatedly failing: ${digest.verify.repeatedlyFailing.length === 0 ? "none" : digest.verify.repeatedlyFailing.join(", ")}`);
  lines.push(`Events: ${digest.events.sinceDispatch} since dispatch; last ${digest.events.lastKind ?? "none"} ${ago(digest.events.lastAt, now)}`);
  return lines;
}
