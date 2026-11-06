import { escapeHtml } from "./format.ts";

type ConversationBlock =
  | { kind: "heading"; text: string; level: number }
  | { kind: "code"; text: string; language: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "paragraph"; text: string };

type ConversationGroup = { role: string; timestamp: string; blocks: ConversationBlock[] };

function toolName(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.toLowerCase() === "### tool call") return "tool call";
  if (trimmed.startsWith("[tool:")) {
    const end = trimmed.indexOf("]");
    if (end > 6) return trimmed.slice(6, end);
  }
  if (trimmed.startsWith("tools.") || trimmed.startsWith("functions.")) {
    const end = trimmed.indexOf("(");
    return end < 0 ? trimmed : trimmed.slice(0, end);
  }
  return undefined;
}

function toolCounts(body: string): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of body.split("\n")) {
    const name = toolName(line);
    if (name === undefined) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.keys()].sort();
  const rows: Array<{ name: string; count: number }> = [];
  for (const name of names) rows.push({ name, count: counts.get(name) ?? 0 });
  return rows;
}

function readableBody(body: string, title: string): string {
  const source = body.split("\n");
  const lines: string[] = [];
  for (const line of source) {
    if (toolName(line) !== undefined) continue;
    const cleaned = line
      .replace(/\[tool:[^\]]+\]/g, "")
      .replace(/(?<![\w/])(?:tools|functions)\.[A-Za-z0-9_./-]+(?:\([^)\n]*\))?/g, "");
    lines.push(cleaned);
  }
  const normalizedTitle = title.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalizedTitle.length > 0) {
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first >= 0) {
      const heading = (lines[first] ?? "")
        .replace(/^[#>*-]+\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (heading === normalizedTitle) lines.splice(first, 1);
    }
  }
  return lines.join("\n").trim();
}

function readableBlocks(body: string): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let orderedList = false;
  let code: string[] | undefined;
  let codeLanguage = "";
  const flushParagraph = (): void => {
    const text = paragraph.join("\n").trim();
    if (text.length > 0) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length > 0) blocks.push({ kind: "list", items: list, ordered: orderedList });
    list = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (code !== undefined) {
      if (/^```\s*$/.test(trimmed)) {
        blocks.push({ kind: "code", text: code.join("\n"), language: codeLanguage });
        code = undefined;
        codeLanguage = "";
      } else {
        code.push(line);
      }
      continue;
    }
    const fence = /^```\s*([A-Za-z0-9_-]+)?\s*$/.exec(trimmed);
    if (fence !== null) {
      flushAll();
      codeLanguage = fence[1] ?? "";
      code = [];
      continue;
    }
    if (trimmed.length === 0) {
      flushAll();
      continue;
    }
    if (/^#{1,6}\s+.+$/.test(trimmed)) {
      flushAll();
      const marks = /^#+/.exec(trimmed);
      const level = marks === null ? 1 : marks[0].length;
      blocks.push({ kind: "heading", text: trimmed.slice(level).trim(), level });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushAll();
      blocks.push({ kind: "quote", text: trimmed.slice(1).trim() });
      continue;
    }
    if (/^(?:[-*+]\s+|[0-9]+[.)]\s+).+$/.test(trimmed)) {
      const ordered = trimmed[0] !== undefined && trimmed[0] >= "0" && trimmed[0] <= "9";
      if (list.length > 0 && orderedList !== ordered) flushList();
      orderedList = ordered;
      list.push(trimmed.replace(/^(?:[-*+]\s+|[0-9]+[.)]\s+)/, ""));
      continue;
    }
    if (list.length > 0) flushList();
    paragraph.push(line);
  }
  if (code !== undefined) blocks.push({ kind: "code", text: code.join("\n"), language: codeLanguage });
  flushAll();
  return blocks;
}

function readableGroups(blocks: ConversationBlock[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let role = "message";
  let timestamp = "";
  let current: ConversationBlock[] = [];
  const flush = (): void => {
    if (current.length > 0) groups.push({ role, timestamp, blocks: current });
    current = [];
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      const pieces = block.text.split("·");
      const candidate = (pieces[0] ?? "").trim().toLowerCase();
      if (candidate === "user" || candidate === "assistant" || candidate === "tool call") {
        flush();
        role = candidate === "tool call" ? "tool" : candidate;
        if (pieces.length > 1) {
          const rest: string[] = [];
          for (let index = 1; index < pieces.length; index += 1) rest.push(pieces[index] ?? "");
          timestamp = rest.join("·").trim();
        } else {
          timestamp = "";
        }
        continue;
      }
    }
    current.push(block);
  }
  flush();
  return groups;
}

function inlineMarkdown(text: string): string {
  const pieces = text.split("`");
  let markup = "";
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? "";
    if (index % 2 === 1 && index !== pieces.length - 1) markup += `<code>${escapeHtml(piece)}</code>`;
    else markup += emphasisAndLinks(piece);
  }
  return markup;
}

function emphasisAndLinks(text: string): string {
  const pattern = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let markup = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    markup += escapeHtml(text.slice(cursor, start));
    const label = match[1];
    const bold = match[3];
    const italic = match[4];
    if (label !== undefined) markup += `<span class="md-link">${escapeHtml(label)}</span>`;
    else if (bold !== undefined) markup += `<strong>${escapeHtml(bold)}</strong>`;
    else if (italic !== undefined) markup += `<em>${escapeHtml(italic)}</em>`;
    cursor = start + match[0].length;
  }
  markup += escapeHtml(text.slice(cursor));
  return markup;
}

function blockMarkup(block: ConversationBlock): string {
  if (block.kind === "code") {
    const language = block.language.length > 0 ? `<div class="tiny">${escapeHtml(block.language)}</div>` : "";
    return `<div class="conversation-code">${language}<pre>${escapeHtml(block.text)}</pre></div>`;
  }
  if (block.kind === "heading") {
    const level = block.level <= 2 ? " major" : "";
    return `<div class="conversation-heading${level}">${inlineMarkdown(block.text)}</div>`;
  }
  if (block.kind === "quote") return `<div class="conversation-quote">${inlineMarkdown(block.text)}</div>`;
  if (block.kind === "list") {
    const items: string[] = [];
    for (let index = 0; index < block.items.length; index += 1) {
      const marker = block.ordered ? `${index + 1}.` : "•";
      items.push(`<div class="row"><span class="tiny">${marker}</span><span class="grow">${inlineMarkdown(block.items[index] ?? "")}</span></div>`);
    }
    return items.join("");
  }
  return `<p>${inlineMarkdown(block.text)}</p>`;
}

function groupMarkup(group: ConversationGroup): string {
  const blocks: string[] = [];
  for (const block of group.blocks) blocks.push(blockMarkup(block));
  const stamp = group.timestamp.length > 0 ? `<span class="tiny">${escapeHtml(group.timestamp)}</span>` : "";
  if (group.role === "tool") {
    const count = group.blocks.length;
    const label = count === 1 ? "part" : "parts";
    return `<details class="conversation-tool"><summary class="conversation-role tool">Tool call · ${count} ${label}${stamp.length > 0 ? " " : ""}${stamp}</summary>${blocks.join("")}</details>`;
  }
  return `<div class="conversation-group ${escapeHtml(group.role)}"><div class="row"><span class="conversation-role ${escapeHtml(group.role)}">${escapeHtml(group.role)}</span>${stamp}</div>${blocks.join("")}</div>`;
}

/** Readable transcript: role groups, markdown blocks, and a separate tool summary. */
export function renderConversation(body: string, title: string): string {
  const tools = toolCounts(body);
  const readable = readableBody(body, title);
  const parts: string[] = [`<div class="conversation">`];
  if (tools.length > 0) {
    let total = 0;
    const rows: string[] = [];
    for (const tool of tools) {
      total += tool.count;
      rows.push(`<div class="tiny">${escapeHtml(tool.name)} · ${tool.count}</div>`);
    }
    parts.push(`<details class="conversation-tools"><summary>Tools used · ${total}</summary>${rows.join("")}</details>`);
  }
  if (readable.length === 0) parts.push(`<p class="muted">No conversation body indexed.</p>`);
  else {
    for (const group of readableGroups(readableBlocks(readable))) parts.push(groupMarkup(group));
  }
  parts.push(`</div>`);
  return parts.join("");
}
