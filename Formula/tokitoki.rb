# Homebrew formula for tokitoki — PREPARED, NOT PUBLISHED.
#
# Strategy: install the portable JS tarball (bin/ + dist/cli.js + dist/web)
# built by .github/workflows/release.yml, executed via Bun.
#
# Why not the per-platform `bun build --compile` binaries? Compiled binaries
# embed the runtime filesystem, so they can't resolve sibling web assets —
# historically they served stale UI from ~/.local/share/tokitoki/web or 503'd
# (see docs/packaging.md). The portable layout keeps bin/dist siblings intact
# and matches what npm ships.
#
# Before first tap publish:
#   1. Cut a GitHub release (tag v<version>) so the workflow uploads
#      tokitoki-portable.tar.gz + SHA256SUMS
#   2. Replace PLACEHOLDER-SHA256 below with the real digest
#   3. Create the tap repo (<user>/tap), copy this file to Formula/tokitoki.rb,
#      then: brew audit --strict tap/tokitoki && brew install tap/tokitoki
class Tokitoki < Formula
  desc "Unified coding-agent usage & session analytics across machines, harnesses, and accounts"
  homepage "https://github.com/astahmer/tokitoki"
  url "https://github.com/astahmer/tokitoki/releases/download/v0.4.0/tokitoki-portable.tar.gz"
  version "0.4.0"
  sha256 "PLACEHOLDER-SHA256" # TODO: fill from SHA256SUMS after first release

  livecheck do
    url :stable
    regex(/^v?(\d+\.\d+\.\d+)$/i)
  end

  # bun is not in homebrew-core; oven-sh/bun is the official tap.
  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    # bin/tokitoki.js resolves ../dist/cli.js next to itself → libexec layout works.
    (bin/"tokitoki").write <<~EOS
      #!/bin/sh
      exec "#{Formula["oven-sh/bun/bun"].opt_bin}/bun" "#{libexec}/bin/tokitoki.js" "$@"
    EOS
    chmod 0555, bin/"tokitoki"
  end

  def caveats
    <<~EOS
      Data lives in ~/.local/share/tokitoki (override with TOKITOKI_DATA_DIR).
      First run: `tokitoki scan` then `tokitoki today`.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tokitoki -v")
  end
end
