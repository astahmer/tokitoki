# Plan: local MCP server (`tokitoki mcp`)

Status: planned. Goal: any coding agent (pi, claude, codex, cursor…) can query
tokitopi's full surface as MCP tools instead of shelling out.

## Shape

- Subcommand: `tokitoki mcp` → stdio transport (local-only, no daemon, no
  port; lifecycle owned by the client). Optional `--http <port>` later for
  multi-client setups.
- SDK: `@modelcontextprotocol/sdk` (official TS SDK; already star-tracked).
  Runs inside the existing Bun binary — no new runtime.
- One EventCache handle per server lifetime (WAL + busy_timeout already make
  concurrent CLI/menubar/web access safe).

## Tools — mirror every CLI surface

| Tool | Maps to | Returns |
|---|---|---|
| `usage_report` | `report/today/week/month --json` | window totals + per-dimension rows |
| `usage_chart` | `chart` | daily series (data, not ASCII) |
| `usage_pie` | `pie` | share-of-tokens by dimension |
| `sessions_top` | `sessions` | costliest/heaviest sessions |
| `session_detail` | sessions drill-down | per-request rows for one session |
| `tool_spend` | `tools` | spend attributed to tools (mcp: rollup incl.) |
| `repo_efficiency` | `repos` | repo ranking |
| `budgets_status` | `budgets --json` | caps vs used (menubar contract) |
| `quota_snapshot` | limits/hero cards | latest provider-reported quota windows |
| `anomalies` | `anomalies` | unusual days vs baseline |
| `sources` | `sources` | freshness/provenance per provider |
| `scan_now` | `scan` | trigger incremental scan, returns counts |
| `export_report` | `export` | json/csv/markdown blob |

Design rules:
- Every tool takes the same window semantics as the CLI (`--last`, `--from/--to`)
  via a shared arg schema helper so CLI/MCP never drift.
- Read-only tools return compact JSON (agents don't need pretty tables);
  `format: "markdown"` opt-in flag reuses render functions.
- `scan_now` is the only mutator; it's idempotent and safe to call before reads.

## Wiring & docs

- Config snippets in README for pi / claude / codex registrations.
- Test: script a client session against the stdio server in bun test
  (list-tools → call each tool against fixture data dir).
- Later (out of scope): MCP Apps/UI surface for embedding report cards in
  clients that support it (mcp-ui / ext-apps spec watch).

## Why this matters competitively

ccusage/CodexBar have no agent-facing API — they're human-facing only. An MCP
server makes tokitoki the usage-brain *inside* the loop: agents can check
their own burn rate, quota headroom, or repo cost-efficiency mid-task. Cheap
to build, unique in the field (see competitive-analysis.md).
