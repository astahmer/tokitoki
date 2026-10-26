# Native harness accounts

Tokitoki reads accounts from their owning harnesses. Codex quota polling uses
the stock CLI’s app-server account methods rather than an intermediary account
pool. Session scanning and quota polling remain separate operations.

## Set up Codex

Install a Codex CLI version supporting `account/read` and
`account/rateLimits/read` and expose `codex` on Tokitoki’s PATH. Authenticate
with a ChatGPT account using `codex login`; check it with `codex login status`.
For headless sign-in, the stock CLI offers `codex login --device-auth` where
allowed. See the [official CLI reference](https://learn.chatgpt.com/docs/cli/reference)
and [authentication guidance](https://learn.chatgpt.com/docs/auth).

The default home is `$CODEX_HOME` or `~/.codex`. Give each additional login a
native home and sign into it explicitly:

```sh
CODEX_HOME="$HOME/.codex-personal" codex login
CODEX_HOME="$HOME/.codex-work" codex login
CODEX_HOME="$HOME/.codex-work" codex login status
```

Merge this into `~/.config/tokitoki/config.json`, replacing the example paths
with absolute paths for your machine:

```json
{
  "poll": {
    "codexHomes": ["/home/you/.codex-personal", "/home/you/.codex-work"]
  }
}
```

`poll.codexHomes` adds native account homes for polling and, by default, scanning
their `sessions` and `archived_sessions` directories. An explicit
`providers.codex.paths` overrides those scanner roots. Then run `tokitoki poll --provider codex` and
`tokitoki scan --provider codex`.

This migration does not import old pool credentials. Sign into each desired
native home with the CLI. Account keys based on plan names or metered bucket
names are not proof of account identity; unbound historical observations must
not be attached to a current email. Newly discovered native account cards can
be ordered and hidden using the existing presentation controls.

## Feature mapping

| Visible feature | Native source or behavior |
| --- | --- |
| Account emails and plans | Codex `account/read` for the owning home; absent identity remains unknown |
| Multiple profiles | Separate native homes selected by `poll.codexHomes` |
| Account identity | Stable native account identity; unverified historical aliases remain unbound; never a plan or meter ID |
| Bar and Quotas order | Independent `ui.previewAccountOrder` and `ui.menubarAccountOrder` preferences |
| Hide and restore | Existing account/provider visibility controls, including separate bar visibility |
| Refresh | Poll the native provider; scan-only accounts use session refresh |
| Login | Stock harness sign-in; additional Codex profiles use their owning `CODEX_HOME` |
| All quota windows | Every returned metered bucket and optional slot, with supplied duration/reset and per-window observation time |
| Stale, expired or unknown limits | Retain uncertainty; a passed reset does not invent unused capacity |
| Banked resets | Native earned-reset inventory, separate from usage and monetary balances |
| Local usage and budgets | Reports and `budgetWindows`, separate from reported quota |
| T3 Code activity | Existing session/activity payload and reports, separate from subscription quota accounts |

The [official app-server contract](https://learn.chatgpt.com/docs/app-server)
describes native account, quota and earned-reset responses. The
[provider semantics note](quota-window-provider-research.md) records observation
rules and adapter limitations. Adding a native home does not guarantee that a
particular plan returns every optional counter.

## Existing presentation preferences

When a retired cached account and a native account have a proven matching
account ID, Tokitoki projects saved account order and visibility onto the native
card at read time. Quotas order and bar order stay independent; explicit empty
bar order remains explicit. Provider-wide hides keep their meaning. Legacy
account suffix hides move only when their destination is unambiguous; unrelated
or unverified entries remain unchanged. Reading a payload does not rewrite the
configuration. Explicit restore actions remove the corresponding proven legacy
hide entry when saving, so it cannot hide the native account again on reload.

Workspace credits use the optional `credits` field
(`hasCredits`, `unlimited`, `balance`) and appear as “Workspace credits 123.45”
or “Unlimited workspace credits”. These are provider units, not USD and not
banked reset counts; the two inventories display separately. Native-home paths
are used only to target sign-in actions and are not shown as account labels.
