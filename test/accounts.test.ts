import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";

// Fake HOME with harness stores so email resolution is hermetic.
const home = `/tmp/tokitoki-accounts-test-${Date.now()}`;
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CURSOR_DIR;
process.env.CODEX_HOME = `${home}/.codex`;

fs.mkdirSync(`${home}/.codex`, { recursive: true });
// claude-code: ~/.claude.json → oauthAccount.emailAddress
fs.writeFileSync(
  `${home}/.claude.json`,
  JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }),
);
// codex: auth.json → JWT id_token payload (unsigned header, real b64 payload)
const payload = Buffer.from(JSON.stringify({
  email: "codex@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "codex-account-123" },
}))
  .toString("base64")
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");
fs.writeFileSync(
  `${home}/.codex/auth.json`,
  JSON.stringify({ tokens: { id_token: `fakeheader.${payload}.fakesig` } }),
);
// cursor: ~/.cursor/cli-config.json → authInfo.email
fs.mkdirSync(`${home}/.cursor`, { recursive: true });
fs.writeFileSync(
  `${home}/.cursor/cli-config.json`,
  JSON.stringify({ authInfo: { email: "cursor@example.com", displayName: "Cursor User" } }),
);

const { accountEmailFor, accountIdentityFor } = await import("../src/accounts.ts");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("account email resolution", () => {
  test("claude-code reads oauthAccount.emailAddress", () => {
    expect(accountEmailFor("claude-code")).toBe("me@example.com");
  });

  test("codex decodes the JWT id_token payload", () => {
    expect(accountEmailFor("codex")).toBe("codex@example.com");
  });

  test("codex exposes the stable account id alongside the email", () => {
    expect(accountIdentityFor("codex")).toEqual({
      email: "codex@example.com",
      accountId: "codex-account-123",
    });
  });

  test("cursor reads authInfo.email from its CLI config", () => {
    expect(accountEmailFor("cursor")).toBe("cursor@example.com");
  });

  test("providers without local identity return null", () => {
    expect(accountEmailFor("pi")).toBeNull();
    expect(accountEmailFor("opencode")).toBeNull();
    expect(accountEmailFor("unknown-provider")).toBeNull();
  });
});
