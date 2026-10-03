#!/usr/bin/env node
// Builds the hcoord that sasu's daemon tests drive, from the commit pinned in
// cli/test/hcoord-source.json, and prints the path of the executable wrapper
// it writes. Export that path as SASU_TEST_HCOORD to run the tests.
//
//   node scripts/build-test-hcoord.mjs [--src <checkout>] [--out <dir>]
//
// Without --src it fetches the pinned commit itself, sparse to hcoord and the
// pnpm workspace files, into <out>/src. CI checks the same commit out with
// actions/checkout and passes it as --src, so the build below is the one
// implementation of "how hcoord is built" (hide's: pnpm install with the
// workspace lockfile, then `pnpm --dir plugins/hcoord build`).
// Everything but the wrapper path goes to stderr, so `$(...)` captures it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, "cli", "test", "hcoord-source.json"), "utf8"));
for (const field of ["repo", "ref", "path"]) if (typeof pin[field] !== "string" || pin[field] === "") fail(`cli/test/hcoord-source.json has no ${field}`);
if (!/^[0-9a-f]{40}$/.test(pin.ref)) fail("cli/test/hcoord-source.json ref must be a full commit SHA, so the build cannot move");

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 ? null : args[at + 1] ?? fail(`--${name} needs a value`); };
const out = path.resolve(option("out") ?? path.join(repoRoot, "cli", ".cache", "hcoord", pin.ref.slice(0, 12)));
const given = option("src");
const src = path.resolve(given ?? path.join(out, "src"));
const plugin = path.join(src, pin.path);

function fail(message) { process.stderr.write(`build-test-hcoord: ${message}\n`); process.exit(1); }
function run(command, argv, cwd) {
  process.stderr.write(`$ ${command} ${argv.join(" ")}\n`);
  const result = spawnSync(command, argv, { cwd, stdio: ["ignore", process.stderr, process.stderr], env: { ...process.env, CI: process.env.CI ?? "1" } });
  if (result.error?.code === "ENOENT") fail(`${command} is not installed${command === "pnpm" ? "; hide builds hcoord with pnpm 10 (corepack enable, or npm i -g pnpm@10)" : ""}`);
  if (result.status !== 0) fail(`${command} ${argv.join(" ")} exited ${result.status ?? "without a status"}`);
}
const head = () => { const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };

if (given === null && head() !== pin.ref) {
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  run("git", ["init", "-q"], src);
  run("git", ["remote", "add", "origin", `https://github.com/${pin.repo}.git`], src);
  run("git", ["sparse-checkout", "set", "--no-cone", pin.path, "pnpm-workspace.yaml", "pnpm-lock.yaml"], src);
  run("git", ["fetch", "-q", "--depth", "1", "origin", pin.ref], src);
  run("git", ["checkout", "-q", "FETCH_HEAD"], src);
}
if (head() !== pin.ref) fail(`${src} is at ${head() ?? "no commit"}, not the pinned ${pin.ref}`);
for (const file of [pin.path, "pnpm-workspace.yaml", "pnpm-lock.yaml"]) if (!fs.existsSync(path.join(src, file))) fail(`${src} has no ${file}; the checkout must include hcoord and the pnpm workspace files`);

run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8")).name], src);
run("pnpm", ["--dir", pin.path, "build"], src);

const cli = path.join(plugin, "dist", "hcoord", "cli.js");
if (!fs.existsSync(cli)) fail(`the build left no ${cli}`);
// Node by absolute path: tests give the wrapper a PATH that need not hold node.
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const wrapper = path.join(out, "bin", "hcoord");
fs.mkdirSync(path.dirname(wrapper), { recursive: true });
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
process.stdout.write(`${wrapper}\n`);
