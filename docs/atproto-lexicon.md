# Publishing the tokitoki ATProto lexicon

The `atproto` sync adapter currently writes records under the **unpublished**
NSID `dev.tokitoki.usage`. It works against any PDS but other tooling won't
understand it until the lexicon is published. This doc is the step-by-step for
publishing it properly when we decide to.

## Current record shape (adapter source of truth: `src/sync/atproto.ts`)

```jsonc
{
  "$type": "dev.tokitoki.usage",
  "machine": "<machine-id>",
  "provider": "<harness id>",
  "accountKey": "<account label>",
  "model": "<model>",
  "ts": "<ISO-8601>",
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "costUsd": 0,
  "projectDir": "<optional>",
  "sessionId": "<optional>",
  "eventId": "<stable dedupe id>"
}
```

## Steps

### 1. Finalize the NSID

- NSID = reverse-DNS + name: `dev.tokitoki.usage`
- Requirement: you control the domain `tokitoki.dev` (add `_atproto` TXT
  verification or host the DID doc there). If we don't want the domain, pick
  one we do own — NSIDs are permanent once others depend on them.
- Record type should be singular (`usage`, not `usages`).

### 2. Write the lexicon schema document

`lexicons/dev/tokitoki/usage.json`:

```json
{
  "lexicon": 1,
  "id": "dev.tokitoki.usage",
  "defs": {
    "main": {
      "type": "record",
      "description": "One normalized coding-agent usage event",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["machine", "provider", "model", "ts", "eventId"],
        "properties": {
          "machine":    { "type": "string", "maxLength": 256 },
          "provider":   { "type": "string", "maxLength": 64 },
          "accountKey": { "type": "string", "maxLength": 256 },
          "model":      { "type": "string", "maxLength": 256 },
          "ts":         { "type": "string", "format": "datetime" },
          "inputTokens":      { "type": "integer", "minimum": 0 },
          "outputTokens":     { "type": "integer", "minimum": 0 },
          "cacheReadTokens":  { "type": "integer", "minimum": 0 },
          "cacheWriteTokens": { "type": "integer", "minimum": 0 },
          "costUsd":          { "type": "number" },
          "projectDir": { "type": "string", "maxLength": 1024 },
          "sessionId":  { "type": "string", "maxLength": 512 },
          "eventId":    { "type": "string", "maxLength": 1024 }
        }
      }
    }
  }
}
```

Keep it in sync with `src/types.ts` — consider generating this file from the
TS types later.

### 3. Publish / announce

Options, cheapest first:
1. **Lexicon community repo** — PR the file into
   <https://github.com/bluesky-community/lexicons> (community-maintained
   registry; the de-facto discovery mechanism for third-party lexicons)
2. **HTTP hosting on your own domain** — serve at
   `https://tokitoki.dev/lexicons/dev/tokitoki/usage.json`; clients can fetch
   it directly. Add a link from the repo README.
3. Both (recommended).

Announce: open an issue/discussion linking the schema from
`atproto-spec` discussions and your own README; no central authority approves
NSIDs — ownership is enforced by DNS/DID control of the domain.

### 4. Flip the adapter

In `src/sync/atproto.ts`:
- remove/loosen the experimental guard flag around the backend
- validate remote-side records against the published schema where cheap
- bump the record `$type` ONLY IF the shape changed since first release —
  otherwise keep `dev.tokitoki.usage` and treat additions as optional fields
  (never rename/remove existing fields)

### Versioning rules

- Lexicons are append-only in practice: add optional fields freely, never
  repurpose existing ones
- Breaking change ⇒ new NSID (`dev.tokitopi.usageV2` style) + migration read
  path, not an edit of the old schema
- Tag adapter versions together with schema revisions in this repo's releases

## Privacy note before publishing

Events include projectDir paths (can leak client/project names) and account
labels. Decide whether to hash/omit these for the public network or document
that records are user-private (they live in YOUR PDS — only repos you grant
access can read, so publishing the lexicon does NOT publish your data).

## What it will be used for

Three concrete consumers, in the order we expect to need them:

### (a) Sync adapter records (already live, unpublished NSID)
`dev.tokitoki.usage` — machine-readable per-event usage rows synced across
machines by `tokitoki sync --backend atproto`. Works today against any PDS;
publishing makes third-party tools able to read/validate them and lets us
drop the "lexicon unpublished?" 400-rejection workaround.

### (b) Public share records (`dev.tokitoki.share`)
The opt-in sharing feature (`tokitoki share`, web share button) publishes a
sanitized aggregate under this second NSID:

```jsonc
{
  "$type": "dev.tokitoki.share",
  "period": "week",                       // or "month"
  "window": { "since": "...", "until": "..." },
  "totals": { "costUsd": 0, "requests": 0, "tokens": 0 },
  "topModels": [{ "name": "...", "share": 50 }],   // % of spend (or tokens when free)
  "topTools":  [{ "name": "...", "share": 30 }],
  "repos":     [{ "hash": "<sha256-16>", "share": 12 }], // optional, hashed only
  "generatedAt": "..."
}
```

Privacy contract (enforced in `src/share.ts`, tested in `test/share.test.ts`):
no messages, no prompts, no emails, no account ids, no raw project paths —
repo names are hashed even with `--include-repos`. Publishing the lexicon
lets aggregate dashboards (e.g. community leaderboards) consume these
records interoperably. Key type: `id` style rkey (`<scope>-<YYYY-MM-DD>`) —
one rolling record per scope/day, republish replaces via putRecord.

### (c) Cross-device session bodies sync (future)
Today only normalized usage *events* sync; session text bodies stay local
(see `plans/sessions-page.md`). A `dev.tokitoki.sessionBody` record would let
search work across machines without Syncthing: one record per session chunk,
encrypted client-side if desired. Design deliberately deferred until the
usage + share lexicons are stable.

### Versioning policy (applies to all three)
- Additive optional fields: always fine, bump nothing
- Renames/removals/semantic changes: never edit — new NSID
  (`...usageV2`) + read-compat window in the adapter
- Schema files live in `lexicons/dev/tokitoki/*.json` in this repo and are
  generated-checked against `src/types.ts` / `src/share.ts` before publish
