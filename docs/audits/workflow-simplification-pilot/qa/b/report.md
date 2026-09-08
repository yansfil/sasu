# Candidate B independent browser QA

**Verdict: PASS.**

The frozen candidate at Git HEAD `0f2e1b20d644be9c897904c6900c6b9da16f7808` completed the bounded browser QA without a product defect or blocking evidence gap.
The 20-file source inventory matched byte for byte before and after the drive, with aggregate SHA-256 `0b2aa9ddf2609a6e5f751ba4f80f7f68d6d9c05962d0b19684a820cfe2ec234d`.
No project suite or judge was invoked.
The plugin-managed pane entrypoint exited immediately on fresh panes, so the drive used a new raw split from `w72:p1` running the same official Browser viewer with its exact plugin environment, then attached Chromux through that view-only CDP contract.
This preserved the required Browser and Chromux route without touching the foreign view.

Real pointer and keyboard interaction covered creation, validation, normalized tags, editing, Escape dismissal, Enter submission, reload persistence, free-text search, tag filtering, no-results recovery, delete, timed undo, deletion persistence, malformed-storage retry, explicit reset confirmation, and 360 CSS px operation.
The first undo attempt was made after the advertised 10-second window and correctly had no actionable button; a fresh deletion followed immediately by the real Undo button restored the full entry.
The malformed payload remained byte-identical after Retry and remained present until the explicit `Delete saved data` confirmation was clicked.

A browser-only fault replaced `Storage.prototype.setItem` so the real storage write threw `QuotaExceededError` when `Save link` was clicked.
The app kept the modal open, preserved title, URL and note inputs, kept the two existing rows unchanged, and displayed both status and inline error feedback.
The fault was restored before the malformed-data drive.

At 360 CSS px, the Add button accepted a real pointer click and Escape closed the focused modal through the keyboard.
A link with a long unbroken URL and tag was created through the form; the primary actions stayed visible, content wrapped inside the card, and measured widths were `innerWidth=360`, `documentElement.scrollWidth=360`, and `body.scrollWidth=360`.
The desktop empty state, populated save-failure state, malformed-data state, mobile modal, and long-content mobile state were visually coherent and distinct.
No console errors or failed network requests were captured during the drive.

Evidence:

- `desktop-empty.png`
- `save-failure.png`
- `malformed.png`
- `mobile-360-empty.png`
- `mobile-360-modal.png`
- `mobile-360-long-content.png`
- `source-before.json`
- `source-after.json`
- `browser-connect.json`
- `resources.json`

The owned Vite listener on port 42842, Herdr pane `w72:pD`, Browser view `4b196559-f859-4ea6-bfed-5f9ab5cf1f55`, Chromux attachment, and its external daemon were stopped or closed.
The foreign Browser pane `w72:p6`, view `e1ec6036-f0e3-448d-b3c0-28dc3e2b54e7`, and server on port 42831 remained intact.
