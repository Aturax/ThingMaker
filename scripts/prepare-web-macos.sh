#!/usr/bin/env bash
# Build-time only. The installed application runs the private copies in web-runtime.
#
#   prepare-web-macos.sh              stage for the target Tauri is building, else this Mac
#   prepare-web-macos.sh universal    stage both architectures (what a release ships)
#   prepare-web-macos.sh arm64|x64    stage one architecture
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/runtime/web"
STAGE="$ROOT/apps/desktop/dist-web"
CACHE="$ROOT/output/web-runtime-cache"
NODE_VERSION="v24.18.1"

case "${1:-${TAURI_ENV_ARCH:-$(uname -m)}}" in
  universal) ARCHS="arm64 x64" ;;
  arm64 | aarch64) ARCHS="arm64" ;;
  x64 | x86_64) ARCHS="x64" ;;
  *) echo "Unknown architecture '${1:-${TAURI_ENV_ARCH:-}}'" >&2; exit 1 ;;
esac
case "$(uname -m)" in arm64) HOST="arm64" ;; *) HOST="x64" ;; esac

node_checksum() {
  case "$1" in
    arm64) echo "eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941" ;;
    x64) echo "6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec" ;;
  esac
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

mkdir -p "$STAGE" "$CACHE"

# Node.js: the official build of each architecture, joined into one file when
# the app is universal. Each half keeps the signature Node.js shipped it with.
NODE_STAMP="$STAGE/.node"
if [ ! -x "$STAGE/node" ] || [ "$(cat "$NODE_STAMP" 2>/dev/null)" != "$NODE_VERSION $ARCHS" ]; then
  HALVES=()
  for arch in $ARCHS; do
    name="node-$NODE_VERSION-darwin-$arch"
    archive="$CACHE/$name.tar.gz"
    if [ ! -f "$archive" ] || [ "$(sha "$archive")" != "$(node_checksum "$arch")" ]; then
      curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" -o "$archive"
    fi
    [ "$(sha "$archive")" = "$(node_checksum "$arch")" ] || { echo "Node.js archive checksum mismatch" >&2; exit 1; }
    rm -rf "${CACHE:?}/$name"
    tar -xzf "$archive" -C "$CACHE" "$name/bin/node" "$name/LICENSE"
    HALVES+=("$CACHE/$name/bin/node")
    cp "$CACHE/$name/LICENSE" "$STAGE/NODE-LICENSE.txt"
  done
  rm -f "$STAGE/node"
  if [ "${#HALVES[@]}" -gt 1 ]; then lipo -create -output "$STAGE/node" "${HALVES[@]}"; else cp "${HALVES[0]}" "$STAGE/node"; fi
  codesign --verify --strict "$STAGE/node" || { echo "The staged Node.js lost its signature" >&2; exit 1; }
  for arch in $ARCHS; do rm -rf "${CACHE:?}/node-$NODE_VERSION-darwin-$arch"; done
  echo "$NODE_VERSION $ARCHS" > "$NODE_STAMP"
fi

# The staged Node.js runs the remaining steps when this Mac can run it, so the
# tool catalog comes from the runtime that ships.
case " $ARCHS " in *" $HOST "*) NODE="$STAGE/node" ;; *) NODE="$(command -v node)" ;; esac

cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$SOURCE/session.mjs" "$SOURCE/public-network.mjs" "$SOURCE/lent-document.mjs" "$STAGE/"

DEPENDENCIES="$(sha "$SOURCE/package-lock.json") $ARCHS"
STAMP="$STAGE/.dependencies"
ready() {
  [ "$(cat "$STAMP" 2>/dev/null)" = "$DEPENDENCIES" ] || return 1
  [ -f "$STAGE/node_modules/@modelcontextprotocol/sdk/package.json" ] && [ -f "$STAGE/node_modules/playwright-core/cli.js" ] || return 1
  for arch in $ARCHS; do
    [ -x "$STAGE/node_modules/@opencode/browse-darwin-$arch/bin/browse" ] || return 1
    compgen -G "$STAGE/browsers/chromium_headless_shell-*/chrome-headless-shell-mac-$arch/chrome-headless-shell" >/dev/null || return 1
  done
}

if ! ready; then
  rm -f "$STAMP"
  first=1
  for arch in $ARCHS; do
    # npm installs the Browse companion of one architecture at a time.
    if [ "$first" -eq 1 ]; then
      npm ci --prefix "$STAGE" --omit=dev --ignore-scripts --no-fund --no-audit --os=darwin --cpu="$arch"
    else
      other="$CACHE/dependencies-$arch"
      rm -rf "$other" && mkdir -p "$other"
      cp "$SOURCE/package.json" "$SOURCE/package-lock.json" "$other/"
      npm ci --prefix "$other" --omit=dev --ignore-scripts --no-fund --no-audit --os=darwin --cpu="$arch"
      cp -R "$other/node_modules/@opencode/browse-darwin-$arch" "$STAGE/node_modules/@opencode/"
      rm -rf "$other"
    fi
    first=0
  done
  # Command shims are links into the packages; the runtime never calls them.
  rm -rf "$STAGE/node_modules/.bin"

  rm -rf "$STAGE/browsers"
  for arch in $ARCHS; do
    # Playwright's installer keeps one architecture per folder, but it names a
    # Mac's browser by its architecture, so the two downloads merge into one.
    case "$arch" in arm64) platform="mac15-arm64" ;; *) platform="mac15" ;; esac
    download="$CACHE/browsers-$arch"
    rm -rf "$download"
    PLAYWRIGHT_BROWSERS_PATH="$download" PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$platform" \
      "$NODE" "$STAGE/node_modules/playwright-core/cli.js" install chromium --only-shell
    # Its bookkeeping contains the build machine's checkout path and is only
    # needed by the downloader. The video encoder has one file name for both
    # architectures, and nothing here records video.
    rm -rf "$download/.links" "$download"/ffmpeg-*
    mkdir -p "$STAGE/browsers"
    ditto "$download" "$STAGE/browsers"
    rm -rf "$download"
  done
  echo "$DEPENDENCIES" > "$STAMP"
  ready || { rm -f "$STAMP"; echo "Could not stage the web runtime" >&2; exit 1; }
fi

"$NODE" "$STAGE/session.mjs" --print-tool-catalog > "$STAGE/tools.json.new"
[ -s "$STAGE/tools.json.new" ] || { echo "Could not generate the web tool catalog" >&2; exit 1; }
mv "$STAGE/tools.json.new" "$STAGE/tools.json"
