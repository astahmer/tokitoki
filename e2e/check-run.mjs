import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node e2e/check-run.mjs <output-directory>");

const tabs = ["overview", "quotas", "tokens", "reports", "sessions", "sources", "mcp", "settings"];
const interactions = ["search", "session-detail", "session-back", "next-page", "previous-page", "settings-config", "settings-notifications"];
const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
assert.equal(index.mode, "all", "expected the autonomous all-tabs scenario");
assert.deepEqual(index.tabs, tabs, "the run must visit every tab in order");
for (const interaction of interactions) {
  assert.ok(index.interactions.includes(interaction), `missing interaction marker: ${interaction}`);
}

const logPath = path.join(out, "cli-invocations.jsonl");
const invocations = fs.readFileSync(logPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const sessions = invocations.filter((args) => args[0] === "sessions");
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

assert.ok(sessions.some((args) => args.includes("--search") && valueAfter(args, "--search") === "needle"),
  "the search field must invoke sessions --search needle");
assert.ok(sessions.some((args) => args.includes("--session") && valueAfter(args, "--session") === "e2e-session-001"),
  "opening a row must request that session's detail");
const pageTwoIndex = sessions.findIndex((args) => args.includes("--page") && valueAfter(args, "--page") === "2" && !args.includes("--search"));
assert.ok(pageTwoIndex >= 0,
  "the Next control must request page two");
assert.ok(sessions.slice(pageTwoIndex + 1).some((args) => args.includes("--page") && valueAfter(args, "--page") === "1" && !args.includes("--search")),
  "the Previous control must return to page one");
assert.ok(invocations.some((args) => args[0] === "config" && args[1] === "set" &&
  args[2] === "notifications.enabled" && args[3] === "true"),
  "the notification toggle must persist through the CLI shim");
assert.ok(invocations.some((args) => args[0] === "widget-payload"), "the widget must load its fixture payload");

console.log(`PASS autonomous run: ${tabs.length} tabs, ${interactions.length} UI interactions, ${sessions.length} sessions CLI calls`);
