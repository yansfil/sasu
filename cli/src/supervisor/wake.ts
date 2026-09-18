import type { Candidate } from "./decide";

/**
 * The wake is an identity note, not an instruction (D-07). It names the run
 * instance, the Observer session it is addressed to and the reasons, and
 * points at the one command that turns it into facts. A session that is not
 * the addressed Observer and runs that command is refused by ownership and
 * nothing changes (B10). No transcript, no prompt content, no judgment.
 */
export const WAKE_MARKER = "SASU_WAKE";

export interface WakeLine {
  slug: string;
  runInstanceId: string;
  reasons: Candidate[];
}

export function renderWake(observerSessionId: string, lines: WakeLine[]): string {
  const body = [WAKE_MARKER, `observer: ${observerSessionId}`];
  for (const line of lines) {
    body.push(`run: ${line.slug} instance ${line.runInstanceId}`);
    body.push(`reason: ${line.reasons.map((entry) => entry.reason).join(", ")}`);
    for (const entry of line.reasons) body.push(`  ${entry.reason}: ${entry.detail}`);
    body.push(`inspect: sasu implement status --slug ${line.slug} --digest`);
  }
  return body.join("\n");
}
