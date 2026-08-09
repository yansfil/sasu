// Quick-contract grammar: the evidence lane is executable declaration, so a
// parse drift silently changes what the harness runs and hashes. Every field
// shape and every rejection is pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import { parseContract, EVIDENCE_MAX_BYTES } from "../../dist/gates/contract.js";

const FULL = `---
topic: demo
status: active
---

## Goal

Ship it.

## Checks

- \`npm test\`
- \`bash -c "curl -sf localhost:3000/health"\`

## Acceptance Criteria

- AC1. the widget renders
- AC2. the API answers
  - evidence: agents/quick/demo/evidence/api.json
- AC3. dark mode looks right
  - capture: \`node scripts/shot.js out/dark.png\` -> out/dark.png
- AC4. matches the printed mock
  - human: compare against the mock the user attached
`;

test("parses checks, criteria, and every evidence field", () => {
  const parsed = parseContract(FULL);
  assert.deepEqual(parsed.defects, []);
  assert.deepEqual(parsed.checks.map((c) => c.command), ["npm test", 'bash -c "curl -sf localhost:3000/health"']);
  assert.deepEqual(parsed.criteria.map((c) => c.id), ["AC1", "AC2", "AC3", "AC4"]);

  const [ac1, ac2, ac3, ac4] = parsed.criteria;
  assert.equal(ac1.text, "the widget renders");
  assert.deepEqual(ac1.evidence, []);
  assert.deepEqual(ac2.evidence.map((e) => e.path), ["agents/quick/demo/evidence/api.json"]);
  assert.deepEqual(ac3.captures.map((c) => [c.command, c.path]), [["node scripts/shot.js out/dark.png", "out/dark.png"]]);
  assert.equal(ac4.human, "compare against the mock the user attached");
});

test("an arrow variant and multiple artifacts per criterion parse", () => {
  const parsed = parseContract(`---
topic: demo
status: active
---

## Acceptance Criteria

- AC1. two proofs
  - evidence: logs/a.txt
  - evidence: logs/b.txt
  - capture: \`shot\` → out/x.png
`);
  assert.deepEqual(parsed.defects, []);
  assert.deepEqual(parsed.criteria[0].evidence.map((e) => e.path), ["logs/a.txt", "logs/b.txt"]);
  assert.equal(parsed.criteria[0].captures[0].path, "out/x.png");
});

const DEFECT_CASES = [
  ["unbackticked check", "## Checks\n\n- npm test\n\n## Acceptance Criteria\n\n- AC1. x\n", "contract-check-format"],
  ["capture without artifact path", "## Acceptance Criteria\n\n- AC1. x\n  - capture: `shot`\n", "contract-capture-format"],
  ["unknown subfield", "## Acceptance Criteria\n\n- AC1. x\n  - proof: something\n", "contract-unknown-subfield"],
  ["orphan subfield", "## Acceptance Criteria\n\n  - evidence: a.txt\n- AC1. x\n", "contract-orphan-subfield"],
  ["empty evidence path", "## Acceptance Criteria\n\n- AC1. x\n  - evidence:\n", "contract-evidence-empty"],
  ["empty human reason", "## Acceptance Criteria\n\n- AC1. x\n  - human:\n", "contract-human-empty"],
  ["absolute evidence path", "## Acceptance Criteria\n\n- AC1. x\n  - evidence: /etc/passwd\n", "contract-evidence-path"],
  ["escaping evidence path", "## Acceptance Criteria\n\n- AC1. x\n  - evidence: ../../secrets.txt\n", "contract-evidence-path"],
  ["escaping capture artifact", "## Acceptance Criteria\n\n- AC1. x\n  - capture: `shot` -> ../out.png\n", "contract-capture-path"],
  ["human mixed with machine evidence", "## Acceptance Criteria\n\n- AC1. x\n  - human: eyeball it\n  - evidence: a.txt\n", "contract-human-conflict"],
];

for (const [label, body, rule] of DEFECT_CASES) {
  test(`rejects ${label}`, () => {
    const parsed = parseContract(`---\ntopic: demo\nstatus: active\n---\n\n${body}`);
    assert.deepEqual([...new Set(parsed.defects.map((d) => d.rule))], [rule], JSON.stringify(parsed.defects, null, 2));
  });
}

test("a rejected path is never handed to the harness", () => {
  const parsed = parseContract(`---\ntopic: demo\nstatus: active\n---\n\n## Acceptance Criteria\n\n- AC1. x\n  - evidence: ../../secrets.txt\n`);
  assert.deepEqual(parsed.criteria[0].evidence, [], "an escaping path must not survive parsing as usable evidence");
});

test("the inline evidence budget is a real cap, not advisory", () => {
  assert.equal(typeof EVIDENCE_MAX_BYTES, "number");
  assert.ok(EVIDENCE_MAX_BYTES > 0 && EVIDENCE_MAX_BYTES <= 128 * 1024);
});
