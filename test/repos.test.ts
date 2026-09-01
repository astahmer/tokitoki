import { describe, expect, it } from "bun:test";

import { fallbackKey, findRepoRoot, repoDisplayName, resolveRepo } from "../src/repos.ts";
import { EventCache } from "../src/cache.ts";

const HOME = "/Users/me";
const existsIn = (...paths: string[]) => (p: string) => paths.includes(p);

describe("findRepoRoot", () => {
  it("walks up to the nearest .git", () => {
    const root = findRepoRoot("/Users/me/dev/emisoup/apps/web/src", HOME, existsIn("/Users/me/dev/emisoup/.git"));
    expect(root).toBe("/Users/me/dev/emisoup");
  });

  it("returns null when nothing under $HOME has .git", () => {
    expect(findRepoRoot("/Users/me/dev/foo/bar", HOME, () => false)).toBeNull();
  });

  it("never escapes above $HOME", () => {
    // .git at / would be ignored because walk stops before leaving home
    expect(findRepoRoot("/Users/me/dev/x", HOME, existsIn("/.git"))).toBeNull();
  });

  it("treats a sibling dir that textually starts with $HOME as outside it", () => {
    // "/Users/melody" is not under "/Users/me" — the boundary check must be
    // path-aware (require a separator or exact match), not a raw string
    // prefix, or any home path that's a string-prefix of a sibling
    // user/dir name defeats the "never escape $HOME" guarantee above.
    expect(findRepoRoot("/Users/melody/project", HOME, existsIn("/Users/melody/.git"))).toBeNull();
  });
});

describe("fallbackKey", () => {
  it("takes first 3 segments under home", () => {
    expect(fallbackKey("/Users/me/dev/welii/apps/backend/src", HOME)).toBe("dev/welii/apps");
  });
  it("falls back to basename outside home", () => {
    expect(fallbackKey("/private/tmp/stuff", HOME)).toBe("stuff");
  });
});

describe("repoDisplayName", () => {
  it("uses ~/dev-relative name for repos there", () => {
    expect(repoDisplayName("/Users/me/dev/emisoup", HOME)).toBe("emisoup");
  });
  it("truncates nested dev paths with ellipsis", () => {
    expect(repoDisplayName("/Users/me/dev/welii/apps/backend", HOME)).toBe("welii/…");
  });
  it("uses home-relative path elsewhere", () => {
    expect(repoDisplayName("/Users/me/work/tools", HOME)).toBe("work/tools");
  });
});

describe("resolveRepo", () => {
  it("git root wins and displays as dev-relative name", () => {
    const r = resolveRepo(
      "/Users/me/dev/pandwind/packages/core",
      HOME,
      existsIn("/Users/me/dev/pandwind/.git"),
    );
    expect(r).toEqual({ key: "/Users/me/dev/pandwind", name: "pandwind" });
  });
});

describe("EventCache repo rollup", () => {
  it("groups by cached repo name and merges sessions across project dirs", () => {
    const nameFor = (dir: string): string =>
      dir.startsWith("/Users/me/dev/emisoup") ? "emisoup" : "(other)";
    const cache = new EventCache(":memory:", nameFor);
    try {
      cache.insert([
        {
          id: "a",
          ts: "2026-08-23T09:00:00.000Z",
          machineId: "m1",
          provider: "pi",
          accountKey: "k",
          model: "m",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          projectDir: "/Users/me/dev/emisoup/apps/api",
          sessionId: "s1",
        },
        {
          id: "b",
          ts: "2026-08-23T09:05:00.000Z",
          machineId: "m1",
          provider: "pi",
          accountKey: "k",
          model: "m",
          inputTokens: 20,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          projectDir: "/Users/me/dev/emisoup/apps/web",
          sessionId: "s2",
        },
        {
          id: "c",
          ts: "2026-08-23T09:06:00.000Z",
          machineId: "m1",
          provider: "pi",
          accountKey: "k",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          sessionId: "s3",
        },
      ]);
      const rows = cache.aggregate("2026-08-01T00:00:00.000Z", "repo");
      expect(rows).toHaveLength(2);
      const emisoup = rows.find((r) => r.bucket === "emisoup");
      expect(emisoup?.requests).toBe(2);
      // Sessions stay distinct across merged project dirs
      expect(emisoup?.sessions).toBe(2);
      expect(rows.find((r) => r.bucket === "(no repo)")?.requests).toBe(1);
    } finally {
      cache.close();
    }
  });
});
