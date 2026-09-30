#!/usr/bin/env bash
# Pinned experimental engine: see yt-dlp/yt-dlp#13515. Fail closed on asset replacement.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT_DIR/bundled-bin/youtube}"
CACHE="$(mktemp -d)"
trap 'rm -rf "$CACHE"' EXIT
mkdir -p "$DEST"
PLATFORM="${2:-mac}"
ARCH="${3:-arm64}"
ASSET=yt-dlp_macos.zip
BINARY=yt-dlp-sabr
SHA=e8cbc3239cf6f95b274051cb2c12a8960268819ff31c54a4a4553e85666855f5
if [[ "$PLATFORM" == win ]]; then
  BINARY=yt-dlp-sabr.exe
  if [[ "$ARCH" == arm64 ]]; then
    ASSET=yt-dlp_win_arm64.zip
    SHA=f678fd0e3329d40e9904bd8528482815b6caa87a6b6dd9af94a9d9333d853d32
  else
    ASSET=yt-dlp_win.zip
    SHA=26acb906275e382f41b4a0e57e081eaa17c9c76ee29039181c991666cdf61b5c
  fi
fi
curl -fL --retry 3 "https://github.com/bashonly/yt-dlp/releases/download/sabr/$ASSET" -o "$CACHE/$BINARY"
python3 -c 'import hashlib,sys; assert hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()==sys.argv[2], "Enhanced engine checksum mismatch"' "$CACHE/$BINARY" "$SHA"
git clone --depth 1 --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$CACHE/provider"
(cd "$CACHE/provider/server" && npm ci && npx tsc && npm prune --omit=dev)
# Onedir avoids extracting and validating the Python runtime on every invocation.
python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$CACHE/$BINARY" "$CACHE/engine"
ENGINE_NAME=yt-dlp_macos
if [[ "$PLATFORM" == win ]]; then
  ENGINE_NAME=yt-dlp.exe
  [[ "$ARCH" == arm64 ]] && ENGINE_NAME=yt-dlp_arm64.exe
fi
cp "$CACHE/engine/$ENGINE_NAME" "$DEST/$BINARY"
rm -rf "$DEST/_internal"
cp -R "$CACHE/engine/_internal" "$DEST/_internal"
chmod +x "$DEST/$BINARY"
mkdir -p "$DEST/server"
cp -R "$CACHE/provider/plugin" "$DEST/"
mkdir -p "$DEST/mediadrop/yt_dlp_plugins/extractor"
cp "$ROOT_DIR/plugins/mediadrop/yt_dlp_plugins/extractor/mediadrop_player.py" "$DEST/mediadrop/yt_dlp_plugins/extractor/"
cp "$ROOT_DIR/app/player_cache_policy.py" "$DEST/mediadrop/yt_dlp_plugins/extractor/_mediadrop_policy.py"
cp -R "$CACHE/provider/server/build" "$CACHE/provider/server/node_modules" "$CACHE/provider/server/package.json" "$DEST/server/"
cp "$CACHE/provider/LICENSE" "$DEST/LICENSE-bgutil"
python3 "$ROOT_DIR/scripts/patch-youtube-provider.py" "$DEST"

if [[ "$PLATFORM" == win ]]; then
  # Pin a matching x64 Node/canvas pair; Windows ARM64 can run this helper under emulation.
  node -e 'require("fs").copyFileSync(process.execPath, require("path").join(process.argv[1], "node.exe"))' "$DEST"
fi
