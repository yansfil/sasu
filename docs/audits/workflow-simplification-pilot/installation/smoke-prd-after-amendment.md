---
topic: "installed workflow smoke"
status: "ready"
human_approval: "pending"
review_profile: "standard"
review_rationale: "A real installed CLI implementation of this library needs one bounded semantic review."
source_intake: "current conversation"
---

# PRD: Installed workflow smoke

## Goal

Provide a tiny local link-normalization library that returns canonical HTTP(S) links and rejects the invalid inputs specified below.

## Non-goals

Do not add persistence, a browser interface, network access, dependencies, delivery, or compatibility behavior.

## Decisions

| D-n | 결정 | 근거 |
| --- | --- | --- |
| D-01 | The library returns a plain object with a canonical URL and trimmed title. | A small deterministic value gives the suite and runtime observation an external expected answer. |
| D-02 | Invalid schemes and blank titles fail with stable caller-visible `TypeError` messages. | Explicit failures prove the implementation is wired and do not hide invalid input. |

## Behaviors

| # | 사용자가 관찰하는 행동 | 결정 |
| --- | --- | --- |
| B1 | Calling `normalizeLink` with surrounding whitespace, a mixed-case HTTP(S) host, and a fragment returns a new `{ url, title }` object with whitespace trimmed, the hostname canonicalized by the URL standard, the fragment removed, and the path and query preserved. | D-01 |
| B2 | Calling `normalizeLink` with a non-HTTP(S) URL throws `TypeError: Only http and https links are supported.`; calling it with a blank title throws `TypeError: Title is required.`. | D-02 |

## Technical structure

Implement the public named export `normalizeLink` in `src/link-pocket.mjs`.
The committed Node suite and observation script are callers of that module.

## Risks

The smoke could become a false pass if the required suite is weakened, the public module is stubbed, the run starts after implementation already exists, a diagnostic judge override is inherited, or an old runtime session is mistaken for fresh installed-skill discovery.
