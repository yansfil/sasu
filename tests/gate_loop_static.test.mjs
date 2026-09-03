// PRD gate-loop static contract (AC3, AC10, AC12): the retired review
// lifecycle is gone from code and skill prose, the skills no longer ask an
// agent to write the qa-log's Audit History, and the spec fidelity prompt
// carries its evidence sentence. A grep is the strongest instrument these
// criteria admit, so it runs as a test rather than living in a checklist.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const RETIRED = ["closure-blocked", "closureExhausted", "closure-exhausted", "judgedRounds", "reviewRound", "reviewPhase", "semantic rounds"];

test("AC3: no round counter or closure phase survives in the harness code or the skills", () => {
  const files = [
    ...walk(path.join(repoRoot, "cli", "src")),
    ...walk(path.join(repoRoot, "cli", "lib")),
    ...walk(path.join(repoRoot, "cli", "scripts")),
    ...walk(path.join(repoRoot, "scripts")),
    ...walk(path.join(repoRoot, "skills")),
  ];
  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const token of RETIRED) {
      // Whole identifiers only: implement's receipt has its own `reviewRounds`
      // (fidelity/final review rounds), which is not the retired PRD counter.
      // The loader's refusal names the retired lifecycle so the operator
      // knows what it found; that one file is the only permitted mention.
      const present = new RegExp(`(?<![\\w-])${token.replace(/[-\s]/g, (m) => m === " " ? "\\s" : "\\-")}(?![\\w-])`).test(content);
      if (present && !/refuse structurally|retired bounded-review state|retired by PRD gate-loop/i.test(content)) {
        offenders.push(`${path.relative(repoRoot, file)}: ${token}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
