import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function contractVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

export type BuildIdentity =
  | { status: "available"; commit: string; dirty: boolean }
  | { status: "unavailable"; reason: "git-unavailable" | "metadata-missing" | "metadata-invalid" };

/** Never consult runtime Git: an installed build can outlive its source HEAD. */
export function buildIdentity(): BuildIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"));
  } catch (error) {
    return { status: "unavailable", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "metadata-missing" : "metadata-invalid" };
  }
  if (raw !== null && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (value.status === "available" && typeof value.commit === "string" && /^[a-f0-9]{40,64}$/.test(value.commit) && typeof value.dirty === "boolean") {
      return { status: "available", commit: value.commit, dirty: value.dirty };
    }
    if (value.status === "unavailable" && value.reason === "git-unavailable") return { status: "unavailable", reason: "git-unavailable" };
  }
  return { status: "unavailable", reason: "metadata-invalid" };
}

export function buildIdentityLine(build: BuildIdentity = buildIdentity()): string {
  return build.status === "available" ? `build commit: ${build.commit} (dirty: ${build.dirty})` : `build provenance unavailable: ${build.reason}; rebuild from a Git checkout`;
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
