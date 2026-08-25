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

## Nix packaging (nixfiles-style repos)

`packages/tokitoki/default.nix` — two viable approaches.

### Option A: build from source in nix (hermetic-ish)

```nix
{
  lib,
  bun,
  stdenv,
  fetchFromGitHub,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "tokitoki";
  version = "0.2.0";

  src = fetchFromGitHub {
    owner = "astahmer";
    repo = "tokitoki";
    rev = "v${finalAttrs.version}";
    hash = ""; # lib.fakeHash on first build, then paste real hash
  };

  nativeBuildInputs = [ bun ];

  # Bun needs network at build time for install; vendor deps first:
  #   bun install --production --copy-lockfile  → commit bun.lock
  offlineCache = bun.fetchDeps { inherit (finalAttrs) src; };

  buildPhase = ''
    export HOME=$TMPDIR
    bun install --frozen-lockfile
    bun build --compile src/cli.ts --outfile dist/tokitoki
  '';

  installPhase = ''
    install -Dm755 dist/tokitoki $out/bin/tokitoki
  '';

  meta = {
    description = "Unified coding-agent usage analytics across machines and harnesses";
    platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
  };
})
```

Notes:
- `bun.fetchDeps` requires a recent nixpkgs bun; on older setups use
  `fetchurl` of the lockfile + `BUN_INSTALL_CACHE_DIR` prewarm instead
- Keep `finalAttrs` so `nix-update` can find the package

### Option B: package the prebuilt binary (fastest, mac-first)

```nix
{ lib, stdenvNoCC, fetchurl }:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "tokitoki";
  version = "0.2.0";

  src = fetchurl {
    url = "https://github.com/astahmer/tokitoki/releases/download/v${finalAttrs.version}/tokitoki-darwin-arm64";
    hash = ""; # fakeHash first, real hash after
  };

  dontUnpack = true;
  installPhase = ''
    install -Dm755 $src $out/bin/tokitoki
  '';

  meta.platforms = [ "aarch64-darwin" ];
})
```

### Wiring into nixfiles

1. Drop the file in `packages/tokitoki/default.nix`
2. Expose it where packages are collected (`perSystem.packages` via
   `pkgs.callPackage`, matching how other custom packages are wired)
3. Add `pkgs.tokitoki` to the relevant `home.packages`
4. **Cockpit reminder**: adding a CLI to `home.packages` means also updating
   `assets/cli-tools/cli-tools.sh` (`list_term`) + `assets/cli-tools/overview.html`
   tool card — keep the map curated
5. `nixcheck` before applying

## Updating pins later

- Bump versions in `package.json` (exact-pinned, no `^`)
- Re-run compile, refresh hashes, update both Option A/B files if both exist
- `nix run .#update-pins` picks up the new rev/hash automatically once the
  GitHub release exists

## nixfiles package (prebuilt route)

`~/dev/nixfiles/packages/tokitoki/default.nix` is a template with placeholder
hashes (deliberately NOT wired into flake.nix — it would break evaluation).
Bootstrap flow:

1. `bun run compile && bun build --compile --target=bun-linux-x64 src/cli.ts --outfile dist/tokitoki-linux`
2. Cut a GitHub release with the binaries; note the URL
3. `nix store prefetch-file <url>` (or `nix hash file <local>`) → real hash
4. Fill `version`/`url`/`hash` in `packages/tokitoki/default.nix`, extend platforms
5. Wire into `flake.nix`: `tokitoki = pkgs'.callPackage ./packages/tokitoki { };`
6. Repo convention: add to `assets/cli-tools/cli-tools.sh` (`list_term`) +
   `assets/cli-tools/overview.html` tool card, then `nixapply`

A source-build derivation waits on a bunDeps-style builder in nixpkgs.
