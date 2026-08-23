import { tidLike } from "./tid.ts";
import type { SyncAdapter, SyncConfig } from "./types.ts";

/**
 * ATProto PDS adapter (SCAFFOLD — the lexicon is NOT published yet).
 *
 * Layout: one record per event chunk under the custom collection
 * `tokitoki.<handle-first-label>.usage`, rkey = TID-like sortable timestamp.
 * ⚠️ The nsid embeds a handle label which does not satisfy the official NSID
 * grammar for a domain you don't own; until a real lexicon is registered
 * (e.g. under an owned domain), most validation layers would reject writes on
 * a strict PDS. Guarded behind `--sync-atproto` for that reason.
 *
 * Auth: app password (never the account password) from config or
 * TOKITOKI_ATPROTO_APP_PASSWORD. Session created lazily, reused per process.
 */
export class AtprotoAdapter implements SyncAdapter {
  readonly id = "atproto" as const;
  readonly label: string;

  private accessJwt: string | undefined;
  private did: string | undefined;

  constructor(private readonly cfg: Required<Pick<SyncConfig, "handle">> & SyncConfig) {
    this.label = `atproto:${cfg.handle}@${cfg.pds ?? "https://bsky.social"}`;
  }

  private get pds(): string {
    return (this.cfg.pds ?? "https://bsky.social").replace(/\/$/, "");
  }

  /** NSID is unstable until the lexicon is published — see class doc. */
  private get collection(): string {
    const label = this.cfg.handle.split(".")[0]!.replace(/[^a-zA-Z0-9-]/g, "");
    return `tokitoki.${label}.usage`;
  }

  private appPassword(): string {
    const pw = this.cfg.appPassword ?? process.env.TOKITOKI_ATPROTO_APP_PASSWORD;
    if (pw === undefined || pw.length === 0) {
      throw new Error(
        "atproto sync needs an app password: set [sync].appPassword in config or TOKITOKI_ATPROTO_APP_PASSWORD",
      );
    }
    return pw;
  }

  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.pds}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.accessJwt !== undefined ? { authorization: `Bearer ${this.accessJwt}` } : {}),
        ...init?.headers,
      },
    });
  }

  /** createSession once; retry once after a 401 (expired token). */
  private async ensureSession(force = false): Promise<void> {
    if (!force && this.accessJwt !== undefined && this.did !== undefined) return;
    const res = await fetch(`${this.pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: this.cfg.handle,
        password: this.appPassword(),
      }),
    });
    if (!res.ok) throw new Error(`atproto login failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { accessJwt: string; did: string };
    this.accessJwt = body.accessJwt;
    this.did = body.did;
  }

  async push(lines: string[]): Promise<void> {
    await this.ensureSession();
    // One record per line keeps records small and pulls resumable.
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const record = {
        $type: this.collection,
        event: JSON.parse(trimmed),
        syncedAt: new Date().toISOString(),
      };
      const res = await this.request("/xrpc/com.atproto.repo.putRecord", {
        method: "POST",
        body: JSON.stringify({
          repo: this.did,
          collection: this.collection,
          rkey: tidLike(),
          record,
        }),
      });
      if (res.status === 401) {
        this.accessJwt = undefined;
        await this.ensureSession(true);
        return this.push([line]); // single-line retry after re-auth
      }
      if (!res.ok && res.status !== 400) {
        throw new Error(`atproto putRecord failed (${res.status}): ${await res.text()}`);
      }
      if (res.status === 400) {
        // Most likely lexicon-not-published / nsid rejection — surface clearly
        throw new Error(`atproto putRecord rejected (lexicon unpublished?): ${await res.text()}`);
      }
    }
  }

  /** Publish an arbitrary record under a custom collection (public share). */
  async putCustomRecord(
    collection: string,
    rkey: string,
    record: unknown,
  ): Promise<{ cid: string; rkey: string }> {
    await this.ensureSession();
    const res = await this.request("/xrpc/com.atproto.repo.putRecord", {
      method: "POST",
      body: JSON.stringify({ repo: this.did, collection, rkey, record }),
    });
    if (!res.ok) {
      throw new Error(`atproto putRecord failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { cid?: string };
    return { cid: body.cid ?? "", rkey };
  }

  async *pull(): AsyncIterable<string> {
    await this.ensureSession();
    let cursor: string | undefined;
    do {
      const url = new URL("/xrpc/com.atproto.repo.listRecords", this.pds);
      url.searchParams.set("repo", this.did!);
      url.searchParams.set("collection", this.collection);
      url.searchParams.set("limit", "100");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const res = await this.request(url.pathname + url.search);
      if (!res.ok) throw new Error(`atproto listRecords failed (${res.status}): ${await res.text()}`);
      const body = (await res.json()) as { records?: Array<{ value: unknown }>; cursor?: string };
      for (const rec of body.records ?? []) {
        const value = rec.value as { event?: unknown } | null;
        if (value?.event !== undefined) yield JSON.stringify(value.event);
      }
      cursor = body.cursor;
    } while (cursor !== undefined);
  }
}
