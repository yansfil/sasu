import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("canonical workflow uses qa-log as the only intake artifact", () => {
  const files = [
    path.join(repoRoot, "skills", "interview-me", "SKILL.md"),
    path.join(repoRoot, "skills", "gen-prd", "SKILL.md"),
    path.join(repoRoot, "skills", "please", "SKILL.md"),
  ];
  const combined = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(combined, /prd-handoff\.md/);
  assert.match(combined, /one canonical artifact only: qa-log\.md/);
  // The former standalone "semantic losslessness sweep" now lives inside the
  // gen-prd Inline Self-Check; the guarantee itself must survive.
  assert.match(combined, /Losslessness: every material answer/);
  assert.match(combined, /without treating silence as consent/);
  assert.match(combined, /do not treat silence or a topic change as approval/);
});
