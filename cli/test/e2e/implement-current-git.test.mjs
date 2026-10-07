import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CLI, INTAKE_PATH, PRD_PATH, STATE_PATH, git, isolatedEnv, makeProject, readState } from "../helpers/implement-fixture.mjs";

const ship = path.resolve(import.meta.dirname, "../../../skills/ship/scripts/prd_ship.js");
const ok = (result) => { assert.equal(result.status, 0, result.text); return result.json; };

function fixture(t) {
  const root = fs.realpathSync(makeProject({ count: 1 }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-current-git-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["checkout", "-qb", "feature/custom"]);
  const bin = path.join(outside, "bin"), home = path.join(outside, "home");
  fs.mkdirSync(bin); fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, "sasu"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,[${JSON.stringify(CLI)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  const env = isolatedEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: home });
  function command(entry, args, cwd = root) {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    let json; try { json = JSON.parse(result.stdout); } catch { json = null; }
    return { ...result, json, text: result.stderr + result.stdout };
  }
  const cli = (args, cwd) => command(CLI, [...args, "--json"], cwd);
  const deliver = (args = [], cwd) => command(ship, ["local", "--no-gpg-sign", ...args], cwd);
  function commit(relative, text) {
    fs.writeFileSync(path.join(root, relative), text);
    git(root, ["add", relative]); git(root, ["commit", "-qm", `Update ${relative}`]);
  }
  function begin() { ok(cli(["implement", "start", "--prd", PRD_PATH])); commit("implementation.txt", "approved implementation\n"); }
  const verify = (cwd) => ok(cli(["implement", "verify", "--slug", "fixture"], cwd));
  const state = () => readState(root);
  const report = () => JSON.parse(fs.readFileSync(path.join(root, state().verificationReport.jsonPath), "utf8"));
  function upstream() {
    git(root, ["checkout", "-q", "main"]); commit("upstream.txt", "upstream-only change\n"); git(root, ["checkout", "-q", "feature/custom"]);
  }
  return { root, outside, cli, command, deliver, commit, begin, verify, state, report, upstream };
}

test("rebase rewrites the start commit; fresh real verification can still deliver", (t) => {
  const f = fixture(t);
  f.commit("earlier.txt", "earlier feature work\n");
  f.begin(); f.verify();
  const originalBaseline = f.state().initialSource.head;
  f.upstream(); git(f.root, ["rebase", "main"]);
  assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", originalBaseline, "HEAD"], { cwd: f.root }).status, 0);
  f.verify();
  assert.equal(f.report().baseSha, git(f.root, ["merge-base", "main", "HEAD"]));
  assert.deepEqual(f.report().ownedFiles, ["earlier.txt", "implementation.txt"]);
  assert.equal(ok(f.deliver()).commit.commit, git(f.root, ["rev-parse", "HEAD"]));
});

test("merging main excludes upstream-only paths from the verified delivery range", (t) => {
  const f = fixture(t); f.begin(); f.upstream();
  git(f.root, ["merge", "--no-edit", "main"]); f.verify();
  assert.deepEqual(f.report().ownedFiles, ["implementation.txt"]);
  assert.deepEqual(ok(f.deliver()).commit.changed, ["implementation.txt"]);
});

test("content-equivalent HEAD changes stale the report until verification runs again", (t) => {
  const f = fixture(t); f.begin(); f.verify();
  const old = f.report(); git(f.root, ["commit", "--amend", "-qm", "Same source, new candidate"]);
  assert.notEqual(git(f.root, ["rev-parse", "HEAD"]), old.headSha);
  const status = ok(f.cli(["implement", "status"])).detail;
  assert.equal(status.verification.verdict, "STALE"); assert.equal(status.delivery.eligible, false);
  assert.notEqual(f.deliver().status, 0);
  f.verify(); assert.equal(ok(f.deliver()).ok, true);
});

test("sibling invocation judges and delivers the checkout containing the record", (t) => {
  const f = fixture(t); f.begin();
  const sibling = path.join(f.outside, "sibling"); git(f.root, ["worktree", "add", "-qb", "other/candidate", sibling, "main"]);
  fs.writeFileSync(path.join(sibling, "foreign.txt"), "must never be judged or delivered\n");
  f.verify(sibling);
  assert.equal(f.report().headSha, git(f.root, ["rev-parse", "HEAD"]));
  assert.deepEqual(f.report().ownedFiles, ["implementation.txt"]);
  const delivered = ok(f.deliver([], sibling));
  assert.equal(delivered.implementationHead, git(f.root, ["rev-parse", "HEAD"]));
  assert.equal(fs.existsSync(path.join(sibling, STATE_PATH)), false);
  assert.equal(git(sibling, ["branch", "--show-current"]), "other/candidate");
});

test("delivery defaults to the existing arbitrary branch without creating a prefixed branch", (t) => {
  const f = fixture(t); f.begin(); f.verify();
  const preflight = ok(f.command(ship, ["preflight"]));
  assert.equal(preflight.delivery.branch, "feature/custom");
  assert.equal(git(f.root, ["branch", "--show-current"]), "feature/custom");
  assert.doesNotMatch(git(f.root, ["branch", "--list"]), /prd\/fixture/);
});

test("a duplicate slug is ambiguous even when one record is local", (t) => {
  const f = fixture(t); f.begin();
  const sibling = path.join(f.outside, "sibling"); git(f.root, ["worktree", "add", "-qb", "other/candidate", sibling, "main"]);
  fs.mkdirSync(path.dirname(path.join(sibling, STATE_PATH)), { recursive: true });
  fs.copyFileSync(path.join(f.root, STATE_PATH), path.join(sibling, STATE_PATH));
  const ambiguous = f.cli(["implement", "status", "--slug", "fixture"]);
  assert.notEqual(ambiguous.status, 0); assert.match(ambiguous.text, /more than one|multiple|ambiguous/);
  assert.equal(ok(f.cli(["implement", "status", "--state", path.join(f.root, STATE_PATH)])).detail.topicSlug, "fixture");
});

test("a moved record checkout is resolved from its new location", (t) => {
  const f = fixture(t); f.begin(); f.verify();
  const moved = path.join(f.outside, "moved-checkout");
  fs.renameSync(f.root, moved);
  const status = ok(f.cli(["implement", "status"], moved)).detail;
  assert.equal(status.recordRoot, moved);
  assert.equal(status.workingRoot, moved);
  assert.equal(status.verification.verdict, "PASS");
  assert.equal(ok(f.deliver([], moved)).ok, true);
});

test("missing base refs, detached HEAD, and mismatched branch requests fail explicitly", (t) => {
  const f = fixture(t); f.begin(); f.verify();
  const mismatch = f.command(ship, ["preflight", "--branch", "invented/branch"]);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.text, /does not match/);
  assert.equal(git(f.root, ["branch", "--show-current"]), "feature/custom");
  git(f.root, ["branch", "-D", "main"]);
  const missing = f.cli(["implement", "verify"]);
  assert.notEqual(missing.status, 0); assert.match(missing.text, /base ref is missing/);
  assert.equal(f.state().activeVerification, undefined);
  git(f.root, ["branch", "main", f.state().initialSource.head]);
  git(f.root, ["checkout", "--detach", "-q"]);
  const detached = ok(f.cli(["implement", "status"])).detail;
  assert.equal(detached.delivery.eligible, false); assert.match(detached.artifactProblems.join(" "), /detached/);
  assert.notEqual(f.deliver().status, 0);
});

test("an origin requires its configured remote base rather than falling back locally", (t) => {
  const f = fixture(t); f.begin();
  git(f.root, ["remote", "add", "origin", path.join(f.outside, "unavailable-origin")]);
  const missing = f.cli(["implement", "verify"]);
  assert.notEqual(missing.status, 0); assert.match(missing.text, /refs\/remotes\/origin\/main/);
  git(f.root, ["update-ref", "refs/remotes/origin/main", git(f.root, ["rev-parse", "main"])]);
  f.verify(); assert.equal(f.report().currentGit.baseRef, "refs/remotes/origin/main");
});

test("a base ref change invalidates verification even when HEAD and merge-base stay unchanged", (t) => {
  const f = fixture(t); f.begin(); f.verify(); const before = f.report();
  f.upstream();
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), before.headSha);
  assert.equal(git(f.root, ["merge-base", "main", "HEAD"]), before.baseSha);
  assert.equal(ok(f.cli(["implement", "status"])).detail.verification.verdict, "STALE");
  f.verify(); assert.deepEqual(f.report().ownedFiles, ["implementation.txt"]);
});

test("a HEAD change during a successful suite produces ERROR and releases the lease", (t) => {
  const f = fixture(t);
  f.commit("suite.cjs", "const {spawnSync}=require('node:child_process'); const r=spawnSync('git',['-c','commit.gpgsign=false','commit','--amend','-qm','Candidate changed during suite'],{stdio:'inherit'}); process.exit(r.status);\n");
  f.begin(); const provenance = f.state().initialSource;
  const changed = f.cli(["implement", "verify"]);
  assert.notEqual(changed.status, 0); assert.match(changed.text, /inputs changed while verification/);
  assert.equal(f.state().verificationAttempts.at(-1).verdict, "ERROR");
  assert.equal(f.state().activeVerification, undefined);
  assert.deepEqual(f.state().initialSource, provenance);
  assert.notEqual(f.deliver().status, 0);
});

test("changed or missing registered evidence invalidates delivery without rewriting observations", (t) => {
  const f = fixture(t); f.begin();
  const proof = path.join(f.root, "agents/proof.txt"); fs.writeFileSync(proof, "observed bytes\n");
  ok(f.cli(["implement", "artifact", "--kind", "file", "--path", "agents/proof.txt", "--description", "Runtime observation"]));
  f.verify(); const observation = f.state().artifacts.find(x => x.path === "agents/proof.txt");
  fs.writeFileSync(proof, "changed bytes\n");
  assert.equal(ok(f.cli(["implement", "status"])).detail.delivery.eligible, false);
  assert.notEqual(f.deliver().status, 0);
  fs.unlinkSync(proof);
  assert.notEqual(f.cli(["implement", "verify"]).status, 0);
  assert.deepEqual(f.state().artifacts.find(x => x.path === "agents/proof.txt"), observation);
  assert.equal(f.state().activeVerification, undefined);
});

for (const mixed of [false, true]) test(`current Git does not acquire pre-existing dirty work${mixed ? " in a mixed path map" : ""}`, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "peer.txt"), "unrelated existing work\n");
  if (mixed) fs.writeFileSync(path.join(f.root, "owned.txt"), "approved existing implementation\n");
  const attribution = mixed ? JSON.stringify({ "peer.txt": "pre-existing", "owned.txt": "run-owned" }) : "pre-existing";
  ok(f.cli(["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", attribution]));
  fs.writeFileSync(path.join(f.root, "implementation.txt"), "approved implementation\n");
  git(f.root, ["add", "."]); git(f.root, ["commit", "-qm", "Commit mixed work"]);
  f.verify();
  assert.deepEqual(f.report().ownedFiles, mixed ? ["implementation.txt", "owned.txt"] : ["implementation.txt"]);
  const refused = f.deliver();
  assert.notEqual(refused.status, 0); assert.match(refused.text, /Unexpected paths: peer\.txt/);
  assert.equal(ok(f.deliver(["--include", "peer.txt"])).ok, true, "explicit delivery inclusion remains a separate decision");
});

test("start refuses a nested record root before writing a run record or seal", (t) => {
  const f = fixture(t), nested = path.join(f.root, "nested");
  fs.mkdirSync(nested);
  fs.cpSync(path.join(f.root, "agents"), path.join(nested, "agents"), { recursive: true });
  const refused = f.cli(["implement", "start", "--prd", PRD_PATH, "--dirty-attribution", "run-owned"], nested);
  assert.notEqual(refused.status, 0); assert.match(refused.text, /Git checkout root/);
  assert.equal(fs.existsSync(path.join(nested, "agents/runs/fixture")), false);
});

for (const linked of [false, true]) test(`start keeps new records in the selected checkout (${linked ? "linked" : "unrelated"} destination)`, (t) => {
  const f = fixture(t);
  let other;
  if (linked) {
    other = path.join(f.outside, "sibling");
    git(f.root, ["worktree", "add", "-qb", "other/candidate", other, "main"]);
  } else {
    other = fs.realpathSync(makeProject({ count: 1 }));
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  }
  const localRuns = path.join(f.root, "agents/runs"), otherRuns = path.join(other, "agents/runs");
  fs.mkdirSync(otherRuns, { recursive: true });
  fs.symlinkSync(otherRuns, localRuns, "dir");
  assert.deepEqual(fs.readdirSync(localRuns), []);
  assert.deepEqual(fs.readdirSync(otherRuns), []);
  const refused = f.cli(["implement", "start", "--prd", PRD_PATH]);
  assert.notEqual(refused.status, 0, refused.text);
  assert.match(refused.text, /selected checkout/);
  assert.deepEqual(fs.readdirSync(localRuns), [], "refusal must not write a local run, seal or artifact");
  assert.deepEqual(fs.readdirSync(otherRuns), [], "refusal must not write into the other checkout");
});

test("start accepts an intentionally selected sibling checkout through its canonical alias", (t) => {
  const f = fixture(t), sibling = path.join(f.outside, "sibling"), alias = path.join(f.outside, "selected");
  git(f.root, ["worktree", "add", "-qb", "other/candidate", sibling, "main"]);
  fs.mkdirSync(path.dirname(path.join(sibling, PRD_PATH)), { recursive: true });
  fs.copyFileSync(path.join(f.root, PRD_PATH), path.join(sibling, PRD_PATH));
  fs.mkdirSync(path.dirname(path.join(sibling, INTAKE_PATH)), { recursive: true });
  fs.copyFileSync(path.join(f.root, INTAKE_PATH), path.join(sibling, INTAKE_PATH));
  fs.symlinkSync(sibling, alias, "dir");
  ok(f.cli(["implement", "start", "--prd", PRD_PATH], alias));
  assert.equal(fs.existsSync(path.join(f.root, STATE_PATH)), false);
  assert.equal(fs.existsSync(path.join(sibling, STATE_PATH)), true);
  const selected = ok(f.cli(["implement", "status", "--state", path.join(sibling, STATE_PATH)])).detail;
  assert.equal(selected.recordRoot, fs.realpathSync(sibling));
  assert.equal(ok(f.cli(["implement", "status", "--slug", "fixture"])).detail.recordRoot, selected.recordRoot);
});
