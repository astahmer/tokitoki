import { mkdtempSync, readFileSync } from "node:fs";
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
    opencodexCachePath: missing("opencodex-cache.json"),
    opencodexAccountsPath: missing("opencodex-accounts.json"),
    opencodeAuthPath: missing("opencode-auth.json"),
    commandcodeAuthPath: missing("commandcode.json"),
    geminiCredsPath: missing("gemini-oauth-creds.json"),
    kimiHome: missing("kimi-code"),
  };
  return { dir, cache, options };
};
