# Packaging tokitoki

## Compiled binary (local)

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
