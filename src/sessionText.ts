/** Remove injected agent/app context before showing or indexing conversations. */
export function cleanSessionText(raw: string): string {
  let text = raw.replaceAll("\r\n", "\n");
  for (const tag of ["app-context", "environment_context", "skills_instructions"]) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  text = text.replace(/<recommended_plugins>[\\s\\S]*?(?=\n\s*(?:My request:|#\s|\*\s|\-\s)|$)/gi, "");
  text = text.replace(/<image[^>]*>[\\s\\S]*?<\/image>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  return text.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").trim();
}

export function sessionTitle(raw: string, fallback = ""): string {
  const cleaned = cleanSessionText(raw);
  const parts = cleaned.split(/\n{2,}|\n(?=(?:[-*#]|\d+[.)])\s)/).map((part) => part.trim()).filter(Boolean);
  const candidate = [...parts].reverse().find((part) => {
    const lower = part.toLowerCase();
    return part.length >= 3 && !lower.startsWith("here is a list of plugins") && !lower.startsWith("you are chatgpt");
  });
  return (candidate ?? cleaned.split("\n")[0] ?? fallback).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function sessionSnippet(raw: string, max = 2000): string {
  return cleanSessionText(raw).slice(0, max);
}
