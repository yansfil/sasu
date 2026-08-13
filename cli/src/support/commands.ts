interface SupportArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

interface RulesLibrary {
  cmdRules(args: string[]): unknown;
}

interface SetupLibrary {
  cmdSeedAgentsMd(options: Record<string, string | true>): unknown;
}

const rules = require("../../lib/commands/rules.js") as RulesLibrary;
const setup = require("../../lib/commands/setup.js") as SetupLibrary;

function rawArgs(args: SupportArgs, offset: number): string[] {
  const values = args.positional.slice(offset);
  for (const [name, value] of args.flags) {
    values.push(`--${name}`);
    if (typeof value === "string") values.push(value);
  }
  return values;
}

export function runRulesCommand(args: SupportArgs): unknown {
  return rules.cmdRules(rawArgs(args, 1));
}

export function runSetupCommand(args: SupportArgs): unknown {
  const subcommand = args.positional[1];
  if (subcommand !== "seed-agents-md") throw new Error("unknown setup subcommand; use seed-agents-md");
  const options: Record<string, string | true> = {};
  for (const [name, value] of args.flags) options[name] = value;
  return setup.cmdSeedAgentsMd(options);
}
