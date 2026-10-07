import { spawnSync } from "node:child_process";

type ObjectValue = Record<string, unknown>;
type InputValue = { type: string; values?: readonly string[] } | null;
interface CommandRequirement {
  command: string;
  arguments: readonly { name: string; value: InputValue }[];
  options: Readonly<Record<string, InputValue>>;
  rest: boolean;
  answers: readonly string[];
  refusals?: readonly string[];
}
interface AnswerRequirement {
  types: readonly string[];
  enum?: readonly string[];
  fields?: Readonly<Record<string, AnswerRequirement>>;
  items?: AnswerRequirement;
}
const text = { type: "text" };
const key = { type: "key" };
const string: AnswerRequirement = { types: ["string"] };
const agent: AnswerRequirement = {
  types: ["object"],
  fields: {
    id: string, name: string, machine: string, hostScope: string, pane: string,
    parent: { types: ["string", "null"] }, project: { types: ["string", "null"] },
    runtime: { types: ["string"], enum: ["running", "ended"] }, registered: { types: ["boolean"] },
  },
};
const command = (name: string, options: CommandRequirement["options"] = {}, answers: readonly string[] = [], argument?: string, rest = false): CommandRequirement => ({
  command: name, arguments: argument ? [{ name: argument, value: key }] : [], options, rest, answers,
});

/** Only the consumed public surface. Additive upstream commands are compatible. */
export const REQUIRED_HIDE_CONTRACT = {
  format: 1,
  commands: [
    { ...command("agent show here", {}, ["agent"]), refusals: [
      "agent_pane_required", "caller_identity_conflict", "participant_unavailable",
      "participant_ended", "participant_session_changed", "ambiguous_participant",
    ] },
    command("agent list", {}, ["agent_list"]),
    command("agent spawn", { "--parent": text, "--name": text, "--intent": text, "--kind": text, "--repo": text, "--branch": text, "--path": text }, ["agent"], undefined, true),
    command("request send", { "--intent": key, "--body": { type: "body" }, "--kind": { type: "one_of", values: ["request", "block", "report"] } }, ["letter"], "target"),
    command("request reply", { "--intent": key, "--body": { type: "body" } }, ["letter"], "id"),
    command("inbox", {}, ["inbox"]),
  ],
  envelopes: {
    agent: { ok: "ok", answer: "value", code: "error.code" },
    request: { ok: "ok", answer: "result", code: "reason" },
    inbox: { ok: "ok", answer: "result", code: "reason" },
  },
  answers: {
    agent,
    agent_list: { types: ["object"], fields: { items: { types: ["array"], items: agent } } },
    letter: { types: ["object"] },
    inbox: { types: ["array"] },
  } satisfies Record<string, AnswerRequirement>,
};

export interface HideVersion { version: string; commit: string; contract: string }
export interface HideCompatibility {
  compatible: boolean;
  code: "HIDE_COMPATIBLE" | "HIDE_MISSING" | "HIDE_QUERY_FAILED" | "HIDE_VERSION_INVALID" | "HIDE_CONTRACT_INVALID" | "HIDE_CONTRACT_UNSUPPORTED";
  installed: HideVersion | null;
  required: typeof REQUIRED_HIDE_CONTRACT;
  issues: string[];
}
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const result = (code: HideCompatibility["code"], installed: HideVersion | null, issues: string[]): HideCompatibility => ({ compatible: code === "HIDE_COMPATIBLE", code, installed, required: REQUIRED_HIDE_CONTRACT, issues });

function inputCompatible(actual: unknown, expected: InputValue): boolean {
  if (expected === null) return actual === null;
  const value = object(actual);
  const values = value?.values;
  return value?.type === expected.type && (expected.values === undefined || (strings(values) && expected.values.every((entry) => values.includes(entry))));
}

// Resolve only the local schema references exported by Hide; cycles or unknown
// schema forms fail closed rather than claiming to implement all JSON Schema.
function resolveSchema(value: unknown, root: ObjectValue): ObjectValue | null {
  let schema = object(value);
  const seen = new Set<string>();
  while (schema && typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return null;
    seen.add(ref);
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) target = object(target)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    schema = object(target);
  }
  return schema;
}

function schemaCompatible(value: unknown, expected: AnswerRequirement, root: ObjectValue): boolean {
  const schema = resolveSchema(value, root);
  if (!schema) return false;
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (!strings(types) || types.length === 0 || !types.every((type) => expected.types.includes(type))) return false;
  if (expected.enum && (!strings(schema.enum) || schema.enum.length === 0 || !schema.enum.every((value) => expected.enum!.includes(value)))) return false;
  if (expected.fields) {
    const properties = object(schema.properties);
    if (!properties || !strings(schema.required)) return false;
    for (const [field, requirement] of Object.entries(expected.fields)) {
      if (!schema.required.includes(field) || !schemaCompatible(properties[field], requirement, root)) return false;
    }
  }
  return expected.items === undefined || schemaCompatible(schema.items, expected.items, root);
}

/** Compatibility follows command and answer structure, never a semver guess. */
export function compareHideContract(versionValue: unknown, contractValue: unknown): HideCompatibility {
  const version = object(versionValue);
  if (!version || typeof version.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version.version) || typeof version.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(version.commit) || !digest(version.contract)) {
    return result("HIDE_VERSION_INVALID", null, ["Hide version must expose version, build commit and contract digest; install a build with the public CLI contract"]);
  }
  const installed: HideVersion = { version: version.version, commit: version.commit, contract: version.contract };
  const contract = object(contractValue);
  if (!contract || contract.digest !== version.contract || !Array.isArray(contract.commands) || !object(contract.answers) || !object(contract.envelopes)) {
    return result("HIDE_CONTRACT_INVALID", installed, ["Hide contract is missing, malformed or disagrees with its version digest; retry after installing one consistent build"]);
  }
  if (contract.format !== REQUIRED_HIDE_CONTRACT.format) return result("HIDE_CONTRACT_UNSUPPORTED", installed, ["unsupported Hide contract format; install a compatible build"]);
  const issues: string[] = [];
  for (const expected of REQUIRED_HIDE_CONTRACT.commands) {
    const matches = contract.commands.filter((entry) => object(entry)?.command === expected.command);
    const actual = matches.length === 1 ? object(matches[0]) : null;
    const args = actual?.arguments;
    const opts = actual?.options;
    if (!actual || !Array.isArray(args) || !Array.isArray(opts)) { issues.push(`missing or malformed command: ${expected.command}`); continue; }
    const argsOk = args.length === expected.arguments.length && args.every((entry, index) => {
      const argument = object(entry), required = expected.arguments[index];
      return required && argument?.name === required.name && inputCompatible(argument.value, required.value);
    });
    const optsOk = Object.entries(expected.options).every(([name, value]) => {
      const options = opts.filter((entry) => object(entry)?.name === name);
      const option = options.length === 1 ? object(options[0]) : null;
      return option && inputCompatible(option.value, value) && typeof option.required === "boolean" && strings(option.requires) && option.requires.every((dependency) => dependency in expected.options);
    }) && opts.every((entry) => {
      const option = object(entry);
      return option && typeof option.name === "string" && typeof option.required === "boolean" && (!option.required || option.name in expected.options);
    });
    const actualAnswers = actual.answers;
    if (!argsOk || !optsOk || actual.repeats_at_most !== null || (expected.rest ? typeof actual.rest !== "string" : actual.rest !== null) || !strings(actualAnswers) || !expected.answers.every((name) => actualAnswers.includes(name)) || actualAnswers.some((name) => !expected.answers.includes(name))) {
      issues.push(`unsupported command signature: ${expected.command}`);
    }
    // The export declares command-specific refusals, not an exhaustive list.
    // The client rejects every failure; additional refusal codes stay safe.
    const refusals = actual.refusals;
    if (expected.refusals && (!strings(refusals) || !expected.refusals.every((code) => refusals.includes(code)))) {
      issues.push(`missing or unsupported refusals: ${expected.command}`);
    }
  }
  const envelopes = object(contract.envelopes)!;
  for (const [topic, expected] of Object.entries(REQUIRED_HIDE_CONTRACT.envelopes)) {
    const envelope = object(envelopes[topic]);
    if (!envelope || Object.entries(expected).some(([key, value]) => envelope[key] !== value)) issues.push(`unsupported response envelope: ${topic}`);
  }
  const answers = object(contract.answers)!;
  for (const [name, expected] of Object.entries(REQUIRED_HIDE_CONTRACT.answers)) {
    const root = object(answers[name]);
    if (!root || !schemaCompatible(root, expected, root)) issues.push(`missing or unsupported answer schema: ${name}`);
  }
  return result(issues.length === 0 ? "HIDE_COMPATIBLE" : "HIDE_CONTRACT_UNSUPPORTED", installed, issues);
}

/** Two bounded, read-only queries. Never copy external stderr into diagnostics. */
export function inspectHideCompatibility(options: { binary?: string; env?: NodeJS.ProcessEnv } = {}): HideCompatibility {
  const env = { ...(options.env ?? process.env) };
  delete env.HIDE_CAP_REF;
  const query = (command: string) => spawnSync(options.binary ?? "hide", [command, "--json"], { env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  const version = query("version");
  if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return result("HIDE_MISSING", null, ["Hide executable missing; install Hide and put hide on PATH"]);
  if (version.status !== 0) return result("HIDE_QUERY_FAILED", null, ["Hide version query failed; check the installed Hide build"]);
  let versionValue: unknown;
  try { versionValue = JSON.parse(version.stdout); } catch { return result("HIDE_VERSION_INVALID", null, ["Hide version returned invalid JSON; install a build with the public CLI contract"]); }
  const parsedVersion = compareHideContract(versionValue, null);
  if (parsedVersion.code === "HIDE_VERSION_INVALID") return parsedVersion;
  const contract = query("contract");
  if (contract.status !== 0) return result("HIDE_QUERY_FAILED", parsedVersion.installed, ["Hide contract query failed; install a build with the public CLI contract"]);
  let contractValue: unknown;
  try { contractValue = JSON.parse(contract.stdout); } catch { return result("HIDE_CONTRACT_INVALID", parsedVersion.installed, ["Hide contract returned invalid JSON; install a build with the public CLI contract"]); }
  return compareHideContract(versionValue, contractValue);
}
