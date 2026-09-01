import { afterEach, describe, expect, it } from "bun:test";

import { AtprotoAdapter } from "../src/sync/atproto.ts";

describe("AtprotoAdapter.push", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resumes the batch after a mid-batch 401 re-auth instead of dropping the rest", async () => {
    const putRecordIds: string[] = [];
    let sessionCalls = 0;
    let putRecordAttempts = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("createSession")) {
        sessionCalls += 1;
        return new Response(JSON.stringify({ accessJwt: `jwt-${sessionCalls}`, did: "did:plc:test" }), { status: 200 });
      }
      if (url.includes("putRecord")) {
        putRecordAttempts += 1;
        const body = JSON.parse(String(init?.body)) as { record: { event: { id: string } } };
        // The second line's first attempt hits an expired-token 401.
        if (putRecordAttempts === 2) return new Response("expired", { status: 401 });
        putRecordIds.push(body.record.event.id);
        return new Response(JSON.stringify({ cid: "bafytest" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const adapter = new AtprotoAdapter({ handle: "test.bsky.social", appPassword: "app-pw" });
    await adapter.push([
      JSON.stringify({ id: "e1" }),
      JSON.stringify({ id: "e2" }),
      JSON.stringify({ id: "e3" }),
    ]);

    expect(putRecordIds).toEqual(["e1", "e2", "e3"]);
    expect(sessionCalls).toBe(2); // initial login + one forced re-auth after the 401
  });
});
