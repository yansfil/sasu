# Candidate A independent browser QA

Verdict: **INCONCLUSIVE for the moving final tree; PASS for the observed core flows and targeted repaired boundaries on their recorded source identities.**

## Source identity

- Initial full-flow observation: Git `0f2e1b20d644be9c897904c6900c6b9da16f7808`, aggregate `fbb191b39bf05194bc71f178fa7940f1e7a5a2cfe10528ccb96423a5853b40ac`. The complete 11-file inventory is in `source-before.json`.
- Later targeted observation after the F1-F8 repair sequence: aggregate `e0179b322d14153c0076ce0dc5d05117ab5a551712d138f3be19d3589a9bcf15`; `src/main.ts` `d025769c95d97895fb82bc206327a60035040ef327ed121dd8c173afb3946726`, `src/style.css` `c3f7eb8266c3dab05ce495db6510fdd7358bad2945efa7ed4f2aa1332c8d0d55`.
- The tree changed again while this report was frozen. The post-observation inventory at 2026-09-08T08:01:04Z is `source-after.json`, aggregate `57d2150cd4689b41d72b0f23848d170ab39475c7a1189594d92d96ca960f26a1`; it was not interactively requalified. This includes `src/main.ts` `4a76dc9217af0de65cad4d3853b0a8033166b0b41c9587ec5159fcf1287b07e1` and `tests/startup.spec.ts` `aaf2e40f641cf375a32f16ad1caaf3cce4b7bb3976439b7fc06b02c875bca076`.

## Observations

- On `fbb191...`, actual clicks and keystrokes created two links and survived reload; note search, tag filtering, and note-plus-tag intersection returned the actual expected row and counts; edit reordered the changed item; Copy URL showed success (system clipboard read was browser-denied); Open created the exact URL in a new target with `window.opener === null`; Delete followed immediately by Undo restored the item and survived reload.
- On `e0179...`, true-empty state visibly showed `0 links`. A long tag was created with real form input, selected with an actual desktop click, and then measured at a 360 px viewport: document/body scroll width 360, tag right edge 312.05 px, search right edge 346 px. Capture: `current-mobile-selected-long-tag.png`.
- On `e0179...`, successful create exposed `Link saved.` in the persistent live region. Delete exposed both a visible 10-second Undo bar and `Current Long Resource deleted. Undo is available for 10 seconds.`; actual Undo restored the row and exposed `Current Long Resource restored.`
- On `e0179...`, malformed local data produced the explicit recovery screen and Retry preserved the exact raw malformed value. A MutationObserver saw `Loading saved links.` followed by `Saved links could not be loaded.` during the actual Retry click. Evidence: `current-malformed.png`, `current-malformed-inject.txt`, `current-retry-announcements.txt`.
- On `e0179...`, Enter on an invalid URL kept the draft and focus on the URL field. A real replacement of `Storage.prototype.setItem` threw `QuotaExceededError`; Enter then kept the modal, title, URL, and URL focus, displayed `Link Pocket could not save this change.`, and left storage unchanged. The original prototype was restored. Evidence: `current-invalid-enter-focus.txt`, `current-storage-failure-focus.txt`, `current-storage-restore.txt`.

## Limits

- The required standard Herdr Browser plugin pane was created twice from `w72:p1`, but each view disappeared immediately and the official plugin `views` command timed out. The observations above used the QA-owned standalone Chromux profile against the owned Vite server, so they are browser interaction evidence but not a standard Herdr Browser route PASS.
- Initial loading was not captured reliably by my RAF instrumentation, so I do not independently claim its painted state.
- Exact clipboard contents remain unverified because browser clipboard read permission was denied; the saved URL and visible success feedback were verified.
- Changes after `e0179...`, including the later focus/announcement repair represented by `57d215...`, require targeted reconciliation if they are to inherit this receipt.
