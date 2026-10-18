import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { PollAccountResult, PolledWindow } from "../poll.ts";
import {
  clampPercent,
  decodeJwtClaims,
  envValue,
  homeDir,
  httpFailure,
  isOk,
  requestJson,
  storePolledAccount,
  toEpochSeconds,
  type JsonResponse,
  type PollEnv,
  type QuotaPollContext,
} from "./shared.ts";

const CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_SAFETY_MS = 60_000;

export const GEMINI_CONSUMER_SHUTDOWN_REASON =
  "Google no longer serves Gemini CLI OAuth for individual, AI Pro, or Ultra accounts (June 2026 shutdown); use Antigravity, or a Workspace or Code Assist Standard/Enterprise account";

const GeminiCredsSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  id_token: z.string().nullish(),
  expiry_date: z.number().nullish(),
});

export type GeminiCreds = z.infer<typeof GeminiCredsSchema>;

export const geminiCredsPath = (input: { env: PollEnv; override?: string }): string =>
  input.override ?? path.join(homeDir(input.env), ".gemini", "oauth_creds.json");

export const loadGeminiCreds = (filePath: string): GeminiCreds | undefined => {
  try {
    const parsed = GeminiCredsSchema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    if (!parsed.success) return undefined;
    const hasToken = (parsed.data.access_token ?? "").length > 0 || (parsed.data.refresh_token ?? "").length > 0;
    return hasToken ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Merge refreshed token fields into gemini's own creds file; best-effort and atomic. */
const persistGeminiCreds = (input: { filePath: string; update: { access_token: string; expiry_date?: number; id_token?: string } }): void => {
  try {
    const current = z.record(z.string(), z.unknown()).parse(JSON.parse(fs.readFileSync(input.filePath, "utf8")));
    const tmp = `${input.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...current, ...input.update }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, input.filePath);
  } catch {
    // the freshly fetched quota is still valid even when the write-back fails
  }
};

// --- OAuth client discovery (the secret ships inside the installed gemini CLI) ---

export interface GeminiOAuthClient {
  clientId: string;
  clientSecret: string;
}

export const parseGeminiOAuthClient = (content: string): GeminiOAuthClient | undefined => {
  const clientId = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([\w\-.]+)['"]/)?.[1];
  const clientSecret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([\w-]+)['"]/)?.[1];
  return clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : undefined;
};

const readClient = (filePath: string): GeminiOAuthClient | undefined => {
  try {
    return parseGeminiOAuthClient(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
};

const OAUTH_FILE = path.join("dist", "src", "code_assist", "oauth2.js");
const CORE_OAUTH_FILE = path.join("node_modules", "@google", "gemini-cli-core", OAUTH_FILE);

const clientFromPackageRoot = (root: string): GeminiOAuthClient | undefined => {
  for (const candidate of [path.join(root, OAUTH_FILE), path.join(root, CORE_OAUTH_FILE)]) {
    const client = readClient(candidate);
    if (client !== undefined) return client;
  }
  const bundle = path.join(root, "bundle");
  try {
    const files = fs.readdirSync(bundle).filter((name) => name.endsWith(".js")).sort((a, b) =>
      a === "gemini.js" ? -1 : b === "gemini.js" ? 1 : a.localeCompare(b),
    );
    for (const name of files) {
      const client = readClient(path.join(bundle, name));
      if (client !== undefined) return client;
    }
  } catch {
    // no bundle directory
  }
  return undefined;
};

const isGeminiPackage = (dir: string): boolean => {
  try {
    const parsed = z.object({ name: z.string() }).safeParse(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")));
    return parsed.success && parsed.data.name === "@google/gemini-cli";
  } catch {
    return false;
  }
};

const GLOBAL_PACKAGE = path.join("lib", "node_modules", "@google", "gemini-cli");

/** Package roots reachable from the resolved `gemini` binary (npm, bun, Homebrew, and Nix layouts). */
const packageRootsFrom = (binary: string): string[] => {
  const roots: string[] = [];
  let dir = path.dirname(binary);
  for (let depth = 0; depth <= 8; depth += 1) {
    for (const candidate of [
      dir,
      path.join(dir, GLOBAL_PACKAGE),
      path.join(dir, "libexec", GLOBAL_PACKAGE),
      path.join(dir, "share", "gemini-cli"),
      path.join(dir, "share", "gemini-cli", "node_modules", "@google", "gemini-cli"),
    ]) {
      if (isGeminiPackage(candidate) || fs.existsSync(path.join(candidate, "bundle", "gemini.js"))) roots.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const base = path.dirname(path.dirname(binary));
  roots.push(
    path.join(base, "libexec", "lib", "node_modules", "@google", "gemini-cli"),
    path.join(base, "lib", "node_modules", "@google", "gemini-cli"),
    path.join(base, "share", "gemini-cli"),
    path.join(base, "..", "gemini-cli-core"),
  );
  return [...new Set(roots)];
};

const findOnPath = (input: { name: string; env: PollEnv }): string | undefined => {
  for (const dir of (input.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0)) {
    const candidate = path.join(dir, input.name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // not in this PATH entry
    }
  }
  return undefined;
};

/** Env override, then GEMINI_OAUTH2_JS_PATH, then the installed gemini CLI. */
export const resolveGeminiOAuthClient = (env: PollEnv): GeminiOAuthClient | undefined => {
  const clientId = envValue({ env, names: ["GEMINI_OAUTH_CLIENT_ID"] });
  const clientSecret = envValue({ env, names: ["GEMINI_OAUTH_CLIENT_SECRET"] });
  if (clientId !== undefined && clientSecret !== undefined) return { clientId, clientSecret };
  const jsPath = envValue({ env, names: ["GEMINI_OAUTH2_JS_PATH"] });
  if (jsPath !== undefined) {
    const client = readClient(jsPath);
    if (client !== undefined) return client;
  }
  const binary = findOnPath({ name: "gemini", env });
  if (binary === undefined) return undefined;
  for (const root of packageRootsFrom(binary)) {
    const client = clientFromPackageRoot(root);
    if (client !== undefined) return client;
  }
  return undefined;
};

const GoogleTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  id_token: z.string().optional(),
});

const refreshGeminiToken = async (input: {
  ctx: QuotaPollContext;
  refreshToken: string;
}): Promise<{ accessToken: string; expiryDate?: number; idToken?: string } | string> => {
  const client = resolveGeminiOAuthClient(input.ctx.env);
  if (client === undefined) {
    return "token refresh failed: Gemini CLI OAuth client not found (install gemini or set GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET)";
  }
  const response = await requestJson({
    fetcher: input.ctx.fetcher,
    url: GOOGLE_TOKEN_URL,
    init: {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }),
    },
  });
  if (!isOk(response)) return `token refresh failed (${httpFailure({ label: "token endpoint", response })})`;
  const parsed = GoogleTokenSchema.safeParse(response.body);
  if (!parsed.success) return "token refresh failed: response shape unrecognized";
  return {
    accessToken: parsed.data.access_token,
    ...(parsed.data.expires_in !== undefined ? { expiryDate: input.ctx.now + parsed.data.expires_in * 1000 } : {}),
    ...(parsed.data.id_token !== undefined ? { idToken: parsed.data.id_token } : {}),
  };
};

// --- response parsing ---

const LoadCodeAssistSchema = z.object({
  currentTier: z.object({ id: z.string().nullish() }).nullish(),
  paidTier: z.object({ name: z.string().nullish() }).nullish(),
  cloudaicompanionProject: z.union([
    z.string(),
    z.object({ id: z.string().nullish(), projectId: z.string().nullish() }),
  ]).nullish(),
  ineligibleTiers: z.array(z.object({
    reasonCode: z.string().nullish(),
    reasonMessage: z.string().nullish(),
  })).nullish(),
});

export interface GeminiCodeAssist {
  tierId?: string;
  plan?: string;
  projectId?: string;
  /** Google listed this client as unsupported for a consumer account (June 2026 shutdown). */
  consumerUnsupported: boolean;
}

const isShutdownSignal = (value: string): boolean => /UNSUPPORTED_CLIENT|IneligibleTierError|antigravity/i.test(value);

/** loadCodeAssist body (+ id_token `hd` claim) → plan, quota project, and the consumer shutdown flag. */
export const parseGeminiCodeAssist = (body: unknown, hostedDomain?: string): GeminiCodeAssist | undefined => {
  const parsed = LoadCodeAssistSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const project = typeof data.cloudaicompanionProject === "string"
    ? data.cloudaicompanionProject
    : data.cloudaicompanionProject?.id ?? data.cloudaicompanionProject?.projectId ?? undefined;
  const projectId = project?.trim() || undefined;
  const tierId = data.currentTier?.id ?? undefined;
  const paidTierName = data.paidTier?.name?.trim() || undefined;
  const unsupportedListed = (data.ineligibleTiers ?? []).some((tier) =>
    [tier.reasonCode, tier.reasonMessage].some((value) => typeof value === "string" && isShutdownSignal(value)),
  );
  const consumerUnsupported = paidTierName === undefined && hostedDomain === undefined && unsupportedListed;
  const tierPlan = tierId === "standard-tier"
    ? "Paid"
    : tierId === "free-tier"
      ? hostedDomain !== undefined ? "Workspace" : "Free"
      : tierId === "legacy-tier" ? "Legacy" : undefined;
  const plan = paidTierName ?? tierPlan;
  return {
    ...(tierId !== undefined ? { tierId } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    consumerUnsupported,
  };
};

const QuotaBucketsSchema = z.object({
  buckets: z.array(z.object({
    remainingFraction: z.number().nullish(),
    resetTime: z.string().nullish(),
    modelId: z.string().nullish(),
  }).catch({ remainingFraction: undefined, resetTime: undefined, modelId: undefined })).nullish(),
});

const MODEL_FAMILIES = [
  { model: "pro", label: "Pro daily", matches: (id: string) => id.includes("pro") },
  { model: "flash", label: "Flash daily", matches: (id: string) => id.includes("flash") && !id.includes("flash-lite") },
  { model: "flash-lite", label: "Flash Lite daily", matches: (id: string) => id.includes("flash-lite") },
] as const;

/** retrieveUserQuota body → one daily window per model family (lowest remaining fraction wins). */
export const parseGeminiQuota = (body: unknown): PolledWindow[] | undefined => {
  const parsed = QuotaBucketsSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const buckets = (parsed.data.buckets ?? []).flatMap((bucket) =>
    typeof bucket.remainingFraction === "number" && typeof bucket.modelId === "string"
      ? [{ id: bucket.modelId.toLowerCase(), remaining: bucket.remainingFraction, resetTime: bucket.resetTime ?? undefined }]
      : [],
  );
  return MODEL_FAMILIES.flatMap((family) => {
    const lowest = buckets
      .filter((bucket) => family.matches(bucket.id))
      .sort((a, b) => a.remaining - b.remaining)[0];
    if (lowest === undefined) return [];
    return [{
      windowMinutes: 1440,
      usedPct: clampPercent(100 - lowest.remaining * 100),
      resetsAtEpoch: toEpochSeconds(lowest.resetTime),
      model: family.model,
      label: family.label,
    }];
  });
};

const ClaimsSchema = z.object({ email: z.string().optional(), hd: z.string().optional() });

// --- poll ---

export const pollGeminiQuotas = async (input: {
  ctx: QuotaPollContext;
  credsPath: string;
  creds: GeminiCreds;
}): Promise<PollAccountResult | string> => {
  const ctx = input.ctx;
  let accessToken = input.creds.access_token ?? "";
  let idToken = input.creds.id_token ?? undefined;
  let refreshed = false;
  const refresh = async (): Promise<string | undefined> => {
    const refreshToken = input.creds.refresh_token ?? "";
    if (refreshToken.length === 0) return "gemini OAuth token expired and no refresh token available; run gemini to sign in again";
    const renewed = await refreshGeminiToken({ ctx, refreshToken });
    if (typeof renewed === "string") return renewed;
    refreshed = true;
    accessToken = renewed.accessToken;
    idToken = renewed.idToken ?? idToken;
    persistGeminiCreds({
      filePath: input.credsPath,
      update: {
        access_token: renewed.accessToken,
        ...(renewed.expiryDate !== undefined ? { expiry_date: renewed.expiryDate } : {}),
        ...(renewed.idToken !== undefined ? { id_token: renewed.idToken } : {}),
      },
    });
    return undefined;
  };

  const expiry = input.creds.expiry_date ?? undefined;
  if (accessToken.length === 0 || (expiry !== undefined && expiry <= ctx.now + TOKEN_SAFETY_MS)) {
    const failure = await refresh();
    if (failure !== undefined) return failure;
  }

  const post = async (input: { method: string; body: unknown }): Promise<JsonResponse> => {
    const send = () => requestJson({
      fetcher: ctx.fetcher,
      url: `${CODE_ASSIST_URL}:${input.method}`,
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input.body),
      },
    });
    const first = await send();
    if (first.status !== 401 || refreshed) return first;
    const failure = await refresh();
    return failure === undefined ? send() : first;
  };

  const assistResponse = await post({ method: "loadCodeAssist", body: { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } } });
  if (assistResponse.status === 401) return "unauthorized (401); run gemini to sign in again";
  if (!isOk(assistResponse)) {
    if (isShutdownSignal(JSON.stringify(assistResponse.body ?? ""))) return GEMINI_CONSUMER_SHUTDOWN_REASON;
    return httpFailure({ label: "loadCodeAssist", response: assistResponse });
  }
  const claims = ClaimsSchema.safeParse(decodeJwtClaims(idToken ?? "") ?? {});
  const identity = claims.success ? claims.data : {};
  const assist = parseGeminiCodeAssist(assistResponse.body, identity.hd);
  if (assist?.tierId === undefined && assist?.consumerUnsupported === true) return GEMINI_CONSUMER_SHUTDOWN_REASON;

  const quotaResponse = await post({
    method: "retrieveUserQuota",
    body: assist?.projectId !== undefined ? { project: assist.projectId } : {},
  });
  if (quotaResponse.status === 401) return "unauthorized (401); run gemini to sign in again";
  if (!isOk(quotaResponse)) {
    const shutdown = quotaResponse.status === 403 && assist?.consumerUnsupported === true && assist.tierId !== "standard-tier";
    return shutdown ? GEMINI_CONSUMER_SHUTDOWN_REASON : httpFailure({ label: "retrieveUserQuota", response: quotaResponse });
  }
  const windows = parseGeminiQuota(quotaResponse.body);
  if (windows === undefined) return "quota response shape unrecognized";
  const email = identity.email !== undefined && identity.email.includes("@") ? identity.email : undefined;
  const plan = assist?.plan;
  const result: PollAccountResult = {
    accountKey: "default",
    harnesses: ["gemini-cli"],
    ...(email !== undefined ? { email } : {}),
    ...(plan !== undefined ? { planType: plan } : {}),
    windows,
    inserted: 0,
  };
  if (windows.length === 0) return { ...result, error: "no usable windows in response" };
  result.inserted = storePolledAccount({
    ctx,
    provider: "gemini-cli",
    accountKey: "default",
    windows,
    meta: { ...(plan !== undefined ? { plan } : {}), ...(email !== undefined ? { email } : {}) },
  });
  return result;
};
