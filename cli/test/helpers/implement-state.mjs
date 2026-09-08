export const AT = "2026-09-08T00:00:00.000Z";
export const SHA = "a".repeat(64);
export function stateFixture(root = "/tmp/fixture", overrides = {}) {
  return {
    schema: "sasu.implement.state.v9", status: "active", topicSlug: "fixture",
    projectRoot: root, worktree: null, runDir: "agents/runs/fixture", prdPath: "agents/prd/fixture/prd.md",
    prd: { sha256: SHA, snapshotPath: "agents/runs/fixture/prd.md", status: "ready", approval: { source: "frontmatter", evidence: "TEST-FIXTURE-APPROVAL" }, reviewProfile: "standard", reviewRationale: "fixture", sourceIntake: "current conversation" },
    initialSource: { head: null, digest: SHA, entries: [] },
    baselineAttribution: { disposition: "clean", paths: [], baselineDigest: SHA, head: null },
    requirements: [{ id: "B1", behavior: "The public command preserves its input.", decisionIds: [] }],
    artifacts: [], verificationAttempts: [], findings: [], riskFindings: [], deviations: [], events: [], verbs: [], amendments: [], evidenceReplacements: [],
    suite: { sealedAt: AT, commands: [], exclusions: [], results: [] },
    escalations: [], retirement: null, completion: null, createdAt: AT, updatedAt: AT,
    ...overrides,
  };
}
export function attemptFixture(overrides = {}) {
  return {
    id: "V1", inputFingerprint: SHA, sourceFingerprint: SHA,
    inputManifest: { source: [], evidence: [] },
    roundContext: { priorAttemptId: null, changedPaths: [], newEvidence: [] },
    intentInput: { routing: "decisions", contentSha256: SHA },
    startedAt: AT, finishedAt: AT, durationMs: 0, phase: "preflight", verdict: "NOT_RUN",
    prelint: { ok: true, findings: [] }, mechanical: [], review: null, risk: null, error: null,
    ...overrides,
  };
}
export function humanFinding(overrides = {}) {
  return { id: "F1", kind: "human-confirmation", requirementRefs: [], problem: "Confirm the visual result.", evidenceRefs: ["Risks"], nextAction: "Human confirms the visual result.", originAttemptId: "V1", status: "open", history: [], responses: [], human: { sourceRef: "Risks", quote: "The person confirms the visual result after implementation.", timing: "post-completion" }, ...overrides };
}
