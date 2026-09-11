// Real CLI boundary through a pipe, the way every daemon and shell reads it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeProject, run, PRD_PATH } from "../helpers/implement-fixture.mjs";

// stdout to a pipe is asynchronous on macOS, so a CLI that calls process.exit
// right after writing a large document leaves everything past the kernel's
// 64 KiB pipe buffer unwritten while still exiting 0. Measured 2026-09-10:
// `sasu implement status --json | wc -c` gave exactly 65536 of a 194,916-byte
// record, and the daemon reading it failed to parse. The fixture helper reads
// the child through a pipe exactly as that daemon did.
test("a --json document larger than the pipe buffer arrives whole through a pipe", (t) => {
  const root = makeProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, ["implement", "start", "--prd", PRD_PATH, "--allow-unapproved-prd"]).status, 0);
  fs.writeFileSync(path.join(root, "evidence.txt"), "x");
  const registered = run(root, ["implement", "artifact", "--kind", "file", "--path", "evidence.txt", "--description", "d".repeat(220_000), "--issuer", "implementor"]);
  assert.equal(registered.status, 0, registered.stdout);

  const status = run(root, ["implement", "status"]);
  assert.equal(status.status, 0);
  const bytes = Buffer.byteLength(status.stdout);
  assert.ok(bytes > 200_000, `the record must exceed the 65,536-byte pipe buffer by a wide margin to prove anything; got ${bytes}`);
  assert.equal(status.json.action, "status", "the whole document parsed as JSON, so nothing was cut at the pipe buffer");
  assert.ok(status.stdout.endsWith("}\n"), "the last byte written is the last byte received");
});
