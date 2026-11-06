export interface TrackedSource {
  id: string;
  label: string;
  roots: Array<{ path: string; envVar: string }>;
  filesFound: number;
  trackedFiles: number;
  upToDateFiles: number;
  events: number;
  accounts: string;
  models: string[];
  note: string;
}

function count(value: string): number {
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseTrackedSources(text: string): TrackedSource[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "no providers registered") return [];
  const blocks = trimmed.split(/\n\s*\n/);
  const sources: TrackedSource[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const separator = header.indexOf(" — ");
    if (separator <= 0) continue;
    const source: TrackedSource = {
      id: header.slice(0, separator).trim(),
      label: header.slice(separator + 3).trim(),
      roots: [],
      filesFound: 0,
      trackedFiles: 0,
      upToDateFiles: 0,
      events: 0,
      accounts: "",
      models: [],
      note: "",
    };
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const root = /^ {2}root: (.*?)(?: \(`([^`]*)`\))?$/.exec(line);
      if (root !== null) {
        source.roots.push({ path: root[1] ?? "", envVar: root[2] ?? "" });
        continue;
      }
      const files = /^ {2}files: ([0-9,]+) found · ([0-9,]+) tracked · ([0-9,]+) up-to-date$/.exec(line);
      if (files !== null) {
        source.filesFound = count(files[1] ?? "0");
        source.trackedFiles = count(files[2] ?? "0");
        source.upToDateFiles = count(files[3] ?? "0");
        continue;
      }
      const events = /^ {2}events: ([0-9,]+) · accounts: (.+)$/.exec(line);
      if (events !== null) {
        source.events = count(events[1] ?? "0");
        const accounts = events[2] ?? "";
        source.accounts = accounts === "(none)" ? "" : accounts;
        continue;
      }
      const models = /^ {2}models: (.+)$/.exec(line);
      if (models !== null) {
        const value = models[1] ?? "";
        if (value !== "(none)" && value.length > 0) source.models = value.split(", ");
        continue;
      }
      const note = /^ {2}note: (.+)$/.exec(line);
      if (note !== null) source.note = note[1] ?? "";
    }
    if (source.id.length > 0) sources.push(source);
  }
  return sources;
}

export function activeTrackedSources(sources: TrackedSource[]): TrackedSource[] {
  const active: TrackedSource[] = [];
  for (const source of sources) {
    if (source.filesFound > 0 || source.events > 0 || source.trackedFiles > 0) active.push(source);
  }
  return active;
}
