import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installLaunchAgent, kickstart, launchAgentStatus, renderPlist, uninstallLaunchAgent } from "../../dist/supervisor/launchd.js";
import { LAUNCHD_LABEL, launchAgentPlistPath, TICK_INTERVAL_SECONDS } from "../../dist/supervisor/paths.js";

/** A launchctl kept in memory: what is loaded, and every argv asked. */
function fakeLaunchctl() {
  const loaded = new Map();
  const asked = [];
  const run = (args) => {
    asked.push(args.join(" "));
    const label = (target) => String(target).split("/").pop();
    if (args[0] === "print") return loaded.has(label(args[1])) ? { status: 0, stdout: "loaded", stderr: "" } : { status: 113, stdout: "", stderr: `Could not find service "${label(args[1])}"` };
    if (args[0] === "bootstrap") { if (!fs.existsSync(args[2])) return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }; loaded.set(path.basename(args[2], ".plist"), fs.readFileSync(args[2], "utf8")); return { status: 0, stdout: "", stderr: "" }; }
    if (args[0] === "bootout") { loaded.delete(label(args[1])); return { status: 0, stdout: "", stderr: "" }; }
    if (args[0] === "kickstart") return loaded.has(label(args[1])) ? { status: 0, stdout: "", stderr: "" } : { status: 113, stdout: "", stderr: "Could not find service" };
    return { status: 64, stdout: "", stderr: "usage" };
  };
  return { run, asked, loaded };
}

const spec = (home, extra = {}) => ({ node: "/usr/local/bin/node", cli: "/repo/cli/dist/cli.js", home, path: "/opt/homebrew/bin:/usr/bin", ...extra });
const isolated = () => fs.mkdtempSync(path.join(os.tmpdir(), "sasu-launchd-"));

test("the plist runs the tick every interval under the user's own HOME and PATH, and escapes XML", () => {
  const text = renderPlist(spec("/Users/some one", { path: "/a&b:/c<d" }));
  assert.match(text, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(text, /<string>supervisor<\/string>\s*<string>tick<\/string>/);
  assert.match(text, new RegExp(`<key>StartInterval</key>\\s*<integer>${TICK_INTERVAL_SECONDS}</integer>`));
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(text, /KeepAlive/, "no long-lived daemon: launchd starts a fresh tick each interval (D-03)");
  assert.match(text, /<string>\/a&amp;b:\/c&lt;d<\/string>/);
  assert.match(text, /<string>\/Users\/some one\/.sasu\/supervisor\/launchd.log<\/string>/);
  assert.ok(TICK_INTERVAL_SECONDS >= 20 && TICK_INTERVAL_SECONDS <= 30, "the PRD's 20-30 s range");
});

test("B14: install converges - first run writes and bootstraps, a repeat asks launchd nothing, a changed spec reloads, uninstall removes only the label and its plist", () => {
  const home = isolated();
  const env = { HOME: home };
  const launchctl = fakeLaunchctl();
  const environment = { env, launchctl: launchctl.run, uid: 501 };
  const plist = launchAgentPlistPath(env);

  const first = installLaunchAgent(spec(home), environment);
  assert.deepEqual({ plist: first.plist, loaded: first.loaded, problem: first.problem, launchctl: first.launchctl }, { plist: "written", loaded: true, problem: null, launchctl: [`bootstrap gui/501 ${plist}`] });
  assert.equal(fs.existsSync(plist), true);
  assert.deepEqual(launchAgentStatus(environment), { plistPath: plist, installed: true, loaded: true, detail: null });

  const again = installLaunchAgent(spec(home), environment);
  assert.deepEqual({ plist: again.plist, launchctl: again.launchctl, loaded: again.loaded }, { plist: "unchanged", launchctl: [], loaded: true });

  const moved = installLaunchAgent(spec(home, { cli: "/elsewhere/cli.js" }), environment);
  assert.deepEqual({ plist: moved.plist, launchctl: moved.launchctl }, { plist: "written", launchctl: [`bootout gui/501/${LAUNCHD_LABEL}`, `bootstrap gui/501 ${plist}`] });
  assert.match(launchctl.loaded.get(LAUNCHD_LABEL), /elsewhere\/cli\.js/, "launchd now runs the new definition");
  assert.equal(launchctl.loaded.size, 1, "one instance per label, never a second");

  assert.equal(kickstart(environment).ok, true);

  const removed = uninstallLaunchAgent(environment);
  assert.deepEqual(removed, { plistPath: plist, plist: "removed", launchctl: [`bootout gui/501/${LAUNCHD_LABEL}`], problem: null });
  assert.equal(fs.existsSync(plist), false);
  assert.equal(launchctl.loaded.size, 0);
  assert.deepEqual(uninstallLaunchAgent(environment), { plistPath: plist, plist: "absent", launchctl: [], problem: null }, "a second uninstall is a no-op");
  assert.equal(kickstart(environment).ok, false, "nothing to kick once unloaded");
});

test("an unloaded label with an existing plist is bootstrapped without rewriting the file", () => {
  const home = isolated();
  const launchctl = fakeLaunchctl();
  const environment = { env: { HOME: home }, launchctl: launchctl.run, uid: 501 };
  installLaunchAgent(spec(home), environment);
  launchctl.loaded.clear(); // a logout, or `launchctl bootout` by hand
  const reloaded = installLaunchAgent(spec(home), environment);
  assert.deepEqual({ plist: reloaded.plist, launchctl: reloaded.launchctl, loaded: reloaded.loaded }, { plist: "unchanged", launchctl: [`bootstrap gui/501 ${launchAgentPlistPath({ HOME: home })}`], loaded: true });
});

test("a launchctl failure is a reported problem, never a silent success", () => {
  const home = isolated();
  const environment = { env: { HOME: home }, launchctl: () => ({ status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }), uid: 501 };
  const failed = installLaunchAgent(spec(home), environment);
  assert.equal(failed.loaded, false);
  assert.match(failed.problem, /bootstrap failed: Bootstrap failed: 5/);
  const status = launchAgentStatus({ env: { HOME: home }, launchctl: () => ({ status: null, stdout: "", stderr: "spawn launchctl ENOENT" }), uid: 501 });
  assert.equal(status.loaded, null);
  assert.match(status.detail, /launchctl unavailable/);
});
