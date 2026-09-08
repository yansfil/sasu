import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewBlockingRefs } from "../helpers/implement-live-review.mjs";
import { validateReviewResult } from "../../dist/judge/types.js";

const review = (findings = []) => ({ summary: "Fixed fixture assessment.", findings, priorDispositions: [] });
const defect = (requirementRefs) => ({ kind: "defect", requirementRefs, problem: "A planted contract omission.", evidenceRefs: ["src/public.mjs"], nextAction: "Correct the planted omission." });

test("complete and visual fixture oracles require zero blockers while allowing advice", () => {
  assert.doesNotThrow(() => assertReviewBlockingRefs(review(), [], ["D-01"]));
  assert.doesNotThrow(() => assertReviewBlockingRefs(review([{ ...defect(["B1"]), kind: "advisory" }]), [], ["D-01"]));
  for (const refs of [["B1"], ["D-01"], []]) assert.throws(() => assertReviewBlockingRefs(review([defect(refs)]), [], ["D-01"]), /unrelated or unreferenced blocker/);
});

test("each planted case accepts only its exact affected requirement and declared supporting decisions", () => {
  for (const ref of ["B17", "B30", "B28", "B31"]) {
    assert.doesNotThrow(() => assertReviewBlockingRefs(review([defect([ref, "D-01"])]), [ref], ["D-01"]));
    assert.throws(() => assertReviewBlockingRefs(review(), [ref], ["D-01"]), /exactly.*affected requirements/);
    assert.throws(() => assertReviewBlockingRefs(review([defect([ref, "B9"])]), [ref], ["D-01"]), /unrelated blocking reference: B9/);
    assert.throws(() => assertReviewBlockingRefs(review([defect([ref, "D-99"])]), [ref], ["D-01"]), /unrelated blocking reference: D-99/);
    for (const extra of [[], ["D-01"], ["B9"]]) assert.throws(() => assertReviewBlockingRefs(review([defect([ref]), defect(extra)]), [ref], ["D-01"]), /unrelated or unreferenced blocker/);
  }
});

test("the fixed fixtures cannot acquire a human-only completion prerequisite", () => {
  const confirmation = { ...defect(["B31"]), kind: "human-confirmation", human: { sourceRef: "D-01", quote: "Approve the result.", timing: "prerequisite" } };
  assert.throws(() => assertReviewBlockingRefs(review([confirmation]), ["B31"], ["D-01"]), /no human-only judgment/);
});

// Exact accepted review objects from the c96a662 saved live smoke diagnostics.
// Both satisfied the former "some finding includes expected" test.
const recordedStorageReview = {
  "summary": "The command mapping is present, but the contract is incomplete: save failure handling is incorrect, and runtime evidence covers only command(1).",
  "findings": [
    {
      "kind": "defect",
      "requirementRefs": [
        "B31"
      ],
      "problem": "When store.write(value) throws, save catches the error and still returns {ok:true}. It does not return ok:false, an error message, or the input value as required.",
      "evidenceRefs": [
        "src/public.mjs",
        "B31"
      ],
      "nextAction": "Return ok:false with the caught error message and preserved input value when writing fails."
    },
    {
      "kind": "defect",
      "requirementRefs": [
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "B8",
        "B9",
        "B10",
        "B11",
        "B12",
        "B13",
        "B14",
        "B15",
        "B16",
        "B17",
        "B18",
        "B19",
        "B20",
        "B21",
        "B22",
        "B23",
        "B24",
        "B25",
        "B26",
        "B27",
        "B28",
        "B29",
        "B30"
      ],
      "problem": "The only supplied execution evidence is command(1)=1; commands 2 through 30 were not executed, so their required public behavior lacks runtime verification.",
      "evidenceRefs": [
        "smoke.log",
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "B8",
        "B9",
        "B10",
        "B11",
        "B12",
        "B13",
        "B14",
        "B15",
        "B16",
        "B17",
        "B18",
        "B19",
        "B20",
        "B21",
        "B22",
        "B23",
        "B24",
        "B25",
        "B26",
        "B27",
        "B28",
        "B29",
        "B30"
      ],
      "nextAction": "Run the public command for values 2 through 30 and record the results."
    }
  ],
  "priorDispositions": []
};
const recordedUnwiredReview = {
  "summary": "The public command and save entrypoints exist, but the command mapping omits value 27 and shifts values 29-30, so the full contract is not satisfied.",
  "findings": [
    {
      "kind": "defect",
      "requirementRefs": [
        "B27",
        "B28",
        "B29",
        "B30"
      ],
      "problem": "The actions array contains undefined after value26, followed by value29 and value30. Consequently command(27) returns undefined, command(28) returns 29, command(29) returns 30, and command(30) returns undefined.",
      "evidenceRefs": [
        "src/public.mjs"
      ],
      "nextAction": "Provide a complete ordered actions array including value27 and value28 so command(27) through command(30) return their matching numbers."
    }
  ],
  "priorDispositions": []
};
const requirementRefs = [...Array.from({ length: 31 }, (_, index) => `B${index + 1}`), "D-01"];
const referenceContext = { requirementRefs, evidenceRefs: [...requirementRefs, "src/public.mjs", "smoke.log"], priorFindingIds: [] };

test("the recorded storage reply passes structural validation but fails the exact fixture oracle", () => {
  assert.equal(typeof validateReviewResult(recordedStorageReview, referenceContext), "object");
  assert.ok(recordedStorageReview.findings.some((finding) => finding.requirementRefs.includes("B31")), "the former oracle accepted this false-positive result");
  assert.throws(() => assertReviewBlockingRefs(recordedStorageReview, ["B31"], ["D-01"]), /unrelated or unreferenced blocker/);
  assert.doesNotThrow(() => assertReviewBlockingRefs(review([recordedStorageReview.findings[0]]), ["B31"], ["D-01"]));
});

test("the recorded unwired reply cannot hide hallucinated collateral failures beside B28", () => {
  assert.equal(typeof validateReviewResult(recordedUnwiredReview, referenceContext), "object");
  assert.ok(recordedUnwiredReview.findings.some((finding) => finding.requirementRefs.includes("B28")), "the former oracle accepted collateral failures");
  assert.throws(() => assertReviewBlockingRefs(recordedUnwiredReview, ["B28"], ["D-01"]), /unrelated blocking reference: B27/);
});
