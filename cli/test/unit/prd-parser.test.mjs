// Code-span-aware markdown table parsing (prd_parser.js). Live-session
// evidence: a naive split("|") truncated a verification table cell at the
// `||` inside `bash -c "... || exit 1; done"`, and the truncated command was
// still valid shell - so plan-verification passed it and the session hit two
// verify-run contract rejections before diagnosing. A `|` inside a backtick
// code span is command text, never a cell boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseMarkdownTableRow,
  splitTableRow,
  extractCodeSpans,
  cleanTableCell,
  parseVerification,
  parseFrontmatterBlock,
  stripFrontmatter,
} = require("../../lib/prd_parser.js");

// One frontmatter grammar for every reader (2026-08-30 unification). Before
// it, prelint's copy truncated `topic: fix #42` to "fix" and dropped a
// `c#-migration` key entirely, while this file's copy turned
// `"approved"  # note` into `approved"  # note` - a value implement start
// would refuse on a genuinely approved PRD.
test("frontmatter: a quoted value keeps its trailing comment out of the value", () => {
  const doc = '---\nhuman_approval: "approved"  # user 2026-08-29 verbatim: "승인~"\n---\nbody';
  assert.deepEqual(stripFrontmatter(doc).frontmatter, { human_approval: "approved" });
});

test("frontmatter: an unquoted value containing '#' is taken whole, never truncated", () => {
  const doc = "---\ntopic: fix #42 crash\nsource_intake: runs/2026#3\n---\nbody";
  const block = parseFrontmatterBlock(doc);
  assert.deepEqual(
    block.entries.map((entry) => [entry.key, entry.value, entry.line]),
    [["topic", "fix #42 crash", 2], ["source_intake", "runs/2026#3", 3]],
  );
  assert.equal(block.body, "body");
});

test("frontmatter: a document without a block parses as no frontmatter", () => {
  assert.equal(parseFrontmatterBlock("# just a doc"), null);
  assert.deepEqual(stripFrontmatter("# just a doc"), { frontmatter: {}, body: "# just a doc" });
});

// The exact live repro command, pipes and all.
const LIVE_COMMAND = 'bash -c "for f in $(git diff --name-only); do node --check \\"$f\\" || exit 1; done"';

test("pipes inside a backtick code span survive the cell split (live repro)", () => {
  const row = `| V2 | build/static | R2 | \`${LIVE_COMMAND}\` | command-log | exits zero | yes | no |`;
  const cells = parseMarkdownTableRow(row);
  assert.equal(cells.length, 8);
  assert.equal(cells[3], `\`${LIVE_COMMAND}\``, "the || must not become a cell boundary");
  assert.equal(cells[4], "command-log");
});

test("escaped \\| still splits into one cell and unescapes to a literal pipe", () => {
  assert.deepEqual(parseMarkdownTableRow("| a \\| b | c |"), ["a | b", "c"]);
});

test("plain cells are unaffected", () => {
  assert.deepEqual(parseMarkdownTableRow("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(parseMarkdownTableRow("| --- | :---: | ---: |"), ["---", ":---:", "---:"]);
});

test("multi-backtick spans keep their pipes and inner backticks (CommonMark length match)", () => {
  assert.deepEqual(
    parseMarkdownTableRow("| x | ``cmd | with ` tick`` | y |"),
    ["x", "``cmd | with ` tick``", "y"],
  );
});

test("an unmatched backtick run is literal text, so later pipes still delimit", () => {
  assert.deepEqual(parseMarkdownTableRow("| a `b | c |"), ["a `b", "c"]);
});

test("splitTableRow returns raw uncleaned cells", () => {
  assert.deepEqual(splitTableRow("**a** | `b \\| c`"), ["**a** ", " `b \\| c`"]);
});

test("extractCodeSpans reports span contents and unmatched openers", () => {
  assert.deepEqual(extractCodeSpans("run `a | b` and ``c ` d``"), {
    spans: ["a | b", "c ` d"],
    unmatched: 0,
  });
  assert.deepEqual(extractCodeSpans("run `npm test now"), { spans: [], unmatched: 1 });
  assert.deepEqual(extractCodeSpans("no spans at all"), { spans: [], unmatched: 0 });
});

test("cleanTableCell protects code-span content from cosmetic transforms", () => {
  // ** is a real glob fragment inside a command, bold markers outside it.
  assert.equal(
    cleanTableCell('**run** `node --test "cli/test/**/*.test.mjs"`'),
    'run `node --test "cli/test/**/*.test.mjs"`',
  );
  // \| unescapes everywhere - GFM requires the escape even inside code spans.
  assert.equal(cleanTableCell("`grep a \\| b` and a \\| b"), "`grep a | b` and a | b");
  // <br> and &nbsp; still normalize outside spans.
  assert.equal(cleanTableCell("a<br>b `x<br>y`"), "a; b `x<br>y`");
});

test("parseVerification keeps only semantic matrix fields", () => {
  const section = [
    "### 9.2 Required Agent Verification",
    "",
    "| ID | Mode | Covers | Method | Artifact | Pass Intent | Required For Done | Can Be Blocked |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    `| V1 | build/static | R1 | Run \`${LIVE_COMMAND}\` | command-log | exits zero | yes | no |`,
    "",
  ].join("\n");
  const items = parseVerification(section);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "V1");
  assert.equal(items[0].matrix.method, undefined);
  assert.equal(items[0].matrix.artifact, undefined);
  assert.equal(items[0].matrix.passCriteria, "exits zero");
});

test("parseVerification preserves an approved side-effect boundary without treating it as an executor", () => {
  const section = [
    "### 9.2 Required Agent Verification",
    "",
    "| ID | Mode | Covers | Pass Intent | Required For Done | Can Be Blocked | Allowed Side Effect | Sensitive Data Policy |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| V1 | live external API | R1, AC1 | sandbox behavior is proven | no | yes | sandbox record only when approved | redact tokens |",
    "",
  ].join("\n");
  const [item] = parseVerification(section);
  assert.equal(item.matrix.sideEffect, "sandbox record only when approved");
  assert.equal(item.matrix.sensitiveDataPolicy, "redact tokens");
});

