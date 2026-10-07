// Public-contract double only. Native acceptance uses an explicitly pinned Hide.
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.HIDE_FAKE_LOG) fs.appendFileSync(process.env.HIDE_FAKE_LOG, JSON.stringify(argv) + "\n");
const refuse = (code) => {
  process.stdout.write(JSON.stringify(argv[0] === "agent" ? { ok: false, error: { code, message: code } } : { type: "workspace_result", ok: false, reason: code }) + "\n");
  process.exit(1);
};
const reply = (value) => {
  process.stdout.write(JSON.stringify({ ok: true, value }) + "\n");
  process.exit(0);
};
if (process.env.HIDE_CAP_REF) refuse("credential_expired");
if (process.env.HIDE_FAKE_DOWN === "1") refuse("delivery_unavailable");
const file = process.env.HIDE_FAKE_STATE;
const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { seq: 0, participants: {}, spawns: {} };
const save = () => file && fs.writeFileSync(file, JSON.stringify(state, null, 2));
const participants = () => Object.values(state.participants ?? {});
const live = (p) => p.registered === true && p.runtime === "running";
const caller = () => {
  const device = state.context?.device_id ?? process.env.HIDE_FAKE_DEVICE ?? "local";
  const scope = device === "local" ? process.env.HERDR_SOCKET_PATH : device;
  const found = participants().filter((p) => live(p) && p.machine === device && p.pane === process.env.HERDR_PANE_ID && p.hostScope === scope);
  if (found.length !== 1) refuse("native_identity_required");
  return found[0];
};
if (argv[0] !== "agent") refuse("invalid_argument");
if (argv[1] === "list" && argv.length === 2) reply({ items: participants() });
if (argv[1] === "show" && argv.length === 3) {
  if (argv[2] === "here") {
    if (process.env.HIDE_FAKE_CALLER_ERROR) refuse(process.env.HIDE_FAKE_CALLER_ERROR);
    // An explicit provider answer lets client tests vary display environment
    // independently. This double does not prove native caller attestation.
    if (process.env.HIDE_FAKE_CALLER_ID) {
      const current = state.participants?.[process.env.HIDE_FAKE_CALLER_ID];
      if (!current) refuse("participant_unavailable");
      reply(current);
    }
    reply(caller());
  }
  const found = participants().find((p) => p.id === argv[2]);
  if (!found) refuse("agent_unavailable");
  reply(found);
}
if (argv[1] !== "spawn") refuse("invalid_argument");
const flags = {}, native = [];
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--") { native.push(...argv.slice(i + 1)); break; }
  const flag = argv[i];
  if (!["--parent", "--name", "--intent", "--kind", "--repo", "--branch", "--path"].includes(flag)
    || flag in flags || !argv[i + 1] || argv[i + 1].startsWith("--")) refuse("invalid_argument");
  flags[flag] = argv[++i];
}
for (const flag of ["--parent", "--name", "--intent", "--kind", "--repo", "--branch"]) if (!(flag in flags)) refuse("invalid_argument");
const parent = caller();
if (flags["--parent"] !== "here" && flags["--parent"] !== parent.id) refuse("parent_authority_required");
state.spawns ??= {};
const key = JSON.stringify([parent.id, flags["--intent"]]);
const payload = JSON.stringify({ flags, native });
const previous = state.spawns[key];
if (previous) {
  if (previous.payload !== payload) refuse("intent_conflict");
  reply(state.participants[previous.child]);
}
const id = `agent-${++state.seq}`;
const child = {
  id, name: flags["--name"], machine: parent.machine, hostScope: parent.hostScope,
  pane: `fixture:p${state.seq}`, session: `session-${state.seq}`, instance: `terminal-${state.seq}`,
  parent: parent.id, project: flags["--path"] ?? flags["--repo"], runtime: "running", connection: "connected", registered: true,
  watch: { id: `watch-${state.seq}`, parent: { pane_id: parent.pane }, target: { pane_id: `fixture:p${state.seq}` } },
};
state.participants[id] = child;
state.spawns[key] = { payload, child: id };
save();
reply(child);
