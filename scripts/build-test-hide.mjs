#!/usr/bin/env node
// Builds a headless candidate from the exact source pin, never an installed app.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), option = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const source = option("--src"), output = option("--out");
if (!source || !output || args.length !== 4) throw new Error("usage: node scripts/build-test-hide.mjs --src <pinned-checkout> --out <private-resources>");
const pin = JSON.parse(fs.readFileSync(path.join(root, "cli/test/hide-source.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(pin.ref)) throw new Error("Hide source pin must be a full commit SHA");
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(HERDR_|HIDE_|HCOORD_)/.test(key)) delete env[key];
function run(binary, argv) {
  const result = spawnSync(binary, argv, { cwd: path.resolve(source), env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} ${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}
if (run("git", ["rev-parse", "HEAD"]) !== pin.ref) throw new Error("Hide checkout does not match cli/test/hide-source.json");
if (run("git", ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new Error("Hide source checkout must be clean");
const platform = process.platform === "darwin" && process.arch === "arm64" ? "macos-aarch64" : process.platform === "linux" && process.arch === "x64" ? "linux-x86_64" : null;
if (!platform) throw new Error("native Hide integration supports macOS arm64 and Linux x64");
run("bash", ["scripts/verify-cargo.sh", "cli"]);
const herdr = run("zsh", ["scripts/fetch-herdr-runtime.sh", "--platform", platform]);
run("python3", ["scripts/check-herdr-schema.py", "--herdr-bin", herdr]);
const resources = path.resolve(output); fs.mkdirSync(resources, { recursive: true });
for (const [name, input] of [["hide", "hide"], ["hided", "hided"], ["hide-agent-hooks", "hide-agent-hooks"], [`hide-host-helper-${platform}`, "hide-host-helper"]]) {
  fs.copyFileSync(path.join(path.resolve(source), "target/debug", input), path.join(resources, name)); fs.chmodSync(path.join(resources, name), 0o755);
}
fs.copyFileSync(herdr, path.join(resources, "herdr")); fs.chmodSync(path.join(resources, "herdr"), 0o755);
fs.copyFileSync(path.join(path.resolve(source), "contracts/herdr-bundle.json"), path.join(resources, "herdr-bundle.json"));
fs.writeFileSync(path.join(resources, "sasu-hide-candidate.json"), JSON.stringify({ repo: pin.repo, ref: pin.ref, platform }) + "\n");
process.stdout.write(path.join(resources, "hide") + "\n");
