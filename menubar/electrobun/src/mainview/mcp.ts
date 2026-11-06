export interface McpIntegration {
  id: string;
  title: string;
  location: string;
  steps: string[];
  snippet: string;
}

export interface McpTool {
  name: string;
  summary: string;
  inputs: string;
}

export const MCP_INTEGRATIONS: McpIntegration[] = [
  {
    id: "claude-desktop",
    title: "Claude Desktop",
    location: "Claude Desktop settings, Developer, Edit Config",
    steps: ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."],
    snippet: `{
  "mcpServers": {
    "tokitoki": {
      "command": "tokitoki",
      "args": ["mcp"]
    }
  }
}`,
  },
  {
    id: "claude-code",
    title: "Claude Code",
    location: "Claude Code terminal",
    steps: ["Run the command below in a terminal.", "Restart Claude Code or reconnect MCP."],
    snippet: "claude mcp add tokitoki -- tokitoki mcp",
  },
  {
    id: "codex",
    title: "Codex",
    location: "Codex config.toml",
    steps: ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."],
    snippet: `[mcp_servers.tokitoki]
command = "tokitoki"
args = ["mcp"]`,
  },
  {
    id: "cursor",
    title: "Cursor",
    location: "Cursor settings, MCP",
    steps: ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."],
    snippet: `{
  "mcpServers": {
    "tokitoki": {
      "command": "tokitoki",
      "args": ["mcp"]
    }
  }
}`,
  },
  {
    id: "windsurf",
    title: "Windsurf",
    location: "Windsurf settings, MCP",
    steps: ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."],
    snippet: `{
  "mcpServers": {
    "tokitoki": {
      "command": "tokitoki",
      "args": ["mcp"]
    }
  }
}`,
  },
  {
    id: "vscode",
    title: "VS Code",
    location: ".vscode/mcp.json",
    steps: ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."],
    snippet: `{
  "servers": {
    "tokitoki": {
      "type": "stdio",
      "command": "tokitoki",
      "args": ["mcp"]
    }
  }
}`,
  },
];

export const MCP_TOOLS: McpTool[] = [
  { name: "usage_report", summary: "Aggregate tokens, requests, sessions, cache, and cost.", inputs: "window, dimension, optional provider" },
  { name: "usage_totals", summary: "Return only totals for a window.", inputs: "window, optional provider" },
  { name: "sessions_top", summary: "Find the most expensive or token-heavy sessions.", inputs: "window, limit, optional provider" },
  { name: "session_detail", summary: "Expand one session into its request timeline.", inputs: "session id" },
  { name: "tool_spend", summary: "Rank spend by the tool that caused each request.", inputs: "window" },
  { name: "repo_efficiency", summary: "Rank repositories by cost and cache use.", inputs: "window" },
  { name: "budgets_status", summary: "Read configured spending caps and their gauges.", inputs: "none" },
  { name: "quota_snapshot", summary: "Read the latest provider quota windows for one account.", inputs: "provider, account key" },
  { name: "anomalies", summary: "Detect unusual activity days against the trailing baseline.", inputs: "window" },
  { name: "sources", summary: "Explain provider roots, files, freshness, accounts, and models.", inputs: "none" },
  { name: "scan_now", summary: "Scan harness stores and update the local cache. This is the only tool that writes.", inputs: "none" },
  { name: "search_sessions", summary: "Search session titles and summaries.", inputs: "query, limit, optional provider" },
  { name: "usage_chart", summary: "Return one row per day for a chart.", inputs: "window, metric" },
  { name: "export_report", summary: "Export a grouped report as JSON, CSV, or Markdown.", inputs: "window, format, dimension, optional provider" },
];

export function mcpIntegration(id: string): McpIntegration {
  for (const integration of MCP_INTEGRATIONS) {
    if (integration.id === id) return integration;
  }
  const fallback = MCP_INTEGRATIONS[0];
  if (fallback === undefined) throw new Error("missing mcp integration");
  return fallback;
}
