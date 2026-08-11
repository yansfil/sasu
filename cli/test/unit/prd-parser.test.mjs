// Code-span-aware markdown table parsing (prd_parser.js). Live-session
// evidence: a naive split("|") truncated a Verification Method cell at the
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
} = require("../../lib/prd_parser.js");

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

test("parseVerification carries the full Method command into the matrix (end to end)", () => {
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
  assert.equal(items[0].matrix.method, `Run \`${LIVE_COMMAND}\``);
  assert.equal(items[0].matrix.artifact, "command-log");
});
