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
Compatibility checks consumed arguments, options, native argument forwarding, response envelopes and guaranteed answer fields.
Compatible additional commands, optional options and answer fields are accepted.
A minimum version number or a match against one whole-contract digest does not establish compatibility.
The digest connects the two installed-binary responses; the structural comparison determines compatibility.

The public Hide export at commit `72c2113f29b74d60897e62c33031f32a977c6118` does not yet advertise the caller command currently consumed by Sasu, guarantee the presence of the nullable participant fields, or constrain runtime values to the enum its parser accepts.
The diagnostic therefore reports unsupported compatibility for that export.
The caller contract must be published and adopted in the requirement declaration and runtime client before compatibility can pass.
This diagnostic does not replace or bypass runtime authority checks.
