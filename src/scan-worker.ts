/**
 * Scan worker: one provider per worker, spawned by `tokitoki scan` so
 * independent harness stores are read in parallel. Streams extracted events
 * back to the parent in batches. Cursors go to the parent too: it saves them
 * only after the events are in events.jsonl, so an interrupted scan replays
 * instead of skipping unwritten events.
 */
import { getProvider } from "./providers/index.ts";
import { scanProviderCore } from "./scan.ts";

interface ScanRequest {
  type: "scan";
  providerId: string;
  machineId: string;
}

const workerSelf = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<ScanRequest>) => void) | null;
  postMessage: (msg: unknown) => void;
};

workerSelf.onmessage = (ev: MessageEvent<ScanRequest>) => {
  const msg = ev.data;
  if (msg?.type !== "scan") return;
  const provider = getProvider(msg.providerId);
  if (provider === undefined) {
    workerSelf.postMessage({ type: "error", message: `unknown provider: ${msg.providerId}` });
    return;
  }
  try {
    const result = scanProviderCore(provider, msg.machineId, {
      onEvents: (events) => workerSelf.postMessage({ type: "events", events }),
      onQuotas: (quotas) => workerSelf.postMessage({ type: "quotas", quotas }),
      onReplayedUsage: (ids) => workerSelf.postMessage({ type: "replayed-usage", ids }),
      onSaveCursors: (cursors) => workerSelf.postMessage({ type: "cursors", cursors }),
    });
    workerSelf.postMessage({ type: "done", result });
  } catch (err) {
    workerSelf.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
