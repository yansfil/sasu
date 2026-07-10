# Task Graph: standard-regression

- PRD: agents/prd/standard-regression/prd.md
- Status: complete
- Generated: <TS>
- Nodes: 9
- Edges: 18
- Open nodes: 0
- Verification blocking gaps: 0

## Nodes

- [x] VP0 (verification_plan) - ready: Generate and resolve verification plan
  - Evidence: 0
  - Artifacts: 0
- [x] EP0 (execution_plan) - ready: Generate execution plan from PRD tasks
  - Evidence: 0
  - Artifacts: 0
- [x] T1 (task_rollup) - complete: Run the local command verification. Covers R1, AC1.
  - Requirements: R1
  - Acceptance Criteria: AC1
  - Evidence: 1
  - Artifacts: 0
- [x] N1 (execution_node) - complete: Run the local command verification. Covers R1, AC1.
  - Source Task: T1
  - Risk: low
  - Parallel Safe: no
  - Covers: R: R1; AC: AC1; V: V1
  - Evidence: 1
  - Artifacts: 0
- [x] AC1 (acceptance_criterion) - met: V1 passes with a command-log artifact.
  - Evidence: 1
  - Artifacts: 0
- [x] V1 (verification) - pass: `node -e "process.exit(0)"`
  - Covers: R: R1; AC: AC1; T: T1
  - Tool: verify-run
  - Required For Done: yes
  - Evidence: 2
  - Artifacts: 1
- [x] REQ_FIDELITY_REVIEW (requirements_fidelity_review) - pass: Requirements fidelity review
  - Evidence: 1
  - Artifacts: 1
- [x] REVIEW (final_review) - pass: Adversarial final review
  - Required For Done: yes
  - Evidence: 1
  - Artifacts: 1
- [x] FINALIZE (receipt) - complete: Final receipt
  - Evidence: 1
  - Artifacts: 1

## Edges

- VP0 -> EP0 (unblocks): execution planning starts after verification planning
- EP0 -> N1 (unblocks): execution node comes from the execution plan
- T1 -> N1 (decomposes_to): PRD task is executed through this implementation node
- N1 -> AC1 (satisfies): execution node covers this acceptance criterion
- N1 -> V1 (verified_by): execution node is proven by this verification item
- VP0 -> V1 (plans): verification check comes from the verification plan
- T1 -> V1 (verified_by): verification covers this task
- AC1 -> V1 (verified_by): verification covers this acceptance criterion
- T1 -> REQ_FIDELITY_REVIEW (requirements_review_input): requirements reviewer must audit this item against original user intent and PRD decisions
- T1 -> REVIEW (review_input): final reviewer must audit this item and its evidence
- N1 -> REQ_FIDELITY_REVIEW (requirements_review_input): requirements reviewer must audit this item against original user intent and PRD decisions
- N1 -> REVIEW (review_input): final reviewer must audit this item and its evidence
- AC1 -> REQ_FIDELITY_REVIEW (requirements_review_input): requirements reviewer must audit this item against original user intent and PRD decisions
- AC1 -> REVIEW (review_input): final reviewer must audit this item and its evidence
- V1 -> REQ_FIDELITY_REVIEW (requirements_review_input): requirements reviewer must audit this item against original user intent and PRD decisions
- V1 -> REVIEW (review_input): final reviewer must audit this item and its evidence
- REQ_FIDELITY_REVIEW -> REVIEW (review_input): final reviewer must audit the requirements fidelity verdict
- REVIEW -> FINALIZE (gates): receipt can be written only after passing final review
