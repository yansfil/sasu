import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureHooks, removeHooks } = require("../../lib/hooks.js");
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sasu-hooks-")), "settings.json");

test("mixed matchers retain foreign commands and matcher metadata when harness hooks are reconciled", () => {
  const target = file();
  fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [{ matcher: "tool", custom: { keep: true }, hooks: [
    { type: "command", command: "/mine/supervisor_stop.mjs", timeout: 10 },
    { type: "command", command: "/foreign/check.sh", timeout: 30 },
  ] }] }, unrelated: 7 }));
  removeHooks(target, ["supervisor_stop.mjs"]);
  let parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(parsed.hooks.Stop, [{ matcher: "tool", custom: { keep: true }, hooks: [{ type: "command", command: "/foreign/check.sh", timeout: 30 }] }]);
  assert.equal(parsed.unrelated, 7);

  ensureHooks(target, { Stop: "/new/supervisor_stop.mjs" });
  parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(parsed.hooks.Stop[0], { matcher: "tool", custom: { keep: true }, hooks: [{ type: "command", command: "/foreign/check.sh", timeout: 30 }] });
  assert.equal(parsed.hooks.Stop[1].hooks[0].command, "/new/supervisor_stop.mjs");
});
