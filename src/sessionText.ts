/** Remove injected agent/app context before showing or indexing conversations. */
export function cleanSessionText(raw: string): string {
  let text = raw.replaceAll("\r\n", "\n");
  for (const tag of ["app-context", "environment_context", "skills_instructions"]) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  text = text.replace(/<recommended_plugins>/gi, "");
  text = text.replace(new RegExp("<image[^>]*>" + "[^]*?" + "</image>", "gi"), "");
  text = text.replace(/<[^>]+>/g, "");
  let skipPluginCatalog = false;
  const lines = text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const visible = lines.filter((line) => {
    const lower = line.toLowerCase();
    if (lower.includes("here is a list of plugins that are available but not installed")) {
      skipPluginCatalog = true;
      return false;
    }
    if (skipPluginCatalog && (line.startsWith("-") || lower.includes("@openai-curated-remote"))) return false;
    skipPluginCatalog = false;
    return true;
  });
  return visible.join("\n").trim();
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
