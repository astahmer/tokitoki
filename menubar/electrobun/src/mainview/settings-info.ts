export interface AlertRecord {
  at: string;
  title: string;
  body: string;
  reason: string;
  kind: string;
}

export function configPathFromList(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const match = /^surface visibility \(config: (.+)\)$/.exec(line.trim());
    if (match !== null) return match[1] ?? "";
  }
  return "";
}

export function parseAlertHistory(raw: string): AlertRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const history = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as { history?: unknown }).history
      : undefined;
  if (!Array.isArray(history)) return [];
  const records: AlertRecord[] = [];
  for (const item of history) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { at?: unknown; title?: unknown; body?: unknown; reason?: unknown; kind?: unknown };
    const title = typeof record.title === "string" ? record.title : "";
    if (title.length === 0) continue;
    records.push({
      at: typeof record.at === "string" ? record.at : "",
      title,
      body: typeof record.body === "string" ? record.body : "",
      reason: typeof record.reason === "string" ? record.reason : "",
      kind: typeof record.kind === "string" ? record.kind : "",
    });
  }
  records.sort((left, right) => right.at.localeCompare(left.at));
  return records.slice(0, 5);
}
