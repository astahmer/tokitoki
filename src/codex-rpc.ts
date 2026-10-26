import { spawn } from "node:child_process";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";

const windowSchema = z.object({
  usedPercent: z.number().finite(), windowDurationMins: z.number().finite().nullish(), resetsAt: z.number().finite().nullish(),
});
const rpcErrorSchema = z.object({ code: z.number().int(), message: z.string() });
const rpcEnvelopeSchema = z.object({
  id: z.number().optional(), method: z.string().optional(), error: z.unknown().optional(), result: z.unknown().optional(),
});
const creditsSchema = z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullish() });
const bucketSchema = z.object({
  limitId: z.string().nullish(), limitName: z.string().nullish(), planType: z.string().nullish(),
  primary: windowSchema.nullish(), secondary: windowSchema.nullish(), credits: creditsSchema.nullish(),
});
export const nativeRateLimitsSchema = z.object({
  accountId: z.string().nullish(), rateLimits: bucketSchema,
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullish(),
  rateLimitResetCredits: z.object({
    availableCount: z.number().int().nonnegative(),
    credits: z.array(z.object({ status: z.string(), expiresAt: z.number().finite().nullish() })).nullish(),
  }).nullish(),
});
const accountSchema = z.object({
  account: z.discriminatedUnion("type", [
    z.object({ type: z.literal("chatgpt"), email: z.string().nullish(), planType: z.string() }),
    z.object({ type: z.literal("apiKey") }), z.object({ type: z.literal("amazonBedrock") }),
  ]).nullish(),
  requiresOpenaiAuth: z.boolean(),
});
export type NativeRateLimits = z.infer<typeof nativeRateLimitsSchema>;

/** One short-lived stdio connection. Only account metadata is requested; Codex
 * owns credential storage and refresh. Neither server output nor errors are
 * exposed because either may contain credentials or other private details. */
export async function readNativeCodexAccount(input: {
  home: string; command?: readonly string[]; env?: Record<string, string | undefined>;
  timeoutMs?: number; maxOutputBytes?: number;
}): Promise<{ account: z.infer<typeof accountSchema>; limits: NativeRateLimits | undefined }> {
  const command = input.command ?? ["codex", "app-server"];
  if (command.length === 0) throw new Error("native Codex command is empty");
  const child = spawn(command[0]!, command.slice(1), {
    env: { ...process.env, ...input.env, CODEX_HOME: input.home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const decoder = new StringDecoder("utf8");
  let nextId = 0, outputBytes = 0, buffer = "", failed: Error | undefined;
  const fail = (error: Error) => {
    failed ??= error;
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
    child.kill("SIGKILL");
  };
  const timeout = setTimeout(() => fail(new Error("native Codex account read timed out")), input.timeoutMs ?? 15_000);
  const countOutput = (data: Buffer) => {
    outputBytes += data.length;
    if (outputBytes > (input.maxOutputBytes ?? 2 * 1024 * 1024)) fail(new Error("native Codex output exceeded limit"));
  };
  child.stderr.on("data", countOutput);
  child.on("error", () => fail(new Error("native Codex app-server could not start")));
  child.on("exit", () => fail(new Error("native Codex app-server exited before completing account read")));
  child.stdin.on("error", () => fail(new Error("native Codex app-server input closed")));
  child.stdout.on("data", (data: Buffer) => {
    countOutput(data);
    if (failed) return;
    buffer += decoder.write(data);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: z.infer<typeof rpcEnvelopeSchema>;
      try {
        message = rpcEnvelopeSchema.parse(JSON.parse(line));
      } catch { fail(new Error("native Codex returned invalid JSON")); return; }
      // Refuse unsolicited server requests (including external-token refresh).
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported client request" } }) + "\n");
          fail(new Error("native Codex requested unsupported external authentication"));
          return;
        }
        continue;
      }
      const request = message.id === undefined ? undefined : pending.get(message.id);
      if (request === undefined) continue;
      pending.delete(message.id!);
      if (message.error !== undefined) {
        const error = rpcErrorSchema.safeParse(message.error);
        if (!error.success) {
          request.reject(new Error("native Codex returned invalid RPC error metadata"));
          continue;
        }
        // Classify validated strings without exposing private server text.
        const auth = /unauthorized|not logged in|authentication|refresh token|401|403/i.test(error.data.message);
        request.reject(new Error(auth ? "native Codex authentication required (not logged in or unauthorized)" : "native Codex account request failed"));
      } else request.resolve(message.result);
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failed) return Promise.reject(failed);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  try {
    await request("initialize", { clientInfo: { name: "tokitoki", version: "0.4.0" }, capabilities: {} });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const parsed = accountSchema.safeParse(await request("account/read", { refreshToken: true }));
    if (!parsed.success) throw new Error("native Codex returned invalid account metadata");
    if (parsed.data.account?.type !== "chatgpt") return { account: parsed.data, limits: undefined };
    const limits = nativeRateLimitsSchema.safeParse(await request("account/rateLimits/read", {}));
    if (!limits.success) throw new Error("native Codex returned invalid quota metadata");
    return { account: parsed.data, limits: limits.data };
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    child.kill("SIGKILL");
    // Reap the process on every completion/error path.
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      await new Promise<void>(resolve => child.once("close", () => resolve()));
    }
  }
}
