import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { codexHomes } from "../src/codex-homes.ts";
import { homeJoin, userHome } from "../src/home.ts";
import { cursorIdeDir } from "../src/providers/cursor.ts";
import { homePath } from "../src/providers/types.ts";
import { homeDir } from "../src/quota/shared.ts";

describe("user home", () => {
  test("follows Bun's home directory", () => {
    expect(userHome()).toBe(os.homedir());
    expect(homeDir()).toBe(os.homedir());
  });

  test("joins harness stores with the platform path API", () => {
    expect(homeJoin("/.claude/projects")).toBe(path.join(os.homedir(), ".claude", "projects"));
    expect(homeJoin("/.codex")).toBe(path.join(os.homedir(), ".codex"));
    expect(homeJoin("/.local/share/opencode")).toBe(path.join(os.homedir(), ".local", "share", "opencode"));
    expect(homePath("", "/.claude/projects")).toBe(path.join(os.homedir(), ".claude", "projects"));
    expect(homeJoin("/.claude/projects").startsWith("~")).toBe(false);
  });

  test("an unset HOME still uses the real home directory", () => {
    const previous = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(userHome()).toBe(os.homedir());
      expect(userHome().startsWith("~")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  test("places the Cursor IDE store for this platform", () => {
    const expected = process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cursor")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA && process.env.APPDATA.length > 0 ? process.env.APPDATA : path.join(os.homedir(), "AppData", "Roaming"), "Cursor")
        : path.join(os.homedir(), ".config", "Cursor");
    expect(cursorIdeDir()).toBe(expected);
  });

  test("codex homes follow the runtime home unless CODEX_HOME is set", () => {
    expect(codexHomes({ config: {}, env: {} })).toEqual([path.join(os.homedir(), ".codex")]);
    expect(codexHomes({ config: {}, env: { CODEX_HOME: "/native" } })).toEqual(["/native"]);
  });
});
