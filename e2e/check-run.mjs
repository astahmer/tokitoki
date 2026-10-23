import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node e2e/check-run.mjs <output-directory>");

const tabs = ["overview", "quotas", "tokens", "reports", "sessions", "sources", "mcp", "settings"];
const interactions = ["search", "session-detail", "session-back", "next-page", "previous-page", "settings-config", "settings-notifications"];
const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
assert.ok(["dms", "quickshell"].includes(index.shell), "the run must identify its shell");
assert.equal(index.mode, "all", "expected the autonomous all-tabs scenario");
assert.deepEqual(index.tabs, tabs, "the run must visit every tab in order");
for (const interaction of interactions) {
  assert.ok(index.interactions.includes(interaction), `missing interaction marker: ${interaction}`);
}

if (index.shell === "dms") {
  assert.ok(index.interactions.includes("hover-countdown"), "hover must remain open across a countdown update");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "hover-after-tick.json"), "utf8")).open, true);
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

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
const readJsonLines = (name) => fs.readFileSync(path.join(out, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const states = readJsonLines("state-interactions.jsonl");
const tabStates = states.slice(index.shell === "quickshell" ? 1 : 0, index.shell === "quickshell" ? 9 : 8);
assert.deepEqual(tabStates.map((state) => state.actual), tabs, "every pointer-selected tab must be observed");
for (const state of states) {
  assert.equal(state.shell, index.shell);
  assert.equal(state.actual, state.expected);
  assert.equal(state.source, index.shell === "quickshell" ? "ipc-status" : "state-file");
}
assert.deepEqual(readJsonLines("interactions.jsonl").map((entry) => entry.interaction), index.interactions);

if (index.shell === "quickshell") {
  for (const interaction of ["widget-config-write", "restart-persistence", "multi-screen-transfer", "short-screen-fit", "bar-toggle", "escape-close", "outside-close"]) {
    assert.ok(index.interactions.includes(interaction), `missing standalone interaction: ${interaction}`);
  }
  assert.deepEqual(readJson("runtime.json"), { shell: "quickshell", dmsRunning: false, dmsConfigExists: false });
  const before = readJson("config-before-restart.json");
  assert.equal(before.autoRefreshEnabled, false, "the real widget setting must be changed");
  assert.deepEqual(readJson("config-after-restart.json"), before, "widget config must survive restart");
  const state = readJson("state-before-restart.json");
  assert.equal(state.selectedTab, "tokens");
  assert.deepEqual(readJson("state-after-restart.json"), state, "selected tab must survive restart");
  const restored = readJson("status-after-restart.json");
  assert.equal(restored.autoRefreshEnabled, false, "restarted host must load persisted config");
  assert.equal(restored.selectedTab, "tokens", "restarted host must load persisted state");
  const shortScreen = readJson("status-short-screen.json");
  assert.equal(shortScreen.visible, true);
  assert.equal(shortScreen.screen, "HEADLESS-2");
  assert.ok(shortScreen.popupGeometry.y + shortScreen.popupGeometry.height <= 540);
  assert.ok(shortScreen.popupGeometry.x + shortScreen.popupGeometry.width <= 960);
  const restart = readJson("restart.json");
  assert.notEqual(restart.beforePid, restart.afterPid, "persistence must be tested across distinct processes");
  const ipc = readJsonLines("quickshell-ipc.jsonl").filter((entry) => entry.ok);
  for (const method of ["open", "close", "toggle", "status"]) {
    assert.ok(ipc.some((entry) => entry.method === method), `missing native IPC method: ${method}`);
  }
}

console.log(`PASS ${index.shell} autonomous run: ${tabs.length} tabs, ${index.interactions.length} UI interactions, ${sessions.length} sessions CLI calls`);
