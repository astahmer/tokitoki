import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { pickStaticRoot } from "../src/web/server.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("npm package layout (guards the publish pipeline)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version?: string;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };

  it("ships the shim and the built output", () => {
    expect(pkg.files).toContain("bin");
    expect(pkg.files).toContain("dist");
    // bin must point at the shim, not at src — the tarball has no src/
    const shim = pkg.bin?.tokitoki;
    expect(shim).toBeDefined();
    expect(fs.existsSync(path.join(repoRoot, shim!))).toBe(true);
    expect(shim).not.toContain("src/");
  });

  it("prepack builds everything the tarball needs", () => {
    // web:build produces dist/web; build produces dist/cli.js — prepack must
    // chain both or published installs serve no UI / no CLI.
    const prepack = pkg.scripts?.prepack ?? "";
    expect(prepack).toContain("test");
    expect(prepack).toContain("typecheck");
    expect(prepack).toContain("build");
    const build = pkg.scripts?.build ?? "";
    expect(build).toContain("web:build");
    expect(build).toContain("--outfile dist/cli.js");
  });

  it("declares bun as the runtime (bundle targets bun APIs)", () => {
    expect(pkg.engines?.bun).toBeDefined();
  });

  it("bin shim actually invokes main and reports the package version", () => {
    // Regression: a shim that only `await import(...)`es the entry silently
    // no-ops because cli.ts guards execution with import.meta.main.
    const proc = Bun.spawnSync(["bun", path.join(repoRoot, "bin/tokitoki.js"), "--version"], {
      cwd: "/tmp", // prove it does not depend on cwd
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain(`v${pkg.version}`);
  });
});

describe("pickStaticRoot (source vs packaged web-asset resolution)", () => {
  const tmp = path.join(import.meta.dir, ".fixture");
  const mk = (name: string, withIndex: boolean): string => {
    const full = path.join(tmp, name);
    fs.mkdirSync(full, { recursive: true });
    if (withIndex) fs.writeFileSync(path.join(full, "index.html"), "<html></html>");
    return full;
  };

  it("prefers the first candidate with an index.html (repo build wins)", () => {
    const first = mk("a", true);
    const second = mk("b", true);
    expect(pickStaticRoot([first, second], "/nonexistent")).toBe(first);
  });

  it("falls through empty candidates to a valid fallback (legacy stable copy)", () => {
    const empty = mk("c", false);
    const stable = mk("d", true);
    expect(pickStaticRoot([empty], stable)).toBe(stable);
  });

  it("returns the first candidate when nothing is built (canonical error location)", () => {
    const empty = mk("e", false);
    expect(pickStaticRoot([empty], "/nonexistent")).toBe(empty);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
