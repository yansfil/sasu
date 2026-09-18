# Observer supervisor - implementation evidence

Run `sasu-observer-supervisor`, branch `prd/sasu-observer-supervisor`, evidence collected 2026-09-18 by the Implementor session in pane w8H:p1.

| File | What it proves |
| --- | --- |
| `herdr-measurements.md` | The Herdr 0.9.1 facts the adapter is built on: `agent get` shape, `agent_not_found`, guard flag unsupported, terminal id rotation. |
| `real-domain-untouched.txt` | After the whole check order and the mutation pass, no LaunchAgent, plist, supervisor index or Stop hook exists in the real user domain. |
| `evidence/check-head.txt` | The head and wall-clock window of the final check order. |
| `evidence/check-build.log`, `check-root.log`, `check-unit.log`, `check-e2e.log`, `check-tsc.log` | The four required commands plus `tsc --noEmit` on that head: build 0, root 97/97, unit 474/474, e2e 86/86, tsc 0. |
| `evidence/check2-*.log`, `check2-head.txt` | The same check order on the source of the D-15 fix (head 751e593): build 0, root 97/97, unit 475/475, e2e 87/87, tsc 0. |
| `reviews/round-1-*.md` | Native Fidelity, Code and Security review reports for head 00fd068. Fidelity's one Fix now item (D-15 recovery owner not surfaced) is fixed in the following commit; Code and Security found nothing to fix. |
| `evidence/mutation.log` | Five planted bugs in `decide.ts` and `tick.ts`; four killed by the predicted tests, the fifth (stall reported beside settled) survived and gained the B6/B8 assertion that is red under it. |

Unrun: a real launchd bootstrap of `com.sasu.supervisor` into `gui/501`.
The install path is exercised only through the fake `launchctl` in the isolated HOME; the real load happens after the human merge and global installation.
