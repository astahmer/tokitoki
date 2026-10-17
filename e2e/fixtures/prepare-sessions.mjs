import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const listPath = path.join(fixtureDirectory, "sessions.json");
const sessions = JSON.parse(fs.readFileSync(listPath, "utf8"));

if (!Array.isArray(sessions.rows) || sessions.rows.length === 0 || !sessions.hasMore) {
  throw new Error("sessions.json must contain rows and report another CLI page");
}

const stableRows = sessions.rows.map((row, index) => ({
  ...row,
  sessionId: `e2e-session-${String(index + 1).padStart(3, "0")}`,
  title: index === 0 ? "E2E search needle" : "e2e fixture session",
  snippet: index === 0
    ? "A deterministic Docker fixture with a searchable needle."
    : "### User · 2026-01-01 00:00:00 e2e fixture prompt ### Assistant · 2026-01-01 00:00:01",
}));

sessions.rows = stableRows;
fs.writeFileSync(listPath, `${JSON.stringify(sessions, null, 2)}\n`);

const pageTwoRow = {
  accountKey: "codex",
  cachePct: 42,
  cacheReadTokens: 1200,
  cacheWriteTokens: 0,
  costUsd: 0.42,
  inputTokens: 1800,
  lastRequestAt: "2026-09-09T14:20:00.000Z",
  models: ["gpt-6-luna"],
  outputTokens: 900,
  provider: "codex",
  repos: ["project-1"],
  requests: 3,
  sessionId: "e2e-session-026",
  snippet: "A synthetic session on the second page.",
  startedAt: "2026-09-09T14:00:00.000Z",
  title: "e2e page two session",
  totalTokens: 3900,
};
const pageTwo = {
  ...sessions,
  page: 2,
  hasMore: false,
  rows: [pageTwoRow],
};
fs.writeFileSync(path.join(fixtureDirectory, "sessions-page-2.json"), `${JSON.stringify(pageTwo, null, 2)}\n`);

const timestamp = "2026-09-10T12:00:00.000Z";
const sessionDetail = {
  provider: stableRows[0].provider,
  sessionId: stableRows[0].sessionId,
  conversation: {
    title: stableRows[0].title,
    body: "User: Open the e2e search fixture.\nAssistant: This synthetic conversation verifies the session detail panel.",
  },
  cacheDuration: {
    estimatedSeconds: 300,
    confidence: "medium",
    samples: 3,
    busts: 1,
    lastBustAt: timestamp,
  },
  events: [
    {
      n: 1,
      ts: timestamp,
      model: "gpt-6-luna",
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.08,
      description: "Synthetic e2e request one",
      runningTokens: 1600,
    },
    {
      n: 2,
      ts: "2026-09-10T12:05:00.000Z",
      model: "gpt-6-luna",
      inputTokens: 800,
      outputTokens: 600,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      costUsd: 0.04,
      description: "Synthetic e2e request two",
      runningTokens: 3500,
    },
    {
      n: 3,
      ts: "2026-09-10T12:10:00.000Z",
      model: "gpt-6-luna",
      inputTokens: 900,
      outputTokens: 500,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      costUsd: 0.05,
      description: "Synthetic e2e request three",
      runningTokens: 5300,
    },
  ],
  eventsTotal: 3,
  eventsOffset: 0,
  eventsHasMore: false,
};
fs.writeFileSync(path.join(fixtureDirectory, "session-detail.json"), `${JSON.stringify(sessionDetail, null, 2)}\n`);
