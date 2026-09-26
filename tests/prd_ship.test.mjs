import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shipScript = path.join(repoRoot, "skills", "ship", "scripts", "prd_ship.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8" });
  if (!options.allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

function fixture(baselineFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-ship-report-"));
  run("git", ["init", "-q"], { cwd: root });
  run("git", ["config", "user.name", "test"], { cwd: root });
  run("git", ["config", "user.email", "test@example.test"], { cwd: root });
  write(path.join(root, ".gitignore"), "agents/\n");
  write(path.join(root, "src", "feature.js"), "export const ready = false;\n");
  for (const [relative, text] of Object.entries(baselineFiles)) write(path.join(root, relative), text);
  run("git", ["add", ".gitignore", "src/feature.js", ...Object.keys(baselineFiles)], { cwd: root });
  run("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  write(path.join(root, "src", "feature.js"), "export const ready = true;\n");
  run("git", ["add", "src/feature.js"], { cwd: root });
  run("git", ["commit", "-q", "-m", "Implement feature"], { cwd: root });
  const implementationHead = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  const runDir = "agents/runs/fixture";
  const statePath = path.join(root, runDir, "state.json");
  const identity = {
    schema: "sasu.verification-report.v1",
    inputFingerprint: "input-current",
    prdSha256: "a".repeat(64),
    baseSha: head,
    headSha: implementationHead,
    sourceFingerprint: "source-current",
    generatedAt: "2026-09-15T00:00:00.000Z",
    status: "PASS",
    jsonPath: `${runDir}/verification-report.json`,
    markdownPath: `${runDir}/verification-report.md`,
  };
  const latest = {
    id: "verify-1",
    inputFingerprint: identity.inputFingerprint,
    prdSha256: identity.prdSha256,
    sourceFingerprint: identity.sourceFingerprint,
    verdict: "PASS",
  };
  const report = {
    ...identity,
    ownedFiles: ["src/feature.js"],
    requiredCommands: [{
      id: "S1",
      command: "node test.js",
      cwd: ".",
      excluded: false,
      result: { status: "GREEN", exitCode: 0, durationMs: 12, logPath: `${runDir}/artifacts/logs/test.log` },
    }],
    evidence: [],
    error: null,
    agentReview: { status: "NOT_RUN", authority: "advisory", instruction: "Run native review." },
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  identity.reportSha256 = crypto.createHash("sha256").update(reportText).digest("hex");
  const state = {
    schema: "sasu.implement.state.v11.stateless-verification",
    status: "active",
    topicSlug: "fixture",
    projectRoot: root,
    worktree: null,
    runDir,
    prdPath: "agents/prd/fixture/prd.md",
    delivery: { mode: "local" },
    initialSource: { head },
    baselineAttribution: { head },
    verificationAttempts: [latest],
    verificationReport: identity,
  };
  write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  write(path.join(root, runDir, "verification-report.json"), reportText);
  write(path.join(root, runDir, "verification-report.md"), "# Verification report\n\nStatus: **PASS**\n");

  const bin = path.join(root, "agents", "test-bin");
  write(path.join(bin, "sasu"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "rules") {
  process.stdout.write(JSON.stringify({ok:true,results:[],failures:[],manualConfirmations:[],pending:{count:0,items:[]}}));
  process.exit(0);
}
const statePath = args[args.indexOf("--state") + 1];
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const latest = state.verificationAttempts.at(-1);
process.stdout.write(JSON.stringify({ok:true,detail:{status:state.status,verification:{verdict:"PASS",latest},verificationReport:state.verificationReport,delivery:{eligible:true,reasons:[]},artifactProblems:[]}}));
`, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { root, statePath, state, report, env };
}

test("local delivery accepts a report bound to the already committed implementation head", () => {
  const current = fixture();
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath, "--no-gpg-sign"], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "local");
  assert.equal(output.commit.existing, true);
  assert.deepEqual(output.commit.staged, []);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: current.root }).stdout.trim(), "Implement feature");
});

test("a completed delivery of an hcoord-supervised run ends its implementor participant", () => {
  const current = fixture();
  current.state.supervision = { runInstanceId: "run-key-1", coordinationOwner: "hcoord", hcoord: { observer: "a_observer", implementor: "a_implementor" } };
  write(current.statePath, `${JSON.stringify(current.state, null, 2)}\n`);
  const bin = path.join(current.root, "agents", "test-bin");
  write(path.join(bin, "hcoord"), `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(path.join(current.root, "agents", "hcoord-argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, delivery: "delivered", value: {} }));
`, 0o755);
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath, "--no-gpg-sign"], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.coordination, { ended: true, implementor: "a_implementor", delivery: "delivered" });
  const asked = fs.readFileSync(path.join(current.root, "agents", "hcoord-argv.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(asked, [["agent", "end", "a_implementor", "--actor", "a_observer", "--json"]]);
});

test("local delivery never amends a verified checkpoint commit", () => {
  const current = fixture();
  run("git", ["commit", "--amend", "-q", "-m", "checkpoint: implementation"], { cwd: current.root });
  const checkpointHead = run("git", ["rev-parse", "HEAD"], { cwd: current.root }).stdout.trim();
  current.report.headSha = checkpointHead;
  const reportText = `${JSON.stringify(current.report, null, 2)}\n`;
  current.state.verificationReport.headSha = checkpointHead;
  current.state.verificationReport.reportSha256 = crypto.createHash("sha256").update(reportText).digest("hex");
  current.state.verificationAttempts[0].sourceFingerprint = current.report.sourceFingerprint;
  write(path.join(current.root, current.report.jsonPath), reportText);
  write(current.statePath, `${JSON.stringify(current.state, null, 2)}\n`);

  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath, "--no-gpg-sign"], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.commit.existing, true);
  assert.equal(output.commit.promotedCheckpoint, false);
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: current.root }).stdout.trim(), checkpointHead);
  assert.equal(run("git", ["log", "-1", "--format=%s"], { cwd: current.root }).stdout.trim(), "checkpoint: implementation");
});

test("PR body draft reads Summary, Review, Evidence first and folds the machine record", () => {
  const current = fixture();
  const result = run(process.execPath, [shipScript, "body", "--state", current.statePath], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.template, null);
  const body = fs.readFileSync(path.join(current.root, output.bodyPath), "utf8");
  const order = ["Related:", "## Summary", "## Review", "## Evidence", "## Breaking change", "<details><summary>Verification record</summary>"]
    .map(marker => body.indexOf(marker));
  assert.ok(order.every(index => index !== -1), `missing section in ${body}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "sections are out of reading order");
  const record = body.slice(body.indexOf("<details>"));
  assert.match(record, /S1: GREEN/);
  assert.match(record, /verification-report\.json/);
  assert.match(record, /Reviews: <!-- AGENT-FILL/);
  assert.doesNotMatch(body.slice(0, body.indexOf("<details>")), /sha256|fingerprint/i, "hashes belong in the folded record only");
  assert.doesNotMatch(body, /## Deterministic Verification|## Human Review Focus|## Delivery Staging/);
  assert.doesNotMatch(body, /Mode: unknown|Branch: unknown/);
});

test("PR body draft takes the repository's own template and adds only the folded record", () => {
  const current = fixture({
    ".github/pull_request_template.md": [
    "<!-- house guidance -->",
    "",
    "## Summary",
    "",
    "<!-- what changed -->",
    "",
    "## Review",
    "",
    "- **Judge**: <!-- product calls -->",
    "",
    "<details><summary>Verification record</summary>",
    "",
    "<!-- filled by ship -->",
    "",
    "</details>",
    "",
  ].join("\n"),
  });
  const result = run(process.execPath, [shipScript, "body", "--state", current.statePath], { cwd: current.root, env: current.env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.template, ".github/pull_request_template.md");
  const body = fs.readFileSync(path.join(current.root, output.bodyPath), "utf8");
  assert.ok(body.indexOf("<!-- house guidance -->") < body.indexOf("Related:"), "Related sits right under the template's leading comment");
  assert.ok(body.indexOf("Related:") < body.indexOf("## Summary"), "Related sits above Summary");
  assert.match(body, /Related: PRD `agents\/prd\/fixture\/prd\.md`/);
  assert.match(body, /## Review\n\n- \*\*Judge\*\*: <!-- product calls -->/);
  assert.doesNotMatch(body, /<!-- filled by ship -->/, "the template's placeholder record is replaced");
  assert.equal((body.match(/<details>/g) || []).length, 1);
  assert.match(body, /<details><summary>Verification record<\/summary>\n\n- PRD: `agents\/prd\/fixture\/prd\.md`/);
  assert.match(body, /S1: GREEN/);
  assert.doesNotMatch(body, /## Breaking change/, "no house sections are added to a repository template");
});

function fakeGh(root) {
  // Outside the fixture repository, so the fake never shows as an uncommitted change.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sasu-ship-gh-"));
  const bin = path.join(outside, "bin");
  const store = path.join(outside, "store");
  fs.mkdirSync(store, { recursive: true });
  write(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
const store = ${JSON.stringify(store)};
fs.appendFileSync(path.join(store, "calls.log"), JSON.stringify(args) + "\\n");
if (args[0] !== "api") { process.stdout.write("{}"); process.exit(0); }
const put = args.includes("PUT");
const target = args.find(arg => arg.startsWith("repos/"));
const marker = path.join(store, encodeURIComponent(target));
if (put) {
  const input = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
  if (!input.message || !input.content) { process.stderr.write("bad payload"); process.exit(1); }
  fs.writeFileSync(marker, input.content.length.toString());
  process.stdout.write(JSON.stringify({ content: { sha: "deadbeef" } }));
  process.exit(0);
}
if (fs.existsSync(marker)) { process.stdout.write("deadbeef\\n"); process.exit(0); }
process.stderr.write("HTTP 404: Not Found"); process.exit(1);
`, 0o755);
  return { bin, store };
}

test("screenshots upload once per head into the assets repo and land under Summary", () => {
  const current = fixture();
  run("git", ["remote", "add", "origin", "https://github.com/example/product.git"], { cwd: current.root });
  const gh = fakeGh(current.root);
  const env = { ...current.env, PATH: `${gh.bin}:${current.env.PATH}` };
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  write(path.join(current.root, "agents", "runs", "fixture", "artifacts", "01 overview.png"), png);
  write(path.join(current.root, "agents", "runs", "fixture", "artifacts", "02-empty-state.png"), png);
  const bodyPath = path.join(current.root, "agents", "runs", "fixture", "delivery", "pr-body.md");
  write(bodyPath, "Related: #1\n\n## Summary\n\n- one\n- two\n\n## Review\n\n- judge\n\n<details><summary>Verification record</summary>\n\n- x\n\n</details>\n");
  const args = [shipScript, "screenshots", "--state", current.statePath, "--assets-repo", "someone/pr-assets",
    "--file", "agents/runs/fixture/artifacts/01 overview.png", "--caption", "Overview, grouped by worktree",
    "--file", "agents/runs/fixture/artifacts/02-empty-state.png", "--caption", "02 empty state"];
  let output = JSON.parse(run(process.execPath, args, { cwd: current.root, env }).stdout);
  const head = current.report.headSha.slice(0, 7);
  assert.equal(output.screenshots.length, 2);
  assert.equal(output.screenshots[0].path, `product/fixture/${head}/01-overview.png`);
  assert.equal(output.screenshots[0].url, `https://github.com/someone/pr-assets/blob/main/product/fixture/${head}/01-overview.png?raw=true`);
  assert.equal(output.screenshots[0].caption, "Overview, grouped by worktree");
  assert.equal(output.screenshots[1].caption, "02 empty state");
  assert.ok(output.screenshots.every(item => item.uploaded));
  assert.equal(output.body.updated, true);
  const body = fs.readFileSync(bodyPath, "utf8");
  const summaryAt = body.indexOf("## Summary");
  const imageAt = body.indexOf("![Overview, grouped by worktree](");
  const reviewAt = body.indexOf("## Review");
  assert.ok(summaryAt < imageAt && imageAt < reviewAt, `images sit between Summary and Review:\n${body}`);
  assert.match(body, /- two\n\n!\[Overview, grouped by worktree\]\(.*\)\n\n!\[02 empty state\]\(.*\)\n\n## Review/);

  output = JSON.parse(run(process.execPath, args, { cwd: current.root, env }).stdout);
  assert.ok(output.screenshots.every(item => item.uploaded === false), "a second run uploads nothing");
  assert.equal(output.body.updated, false);
  assert.equal(fs.readFileSync(bodyPath, "utf8"), body, "a second run leaves the body as it was");
  const puts = fs.readFileSync(path.join(gh.store, "calls.log"), "utf8").split("\n").filter(line => line.includes("\"PUT\""));
  assert.equal(puts.length, 2);

  const bad = run(process.execPath, [shipScript, "screenshots", "--state", current.statePath, "--file", "agents/runs/fixture/artifacts/02-empty-state.png"], { cwd: current.root, env, allowFailure: true });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--assets-repo/);
  const uneven = run(process.execPath, [...args, "--caption", "one too many"], { cwd: current.root, env, allowFailure: true });
  assert.notEqual(uneven.status, 0);
  assert.match(uneven.stderr, /one --caption per --file/);
});

test("ship refuses a body that still carries template comments or lacks the record", () => {
  const current = fixture();
  const bodyPath = path.join(current.root, "agents", "runs", "fixture", "delivery", "pr-body.md");
  write(bodyPath, "## Summary\n\n- done\n\n<!-- leftover guidance -->\n\n<details><summary>Verification record</summary>\n\n- Verification report: x\n\n</details>\n");
  const shipArgs = [shipScript, "ship", "--state", current.statePath, "--no-watch", "--no-gpg-sign", "--override-mode", "--reason", "test"];
  let result = run(process.execPath, shipArgs, { cwd: current.root, env: current.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /template comments/);
  write(bodyPath, "## Summary\n\n- done, see the verification report\n");
  result = run(process.execPath, shipArgs, { cwd: current.root, env: current.env, allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Verification record/);
  let preflight = JSON.parse(run(process.execPath, [shipScript, "preflight", "--state", current.statePath], { cwd: current.root, env: current.env }).stdout);
  assert.equal(preflight.body.status, "draft-unfilled-or-invalid");
});

test("delivery refuses a stale report identity before staging", () => {
  const current = fixture();
  const state = JSON.parse(fs.readFileSync(current.statePath, "utf8"));
  state.verificationReport.sourceFingerprint = "source-newer";
  fs.writeFileSync(current.statePath, JSON.stringify(state));
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the current state identity/);
  assert.equal(run("git", ["diff", "--cached", "--name-only"], { cwd: current.root }).stdout.trim(), "");
});

test("delivery refuses a report whose body was edited after verification", () => {
  const current = fixture();
  const reportPath = path.join(current.root, "agents", "runs", "fixture", "verification-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.ownedFiles = ["src/unrelated.js"];
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const result = run(process.execPath, [shipScript, "local", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the current state identity/);
});

test("old receipt-era state is rejected explicitly", () => {
  const current = fixture();
  const state = JSON.parse(fs.readFileSync(current.statePath, "utf8"));
  state.schema = "sasu.implement.state.v10";
  fs.writeFileSync(current.statePath, JSON.stringify(state));
  const result = run(process.execPath, [shipScript, "body", "--state", current.statePath], {
    cwd: current.root,
    env: current.env,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected sasu\.implement\.state\.v11\.stateless-verification/);
  assert.match(result.stderr, /last supported commit/);
});
