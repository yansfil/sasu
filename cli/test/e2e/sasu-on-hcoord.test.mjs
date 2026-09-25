// Sasu supervision on hcoord at the real CLI boundary: an isolated HOME, a
// fake herdr and a fake launchctl on PATH, and a test-owned hcoord daemon.
// No test reaches a live pane, the live daemon, or the real launchd domain.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { installFakeLaunchctl } from "../helpers/fake-herdr.mjs";

const HCOORD = path.resolve(import.meta.dirname, "../../dist/hcoord/cli.js");

test("daemon start after a manual stop kickstarts the still-loaded label instead of failing its bootstrap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcoord-launchd-"));
  const launchctl = installFakeLaunchctl(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, PATH: launchctl.env.PATH, LAUNCHCTL_FAKE_LOG: launchctl.log, LAUNCHCTL_FAKE_STATE: launchctl.stateFile };
  delete env.HCOORD_HOME;
  const start = () => spawnSync(process.execPath, [HCOORD, "daemon", "start", "--json"], { env, encoding: "utf8" });
  const first = start();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // `hcoord daemon stop` leaves the label loaded (KeepAlive keeps a clean exit down) and writes the marker.
  fs.writeFileSync(path.join(home, ".hcoord", "manual-stop"), "stopped\n");
  const again = start();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).ok, true);
  const asked = launchctl.argv().map((args) => args[0]);
  assert.deepEqual(asked.filter((verb) => verb === "bootstrap").length, 1, "a loaded label is never bootstrapped a second time");
  assert.equal(launchctl.state().kicked, 2, "each start asks launchd to run the loaded label");
  assert.equal(fs.existsSync(path.join(home, ".hcoord", "manual-stop")), false, "start clears the manual stop");
});
