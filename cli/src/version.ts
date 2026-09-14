import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function contractVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

let buildDigest: string | null = null;

/**
 * sha256 of every JavaScript file in this build, by relative path and bytes.
 *
 * The review policy needs to name the code that shaped a judgment - the
 * prompts, the validators, the judge invocation - and the version string does
 * not: it moves when a person bumps it, and on 2026-09-14 the prompt and
 * validator modules changed under an unchanged 0.10.0. A list of "the modules
 * that matter" would be a second thing to keep in step with the code
 * (PRINCIPLES 13), so the whole build is the identity. The cost is one full
 * round after a CLI install mid-run, which is the conservative direction.
 * Computed once per process; tsc output carries no timestamp, so the same
 * source builds to the same digest.
 */
export function buildSha256(): string {
  if (buildDigest !== null) return buildDigest;
  const root = __dirname;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(absolute);
    }
  };
  walk(root);
  const hash = crypto.createHash("sha256");
  for (const file of files.map((entry) => path.relative(root, entry)).sort()) {
    hash.update(file.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  buildDigest = hash.digest("hex");
  return buildDigest;
}
