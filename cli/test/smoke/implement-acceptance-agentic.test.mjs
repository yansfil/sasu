import test from "node:test";
import { evaluateLiveReview } from "../helpers/implement-live-review.mjs";

test("live comprehensive review finds middle, final, unwired, and storage-failure omissions through the production read-only backend", { timeout: 1_200_000 }, async (t) => {
  await evaluateLiveReview("claude", t);
});
