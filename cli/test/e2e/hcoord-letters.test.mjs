import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createFakeRemote } from "../helpers/fake-remote.mjs";

const CLI = path.resolve(import.meta.dirname, "../../dist/hcoord/cli.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One isolated HQ: a fake Herdr, a HOME, and a daemon this test owns. */
export function hq(t, fake, host = "local") {
  const env = fake.env(host);
  const dir = path.join(env.HOME, ".hcoord");
  let daemon = null;
  const api = {
    env, dir,
    run: (...args) => spawnSync(process.execPath, [CLI, ...args, "--json"], { env, encoding: "utf8" }),
    json(...args) { const result = api.run(...args); try { return JSON.parse(result.stdout); } catch { throw new Error(`${args.join(" ")}: ${result.status} ${result.stdout} ${result.stderr}`); } },
    ok(...args) { const parsed = api.json(...args); assert.equal(parsed.ok, true, `${args.join(" ")}: ${JSON.stringify(parsed)}`); return parsed.value; },
    async start() {
      daemon = spawn(process.execPath, [CLI, "daemon", "run"], { env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      daemon.stderr.on("data", (chunk) => { stderr += chunk; });
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (fs.existsSync(path.join(dir, "api.sock"))) return;
        if (daemon.exitCode !== null) throw new Error(`daemon exited: ${stderr}`);
        await wait(20);
      }
      throw new Error(`daemon did not listen: ${stderr}`);
    },
    async stop(signal = "SIGTERM") {
      if (!daemon) return;
      const old = daemon; daemon = null;
      if (old.exitCode === null && old.signalCode === null) { old.kill(signal); await new Promise((resolve) => old.once("exit", resolve)); }
    },
    ledger: () => JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")),
    outbox: () => fs.existsSync(path.join(dir, "outbox")) ? fs.readdirSync(path.join(dir, "outbox")).filter((name) => name.endsWith(".json")) : [],
    async until(predicate, message) {
      for (let attempt = 0; attempt < 150; attempt += 1) { if (predicate()) return; await wait(100); }
      assert.fail(message);
    },
  };
  t.after(() => api.stop());
  return api;
}

function pair(fake, coordinator) {
  fake.addAgent("local", "parent-pane", { name: "parent", session: "s-parent", instance: "i-parent" });
  fake.addAgent("local", "child-pane", { name: "child", session: "s-child", instance: "i-child" });
  const parent = coordinator.ok("agent", "register", "--machine", "local", "--session", "s-parent", "--instance", "i-parent", "--pane", "parent-pane", "--name", "parent");
  const child = coordinator.ok("agent", "register", "--machine", "local", "--session", "s-child", "--instance", "i-child", "--pane", "child-pane", "--name", "child", "--parent", parent.id);
  return { parent, child };
}

test("letters written while the daemon is down are applied once, in order, after it starts", async (t) => {
  const fake = createFakeRemote(CLI);
  t.after(() => fake.cleanup());
  const coordinator = hq(t, fake);
  await coordinator.start();
  const { parent, child } = pair(fake, coordinator);
  await coordinator.stop();

  const first = coordinator.json("request", "send", "--from", child.id, "--to", parent.id, "--body", "first", "--intent", "q-1");
  const repeated = coordinator.json("request", "send", "--from", child.id, "--to", parent.id, "--body", "first", "--intent", "q-1");
  const second = coordinator.json("request", "send", "--from", child.id, "--to", parent.id, "--body", "second", "--intent", "q-2");
  for (const result of [first, repeated, second]) assert.deepEqual([result.ok, result.delivery], [true, "pending"]);
  assert.equal(coordinator.outbox().length, 3);
  const text = spawnSync(process.execPath, [CLI, "request", "send", "--from", child.id, "--to", parent.id, "--body", "third", "--intent", "q-3"], { env: coordinator.env, encoding: "utf8" });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^pending: letter [0-9a-f-]{36} waits for the coordinator; the coordinator daemon is not running/);

  await coordinator.start();
  await coordinator.until(() => coordinator.outbox().length === 0, "the daemon sweeps waiting letters");
  const requests = Object.values(coordinator.ledger().requests).filter((item) => item.from === child.id);
  assert.deepEqual(requests.map((item) => item.body).sort(), ["first", "second", "third"], "a repeated intent records one request");
  const created = coordinator.ledger().events.filter((entry) => entry.type === "request.created").map((entry) => entry.correlationId);
  assert.deepEqual(created, ["q-1", "q-2", "q-3"], "letters apply in the order they were written");
  assert.equal(Object.values(coordinator.ledger().letters).filter((record) => record.operation === "request.send" && record.outcome === "applied").length, 4);
});

test("a letter recorded before a crash is removed on restart without a second effect", async (t) => {
  const fake = createFakeRemote(CLI);
  t.after(() => fake.cleanup());
  const coordinator = hq(t, fake);
  await coordinator.start();
  const { parent, child } = pair(fake, coordinator);
  const delivered = coordinator.json("request", "send", "--from", child.id, "--to", parent.id, "--body", "once", "--intent", "crash-1");
  assert.equal(delivered.delivery, "delivered");
  await coordinator.stop();
  // Crash window: the ledger save recorded the letter, the deletion never ran.
  const [record] = Object.values(coordinator.ledger().letters).filter((entry) => entry.operation === "request.send");
  const letter = { schema: "hcoord.letter.v1", id: record.id, operation: "request.send", args: { from: child.id, to: parent.id, body: "once", intent: "crash-1" }, createdAt: new Date(Date.now() - 60_000).toISOString(), writer: { host: "test", protocol: 1 } };
  fs.writeFileSync(path.join(coordinator.dir, "outbox", `${String(Date.now() - 60_000).padStart(15, "0")}-${record.id}.json`), JSON.stringify(letter));
  await coordinator.start();
  await coordinator.until(() => coordinator.outbox().length === 0, "the recorded letter is deleted");
  assert.equal(Object.values(coordinator.ledger().requests).filter((item) => item.intent === "crash-1").length, 1);
  assert.equal(coordinator.ledger().events.filter((entry) => entry.type === "request.created").length, 1, "no second effect or event");
});

test("an unknown letter version stays in the outbox and is shown with its reason", async (t) => {
  const fake = createFakeRemote(CLI);
  t.after(() => fake.cleanup());
  const coordinator = hq(t, fake);
  await coordinator.start();
  pair(fake, coordinator);
  const id = "00000000-0000-4000-8000-000000000001";
  const file = path.join(coordinator.dir, "outbox", `${String(Date.now() - 60_000).padStart(15, "0")}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: "hcoord.letter.v9", id, operation: "request.send", args: {}, createdAt: new Date().toISOString(), writer: { host: "future", protocol: 9 } }));
  await coordinator.until(() => coordinator.ok("inbox").some((item) => item.kind === "letter_rejected" && item.letter === id), "the refusal reaches the inbox");
  const item = coordinator.ok("inbox").find((entry) => entry.letter === id);
  assert.equal(item.code, "unsupported_letter");
  assert.match(item.reason, /hcoord\.letter\.v9 is unsupported/);
  await wait(2500);
  assert.equal(fs.existsSync(file), true, "an unsupported letter is kept for a newer coordinator");
  assert.equal(coordinator.ledger().events.filter((entry) => entry.type === "letter.rejected").length, 1, "the refusal is recorded once");
});

test("an immediate refusal is returned to the writer and not repeated in the inbox", async (t) => {
  const fake = createFakeRemote(CLI);
  t.after(() => fake.cleanup());
  const coordinator = hq(t, fake);
  await coordinator.start();
  const { child } = pair(fake, coordinator);
  const refused = coordinator.json("request", "send", "--from", child.id, "--to", "a_missing", "--body", "x", "--intent", "bad");
  assert.deepEqual([refused.ok, refused.delivery, refused.error.code], [false, "delivered", "not_found"]);
  assert.equal(coordinator.outbox().length, 0);
  assert.equal(coordinator.ok("inbox").some((item) => item.kind === "letter_rejected"), false);
});
