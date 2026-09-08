import test from "node:test";
import { evaluateLiveReview } from "../helpers/implement-live-review.mjs";

test("live concurrent Fidelity and Code reviews preserves all thirty requirements and audited isolation while identifying exactly the planted failures", { timeout: 1_200_000 }, async (t) => {
  await evaluateLiveReview("codex", t);
});

test("live concurrent Fidelity and Code reviews reads actual visual evidence through the attachment-capable production route", { timeout: 240_000 }, async (t) => {
  const { evaluateLiveVisual } = await import("../helpers/implement-live-review.mjs");
  await evaluateLiveVisual(t);
});
