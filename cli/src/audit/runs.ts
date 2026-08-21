import fs from "node:fs";
import path from "node:path";
import type { SasuConfig } from "../config";
import { prelintQaLog } from "../gates/prelint";
import { gateStatus, type GateId, type GatesState } from "../gates/store";
import { implementStatePathFor } from "../runs/paths";

/**
 * Read-only run auditor (`sasu audit runs`): replays the forensics of
 * 2026-08-20 - three $please runs burned 58-68 minutes each in the PRD gates
 * before anyone noticed, and every symptom was sitting machine-readable in
 * gates.json the whole time - as a periodic sweep a Claude loop can drive.
 *
 * Contract with the loop that runs it (L1, report-only):
 * - Every rule is a deterministic read of recorded state; no judge calls, no
 *   writes outside the ledger. The command NEVER edits a run.
 * - Each finding carries the PRINCIPLES item it leans on and a
 *   classification: `mechanical-fix-candidate` (a failing test could pin it),
 *   `design-question` (needs a human decision), or `info` (worth seeing,
 *   nothing to fix).
 * - The ledger (agents/runs/.audit/ledger.json) is the close-criteria spine:
 *   a fingerprint is reported ONCE and then only tracked, so the loop cannot
 *   re-litigate what it already surfaced (PRINCIPLES item 13 - this loop must
 *   itself converge). Fingerprints key on structure (slug, gate, rule), never
 *   on message phrasing (item 11).
 */

export type AuditClassification = "mechanical-fix-candidate" | "design-question" | "info";

export interface AuditFinding {
  /** Structure-keyed identity: `<slug>:<gate|->:<rule>`. */
  fingerprint: string;
  rule: string;
  slug: string;
  gate: GateId | null;
  classification: AuditClassification;
  /** PRINCIPLES item numbers this finding leans on. */
  principles: number[];
  summary: string;
  /** Concrete numbers/quotes backing the summary - a report is not evidence without them (item 1). */
  evidence: Record<string, unknown>;
  /** True when the ledger had already reported this fingerprint before this sweep. */
  seen: boolean;
}

export interface AuditResult {
  projectRoot: string;
  scannedSlugs: string[];
  findings: AuditFinding[];
  newFindings: number;
  ledgerPath: string;
}

interface LedgerEntry {
  rule: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** L1 lifecycle: reported. Stage 2 (auto-PR) extends this with pr-opened/closed/wontfix. */
  status: "reported";
}

interface Ledger {
  schema: 1;
  findings: Record<string, LedgerEntry>;
}

const LEDGER_REL = path.join("agents", "runs", ".audit", "ledger.json");

function loadLedger(projectRoot: string): Ledger {
  const file = path.join(projectRoot, LEDGER_REL);
  if (!fs.existsSync(file)) return { schema: 1, findings: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
    return parsed && parsed.schema === 1 && parsed.findings ? parsed : { schema: 1, findings: {} };
  } catch {
    // A corrupt ledger only costs re-reporting, never a false silence.
    return { schema: 1, findings: {} };
  }
}

function saveLedger(projectRoot: string, ledger: Ledger): void {
  const file = path.join(projectRoot, LEDGER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Enumerate slugs with a recorded gates.json, unified layout plus legacy. */
function slugsWithGates(projectRoot: string): { slug: string; gatesFile: string }[] {
  const out: { slug: string; gatesFile: string }[] = [];
  const seen = new Set<string>();
  for (const base of [path.join(projectRoot, "agents", "runs"), path.join(projectRoot, "agents", "gates")]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      if (entry.startsWith(".") || seen.has(entry)) continue;
      const unified = path.join(base, entry, "gates", "gates.json");
      const legacy = path.join(base, entry, "gates.json");
      const file = fs.existsSync(unified) ? unified : fs.existsSync(legacy) ? legacy : null;
      if (file) {
        seen.add(entry);
        out.push({ slug: entry, gatesFile: file });
      }
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Milliseconds past which a single judge call is an outlier worth seeing (max observed healthy call: 394s). */
const SLOW_JUDGE_MS = 300_000;

interface ImplementStateSlice {
  status?: string;
  prd?: { approval?: { source?: string; evidence?: string } };
}

export function auditProject(projectRoot: string, config: SasuConfig): Omit<AuditResult, "ledgerPath" | "newFindings"> {
  const budget = config.judge.retryBudget;
  const findings: AuditFinding[] = [];
  const slugs = slugsWithGates(projectRoot);

  for (const { slug, gatesFile } of slugs) {
    const state = readJson<GatesState>(gatesFile);
    if (!state) continue;
    const implementState = readJson<ImplementStateSlice>(implementStatePathFor(projectRoot, slug));
    const delegated = implementState?.prd?.approval?.source === "conversation";

    const add = (
      rule: string,
      gate: GateId | null,
      classification: AuditClassification,
      principles: number[],
      summary: string,
      evidence: Record<string, unknown>,
    ) => {
      findings.push({ fingerprint: `${slug}:${gate ?? "-"}:${rule}`, rule, slug, gate, classification, principles, summary, evidence, seen: false });
    };

    for (const gate of ["gap-audit", "spec", "verify"] as GateId[]) {
      const record = state.gates?.[gate];
      if (!record || record.verdict === null) continue;
      const view = gateStatus(state, gate, budget, projectRoot);
      const history = record.history ?? [];
      const nonPass = Number.isInteger(record.totalNonPassAttempts)
        ? (record.totalNonPassAttempts as number)
        : history.filter((h) => h.verdict !== "PASS").length;

      // Rule: excessive-rounds. The fix budget bounds CONSECUTIVE failures;
      // total failed rounds past the budget means the loop converged only by
      // grinding (2026-08-20: 10-11 failed rounds per run went unnoticed).
      if (nonPass > budget) {
        add("excessive-rounds", gate, "design-question", [2, 13], `${gate} accumulated ${nonPass} judged non-PASS rounds (fix budget ${budget})`, {
          nonPassRounds: nonPass,
          budget,
          historyVerdicts: history.map((h) => h.verdict),
        });
      }

      // Rule: post-pass-reblock. A PASS followed by 2+ non-PASS rounds is the
      // PASS->cross-gate-fix->STALE->re-judge ping-pong shape.
      const firstPass = history.findIndex((h) => h.verdict === "PASS");
      const reblocks = firstPass === -1 ? 0 : history.slice(firstPass + 1).filter((h) => h.verdict !== "PASS").length;
      if (reblocks >= 2) {
        add("post-pass-reblock", gate, "design-question", [5, 13], `${gate} re-blocked ${reblocks} times after its first PASS (staleness ping-pong)`, {
          reblocks,
          historyVerdicts: history.map((h) => h.verdict),
        });
      }

      // Rule: budget-grant-used. Every grant is a human unblocking the
      // autonomous loop - the loop's own bound fired mid-run.
      if ((record.budgetGrants?.length ?? 0) > 0) {
        add("budget-grant-used", gate, "info", [13], `${gate} needed ${record.budgetGrants!.length} user budget grant(s) mid-run`, {
          grants: record.budgetGrants!.map((g) => ({ at: g.at, evidence: g.evidence })),
        });
      }

      // Rule: stalled-at-terminal-cause. A gate parked at a terminal gauge
      // with the run not finalized is work silently waiting on a human.
      if ((view.budgetExhausted || view.judgeErrorLoop || view.cycleExhausted) && implementState?.status !== "complete" && implementState?.status !== "blocked") {
        add("stalled-at-terminal-cause", gate, "info", [10], `${gate} sits at a terminal cause (${view.budgetExhausted ? "budget" : view.judgeErrorLoop ? "judge-error" : "cycle"}) and the run is not finalized`, {
          attempts: view.attempts,
          budget: view.budget,
          roundsSinceGrant: view.roundsSinceGrant,
        });
      }

      // Rule: delegation-not-recorded. The run's PRD approval says
      // "conversation" (a delegated $please run) but the gate state carries
      // no delegation and no assumption ledger: the exact omission that cost
      // 4+ blocked rounds per run on 2026-08-20.
      if (gate === "gap-audit" && delegated && state.delegation === undefined && (record.humanAssumptions?.length ?? 0) === 0 && nonPass > 0) {
        add("delegation-not-recorded", gate, "mechanical-fix-candidate", [7], `delegated run (PRD approval source: conversation) but no gate delegation was recorded and no findings were assumed`, {
          approvalEvidence: implementState?.prd?.approval?.evidence ?? null,
          nonPassRounds: nonPass,
        });
      }
    }

    // Rule: citation-advisories-on-passed-doc. Our own advisory rules firing
    // on a document whose gap-audit PASSed are false-positive telemetry for
    // the advisories themselves - the auditor watches the harness too.
    const gapRecord = state.gates?.["gap-audit"];
    if (gapRecord?.verdict === "PASS" && gapRecord.inputs?.length) {
      const qaPath = path.join(projectRoot, gapRecord.inputs[0]!.path);
      if (fs.existsSync(qaPath)) {
        const lint = prelintQaLog(fs.readFileSync(qaPath, "utf8"));
        const rules = (lint.warnings ?? []).map((w) => w.rule);
        if (rules.length > 0) {
          add("citation-advisories-on-passed-doc", "gap-audit", "info", [11], `qa-log of a PASSed gap-audit carries ${rules.length} citation advisories (advisory false-positive telemetry)`, {
            qaLog: gapRecord.inputs[0]!.path,
            rules,
          });
        }
      }
    }

    // Rule: slow-judge-calls. Wall-clock outliers among recorded judge calls.
    const slow = (state.judgeCalls ?? []).filter((c) => (c.durationMs ?? 0) > SLOW_JUDGE_MS);
    if (slow.length > 0) {
      const max = Math.max(...slow.map((c) => c.durationMs ?? 0));
      add("slow-judge-calls", null, "info", [9], `${slow.length} judge call(s) exceeded ${SLOW_JUDGE_MS / 1000}s (max ${Math.round(max / 1000)}s)`, {
        count: slow.length,
        maxMs: max,
        purposes: slow.map((c) => c.purpose),
      });
    }
  }

  return { projectRoot, scannedSlugs: slugs.map((s) => s.slug), findings };
}

export function runAudit(projectRoot: string, config: SasuConfig, options: { includeSeen?: boolean } = {}): AuditResult {
  const scanned = auditProject(projectRoot, config);
  const ledger = loadLedger(projectRoot);
  const now = new Date().toISOString();
  let newFindings = 0;
  for (const finding of scanned.findings) {
    const existing = ledger.findings[finding.fingerprint];
    if (existing) {
      finding.seen = true;
      existing.lastSeenAt = now;
    } else {
      newFindings += 1;
      ledger.findings[finding.fingerprint] = { rule: finding.rule, firstSeenAt: now, lastSeenAt: now, status: "reported" };
    }
  }
  saveLedger(projectRoot, ledger);
  const findings = options.includeSeen ? scanned.findings : scanned.findings.filter((f) => !f.seen);
  return { ...scanned, findings, newFindings, ledgerPath: path.join(projectRoot, LEDGER_REL) };
}
