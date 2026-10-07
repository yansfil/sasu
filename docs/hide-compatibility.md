# Build provenance and Hide compatibility

`sasu version --json` reports the Sasu package version, the Git commit and dirty state frozen at build time, and the required Hide contract declaration.
`sasu --version` prints the same identity in a readable form.
`sasu --contract-version` retains its existing plain package-version response for installer probes.
Moving the build, changing the source checkout's HEAD, or running from another project's checkout does not change its build provenance.
Builds outside Git and missing or damaged build metadata report provenance as unavailable and make the version command exit unsuccessfully.

`sasu doctor --json` includes the frozen build identity and the installed Hide version, commit, contract digest and compatibility result in its `contract` section.
It performs only bounded `hide version --json` and `hide contract --json` queries.
Missing executables, invalid responses, mismatched contract digests, unsupported formats and incompatible command or answer structures fail explicitly.
External stderr and credential values are not copied into the report.

The required surface lives in `cli/src/hide-compatibility.ts` beside its structural comparison.
Compatibility checks consumed arguments, options, native argument forwarding, response envelopes, guaranteed answer fields and declared command-specific refusals.
Compatible additional commands, optional options, answer fields and refusal codes are accepted.
A minimum version number or a match against one whole-contract digest does not establish compatibility.
The digest connects the two installed-binary responses; the structural comparison determines compatibility.

The consumed caller command is `hide agent show here`, with no positional arguments and the normal `agent` response envelope.
Its published contract guarantees the participant fields consumed by Sasu, including nullable `parent` and `project`, and the `running`/`ended` runtime enum.
The required refusal codes cover a caller outside an agent pane, conflicting caller identity, unavailable or ended participants, changed sessions and ambiguous participants.
Removing or renaming a required code fails compatibility.
Hide commit `3245fec3` renamed `pane_capability_required` to `agent_pane_required` when it began refusing checkout-bound callers for delivery and agent commands, so Sasu requires the new code and builds that predate it report `HIDE_CONTRACT_UNSUPPORTED`.
The published refusal list is not exhaustive, and Sasu rejects every failed response, so additional refusal codes remain compatible.

The regression fixtures retain the older public export at commit `72c2113f29b74d60897e62c33031f32a977c6118`, which fails compatibility, and the published caller export, which passes the structural comparison.
`cli/test/fixtures/hide-contract/published-caller.provenance.json` records the new fixture's source commit, public file hash, contract digest and projection hash.
Native runtime acceptance still requires running the actual merged candidate; a passing comparison of the exported contract alone does not establish it.
