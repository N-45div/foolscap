#!/bin/sh
# foolscap — install on Linux, no root, no npm.
#
#   curl -fsSL https://raw.githubusercontent.com/N-45div/foolscap/main/install.sh | sh
#
# What it does, and nothing else:
#   1. picks a Node: yours if it's 22 or newer, otherwise a private copy
#      under ~/.foolscap/node (downloaded from nodejs.org, checksummed)
#   2. downloads the release bundle from GitHub Releases, checks its
#      sha256, and unpacks it to ~/.foolscap/app
#   3. writes a launcher at ~/.local/bin/foolscap
#
# Knobs: FOOLSCAP_VERSION=0.8.0 (default: latest release),
#        FOOLSCAP_HOME (default ~/.foolscap), FOOLSCAP_BIN (default ~/.local/bin),
#        FOOLSCAP_BUNDLE=/path/to/foolscap-*-linux.tar.gz (offline / testing).
# macOS and Windows: `npx foolscap` — same program, Node does the download.
set -eu

REPO="N-45div/foolscap"
HOME_DIR="${FOOLSCAP_HOME:-$HOME/.foolscap}"
BIN_DIR="${FOOLSCAP_BIN:-$HOME/.local/bin}"
VERSION="${FOOLSCAP_VERSION:-latest}"
APP="$HOME_DIR/app"
NODE_DIR="$HOME_DIR/node"
NODE_MAJOR_MIN=22
NODE_LINE="v24.x"

say() { printf '%s\n' "$*"; }
die() { printf 'foolscap: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs '$1'"; }

case "$(uname -s)" in
  Linux) ;;
  Darwin) die "this installer is Linux-only for now — on macOS run: npx foolscap" ;;
  *) die "this installer is Linux-only for now — elsewhere run: npx foolscap" ;;
esac
need curl; need tar; need sha256sum

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$HOME_DIR" "$BIN_DIR"

# ── 1. Node ──────────────────────────────────────────────────────────
NODE=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge "$NODE_MAJOR_MIN" ] 2>/dev/null; then
    NODE="$(command -v node)"
    say "node    $(node --version) (yours)"
  fi
fi
if [ -z "$NODE" ] && [ -x "$NODE_DIR/bin/node" ]; then
  NODE="$NODE_DIR/bin/node"
  say "node    $("$NODE" --version) (~/.foolscap/node)"
fi
if [ -z "$NODE" ]; then
  say "node    downloading a private copy of Node $NODE_LINE…"
  curl -fsSL "https://nodejs.org/dist/latest-$NODE_LINE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  file="$(grep "linux-$ARCH.tar.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $2}' | head -n1)"
  [ -n "$file" ] || die "no Node $NODE_LINE build for linux-$ARCH"
  curl -fsSL "https://nodejs.org/dist/latest-$NODE_LINE/$file" -o "$TMP/$file"
  (cd "$TMP" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node download failed its checksum"
  rm -rf "$NODE_DIR.tmp" && mkdir -p "$NODE_DIR.tmp"
  tar -xzf "$TMP/$file" -C "$NODE_DIR.tmp" --strip-components=1
  rm -rf "$NODE_DIR" && mv "$NODE_DIR.tmp" "$NODE_DIR"
  NODE="$NODE_DIR/bin/node"
  say "node    $("$NODE" --version) (~/.foolscap/node)"
fi

# ── 2. foolscap ──────────────────────────────────────────────────────
if [ -n "${FOOLSCAP_BUNDLE:-}" ]; then
  cp "$FOOLSCAP_BUNDLE" "$TMP/bundle.tar.gz"
  say "bundle  $FOOLSCAP_BUNDLE"
else
  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
    asset="foolscap-linux.tar.gz"
  else
    base="https://github.com/$REPO/releases/download/v$VERSION"
    asset="foolscap-$VERSION-linux.tar.gz"
  fi
  say "bundle  $base/$asset"
  curl -fsSL "$base/$asset" -o "$TMP/bundle.tar.gz" || die "download failed — is there a release yet? https://github.com/$REPO/releases"
  if curl -fsSL "$base/$asset.sha256" -o "$TMP/bundle.sha256" 2>/dev/null; then
    expected="$(awk '{print $1}' "$TMP/bundle.sha256")"
    actual="$(sha256sum "$TMP/bundle.tar.gz" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || die "bundle failed its checksum"
    say "sha256  ok"
  fi
fi
rm -rf "$APP.tmp" && mkdir -p "$APP.tmp"
tar -xzf "$TMP/bundle.tar.gz" -C "$APP.tmp"
[ -f "$APP.tmp/bin/foolscap.mjs" ] || die "that bundle doesn't look like foolscap"
rm -rf "$APP" && mv "$APP.tmp" "$APP"
installed="$("$NODE" -p 'require(process.argv[1]).version' "$APP/package.json")"

# ── 3. launcher ──────────────────────────────────────────────────────
cat > "$BIN_DIR/foolscap" <<LAUNCHER
#!/bin/sh
# foolscap launcher — written by install.sh; 'foolscap update' re-runs it.
if [ "\${1:-}" = "update" ]; then
  exec sh -c 'curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh'
fi
exec "$NODE" "$APP/bin/foolscap.mjs" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/foolscap"

say ""
say "foolscap $installed installed → $BIN_DIR/foolscap"
case ":$PATH:" in
  *":$BIN_DIR:"*) say "run:    foolscap" ;;
  *) say "add to your PATH, then run it:"; say "        export PATH=\"$BIN_DIR:\$PATH\""; say "        foolscap" ;;
esac
say "update: foolscap update"
