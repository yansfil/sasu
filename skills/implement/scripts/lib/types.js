// @ts-check
"use strict";

// JSDoc typedefs for the hoyeon.prd-implement.state.v1 schema and the
// documents derived from it. Runtime-empty: modules import these types with
// `@typedef {import("./types").State} State` style annotations so editors and
// `tsc --checkJs` can catch state-field typos without a TypeScript migration.

/**
 * @typedef {Object} Evidence
 * @property {string} ts ISO timestamp
 * @property {string} text
 */

/**
 * @typedef {Object} Artifact
 * @property {string} kind screenshot|log|browser|api|db|file
 * @property {string} path project-relative path
 * @property {string} [description]
 * @property {string} [sha256]
 * @property {number} [bytes]
 * @property {string} [recordedAt]
 * @property {string} [createdAt]
 */

/**
 * Task (T#), acceptance criterion (AC#), or requirement (R#) parsed from the PRD.
 * @typedef {Object} TrackedItem
 * @property {string} id
 * @property {string} title
 * @property {string} text
 * @property {string[]} requirements referenced R# ids
 * @property {string[]} acceptanceCriteria referenced AC# ids
 * @property {string} status
 * @property {Evidence[]} evidence
 * @property {Artifact[]} artifacts
 */

/**
 * @typedef {Object} VerificationMatrix
 * @property {string} mode
 * @property {string} covers
 * @property {string} method
 * @property {string} artifact
 * @property {string} passCriteria
 * @property {string} environment
 * @property {boolean} requiredForDone
 * @property {string} requiredForDoneRaw
 * @property {boolean} canBeBlocked
 * @property {string} canBeBlockedRaw
 * @property {string} safeProbe
 * @property {string} liveProof
 * @property {string} sideEffect
 * @property {string} sensitiveDataPolicy
 */

/**
 * @typedef {Object} VerificationItem
 * @property {string} id V# id
 * @property {string} level
 * @property {string} title
 * @property {string} text
 * @property {string} status pending|pass|fail|skipped|blocked
 * @property {Evidence[]} evidence
 * @property {Artifact[]} artifacts
 * @property {"verification_matrix"|"verification_bullet"|"verification_section"} source
 * @property {VerificationMatrix|null} [matrix]
 * @property {string} [testMode]
 */

/**
 * Row of the PRD 9.1 Test Mode Contract table.
 * @typedef {Object} TestModeRow
 * @property {string} id TM# id
 * @property {string} mode
 * @property {string} normalizedMode
 * @property {boolean} requiredForDone
 * @property {string} requiredForDoneRaw
 * @property {boolean} canBeBlocked
 * @property {string} covers
 * @property {string} humanDecision
 */

/**
 * @typedef {Object} ExecutionNode
 * @property {string} id N# id
 * @property {string} title
 * @property {string} status pending|in_progress|complete|blocked|deferred
 * @property {string} sourceTask T# id
 * @property {string[]} dependsOn
 * @property {string[]} writeScope
 * @property {boolean} parallelSafe
 * @property {string} risk low|medium|high
 * @property {string|null} owner
 * @property {{requirements: string[], acceptanceCriteria: string[], verification: string[]}} covers
 * @property {Evidence[]} evidence
 * @property {Artifact[]} artifacts
 */

/**
 * @typedef {Object} PlanGap
 * @property {string} severity "blocking" or a warning level
 * @property {string} id
 * @property {string} message
 */

/**
 * @typedef {Object} VerificationPlan
 * @property {string} status
 * @property {string} generatedAt
 * @property {Array<Object>} checks planned checks keyed by verificationId
 * @property {PlanGap[]} gaps
 * @property {Object} [coverage]
 * @property {string} [contractHash]
 */

/**
 * @typedef {Object} ExecutionPlan
 * @property {string} status
 * @property {string} generatedAt
 * @property {ExecutionNode[]} nodes
 * @property {PlanGap[]} gaps
 * @property {Object} [traceMatrix]
 */

/**
 * Recorded review gate (requirements fidelity or adversarial final review).
 * A passing review flips to "stale" when later evidence invalidates it.
 * @typedef {Object} ReviewRecord
 * @property {"pass"|"fail"|"stale"} status
 * @property {string} summary
 * @property {string} reportPath
 * @property {number} reportBytes
 * @property {string} reportSha256
 * @property {Object} worktreeSnapshot
 * @property {string} recordedAt
 * @property {string} [staleAt]
 * @property {string} [staleReason]
 */

/**
 * @typedef {Object} Deviation
 * @property {string} id D# id
 * @property {string} ts
 * @property {string} type
 * @property {string} targetId
 * @property {string} summary
 * @property {Object} details
 */

/**
 * @typedef {Object} ReviewProfile
 * @property {"trivial"|"standard"|"high-risk"} profile
 * @property {string} source
 * @property {string} [reason]
 * @property {string[]} [signals]
 * @property {number} [policyVersion]
 */

/**
 * The persisted state.json document (hoyeon.prd-implement.state.v1).
 * @typedef {Object} State
 * @property {string} schema
 * @property {string} status active|complete|partial|blocked
 * @property {string} topicSlug
 * @property {string} projectRoot
 * @property {string} prdPath project-relative
 * @property {string|null} prdStatus
 * @property {{source: string, value: string|null, overrideNote: string|null, recordedAt: string}} prdApproval
 * @property {Object} prdSnapshot ids and hashes captured at init
 * @property {string} runDir project-relative run directory
 * @property {Object} delivery normalized delivery config + worktree preparation
 * @property {ReviewProfile} reviewProfile
 * @property {Object|null} [initialWorktreeSnapshot] git worktree baseline captured at init
 * @property {Object} execution normalized execution config
 * @property {Object} intentTrace decision trace snapshot captured at init
 * @property {string} technicalStructure
 * @property {string} implementationNotes
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} activeSessionId
 * @property {TrackedItem[]} tasks
 * @property {TrackedItem[]} acceptanceCriteria
 * @property {TrackedItem[]} requirements
 * @property {VerificationItem[]} verification
 * @property {TestModeRow[]} testModeContract
 * @property {VerificationPlan|null} verificationPlan
 * @property {ExecutionPlan|null} executionPlan
 * @property {Object|null} taskGraph
 * @property {Deviation[]} deviations
 * @property {ReviewRecord|null} requirementsFidelityReview
 * @property {ReviewRecord|null} finalReview
 * @property {Object|null} finalReceipt
 */

/**
 * The .prd-implement-active.json pointer record.
 * @typedef {Object} ActiveRecord
 * @property {string} schema hoyeon.prd-implement.active.v1
 * @property {boolean} [pointer]
 * @property {string} statePath
 * @property {string} [prdPath]
 * @property {string} [runDir]
 * @property {string} [status]
 * @property {Object} [delivery]
 * @property {string|null} [activeSessionId]
 * @property {string} updatedAt
 */

module.exports = {};
