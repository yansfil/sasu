# Judge trace fixtures

Real backend output, kept here so the metering functions are tested against the
shape the CLI actually emits rather than only against traces we wrote
ourselves. A synthetic trace pins boundary conditions; it cannot notice the
CLI changing its format, and a metering function that silently returns 0 after
such a change passes the char budget (0 < the limit) while measuring nothing.

## claude-stream-imgfirst1-excerpt.jsonl

- **Source**: `agents/benchmarks/max-turns-20260910/results/imgfirst1-fidelity.stream.jsonl`, a production fidelity review run 2026-09-10 against claude 2.1.267 with `--output-format stream-json --verbose`.
- **Lines taken**: 1-43, 326-330 and 614 of that file (1-indexed), in that order - the opening `system` init through the first text read after the screenshots, then the Grep turn and the read beside it, then the terminal `type: "result"` record. The second range is there for a shape the first does not have: a `tool_result` whose `content` is a plain string rather than a list of blocks, which is the shape real reads actually use. Censused over all 24 traces on disk: 600 string bodies against 75 list bodies, and every one of those lists is images with no text block in it - so the branch the written fixtures exercise is the one production never takes. The excerpt has 4 string bodies, and they carry all 52,820 of its metered chars.
- **Edited**: every `base64` and `data` string value is replaced with `iVBORw0KGgo=`. Only the values change. The keys stay, because the metering unit is defined by the key it walks and not by a category: an image record and a text read both hang a `file` object off `tool_use_result`, and the only thing separating them is `file.base64` against `file.content`. An excerpt that dropped the image keys would stop testing the distinction that matters.
- **Preserved**: 8 `image` blocks inside `tool_result` content, both `file` shapes above, `rate_limit_event` and `thinking_tokens` events, assistant turns carrying `thinking`, `text` and two `tool_use` blocks at once.
- **Nothing else is edited.** The text of every read is intact, which is why the char count below is a real one.

Expected values, computed by a separate walker (`agents/**` is not a judged
input, so the derivation is recorded here rather than kept as a script): read
output 52,820 chars over 12 tool calls, against a `num_turns` of 45 in the
terminal record. The last two differ on purpose - a fixture where they matched
could not catch a regression to the old `num_turns - 1` unit.

What this fixture cannot show: the *size* argument for excluding image
payloads. The base64 values here are 12-char dummies totalling 96 chars, so the
4,131,584-against-395,260 comparison in `claudeReadChars`' own comment is
reproducible only from the original trace. The assertion on this fixture is an
exact equality for the same reason - on the image axis its margin is 0.18%,
and a bound would not notice.

To refresh after a CLI format change: re-cut the same line ranges from a fresh
trace, re-run the two counts, and update the constants in
`cli/test/unit/backends.test.mjs` from the new numbers rather than from the
functions under test.
