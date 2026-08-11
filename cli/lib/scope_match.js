"use strict";

/**
 * Minimal glob dialect for §8 `Scope:` tails - the single implementation,
 * shared by the lib-side freshness scoping (git.js vouchedTreeFingerprint)
 * and the TS gate (cli/src/gates/commands.ts requires and re-exports it):
 * `**` crosses directories, `*` and `?` stay within one path segment, and a
 * bare path with no wildcard matches itself or anything under it, like a git
 * pathspec. Deliberately no brace/negation support - prelint rejects
 * characters outside this dialect.
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
