#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
BIN_DIST="$ROOT_DIR/bin-dist"
BUNDLED_BIN="$ROOT_DIR/bundled-bin"
YTDLP_VERSION="${YTDLP_VERSION:-2026.07.04}"
FFMPEG_VERSION="8.1.2"

rm -rf "$BIN_DIST/mediadrop-server" "$BUNDLED_BIN"
mkdir -p "$BUNDLED_BIN"

(
  cd "$APP_DIR"
  python3 -m PyInstaller -y mediadrop-server.spec --distpath "$BIN_DIST"
)

cp -R "$BIN_DIST/mediadrop-server/." "$BUNDLED_BIN/"

case "$(uname -s)" in
  Darwin)
    YTDLP_ASSET="yt-dlp_macos"
    ;;
  *)
    echo "Unsupported local build platform: $(uname -s)" >&2
    exit 1
    ;;
esac

curl --fail --location --retry 3 -o "$BUNDLED_BIN/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/$YTDLP_ASSET"
"$ROOT_DIR/scripts/build-ffmpeg-macos.sh" "$BUNDLED_BIN/ffmpeg"

chmod +x "$BUNDLED_BIN/mediadrop-server" "$BUNDLED_BIN/yt-dlp" "$BUNDLED_BIN/ffmpeg"

"$BUNDLED_BIN/yt-dlp" --version
"$BUNDLED_BIN/ffmpeg" -version 2>&1 | sed -n '1p' | grep -Eq "ffmpeg version n?${FFMPEG_VERSION}([ .-]|$)"
FILTERS="$("$BUNDLED_BIN/ffmpeg" -hide_banner -filters 2>&1)"
ENCODERS="$("$BUNDLED_BIN/ffmpeg" -hide_banner -encoders 2>&1)"
for FILTER in ass subtitles; do
  grep -E "[[:space:]]${FILTER}([[:space:]]|$)" <<< "$FILTERS"
done
for ENCODER in ass aac libmp3lame libopus libx264 libvpx-vp9 h264_videotoolbox; do
  grep -E "[[:space:]]${ENCODER}([[:space:]]|$)" <<< "$ENCODERS"
done
test -f "$BUNDLED_BIN/_internal/fonts/Roboto-Medium.ttf"
test -f "$BUNDLED_BIN/_internal/fonts/NotoSansCJKsc-Regular.otf"
test -f "$BUNDLED_BIN/_internal/fonts/Roboto-OFL.txt"
test -f "$BUNDLED_BIN/_internal/fonts/NotoSansCJK-OFL.txt"
