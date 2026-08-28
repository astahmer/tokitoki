/** Remove injected agent/app context before showing or indexing conversations. */
export function cleanSessionText(raw: string): string {
  let text = raw.replaceAll("\r\n", "\n");
  for (const tag of ["app-context", "environment_context", "skills_instructions", "codex_internal_context"]) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  // Codex can persist AGENTS.md and project instructions as ordinary
  // user-role input, outside the XML context wrappers. They are useful to
  // the agent but are not part of the conversation a user wants to search.
  text = text.replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  text = text.replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, "");
  text = text.replace(new RegExp("<image[^>]*>" + "[^]*?" + "</image>", "gi"), "");
  text = text.replace(/<[^>]+>/g, "");
  let skipPluginCatalog = false;
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim());
  let blankPending = false;
  const visible: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      blankPending = visible.length > 0;
      continue;
    }
    if (blankPending && visible.at(-1) !== "") visible.push("");
    blankPending = false;
    const lower = line.toLowerCase();
    if (lower.startsWith("# agents.md instructions")) continue;
    if (lower.includes("here is a list of plugins that are available but not installed")) {
      skipPluginCatalog = true;
      continue;
    }
    if (skipPluginCatalog && (line.startsWith("-") || lower.includes("@openai-curated-remote"))) continue;
    skipPluginCatalog = false;
    visible.push(line);
  }
  return visible.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function sessionTitle(raw: string, fallback = ""): string {
  const cleaned = cleanSessionText(raw);
  const lowerCleaned = cleaned.toLowerCase();
  const marker = cleaned.toLowerCase().lastIndexOf("my request:");
  if (marker < 0 && (lowerCleaned.includes("# agents.md instructions") || lowerCleaned.includes("here is a list of plugins that are available but not installed"))) {
    return fallback;
  }
  const requestText = marker >= 0 ? cleaned.slice(marker + "my request:".length) : cleaned;
  const parts = requestText.split(/\n{2,}|\n(?=(?:[-*#]|\d+[.)])\s)/).map((part) => part.trim()).filter(Boolean);
  const candidate = [...parts].reverse().find((part) => {
    const lower = part.toLowerCase();
    return part.length >= 3 && !lower.startsWith("here is a list of plugins") && !lower.startsWith("you are chatgpt");
  });
  return (candidate ?? cleaned.split("\n")[0] ?? fallback).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function sessionSnippet(raw: string, max = 2000): string {
  return cleanSessionText(raw).slice(0, max);
}

/** Add a stable, renderer-friendly role boundary to indexed transcripts. */
export function sessionMessage(role: "user" | "assistant" | "tool", text: string, timestamp?: string): string {
  const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : "Tool call";
  const cleaned = sessionSnippet(text);
  if (cleaned.length === 0) return "";
  const time = timestamp !== undefined && Number.isFinite(Date.parse(timestamp))
    ? ` · ${timestamp.slice(0, 19).replace("T", " ")}`
    : "";
  return `### ${label}${time}\n\n${cleaned}`;
}

/** Keep tool transcripts useful without echoing giant serialized arguments. */
export function summarizeToolCall(name: string, input = ""): string {
  const normalizedName = name.replace(/^functions\.|^tools\./, "");
  const command = /(?:["']?cmd["']?|["']?command["']?)\s*:\s*["']([^"']+)/i.exec(input)?.[1]
    ?? /\b(?:rtk|bun|pnpm|npm|node|git|jj|swift|curl)\s+[^,}\n]+/i.exec(input)?.[0];
  return command === undefined
    ? normalizedName
    : `${normalizedName} · ${command.replace(/\\["']/g, '"').trim()}`.slice(0, 180);
}
