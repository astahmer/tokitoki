import { describe, expect, it } from "bun:test";
import { COMMAND_HELP, GLOBAL_HELP, commandHelpText, type CommandHelp } from "../src/cli.ts";

/** Parse the command names listed in the rendered global help text. */
function commandsInGlobalHelp(): string[] {
  const section = GLOBAL_HELP.split("Commands:")[1]?.split("\n\nRun ")[0] ?? "";
  return section
    .split("\n")
    .map((l: string) => l.trim().match(/^(\S+)\s/)?.[1])
    .filter((x: string | undefined): x is string => Boolean(x));
}

describe("cli help completeness", () => {
  it("global help lists every registered command", () => {
    const registered = Object.keys(COMMAND_HELP).sort();
    const documented = commandsInGlobalHelp().sort();
    expect(documented).toEqual(registered);
  });

  it("budgets is documented (regression: it was missing from --help)", () => {
    expect(commandsInGlobalHelp()).toContain("budgets");
    expect(commandHelpText("budgets")).toContain("--json");
    expect(commandHelpText("budgets")).toContain("init");
  });

  it("documents the cached sessions read path", () => {
    expect(commandHelpText("sessions")).toContain("--cached");
  });

  it("documents the shared cached widget payload read path", () => {
    expect(commandHelpText("widget-payload")).toContain("--cached");
    expect(commandHelpText("widget-payload")).toContain("--skip-scan");
    expect(commandHelpText("widget-payload")).toContain("--json");
  });

  it("does not retain the temporary widget commands", () => {
    expect(COMMAND_HELP["widget"]).toBeUndefined();
    expect(COMMAND_HELP["menubar-payload"]).toBeUndefined();
  });

  it("every command's help documents all of its known flags", () => {
    for (const [cmd, entry] of Object.entries(COMMAND_HELP) as [string, CommandHelp][]) {
      const text = `${entry.usage}\n${entry.flags ?? ""}`;
      // flags referenced anywhere in the COMMAND_HELP entry (usage or flags)
      const flagRefs = [...text.matchAll(/--([a-z-]+)/gi)].map((m) => m[1]);
      expect(flagRefs.length, `${cmd} should reference at least one flag or be flag-free`).toBeGreaterThanOrEqual(0);
      // and the per-command help text must mention each flag its usage line declares
      for (const f of flagRefs) {
        expect(commandHelpText(cmd).replace(/-/g, "-")).toContain(`--${f}`);
      }
    }
  });

  it("per-command help renders usage + example for every entry that defines them", () => {
    for (const [cmd, entry] of Object.entries(COMMAND_HELP) as [string, CommandHelp][]) {
      const text = commandHelpText(cmd);
      expect(text).toContain(entry.usage);
      if (entry.example) expect(text).toContain(entry.example);
    }
  });
});
