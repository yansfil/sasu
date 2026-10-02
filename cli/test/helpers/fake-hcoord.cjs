// An hcoord stand-in for tests that are about sasu, not about hcoord.
//
// It answers the generic commands sasu calls (agent register [--check], show,
// list, end; watch start, assign, stop; request send, show; graph; inbox;
// status) with the JSON shapes hide's hcoord answers them, keeps participants
// and watches in the JSON file named by HCOORD_FAKE_STATE, and records every
// argv in HCOORD_FAKE_LOG. It delivers nothing: a test that needs a notice
// typed into a pane, a reminder, or a ledger drives the real hcoord instead.
//
//   HCOORD_FAKE_DOWN   "1" answers like a stopped daemon: reads are stale,
//                      `agent register --check` fails with daemon_down
//
// Like hcoord, it refuses a registration whose pane now hosts another session
// (identity_conflict) when the fake herdr's agents file says so.
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.HCOORD_FAKE_LOG) fs.appendFileSync(process.env.HCOORD_FAKE_LOG, JSON.stringify(argv) + "\n");
const json = argv.includes("--json");
const words = [], flags = {};
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (!token.startsWith("--")) { words.push(token); continue; }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) flags[token.slice(2)] = true; else { flags[token.slice(2)] = next; i += 1; }
}
const now = () => new Date().toISOString();
const reply = (value, extra = {}) => { process.stdout.write(JSON.stringify({ ok: true, value, observedAt: now(), ...extra }) + "\n"); process.exit(0); };
const refuse = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, error: { code, message }, observedAt: now() }) + "\n"); process.exit(1); };
const file = process.env.HCOORD_FAKE_STATE;
const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { seq: 0, participants: {}, requests: {} };
const save = () => file && fs.writeFileSync(file, JSON.stringify(state, null, 2));
const view = (p) => ({ ...p });
const [topic, action, target] = words;
const down = process.env.HCOORD_FAKE_DOWN === "1";
if (!json) refuse("invalid_argument", "the fake answers only --json");

if (topic === "status") reply(down ? { stale: true, data: { running: false } } : { running: true });
if (down && topic === "agent" && action === "register" && flags.check) refuse("daemon_down", "the coordinator daemon is not running");
if (down && !(topic === "agent" && (action === "show" || action === "list"))) reply({ letter: "l_fake", operation: `${topic}.${action}`, reason: "the coordinator daemon is not running" }, { delivery: "pending" });

if (topic === "agent" && action === "register") {
  for (const need of ["machine", "session", "instance", "name"]) if (typeof flags[need] !== "string") refuse("invalid_argument", `--${need} is required`);
  const agentsFile = process.env.HERDR_FAKE_AGENTS_FILE;
  const hosted = typeof flags.pane === "string" && agentsFile && fs.existsSync(agentsFile) ? JSON.parse(fs.readFileSync(agentsFile, "utf8"))[flags.pane] : undefined;
  if (hosted?.agent_session?.value !== undefined && hosted.agent_session.value !== flags.session) refuse("identity_conflict", `pane ${flags.pane} hosts another session than ${flags.session}`);
  const hostScope = flags["host-scope"] ?? process.env.HERDR_SOCKET_PATH ?? "default";
  // hcoord's identity rule: the same machine, host scope, pane and session is one participant.
  const same = Object.values(state.participants).find((p) => p.machine === flags.machine && p.hostScope === hostScope && p.pane === (flags.pane ?? null) && p.session === flags.session);
  if (flags.check) reply({ participant: same ? view(same) : null, deliverable: true });
  if (same) { same.instance = flags.instance; same.name = flags.name; save(); reply(view(same), { delivery: "delivered" }); }
  state.seq += 1;
  const participant = { id: `a_fake${state.seq}`, name: flags.name, machine: flags.machine, hostScope, pane: flags.pane ?? null, session: flags.session, instance: flags.instance, parent: flags.parent ?? null, project: flags.project ?? null, runtime: "claude", connection: "connected", registered: true, watch: null };
  state.participants[participant.id] = participant;
  save();
  reply(view(participant), { delivery: "delivered" });
}
if (topic === "agent" && action === "show") {
  const found = state.participants[target];
  if (!found) refuse("not_found", `no participant ${target}`);
  reply(down ? { stale: true, data: view(found) } : view(found));
}
if (topic === "agent" && action === "list") {
  const items = Object.values(state.participants).filter((p) => flags.project === undefined || p.project === flags.project).map(view);
  reply(down ? { stale: true, data: { items } } : { items });
}
if (topic === "agent" && action === "end") {
  const found = state.participants[target];
  if (!found) refuse("not_found", `no participant ${target}`);
  if (found.watch !== null && found.watch.status === "active") found.watch = { ...found.watch, status: "stopped", stoppedAt: now() };
  save();
  reply({ id: target, ended: true }, { delivery: "delivered" });
}
if (topic === "watch" && (action === "start" || action === "assign" || action === "stop")) {
  const found = state.participants[target];
  if (!found) refuse("not_found", `no participant ${target}`);
  if (action === "stop") { if (found.watch) found.watch = { ...found.watch, status: "stopped" }; save(); reply(found.watch, { delivery: "delivered" }); }
  if (typeof flags.observer !== "string" || state.participants[flags.observer] === undefined) refuse("invalid_argument", "--observer must name a participant");
  const previous = found.watch;
  if (action === "assign" && String(previous?.generation) !== String(flags["expected-generation"])) refuse("stale_generation", "the watch moved since it was read");
  const intervalMs = typeof flags.interval === "string" ? Number(/^(\d+)/.exec(flags.interval)[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[flags.interval.slice(-1)] : 15 * 60000;
  found.watch = { target, observer: flags.observer, generation: (previous?.generation ?? 0) + 1, status: "active", intervalMs: action === "assign" && previous ? previous.intervalMs : intervalMs, dueAt: now(), cycle: null, checkedAt: null, brief: typeof flags.brief === "string" ? flags.brief : previous?.brief ?? null };
  save();
  reply(found.watch, { delivery: "delivered" });
}
if (topic === "request" && action === "send") {
  for (const need of ["from", "to", "intent", "body"]) if (typeof flags[need] !== "string") refuse("invalid_argument", `--${need} is required`);
  const existing = Object.values(state.requests).find((r) => r.intent === flags.intent && r.from === flags.from);
  if (existing) reply({ id: existing.id }, { delivery: "delivered" });
  state.seq += 1;
  const request = { id: `r_fake${state.seq}`, from: flags.from, to: flags.to, intent: flags.intent, body: flags.body, waiting: flags.waiting === true, status: "open" };
  state.requests[request.id] = request;
  save();
  reply({ id: request.id }, { delivery: "delivered" });
}
if (topic === "request" && action === "show") { const found = state.requests[target]; if (!found) refuse("not_found", `no request ${target}`); reply(found); }
if (topic === "graph") {
  const all = Object.values(state.participants);
  reply({ participants: all.map(view), watch: all.filter((p) => p.watch?.status === "active").map((p) => p.watch), creation: all.filter((p) => p.parent !== null).map((p) => ({ parent: p.parent, child: p.id })) });
}
if (topic === "inbox") reply([]);
refuse("invalid_argument", `the fake hcoord does not implement: ${words.join(" ")}`);
