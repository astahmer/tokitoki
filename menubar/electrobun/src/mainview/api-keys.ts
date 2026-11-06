export const API_KEY_PROVIDERS = ["opencode-go", "openrouter", "zai", "kimi", "deepseek"];

export interface StoredApiKey {
  id: string;
  label: string;
  provider: string;
  key: string;
}

export interface MaskedApiKey {
  id: string;
  label: string;
  provider: string;
  hint: string;
}

export function maskApiKey(key: string): string {
  if (key.length <= 12) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function readStoredApiKeys(configJson: string): StoredApiKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const poll = (parsed as { poll?: unknown }).poll;
  if (typeof poll !== "object" || poll === null) return [];
  const extraKeys = (poll as { extraKeys?: unknown }).extraKeys;
  if (!Array.isArray(extraKeys)) return [];
  const keys: StoredApiKey[] = [];
  for (const item of extraKeys) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { id?: unknown; label?: unknown; provider?: unknown; key?: unknown };
    const id = typeof record.id === "string" ? record.id : "";
    const secret = typeof record.key === "string" ? record.key : "";
    const provider = typeof record.provider === "string" ? record.provider : "opencode-go";
    if (id.length === 0 || secret.length === 0 || !API_KEY_PROVIDERS.includes(provider)) continue;
    keys.push({
      id,
      label: typeof record.label === "string" ? record.label : "",
      provider,
      key: secret,
    });
  }
  return keys;
}

export function maskedApiKeys(keys: StoredApiKey[]): MaskedApiKey[] {
  const masked: MaskedApiKey[] = [];
  for (const key of keys) {
    masked.push({
      id: key.id,
      label: key.label,
      provider: key.provider,
      hint: maskApiKey(key.key),
    });
  }
  return masked;
}

export function apiKeyInputError(input: { id: string; provider: string; key: string }, existing: StoredApiKey[]): string {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9_.:@-]{1,64}$/.test(id)) return "Use a stable id without spaces";
  if (!API_KEY_PROVIDERS.includes(input.provider)) return "Choose a provider";
  if (input.key.trim().length <= 10) return "The API key is too short";
  for (const key of existing) {
    if (key.id === id && key.provider === input.provider) return "That id is already saved for this provider";
  }
  return "";
}

export function addStoredApiKey(keys: StoredApiKey[], input: { id: string; label: string; provider: string; key: string }): StoredApiKey[] {
  const error = apiKeyInputError(input, keys);
  if (error.length > 0) throw new Error(error);
  const next: StoredApiKey[] = [];
  for (const key of keys) next.push(key);
  const label = input.label.trim().slice(0, 48);
  next.push({
    id: input.id.trim(),
    label,
    provider: input.provider,
    key: input.key.trim(),
  });
  return next;
}

export function removeStoredApiKey(keys: StoredApiKey[], id: string, provider: string): StoredApiKey[] {
  const next: StoredApiKey[] = [];
  for (const key of keys) {
    if (key.id === id && key.provider === provider) continue;
    next.push(key);
  }
  return next;
}

export function storedApiKeyJson(keys: StoredApiKey[]): string {
  const records: Array<{ id: string; label?: string; provider: string; key: string }> = [];
  for (const key of keys) {
    const record: { id: string; label?: string; provider: string; key: string } = {
      id: key.id,
      provider: key.provider,
      key: key.key,
    };
    if (key.label.length > 0) record.label = key.label;
    records.push(record);
  }
  return JSON.stringify(records);
}
