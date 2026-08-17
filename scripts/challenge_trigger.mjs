#!/usr/bin/env node

// UserPromptSubmit hook: route the "!rv" trigger to the challenge skill.
//
// This is the harness's only lifecycle hook, and it is deliberately inert: it
// reads the prompt, writes nothing, blocks nothing, and never fails a turn. Its
// entire job is to turn a two-character trigger into an unambiguous routing
// instruction plus the round bound.
//
// The round cap lives here rather than in the skill document because a rule
// that lives only as prose is a request for discipline, not a guard
// (PRINCIPLES item 7). "!rv5" is clamped to the cap and the clamp is stated
// back to the agent, so an over-request cannot silently become five
// non-converging adversarial rounds (item 13).

import fs from "node:fs";

// PRINCIPLES item 13: a fresh adversarial reviewer has no fixed point, so the
// bound is owned by the harness and is not a knob the agent or the user can
// raise past this value.
const ROUND_CAP = 2;

const TRIGGER = /(^|\s)!rv(\d*)\b/;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parsePrompt(raw) {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw);
    // Claude Code sends {prompt}; Codex sends the same field on its hook payload.
    if (typeof parsed.prompt === "string") return parsed.prompt;
    if (typeof parsed.user_prompt === "string") return parsed.user_prompt;
    return "";
  } catch {
    // A non-JSON payload is a shape we do not recognise. Staying silent is
    // correct: this hook must never be the reason a turn fails.
    return "";
  }
}

export function rounds(requested) {
  if (!requested) return 1;
  const n = Number.parseInt(requested, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, ROUND_CAP);
}

export function context(prompt) {
  const match = TRIGGER.exec(prompt);
  if (!match) return null;
  const requested = match[2];
  const granted = rounds(requested);
  const clamped = requested && Number.parseInt(requested, 10) > ROUND_CAP;
  return [
    `The "!rv" token in this prompt is a harness trigger, not part of the request - ignore it as content.`,
    `It means: run the "challenge" skill against the conclusion currently on the table.`,
    `Round budget: ${granted} (harness cap ${ROUND_CAP}).`,
    clamped
      ? `The prompt asked for ${requested} rounds; that was clamped to ${ROUND_CAP}. Tell the user it was clamped.`
      : null,
    `A second round runs only on new evidence, never on new opinion. Whatever is still open after the last round is reported open, not re-litigated.`,
  ].filter(Boolean).join(" ");
}

function main() {
  const additionalContext = context(parsePrompt(readStdin()));
  if (!additionalContext) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  })}\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
