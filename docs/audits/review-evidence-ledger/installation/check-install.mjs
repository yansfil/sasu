import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const [root, output] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { SKILL_NAMES, contractFiles, transformContractFile } = require(path.join(root, "cli/lib/skill-contract.js"));
const records = [];
for (const runtime of ["codex", "claude"]) for (const name of SKILL_NAMES) {
  const target = path.join("/Users/hoyeonlee", "." + runtime, "skills", name);
  const source = path.join(root, "skills", name);
  const files = contractFiles(path.join(root, "skills"), name, runtime);
  const mismatches = files.filter((relative) => {
    if (!fs.existsSync(path.join(target, relative))) return true;
    const raw = fs.readFileSync(path.join(source, relative));
    const substituted = relative === "SKILL.md" || (relative.startsWith("references/") && relative.endsWith(".md"));
    const expected = substituted ? Buffer.from(transformContractFile(runtime, relative, raw.toString("utf8"))) : raw;
    return !fs.readFileSync(path.join(target, relative)).equals(expected);
  });
  records.push({ runtime, name, regularSkillFile: fs.lstatSync(path.join(target, "SKILL.md")).isFile(), checkedFiles: files.length, mismatches });
}
const hookFiles = ["/Users/hoyeonlee/.codex/hooks.json", "/Users/hoyeonlee/.claude/settings.json"];
const hooks = hookFiles.map((file) => ({ path: file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
const failures = records.filter((entry) => entry.mismatches.length || !entry.regularSkillFile);
fs.writeFileSync(output, JSON.stringify({ ok: failures.length === 0, records, hooks }, null, 2) + "\n");
console.log(JSON.stringify({ ok: failures.length === 0, skills: records.length, files: records.reduce((sum, entry) => sum + entry.checkedFiles, 0), failures, hooks }));
if (failures.length) process.exitCode = 1;
