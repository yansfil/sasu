// Where the tests get an hcoord from. sasu ships none, and none is ever taken
// from PATH: a developer's PATH may hold a different build or a live daemon's
// command, which would make a pass or a fail depend on the machine.
//
// - Tests about sasu use the fake (fake-hcoord.cjs), which needs nothing.
// - Tests that need a real daemon (notices typed into a pane, reminders, the
//   ledger) use the executable named by SASU_TEST_HCOORD, built from the
//   commit pinned in cli/test/hcoord-source.json by
//   `node scripts/build-test-hcoord.mjs`, which prints the path to export.
//   Unset, they skip locally with that instruction; under CI they fail, so a
//   CI run can never silently skip them.
//
// Every real daemon gets its own HCOORD_HOME, which relocates the ledger,
// socket and outbox, so nothing reaches the data folder of a daemon that runs
// on a developer's machine.
import fs from "node:fs";
import path from "node:path";

export const HCOORD_ENV = "SASU_TEST_HCOORD";
const configured = process.env[HCOORD_ENV] ?? "";

const INSTRUCTION = `${HCOORD_ENV} is not set; run \`node scripts/build-test-hcoord.mjs\` (it builds hide's hcoord at the commit pinned in cli/test/hcoord-source.json) and export the path it prints as ${HCOORD_ENV}`;

/** The real hcoord under test; throws, so the test fails, when it is not configured. */
export function hcoordBinary() {
  if (configured === "") throw new Error(INSTRUCTION);
  try { fs.accessSync(configured, fs.constants.X_OK); } catch { throw new Error(`${HCOORD_ENV}=${configured} is not an executable file`); }
  return configured;
}

/** Skip option for a test that needs the real hcoord: skipped locally, never under CI. */
export const HCOORD_SKIP = configured === "" && !process.env.CI ? INSTRUCTION : false;

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
function writeCommand(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hcoord"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** Makes `hcoord` in `dir` the real one, so a spawned sasu finds it on a PATH that starts with `dir`. */
export function installRealHcoord(dir) {
  writeCommand(dir, `exec ${quote(hcoordBinary())} "$@"`);
}

/** Makes `hcoord` in `dir` the fake, with its state and argv log under `root`. */
export function installFakeHcoord(dir, root) {
  writeCommand(dir, `exec ${quote(process.execPath)} ${quote(path.join(import.meta.dirname, "fake-hcoord.cjs"))} "$@"`);
  const stateFile = path.join(root, "hcoord-fake-state.json");
  const log = path.join(root, "hcoord-fake-argv.log");
  return {
    stateFile,
    log,
    env: { HCOORD_FAKE_STATE: stateFile, HCOORD_FAKE_LOG: log },
    state() { return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { seq: 0, participants: {}, requests: {} }; },
    argv() { return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; },
  };
}

/** A PATH holding only the given directory and a `node` link, so a spawned `hcoord` cannot be found. */
export function pathWithoutHcoord(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const node = path.join(dir, "node");
  if (!fs.existsSync(node)) fs.symlinkSync(process.execPath, node);
  return dir;
}
