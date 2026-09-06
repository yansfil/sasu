import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scratchDir } from "../scratch.mjs";

import { loadConfig } from "../../dist/config.js";
import { runPrinciplesCommand } from "../../dist/principles/commands.js";

function tempDir(prefix) {
  return scratchDir(prefix);
}

function tempProject(configJson) {
  const dir = tempDir("sasu-principles-project-");
  if (configJson !== undefined) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "config.json"), JSON.stringify(configJson));
  }
  return dir;
}

function principleRepo({ rootDoc, docs = {} } = {}) {
  const dir = tempDir("sasu-principles-repo-");
  if (rootDoc !== undefined) fs.writeFileSync(path.join(dir, "ROOT.md"), rootDoc);
  for (const [rel, body] of Object.entries(docs)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const GOOD_ROOT = `# Root

## Domains

| Domain | Read when | Document |
| --- | --- | --- |
| engineering | writing or changing code | engineering/principles.md |
| design | building any work screen | design/principles.md |
`;

const GOOD_DOCS = {
  "engineering/principles.md": "# Engineering\n\n### 1. Surface failures explicitly\n\n### 2. Grow in layers\n",
  "design/principles.md": "# Design\n\n### 1. A list is a read view\n",
};

function flags(entries = {}) {
  return new Map(Object.entries(entries));
}

test("config: principles defaults to an empty list and expands ~ in declared paths", () => {
  assert.deepEqual(loadConfig(tempProject()).principles, []);
  const project = tempProject({ principles: ["~/somewhere/principles"] });
  assert.deepEqual(loadConfig(project).principles, [path.join(os.homedir(), "somewhere/principles")]);
});

test("config: a non-string-list principles value fails loudly", () => {
  assert.throws(() => loadConfig(tempProject({ principles: "~/one" })), /principles must be an array of non-empty strings/);
  assert.throws(() => loadConfig(tempProject({ principles: [""] })), /principles must be an array of non-empty strings/);
});

test("list returns every domain with trigger, absolute doc path, and rule titles", () => {
  const repo = principleRepo({ rootDoc: GOOD_ROOT, docs: GOOD_DOCS });
  const project = tempProject({ principles: [repo] });
  const result = runPrinciplesCommand(project, "list", flags());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  const domains = result.detail.domains;
  assert.deepEqual(
    domains.map((domain) => domain.name),
    ["engineering", "design"],
  );
  assert.equal(domains[0].trigger, "writing or changing code");
  assert.equal(domains[0].doc, path.join(repo, "engineering/principles.md"));
  assert.deepEqual(domains[0].rules, ["1. Surface failures explicitly", "2. Grow in layers"]);
  assert.deepEqual(domains[1].rules, ["1. A list is a read view"]);
  // The temp repo is not a git repository, so provenance is honestly null.
  assert.equal(domains[0].commit, null);
});

test("--domain filters to one domain and an unknown domain fails naming the declared ones", () => {
  const repo = principleRepo({ rootDoc: GOOD_ROOT, docs: GOOD_DOCS });
  const project = tempProject({ principles: [repo] });
  const filtered = runPrinciplesCommand(project, "list", flags({ domain: "design" }));
  assert.equal(filtered.ok, true);
  assert.deepEqual(
    filtered.detail.domains.map((domain) => domain.name),
    ["design"],
  );
  const unknown = runPrinciplesCommand(project, "list", flags({ domain: "nope" }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.message, /unknown principle domain: nope/);
  assert.match(unknown.message, /engineering, design/);
});

test("a project without a principles declaration gets an ok empty listing, not an error", () => {
  const result = runPrinciplesCommand(tempProject(), "list", flags());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.detail.domains, []);
  assert.match(result.message, /no principle repositories declared/);
});

test("a broken declaration fails loudly and names the offending path", () => {
  const missing = path.join(os.tmpdir(), "sasu-principles-definitely-missing");
  const missingRepo = runPrinciplesCommand(tempProject({ principles: [missing] }), "list", flags());
  assert.equal(missingRepo.ok, false);
  assert.equal(missingRepo.exitCode, 1);
  assert.match(missingRepo.message, /does not exist/);
  assert.ok(missingRepo.message.includes(missing));

  const noRoot = principleRepo({});
  const noRootResult = runPrinciplesCommand(tempProject({ principles: [noRoot] }), "list", flags());
  assert.equal(noRootResult.ok, false);
  assert.match(noRootResult.message, /has no ROOT.md/);

  const noTable = principleRepo({ rootDoc: "# Root\n\nno table here\n" });
  const noTableResult = runPrinciplesCommand(tempProject({ principles: [noTable] }), "list", flags());
  assert.equal(noTableResult.ok, false);
  assert.match(noTableResult.message, /no domain table/);

  const danglingDoc = principleRepo({ rootDoc: GOOD_ROOT, docs: { "engineering/principles.md": "### 1. Only one\n" } });
  const danglingResult = runPrinciplesCommand(tempProject({ principles: [danglingDoc] }), "list", flags());
  assert.equal(danglingResult.ok, false);
  assert.match(danglingResult.message, /points at a missing document/);
});

test("one broken repository never hides the domains a sibling repository declared correctly", () => {
  const goodRepo = principleRepo({ rootDoc: GOOD_ROOT, docs: GOOD_DOCS });
  const brokenRepo = principleRepo({ rootDoc: "# Root\n\nno table here\n" });
  const project = tempProject({ principles: [brokenRepo, goodRepo] });

  const result = runPrinciplesCommand(project, "list", flags());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.detail.domains.map((domain) => domain.name),
    ["engineering", "design"],
  );
  assert.equal(result.detail.errors.length, 1);
  assert.equal(result.detail.errors[0].source, brokenRepo);
  assert.match(result.detail.errors[0].message, /no domain table/);
  // The broken repository is still named in the summary, not swallowed.
  assert.match(result.message, /1 repository failed to read/);
  assert.ok(result.message.includes(brokenRepo));
});

test("when every declared repository is broken, there is nothing usable and the command fails", () => {
  const brokenA = principleRepo({ rootDoc: "# Root\n\nno table here\n" });
  const brokenB = principleRepo({});
  const project = tempProject({ principles: [brokenA, brokenB] });

  const result = runPrinciplesCommand(project, "list", flags());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /every declared principle repository failed to read/);
  assert.equal(result.detail.errors.length, 2);
});

test("a subcommand other than list is a usage error", () => {
  const result = runPrinciplesCommand(tempProject(), "show", flags());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
});
