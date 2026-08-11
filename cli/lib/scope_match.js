"use strict";

/**
 * Minimal glob dialect for §8 `Scope:` tails, shared by the lib-side freshness
 * scoping (git.js vouchedTreeFingerprint). Semantics are identical to the TS
 * gate's matchesScopeGlob (cli/src/gates/commands.ts): `**` crosses
 * directories, `*` and `?` stay within one path segment, and a bare path with
 * no wildcard matches itself or anything under it, like a git pathspec.
 * Deliberately no brace/negation support - prelint rejects characters outside
 * this dialect.
 *
 * The duplication is one-way and temporary: commands.ts is owned by a later
 * consolidation wave and will migrate onto this module; until then the two
 * copies must not drift.
 */
function matchesScopeGlob(file, glob) {
  const normalized = String(file || "").replace(/\\/g, "/");
  const cleaned = String(glob || "").replace(/\/+$/, "");
  if (!/[*?]/.test(cleaned)) {
    return normalized === cleaned || normalized.startsWith(`${cleaned}/`);
  }
  let pattern = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (char === "*") {
      if (cleaned[i + 1] === "*") {
        // `**/` may match zero directories; bare `**` swallows anything.
        pattern += cleaned[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += cleaned[i + 2] === "/" ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`).test(normalized);
}

module.exports = { matchesScopeGlob };
