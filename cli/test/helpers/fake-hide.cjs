// Contract double only. Native acceptance is exercised separately with pinned Hide.
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.HIDE_FAKE_LOG) fs.appendFileSync(process.env.HIDE_FAKE_LOG, JSON.stringify(argv) + "\n");
const words = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith("--")) { words.push(token); continue; }
  const next = argv[i + 1];
  flags[token.slice(2)] = next === undefined || next.startsWith("--") ? true : (i++, next);
}
const [topic, action, target] = words;
const delivery = topic !== "agent";
const refuse = (reason, message = reason) => {
  process.stdout.write(JSON.stringify(delivery ? { ok: false, reason, next_action: message } : { ok: false, error: { code: reason, message } }) + "\n"); process.exit(1);
};
const reply = (result) => { process.stdout.write(JSON.stringify(delivery ? { type: "workspace_result", request_id: "fixture", ok: true, result } : { ok: true, value: result }) + "\n"); process.exit(0); };
if (["json", "from", "to", "notify-only", "waiting", "interval", "brief"].some((flag) => flag in flags)) refuse("invalid_argument", "unsupported Hide CLI flag");
if (process.env.HIDE_FAKE_DOWN === "1") refuse("delivery_unavailable", "Check the running daemon and current agent pane, then retry the same intent");
const file = process.env.HIDE_FAKE_STATE;
const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { seq: 0, participants: {}, requests: {} };
const save = () => file && fs.writeFileSync(file, JSON.stringify(state, null, 2));
const actor = (participant) => ({ pane_id: participant.pane, name: participant.name, kind: "claude", device_id: "local", session: participant.session });
const nativeAgents = () => process.env.HERDR_FAKE_AGENTS_FILE && fs.existsSync(process.env.HERDR_FAKE_AGENTS_FILE) ? JSON.parse(fs.readFileSync(process.env.HERDR_FAKE_AGENTS_FILE, "utf8")) : {};
const nativeSession = (pane) => (nativeAgents()[pane] ?? (pane === "w4G:p12" ? { agent_session: { value: "observer-session" } } : null))?.agent_session?.value;
const caller = () => Object.values(state.participants).find((p) => p.registered && p.pane === process.env.HERDR_PANE_ID && p.session === nativeSession(p.pane));
if (topic === "agent" && action === "register") {
  for (const required of ["machine", "host-scope", "session", "instance", "name", "pane"]) if (typeof flags[required] !== "string") refuse("invalid_registration");
  const agents = process.env.HERDR_FAKE_AGENTS_FILE && fs.existsSync(process.env.HERDR_FAKE_AGENTS_FILE) ? JSON.parse(fs.readFileSync(process.env.HERDR_FAKE_AGENTS_FILE, "utf8")) : {};
  const hosted = agents[flags.pane] ?? (flags.pane === "w4G:p12" ? { agent_session: { value: "observer-session" } } : null);
  if (hosted === null || hosted.agent_session?.value !== flags.session) refuse("session_identity_conflict");
  if (flags["host-scope"] !== (process.env.HERDR_SOCKET_PATH || "default")) refuse("host_scope_conflict");
  if (flags.parent) {
    const parent = state.participants[flags.parent];
    if (!parent || parent.pane !== process.env.HERDR_PANE_ID || parent.session !== nativeSession(parent.pane)) refuse("parent_identity_conflict");
  } else if (flags.pane !== process.env.HERDR_PANE_ID) refuse("caller_identity_conflict");
  const same = Object.values(state.participants).find((p) => p.registered && p.machine === flags.machine && p.hostScope === flags["host-scope"] && p.pane === flags.pane && p.session === flags.session);
  if (flags.check) reply(same ?? { registered: false, name: flags.name, pane: flags.pane });
  if (same) { same.instance = flags.instance; same.name = flags.name; save(); reply(same); }
  const participant = { id: `a_${++state.seq}`, name: flags.name, machine: flags.machine, hostScope: flags["host-scope"], pane: flags.pane, session: flags.session, instance: flags.instance, parent: flags.parent ?? null, project: flags.project ?? null, runtime: "running", connection: "connected", registered: true, watch: null };
  state.participants[participant.id] = participant; save(); reply(participant);
}
if (topic === "agent" && action === "show") { if (!state.participants[target]) refuse("agent_unavailable"); reply(state.participants[target]); }
if (topic === "agent" && action === "list") reply({ items: Object.values(state.participants) });
if (topic === "agent" && action === "end") {
  const found = state.participants[target]; if (!found) refuse("agent_unavailable");
  const current = caller();
  if (!current || (flags.actor !== undefined && flags.actor !== current.id) || (current.id !== found.id && current.id !== found.parent)) refuse("agent_authority_required", "The target or original registered parent must end this agent");
  found.watch = null; found.registered = false; found.runtime = "ended";
  for (const request of Object.values(state.requests)) if (request.sender.pane_id === found.pane && request.waiting_answer) { request.waiting_answer = false; request.state = "cancelled"; }
  save(); reply({ id: target, ended: true });
}
if (topic === "watch" && action === "start") {
  const found = state.participants[target], parent = state.participants[flags.observer];
  if (!found || !parent || found.parent !== parent.id || caller()?.id !== parent.id || flags.actor !== parent.id) refuse("watch_parent_required");
  if (found.watch) reply(found.watch);
  found.watch = { id: `watch_${++state.seq}`, parent: actor(parent), target: actor(found), generation: 0, last_activity_at_unix_ms: Date.now(), first_warning_at_unix_ms: null, warning_count: 0, activity_failures: 0, last_status: "working", last_state_change_seq: 1, status_changed_at_unix_ms: Date.now() };
  save(); reply(found.watch);
}
if (topic === "watch" && action === "assign") {
  const found = Object.values(state.participants).find((p) => p.watch?.id === target || p.id === target);
  const next = state.participants[flags.observer];
  if (process.env.HIDE_FAKE_REFUSE_ASSIGN === "1") refuse("watch_generation_conflict");
  if (!found?.watch || !next || caller()?.id !== next.id || flags.actor !== next.id || typeof flags.approval !== "string" || !flags.approval.trim()) refuse("watch_handover_approval_required");
  if (String(found.watch.generation) !== flags["expected-generation"]) refuse("watch_generation_conflict");
  found.watch.parent = actor(next); found.watch.generation++; save(); reply(found.watch);
}
if (topic === "watch" && action === "list") reply(Object.values(state.participants).map((p) => p.watch).filter((w) => w && w.parent.pane_id === process.env.HERDR_PANE_ID));
if (topic === "request" && action === "send") {
  const sender = caller(), recipient = state.participants[target];
  if (!sender || !recipient || typeof flags.intent !== "string" || typeof flags.body !== "string" || !["request", "block", "report"].includes(flags.kind)) refuse("native_identity_required");
  const existing = Object.values(state.requests).find((r) => r.intent === flags.intent && r.sender.pane_id === sender.pane);
  if (existing) reply(existing);
  const request = { id: `letter_${++state.seq}`, sender: actor(sender), recipient: actor(recipient), intent: flags.intent, body: flags.body, kind: flags.kind, waiting_answer: flags.kind !== "report", state: "pending", hook_confirmed: false };
  state.requests[request.id] = request; save(); reply(request);
}
if (topic === "request" && action === "show") { if (!state.requests[target]) refuse("not_found"); reply(state.requests[target]); }
refuse("invalid_argument", "unsupported fixture command");
