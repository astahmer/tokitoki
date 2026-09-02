# Packaging tokitoki

> 2026-08-25: the compiled-binary flow (`bun run compile` / `release`) was
> removed — everything runs from source via `bun src/cli.ts` (the menubar app
> resolves bun automatically). Compiled binaries couldn't rebuild or even see
> `dist/web`, so they served stale UI assets from `~/.local/share/tokitoki/web`
> or 503'd with "web UI not built". The notes below are kept for reference if a
> standalone build is ever needed again.

## Compiled binary (local, historical)

```sh
bun run compile          # bun build --compile src/cli.ts --outfile dist/tokitoki
./dist/tokitoki today    # single self-contained binary (~90MB debug-size, Bun runtime embedded)
ln -sf "$PWD/dist/tokitoki" ~/.local/bin/tokitoki
```

Cross-compile from macOS:

```sh
bun build --compile src/cli.ts --target=bun-linux-x64   --outfile dist/tokitoki-linux-x64
bun build --compile src/cli.ts --target=bun-linux-arm64 --outfile dist/tokitoki-linux-arm64
bun build --compile src/cli.ts --target=bun-darwin-arm64 --outfile dist/tokitoki-darwin-arm64
```

(`--target=bun-*` produces binaries that still need the matching Bun version
at runtime? No — `--compile` embeds the runtime; the target flag only picks
OS/arch. Verify with `file dist/tokitoki-*`.)

Release flow suggestion:
1. `bun run compile` per target
2. `shasum -a 256 dist/tokitoki-* > dist/SHA256SUMS`
3. Attach to a git tag / GitHub release; note Bun version in release notes
   (`bun --version`) since compiled output is tied to it

## Distribution (PREPARED, NOT PUBLISHED — 2026-08-25)

Nothing below has been executed against the outside world; artifacts are
prepared so publishing is a checklist, not a project.

### npm strategy (decided)

npm ships **JS + web assets executed by Bun** — not a compiled binary:

- `bin/tokitoki.js` prefers `dist/cli.js`, falls back to `src/cli.ts` (source checkouts)
- `prepack` runs tests + typecheck + `bun run build` → `dist/cli.js` + `dist/web`
- `files: ["bin", "dist"]` keeps the tarball to exactly those trees
- `engines.bun >=1.2` — Bun is the runtime requirement, same as source installs
- Compiled binaries are NOT shipped via npm for the same reason Homebrew skips
  them (web assets can't be resolved from bun's embedded filesystem)

`bun pm pack --dry-run` verified 2026-08-25: tarball = bin/ + dist/{cli.js, web/}
only.

Pre-publish checklist (in order):

1. Add a LICENSE file + matching `package.json` `license` field (deliberately
   absent today — do not publish without it; npm will warn/fail audits)
2. `npm whoami` under the right account; decide scope (`tokitoki` unscoped vs
   `@astahmer/tokitoki` — unscoped name was available as of writing, re-check)
3. `bun pm pack` → inspect tarball → `npm publish --dry-run` once more
4. Tag `v<version>` and push AFTER npm publish so release assets exist for brew
5. First release: fill `Formula/tokitoki.rb` sha256 from SHA256SUMS

### Homebrew tap layout

- Formula lives at `Formula/tokitoki.rb` in-repo (single-source of truth)
- To serve it: create GitHub repo `<user>/homebrew-tap`, copy the formula in,
  then `brew install <user>/tap/tokitoki`
- Depends on `oven-sh/bun/bun` (official Bun tap) — bun is not in core
- Audit before pushing the tap: `brew audit --strict --new-formula <user>/tap/tokitoki`
- The formula downloads `tokitoki-portable.tar.gz` from the GitHub Release;
  update url+sha256 per version (livecheck regex already matches v-tags)

### Release flow (tag → assets → formulas)

1. Bump `version` in package.json, commit
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `.github/workflows/release.yml` builds + uploads **draft** release with:
   `tokitoki-portable.tar.gz`, per-platform compiled tarballs, `SHA256SUMS`
4. Review draft on github.com → publish when ready (nothing is public before)
5. Fill formula sha256 from SHA256SUMS, bump formula `version` if needed,
   push tap
6. npm: run prepack checklist above, `npm publish`

## Menu-bar app (macOS)

```sh
cd menubar/tokitoki-menubar
swift build -c release
# binary at .build/release/tokitoki-menubar — finds ../dist/tokitoki by
# walking up, or set TOKITOKI_BIN
```

No Xcode project needed; Command Line Tools suffice.

## Nix package and Home Manager

The root `flake.nix` exposes a source-built package for Linux and macOS:

```sh
nix build .#tokitoki
nix run .#tokitoki -- --version
```

The package vendors the Bun dependency tree in a fixed-output derivation,
builds both `dist/cli.js` and `dist/web`, and wraps the result with the Nix
Bun runtime. Runtime installations do not need `node_modules` or a network.

For a custom flake, add the repository as an input and use either the package
directly:

```nix
inputs.tokitoki.url = "github:astahmer/tokitoki";

home.packages = [ inputs.tokitoki.packages.${system}.default ];
```

Or import the included Home Manager module:

```nix
imports = [ inputs.tokitoki.homeManagerModules.default ];
programs.tokitoki.enable = true;
```

The flake also exposes `overlays.default`, `apps.${system}.default`, and the
existing `devShells.${system}.default`. If `package.json` or `bun.lock`
changes, regenerate the fixed-output dependency hash by temporarily using
`lib.fakeHash` and copying the hash reported by `nix build .#tokitoki`.
