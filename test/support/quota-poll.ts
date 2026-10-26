import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../../src/cache.ts";
import type { PollOptions } from "../../src/poll.ts";

export const readFixture = (provider: string, name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${provider}/${name}`, import.meta.url), "utf8"));

export const fixturePath = (provider: string, name: string): string =>
  new URL(`../fixtures/${provider}/${name}`, import.meta.url).pathname;

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Fetcher that answers by URL substring and records every request; unknown URLs fail loudly. */
export const routeFetcher = (routes: Record<string, (request: RecordedRequest) => Response>) => {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const request: RecordedRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
      };
      requests.push(request);
      const match = Object.entries(routes).find(([fragment]) => request.url.includes(fragment));
      if (match === undefined) throw new Error(`unexpected fetch: ${request.url}`);
      return match[1](request);
    },
    { preconnect: () => undefined },
  );
  return { fetcher, requests };
};

export const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init });

/** Temp cache plus options pointing every credential source at missing files. */
export const hermeticPoll = (input: { providers: string[]; env?: Record<string, string> }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-quota-poll-"));
  const missing = (name: string) => path.join(dir, "missing", name);
  const cache = new EventCache(path.join(dir, "cache.db"));
  const options: PollOptions = {
    providers: input.providers,
    cache,
    env: input.env ?? {},
    authPath: missing("codex-auth.json"),
    piAuthPath: missing("pi-auth.json"),
    claudeCredentialsPath: missing("claude.json"),
    claudeAccountPath: missing("claude-account.json"),
    copilotAuthPath: missing("copilot.json"),
    cursorAuthPath: missing("cursor.json"),
    cursorStateVscdbPath: missing("cursor.vscdb"),
    opencodeAuthPath: missing("opencode-auth.json"),
    commandcodeAuthPath: missing("commandcode.json"),
    geminiCredsPath: missing("gemini-oauth-creds.json"),
    kimiHome: missing("kimi-code"),
  };
  return { dir, cache, options };
};

/** Native stdio server fixture: never invokes Codex or performs HTTP requests. */
export function nativeCodexFixture(dir: string, scenario: Record<string, unknown> = {}) {
  const scriptPath = path.join(dir, "codex");
  const scenarioPath = path.join(dir, "native-scenario.json");
  const logPath = path.join(dir, "native-rpc.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(scriptPath, `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const scenarioPath = ${JSON.stringify(scenarioPath)};
const logPath = ${JSON.stringify(logPath)};
let initialized = false;
let acknowledged = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  const all = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  const config = all.byHome?.[process.env.CODEX_HOME] ?? all;
  fs.appendFileSync(logPath, JSON.stringify({ home: process.env.CODEX_HOME, pid: process.pid, ...request }) + "\\n");
  if (config.mode === "hang") return;
  if (config.mode === "exit") process.exit(2);
  if (config.mode === "overflow") { process.stdout.write("x".repeat(4096)); return; }
  if (config.mode === "null") { process.stdout.write("null\\n"); return; }
  if (request.method === "initialized") { acknowledged = true; return; }
  let result;
  if (request.method === "initialize") { initialized = true; result = {}; }
  else {
    if (!initialized || !acknowledged) throw new Error("handshake missing");
    if (config.mode === "external") {
      process.stdout.write(JSON.stringify({ id: 99, method: "account/chatgptAuthTokens/refresh", params: {} }) + "\\n"); return;
    }
    if (request.method === "account/read") {
      if (Object.hasOwn(config, "accountError")) { process.stdout.write(JSON.stringify({ id: request.id, error: config.accountError }) + "\\n"); return; }
      if (config.rotate) fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify(config.rotate));
      result = config.account ?? { account: { type: "chatgpt", email: "native@example.com", planType: "plus" }, requiresOpenaiAuth: true };
    } else if (request.method === "account/rateLimits/read") {
      if (Object.hasOwn(config, "error")) { process.stdout.write(JSON.stringify({ id: request.id, error: config.error }) + "\\n"); return; }
      result = config.limits ?? { rateLimits: { primary: null, secondary: null } };
    } else throw new Error("forbidden RPC: " + request.method);
  }
  const response = Buffer.from(JSON.stringify({ id: request.id, result }) + "\\n");
  if (config.mode === "utf8") {
    let index = 0;
    const next = () => { if (index < response.length) { process.stdout.write(response.subarray(index, ++index)); setTimeout(next, 1); } };
    next();
  } else process.stdout.write(response);
});
`);
  chmodSync(scriptPath, 0o755);
  return {
    command: [process.execPath, scriptPath], scriptPath, scenarioPath, logPath,
    update: (next: Record<string, unknown>) => writeFileSync(scenarioPath, JSON.stringify(next)),
    requests: (): Array<{ home: string; pid: number; method: string; params?: unknown }> => {
      try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
      catch { return []; }
    },
  };
}
