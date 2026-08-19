import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config";

export interface PrincipleDomain {
  /** Domain name from the ROOT.md table, e.g. "engineering". */
  name: string;
  /** The table's "Read when" cell, verbatim: the curated trigger sentence. */
  trigger: string;
  /** Absolute path to the domain's principles document. */
  doc: string;
  /** `### ` rule headings of the document, in order. */
  rules: string[];
  /** Root of the principle repository this domain came from. */
  source: string;
  /** HEAD commit of the source repository, for provenance; null outside git. */
  commit: string | null;
}

export interface PrinciplesCommandResult {
  ok: boolean;
  action: string;
  exitCode: number;
  message: string;
  detail?: unknown;
}

// The domain table is the consumption contract with a principle repository
// (oh-my-principle ROOT.md is the canonical producer). Parsing failures are
// loud: a declared repository that cannot be read is a broken declaration,
// never an empty result (engineering principle 4).
const TABLE_HEADER = /^\|\s*Domain\s*\|/;

function parseDomainTable(rootDoc: string): Array<{ name: string; trigger: string; docRel: string }> {
  const text = fs.readFileSync(rootDoc, "utf8");
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (headerIndex === -1) {
    throw new Error(`no domain table (a markdown table with a "Domain" header column) in ${rootDoc}`);
  }
  const rows: Array<{ name: string; trigger: string; docRel: string }> = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trimStart().startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    // A split of "| a | b | c |" yields ["", a, b, c, ""].
    if (cells.length < 5) continue;
    const name = cells[1] ?? "";
    const trigger = cells[2] ?? "";
    const docRel = cells[3] ?? "";
    if (name === "" || /^-+$/.test(name.replace(/\s/g, ""))) continue;
    if (trigger === "" || docRel === "") {
      throw new Error(`domain table row for "${name}" in ${rootDoc} is missing a trigger or document cell`);
    }
    rows.push({ name, trigger, docRel });
  }
  if (rows.length === 0) throw new Error(`the domain table in ${rootDoc} has no domain rows`);
  return rows;
}

function ruleTitles(docPath: string): string[] {
  return fs
    .readFileSync(docPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4).trim());
}

function headCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function listPrincipleDomains(projectRoot: string): PrincipleDomain[] {
  const config = loadConfig(projectRoot);
  const domains: PrincipleDomain[] = [];
  for (const source of config.principles) {
    if (!fs.existsSync(source)) throw new Error(`declared principle repository does not exist: ${source}`);
    const rootDoc = path.join(source, "ROOT.md");
    if (!fs.existsSync(rootDoc)) throw new Error(`declared principle repository has no ROOT.md: ${source}`);
    const commit = headCommit(source);
    for (const row of parseDomainTable(rootDoc)) {
      const doc = path.resolve(source, row.docRel);
      if (!fs.existsSync(doc)) {
        throw new Error(`domain "${row.name}" in ${rootDoc} points at a missing document: ${doc}`);
      }
      domains.push({ name: row.name, trigger: row.trigger, doc, rules: ruleTitles(doc), source, commit });
    }
  }
  return domains;
}

export function runPrinciplesCommand(
  projectRoot: string,
  subcommand: string | undefined,
  flags: Map<string, string | true>,
): PrinciplesCommandResult {
  if (subcommand !== "list") {
    return { ok: false, action: subcommand ?? "(none)", exitCode: 2, message: "unknown principles subcommand; use: sasu principles list [--domain <name>] [--json]" };
  }
  let domains: PrincipleDomain[];
  try {
    domains = listPrincipleDomains(projectRoot);
  } catch (error) {
    return { ok: false, action: "list", exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
  const domainFlag = flags.get("domain");
  if (typeof domainFlag === "string") {
    const filtered = domains.filter((domain) => domain.name === domainFlag);
    if (filtered.length === 0) {
      const known = domains.map((domain) => domain.name).join(", ") || "(none declared)";
      return { ok: false, action: "list", exitCode: 1, message: `unknown principle domain: ${domainFlag} (declared domains: ${known})` };
    }
    domains = filtered;
  } else if (domainFlag === true) {
    return { ok: false, action: "list", exitCode: 2, message: "--domain needs a value" };
  }
  const message =
    domains.length === 0
      ? "no principle repositories declared (agents/config.json `principles` is empty); nothing to apply"
      : `${domains.length} principle domain(s)`;
  return { ok: true, action: "list", exitCode: 0, message, detail: { domains } };
}
