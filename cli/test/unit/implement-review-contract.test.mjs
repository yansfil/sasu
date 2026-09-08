import assert from 'node:assert/strict';
import test from 'node:test';
import { validateImplementationReviewResult } from '../../dist/implement/review-contract.js';

const behaviors = Array.from({ length: 30 }, (_, i) => `B${i + 1}`);
const context = {
  requiredRequirementRefs: behaviors,
  requirementRefs: [...behaviors, 'D-01'],
  evidenceRefs: ['PRD', 'src/public.mjs', 'smoke.log', 'src/unread.mjs', ...behaviors, 'D-01'],
  actualEvidenceRefs: ['src/public.mjs', 'smoke.log'],
  priorFindingIds: [], humanSources: { 'D-01': 'Use the public command entrypoint.' },
};
const assessment = (requirementRefs = behaviors) => ({ requirementRefs, conclusion: 'satisfied', rationale: 'The complete public command dispatch returns n for 1 through 30; the smoke log exercises command(1).', evidenceRefs: ['src/public.mjs', 'smoke.log'] });
const result = (assessments = [assessment()]) => ({ summary: 'Reviewed complete public command contract.', findings: [], priorDispositions: [], assessments });
const validate = (value, role = 'fidelity') => validateImplementationReviewResult(value, context, role);

test('one complete shared source and one actual execution can ground all thirty requirements; Code records its own grounds without all-Bn repetition', () => {
  assert.deepEqual(validate(result()), result());
  assert.deepEqual(validate(result([assessment([])]), 'code'), result([assessment([])]));
  assert.match(validate(result([assessment([])])), /missing required references: B1.*B30/);
});

test('missing, duplicated, unknown and empty requirement/evidence accounting cannot be accepted', () => {
  assert.match(validate(result([assessment(behaviors.slice(0, 29))])), /missing required references: B30/);
  assert.match(validate(result([assessment(), assessment(['B30'])])), /duplicate assessment reference B30/);
  assert.match(validate(result([assessment([...behaviors, 'B31'])])), /unknown reference/);
  assert.match(validate(result([assessment(['B1', 'B1'])])), /duplicate reference/);
  assert.match(validate(result([])), /non-empty array/);
  for (const [field, value, expected] of [
    ['rationale', ' ', /non-empty grounds/], ['evidenceRefs', [], /requires evidence references/],
    ['evidenceRefs', ['invented.log'], /unknown reference/],
    ['evidenceRefs', ['PRD', 'B1', 'D-01', 'src/unread.mjs'], /actual source/],
  ]) assert.match(validate(result([{ ...assessment(), [field]: value }])), expected);
});

test('unresolved B30 has a blocking finding and a later correction is a separate satisfied result', () => {
  const missing = { ...assessment(['B30']), conclusion: 'unresolved', rationale: 'command(30) reaches the missing-command branch.' };
  const failed = result([assessment(behaviors.slice(0, 29)), missing]);
  assert.match(validate(failed), /corresponding blocking finding/);
  failed.findings = [{ kind: 'defect', requirementRefs: ['B30'], problem: 'command(30) throws instead of returning 30.', evidenceRefs: ['src/public.mjs'], nextAction: 'Implement the missing command(30) dispatch.' }];
  const original = JSON.stringify(failed);
  assert.deepEqual(validate(failed), failed);
  assert.deepEqual(validate(result()), result());
  assert.equal(JSON.stringify(failed), original);
  assert.match(validate({ ...failed, findings: [{ ...failed.findings[0], kind: 'advisory' }] }), /corresponding blocking finding/);
});

test('a Behavior reserved for post-completion human judgment stays honestly pending with exact corresponding authority', () => {
  const approvalContext = { ...context, humanSources: { 'D-02': 'After implementation completes, the user will judge B30 wording.' } };
  const pending = result([assessment(behaviors.slice(0, 29)), { requirementRefs: ['B30'], conclusion: 'pending-human', rationale: 'The delivered wording awaits the expressly reserved human judgment.', evidenceRefs: ['PRD', 'src/public.mjs'] }]);
  const parse = (value) => validateImplementationReviewResult(value, approvalContext, 'fidelity');
  assert.match(parse(pending), /corresponding validated post-completion/);
  const finding = { kind: 'human-confirmation', requirementRefs: ['B30'], problem: 'The final wording judgment is reserved for the user.', evidenceRefs: ['PRD'], nextAction: 'Ask for the post-completion wording judgment.', human: { sourceRef: 'D-02', quote: approvalContext.humanSources['D-02'], timing: 'post-completion' } };
  pending.findings = [finding];
  assert.deepEqual(parse(pending), pending);
  assert.match(parse({ ...pending, findings: [{ ...finding, requirementRefs: ['B29'] }] }), /corresponding validated post-completion/);
  assert.match(parse({ ...pending, findings: [{ ...finding, human: { ...finding.human, timing: 'prerequisite' } }] }), /corresponding validated post-completion/);
  assert.match(parse({ ...pending, findings: [{ ...finding, human: { ...finding.human, quote: 'Invented permission.' } }] }), /verbatim substring/);
  assert.match(parse({ ...pending, findings: [{ kind: 'defect', requirementRefs: ['B30'], problem: 'Missing behavior.', evidenceRefs: ['PRD'], nextAction: 'Implement B30.' }] }), /corresponding validated post-completion/);
});
