import os from "node:os";

/** Machine attribution for events produced locally. */
export function localMachineId(): string {
  return os.hostname();
}

/** Hash an account secret down to a short non-reversible label. */
export function hashAccountKey(secret: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(secret);
  return hasher.digest("hex").slice(0, 12);
}

/** Build the stable cross-machine dedupe id for an event. */
export function eventId(
  provider: string,
  accountKey: string,
  sessionId: string,
  entryId: string,
): string {
  return `${provider}:${accountKey}:${sessionId}:${entryId}`;
}
