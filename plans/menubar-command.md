# Plan: `tokitoki menubar` — start the menubar app from the CLI

Status: planned, small. Depends on plans/linux-menubar.md for the Linux
target (command ships first with macOS-only support + clear error elsewhere).

## UX

```
tokitoki menubar              # start for this OS (idempotent)
tokitoki menubar --foreground # run attached (no detach/logs to stdout)
tokitoki menubar --status     # running? which pid / since when
tokitoki menubar --stop       # stop a running instance
tokitoki menubar --rebuild    # rebuild from source (swift build / electrobun build) first
```

## Behavior

- **darwin**: resolve the Swift app exactly like `main.swift:resolveInvocation`
  mirrors today, in reverse priority:
  1. `$TOKITOKI_MENUBAR_BIN` override
  2. `menubar/tokitoki-menubar/.build/release/tokitoki-menubar` (repo build)
  3. `~/bin/tokitoki-menubar`
  Spawn detached (`child.unref()`); if the LaunchAgent plist exists at
  `~/Library/LaunchAgents/dev.tokitoki.menubar.plist`, prefer
  `launchctl bootstrap` so KeepAlive manages it. `--stop` →
  `launchctl bootout` (mirrors the in-app Quit path).
- **linux**: spawn the Electrobun app binary (same resolution order); single-
  instance via lockfile until DBus name claim lands.
- **Idempotency**: pidfile `<data-dir>/menubar.pid` + liveness check; starting
  when already running prints pid and exits 0 (script-friendly).
- **Unsupported OS**: exit 1 with "no menubar app for <os> yet" pointing at
  plans/linux-menubar.md status.
- Output line: `menubar started (pid N, <mode>)`.

## Notes

- The Swift app already self-locates the CLI; the CLI locating the app is the
  inverse map of that logic — keep the two lists in sync or hoist both into a
  shared doc comment cross-reference.
- `--status` reads the pidfile AND verifies process identity (pgrep -p +
  argv[0] match) to avoid stale-pid false positives.
