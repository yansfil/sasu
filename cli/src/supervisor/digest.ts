import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgent, type HerdrEnvironment } from "../implement/herdr";
import { requireWorkRoot, snapshotExcluded } from "../implement/store";
import type { ImplementState, SupervisionRecord } from "../implement/types";
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
  generatedAt: string;
  dispatchedAt: string;
  dispatchHead: string | null;
  workRoot: string;
  implementor: {
    agent: string;
    paneId: string;
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

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; detail: string } {
  const executed = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  if (executed.error !== undefined) return { ok: false, stdout: "", detail: String(executed.error) };
  return { ok: executed.status === 0, stdout: executed.stdout ?? "", detail: (executed.stderr ?? "").trim() || `git ${args[0]} exited ${executed.status ?? "without status"}` };
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
  const status = git(workRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return { ...empty, head: head.stdout.trim(), problem: `git status failed: ${status.detail}` };
  const dirty: string[] = [];
  const statusTokens = status.stdout.split("\0").filter((token) => token !== "");
  for (let index = 0; index < statusTokens.length; index += 1) {
    const token = statusTokens[index]!;
    dirty.push(token.slice(3));
    if (/[RC]/.test(token.slice(0, 2))) index += 1;
    if (token.startsWith("??") && !churn.some((entry) => entry.path === token.slice(3))) {
      let lines = 0;
      try { lines = fs.readFileSync(path.join(workRoot, token.slice(3)), "utf8").split("\n").length - 1; } catch { lines = 0; }
      churn.push({ path: token.slice(3), added: lines, deleted: 0 });
    }
  }
  churn.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted) || a.path.localeCompare(b.path));
  let newest: number | null = null;
  for (const relative of dirty) {
    try {
      const mtime = fs.statSync(path.join(workRoot, relative)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // A deleted path has no mtime; the deletion still counts as a change.
    }
  }
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
    outsideBoundary: churn.map((entry) => entry.path).filter((relative) => snapshotExcluded(relative) || relative.startsWith("../") || path.isAbsolute(relative)).sort(),
    uncommitted: { files: dirty.length, newestChangeAt: newest === null ? null : new Date(Math.round(newest)).toISOString() },
  };
}

function verifyFacts(state: ImplementState): RunDigest["verify"] {
  const attempts = state.verificationAttempts;
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
    reportStatus: state.verificationReport?.status ?? null,
  };
}

export function buildDigest(state: ImplementState, supervision: SupervisionRecord, options: { herdr?: HerdrEnvironment; now?: () => number } = {}): RunDigest {
  const facts = runFacts(state, supervision);
  const now = options.now ?? (() => Date.now());
  const workRoot = requireWorkRoot(state);
  const looked = getAgent(supervision.implementor.paneId, options.herdr ?? {});
  const implementor = looked.kind === "found"
    ? { status: looked.agent.name !== null && looked.agent.name !== supervision.implementor.agent ? `pane holds ${looked.agent.name}, not ${supervision.implementor.agent}` : looked.agent.status, activityAt: looked.agent.activityAt === null ? null : new Date(looked.agent.activityAt).toISOString() }
    : { status: looked.kind === "absent" ? "gone: no agent in the pane" : `unavailable: ${looked.detail}`, activityAt: null };
  const events = state.events.filter((event) => Date.parse(event.at) >= facts.dispatchedAt);
  return {
    slug: state.topicSlug,
    runInstanceId: supervision.runInstanceId,
    generatedAt: new Date(now()).toISOString(),
    dispatchedAt: supervision.dispatchedAt,
    dispatchHead: supervision.dispatchHead,
    workRoot,
    implementor: { agent: supervision.implementor.agent, paneId: supervision.implementor.paneId, ...implementor },
    git: gitFacts(workRoot, supervision.dispatchHead),
    verify: verifyFacts(state),
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
    `${digest.slug} instance ${digest.runInstanceId}: dispatched ${ago(digest.dispatchedAt, now)} (${digest.dispatchedAt}), head at dispatch ${digest.dispatchHead ?? "unavailable"}`,
    `Implementor ${digest.implementor.agent} in ${digest.implementor.paneId}: ${digest.implementor.status}; last herdr activity ${ago(digest.implementor.activityAt, now)}`,
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
