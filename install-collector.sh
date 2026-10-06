#!/bin/sh
# Installs the Heimdall Collector binary for this platform from a GitHub
# Release, verified against the release's SHA256SUMS. Fleet runs it at a pinned
# release:
#
#   curl -fsSL https://raw.githubusercontent.com/dbtlr/heimdall/v0.1.0/install-collector.sh \
#     | HEIMDALL_VERSION=v0.1.0 sh
#
# HEIMDALL_VERSION   release tag to install; defaults to the latest release.
# HEIMDALL_INSTALL_DIR  directory for the binary; defaults to ~/.local/bin.
# HEIMDALL_RELEASE_URL  base of the release downloads; tests point it at a fake.
#
# install-hub.sh is this script with another binary name. Keep them identical.
set -eu

binary=heimdall-collector

repository_url=https://github.com/dbtlr/heimdall/releases
install_dir="${HEIMDALL_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  fail "no $binary release for Intel macOS"
fi
asset="$binary-$os-$arch"

if [ -n "${HEIMDALL_RELEASE_URL:-}" ]; then
  base="$HEIMDALL_RELEASE_URL"
elif [ -n "${HEIMDALL_VERSION:-}" ]; then
  base="$repository_url/download/$HEIMDALL_VERSION"
else
  base="$repository_url/latest/download"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

mkdir -p "$install_dir"
# Download next to the destination so the final rename replaces the binary in
# one step, even while a running Collector or Hub holds the old one open.
download="$install_dir/.$binary.download.$$"
sums="$install_dir/.$binary.SHA256SUMS.$$"
trap 'rm -f "$download" "$sums"' EXIT

fetch() {
  curl -fsSL --proto-redir '=https' --tlsv1.2 "$1" -o "$2" || fail "download failed: $1"
}

printf 'Downloading %s from %s\n' "$asset" "$base" >&2
fetch "$base/SHA256SUMS" "$sums"
fetch "$base/$asset" "$download"

expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$sums")
[ -n "$expected" ] || fail "SHA256SUMS lists no $asset"
[ "$(sha256 "$download")" = "$expected" ] || fail "checksum mismatch for $asset"

chmod 755 "$download"
mv -f "$download" "$install_dir/$binary"
printf 'Installed %s\n' "$("$install_dir/$binary" --version)" >&2
