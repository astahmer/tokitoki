/**
 * Minimal hand-rolled argv parser (commander replacement).
 *
 * Grammar:
 *   tokitoki <command> [--flag] [--key value | --key=value]...
 * `--provider` is repeatable and accumulates into an array.
 */
export type FlagValue = string | boolean;

export interface ParsedInvocation {
  /** First bare token, undefined when absent */
  command: string | undefined;
  flags: Record<string, FlagValue | string[]>;
  /** Bare tokens after the command (unused today, validated per command) */
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedInvocation {
  let command: string | undefined;
  const rest: string[] = [];
  const flags: Record<string, FlagValue | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      if (command === undefined && rest.length === 0) command = token;
      else rest.push(token);
      continue;
    }
    const isLong = token.startsWith("--");
    const stripped = isLong ? token.slice(2) : token.slice(1);
    if (stripped.length === 0) continue;
    let key = stripped;
    let inlineValue: string | undefined;
    const eq = stripped.indexOf("=");
    if (eq >= 0) {
      key = stripped.slice(0, eq);
      inlineValue = stripped.slice(eq + 1);
    }

    let value: FlagValue;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      value = argv[++i]!;
    } else {
      value = true;
    }

    if (isRepeatable(key)) {
      const existing = flags[key];
      const list: string[] = Array.isArray(existing)
        ? (existing as string[])
        : existing === undefined
          ? []
          : [existing as string];
      list.push(value as string);
      flags[key] = list;
    } else {
      flags[key] = value;
    }
  }

  return { command, flags, rest };
}

function isRepeatable(key: string): boolean {
  return key === "provider";
}
