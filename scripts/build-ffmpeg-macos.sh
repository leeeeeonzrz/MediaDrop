#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_PATH="${1:-$ROOT_DIR/bundled-bin/ffmpeg}"
PROBE_OUTPUT_PATH="$(dirname "$OUTPUT_PATH")/ffprobe"
FFMPEG_VERSION="8.1.2"
FFMPEG_ARCHIVE="ffmpeg-n${FFMPEG_VERSION}.tar.gz"
FFMPEG_SOURCE_DIR="FFmpeg-n${FFMPEG_VERSION}"
FFMPEG_URL="https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n${FFMPEG_VERSION}"
FFMPEG_SHA256="9fd092511605bbebafe095ea6d38d9e40f34d12f7386e1258372df8be0576eb7"

LAME_VERSION="3.100"
LAME_ARCHIVE="lame-${LAME_VERSION}.tar.gz"
LAME_SOURCE_DIR="lame-${LAME_VERSION}"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/${LAME_ARCHIVE}"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"

OPUS_VERSION="1.6.1"
OPUS_ARCHIVE="opus-${OPUS_VERSION}.tar.gz"
OPUS_SOURCE_DIR="opus-${OPUS_VERSION}"
OPUS_URL="https://downloads.xiph.org/releases/opus/${OPUS_ARCHIVE}"
OPUS_SHA256="6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"

FREETYPE_VERSION="2.14.3"
FREETYPE_ARCHIVE="freetype-${FREETYPE_VERSION}.tar.xz"
FREETYPE_SOURCE_DIR="freetype-${FREETYPE_VERSION}"
FREETYPE_URL="https://download.savannah.gnu.org/releases/freetype/${FREETYPE_ARCHIVE}"
FREETYPE_SHA256="36bc4f1cc413335368ee656c42afca65c5a3987e8768cc28cf11ba775e785a5f"

FRIBIDI_VERSION="1.0.16"
FRIBIDI_ARCHIVE="fribidi-${FRIBIDI_VERSION}.tar.xz"
FRIBIDI_SOURCE_DIR="fribidi-${FRIBIDI_VERSION}"
FRIBIDI_URL="https://github.com/fribidi/fribidi/releases/download/v${FRIBIDI_VERSION}/${FRIBIDI_ARCHIVE}"
FRIBIDI_SHA256="1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c"

HARFBUZZ_VERSION="14.2.1"
HARFBUZZ_ARCHIVE="harfbuzz-${HARFBUZZ_VERSION}.tar.xz"
HARFBUZZ_SOURCE_DIR="harfbuzz-${HARFBUZZ_VERSION}"
HARFBUZZ_URL="https://github.com/harfbuzz/harfbuzz/releases/download/${HARFBUZZ_VERSION}/${HARFBUZZ_ARCHIVE}"
HARFBUZZ_SHA256="a54a5d8e9380a41fbb762ce367bcbf7704792dfca0d93f1bbca86c5a57902e0e"

LIBASS_VERSION="0.17.4"
LIBASS_ARCHIVE="libass-${LIBASS_VERSION}.tar.xz"
LIBASS_SOURCE_DIR="libass-${LIBASS_VERSION}"
LIBASS_URL="https://github.com/libass/libass/releases/download/${LIBASS_VERSION}/${LIBASS_ARCHIVE}"
LIBASS_SHA256="78f1179b838d025e9c26e8fef33f8092f65611444ffa1bfc0cfac6a33511a05a"

X264_COMMIT="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
X264_ARCHIVE="x264-${X264_COMMIT}.tar.gz"
X264_SOURCE_DIR="x264-${X264_COMMIT}"
X264_URL="https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/${X264_ARCHIVE}"
X264_SHA256="cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9"

LIBVPX_VERSION="1.16.0"
LIBVPX_ARCHIVE="libvpx-${LIBVPX_VERSION}.tar.gz"
LIBVPX_SOURCE_DIR="libvpx-${LIBVPX_VERSION}"
LIBVPX_URL="https://codeload.github.com/webmproject/libvpx/tar.gz/refs/tags/v${LIBVPX_VERSION}"
LIBVPX_SHA256="7a479a3c66b9f5d5542a4c6a1b7d3768a983b1e5c14c60a9396edc9b649e015c"

SOURCE_CACHE="${MEDIADROP_FFMPEG_SOURCE_CACHE:-$ROOT_DIR/build/ffmpeg-sources}"
# Bump this schema whenever the required codec/filter set changes so an older,
# less capable binary cannot be reused merely because its FFmpeg version matches.
BINARY_CACHE_SCHEMA="hard-subtitles-v3"
BINARY_CACHE="${MEDIADROP_FFMPEG_BINARY_CACHE:-$ROOT_DIR/build/ffmpeg-${FFMPEG_VERSION}-macos-arm64-${BINARY_CACHE_SCHEMA}}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
export MACOSX_DEPLOYMENT_TARGET

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "FFmpeg ${FFMPEG_VERSION} must be built on macOS ARM64." >&2
  exit 1
fi

for command_name in clang clang++ cmake curl file make otool pkg-config shasum strip sysctl tar vtool xcrun; do
  command -v "$command_name" >/dev/null || {
    echo "Required build command is missing: $command_name" >&2
    exit 1
  }
done

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')"
if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  JOBS=4
fi

verify_sha256() {
  local archive="$1"
  local expected="$2"
  printf '%s  %s\n' "$expected" "$archive" | shasum -a 256 -c - >/dev/null
}

download_verified() {
  local url="$1"
  local destination="$2"
  local expected="$3"

  if [[ -f "$destination" ]] && verify_sha256 "$destination" "$expected"; then
    return
  fi

  rm -f "$destination"
  curl --fail --location --retry 3 --proto '=https' -o "$destination" "$url"
  verify_sha256 "$destination" "$expected"
}

has_listed_capability() {
  local output="$1"
  local capability="$2"
  grep -Eq "[[:space:]]${capability}([[:space:]]|$)" <<< "$output"
}

validate_smoke_transcodes() {
  local binary="$1"
  local smoke_dir
  local result=0
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/mediadrop-ffmpeg-smoke.XXXXXX")" || return 1

  cat > "$smoke_dir/subtitle.srt" <<'EOF'
1
00:00:00,000 --> 00:00:00,300
MediaDrop subtitle smoke
EOF

  "$binary" -y -hide_banner -loglevel error \
    -i "$smoke_dir/subtitle.srt" -c:s ass "$smoke_dir/subtitle.ass" || result=1

  if [[ "$result" -eq 0 ]]; then
    "$binary" -y -hide_banner -loglevel error \
      -f lavfi -i 'color=c=black:s=160x90:r=10:d=0.3' \
      -f lavfi -i 'sine=frequency=440:duration=0.3' \
      -vf "ass='$smoke_dir/subtitle.ass':fontsdir='$ROOT_DIR/app/fonts'" \
      -c:v libx264 -preset ultrafast -c:a aac -shortest "$smoke_dir/subtitle.mp4" || result=1
  fi

  if [[ "$result" -eq 0 ]]; then
    "$binary" -y -hide_banner -loglevel error \
      -f lavfi -i 'color=c=black:s=160x90:r=10:d=0.3' \
      -f lavfi -i 'sine=frequency=440:duration=0.3' \
      -vf "ass='$smoke_dir/subtitle.ass':fontsdir='$ROOT_DIR/app/fonts'" \
      -c:v libvpx-vp9 -deadline realtime -c:a libopus -shortest "$smoke_dir/subtitle.webm" || result=1
  fi

  [[ -s "$smoke_dir/subtitle.ass" && -s "$smoke_dir/subtitle.mp4" && -s "$smoke_dir/subtitle.webm" ]] || result=1
  rm -rf "$smoke_dir"
  return "$result"
}

validate_binary() {
  local binary="$1"
  local tool="${2:-ffmpeg}"
  local version_output
  local encoder_output
  local filter_output
  local binary_minos
  local capability

  [[ -x "$binary" ]] || return 1
  file "$binary" | grep -q 'arm64' || return 1
  version_output="$("$binary" -version 2>&1)" || return 1
  printf '%s\n' "$version_output" | sed -n '1p' | grep -Eq "${tool} version n?${FFMPEG_VERSION}([ .-]|$)" || return 1
  if [[ "$tool" == "ffmpeg" ]]; then
    encoder_output="$("$binary" -hide_banner -encoders 2>&1)" || return 1
    for capability in png ass aac libmp3lame libopus libx264 libvpx-vp9 h264_videotoolbox; do
      has_listed_capability "$encoder_output" "$capability" || return 1
    done
    filter_output="$("$binary" -hide_banner -filters 2>&1)" || return 1
    for capability in ass subtitles; do
      has_listed_capability "$filter_output" "$capability" || return 1
    done
  fi
  binary_minos="$(vtool -show-build "$binary" 2>/dev/null | awk '$1 == "minos" { print $2; exit }')"
  [[ "$binary_minos" == "$MACOSX_DEPLOYMENT_TARGET" ]] || return 1

  if otool -L "$binary" | tail -n +2 | grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)' | grep -q .; then
    echo "FFmpeg contains a non-system dynamic-library dependency:" >&2
    otool -L "$binary" >&2
    return 1
  fi
  if otool -l "$binary" | grep -q 'LC_RPATH'; then
    echo "FFmpeg unexpectedly contains an LC_RPATH load command." >&2
    return 1
  fi

  if [[ "$tool" == "ffmpeg" ]]; then
    validate_smoke_transcodes "$binary"
  fi
}

mkdir -p "$SOURCE_CACHE" "$BINARY_CACHE" "$(dirname "$OUTPUT_PATH")"

if validate_binary "$BINARY_CACHE/ffmpeg" && validate_binary "$BINARY_CACHE/ffprobe" ffprobe; then
  cp "$BINARY_CACHE/ffmpeg" "$OUTPUT_PATH"
  cp "$BINARY_CACHE/ffprobe" "$PROBE_OUTPUT_PATH"
  chmod +x "$OUTPUT_PATH" "$PROBE_OUTPUT_PATH"
  echo "Using cached FFmpeg ${FFMPEG_VERSION} build."
  exit 0
fi

download_verified "$FFMPEG_URL" "$SOURCE_CACHE/$FFMPEG_ARCHIVE" "$FFMPEG_SHA256"
download_verified "$LAME_URL" "$SOURCE_CACHE/$LAME_ARCHIVE" "$LAME_SHA256"
download_verified "$OPUS_URL" "$SOURCE_CACHE/$OPUS_ARCHIVE" "$OPUS_SHA256"
download_verified "$FREETYPE_URL" "$SOURCE_CACHE/$FREETYPE_ARCHIVE" "$FREETYPE_SHA256"
download_verified "$FRIBIDI_URL" "$SOURCE_CACHE/$FRIBIDI_ARCHIVE" "$FRIBIDI_SHA256"
download_verified "$HARFBUZZ_URL" "$SOURCE_CACHE/$HARFBUZZ_ARCHIVE" "$HARFBUZZ_SHA256"
download_verified "$LIBASS_URL" "$SOURCE_CACHE/$LIBASS_ARCHIVE" "$LIBASS_SHA256"
download_verified "$X264_URL" "$SOURCE_CACHE/$X264_ARCHIVE" "$X264_SHA256"
download_verified "$LIBVPX_URL" "$SOURCE_CACHE/$LIBVPX_ARCHIVE" "$LIBVPX_SHA256"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mediadrop-ffmpeg.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
PREFIX="$WORK_DIR/prefix"
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
COMMON_CFLAGS="-arch arm64 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -isysroot $SDKROOT -I$PREFIX/include"
COMMON_LDFLAGS="-arch arm64 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -isysroot $SDKROOT -L$PREFIX/lib"
export CC=clang
export CXX=clang++
export CFLAGS="$COMMON_CFLAGS"
export CXXFLAGS="$COMMON_CFLAGS"
export LDFLAGS="$COMMON_LDFLAGS"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
mkdir -p "$PREFIX"

tar -xf "$SOURCE_CACHE/$LAME_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$LAME_SOURCE_DIR"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-frontend
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$OPUS_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$OPUS_SOURCE_DIR"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-doc --disable-extra-programs
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$FREETYPE_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$FREETYPE_SOURCE_DIR"
  ./configure \
    --prefix="$PREFIX" \
    --disable-shared \
    --enable-static \
    --with-zlib=no \
    --with-bzip2=no \
    --with-png=no \
    --with-harfbuzz=no \
    --with-brotli=no
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$FRIBIDI_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$FRIBIDI_SOURCE_DIR"
  ./configure --prefix="$PREFIX" --disable-shared --enable-static
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$HARFBUZZ_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$HARFBUZZ_SOURCE_DIR"
  cmake -S . -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
    -DCMAKE_OSX_SYSROOT="$SDKROOT" \
    -DBUILD_SHARED_LIBS=OFF \
    -DHB_BUILD_UTILS=OFF \
    -DHB_BUILD_SUBSET=OFF \
    -DHB_BUILD_RASTER=OFF \
    -DHB_BUILD_VECTOR=OFF \
    -DHB_BUILD_GPU=OFF \
    -DHB_HAVE_CAIRO=OFF \
    -DHB_HAVE_FREETYPE=OFF \
    -DHB_HAVE_GLIB=OFF \
    -DHB_HAVE_GOBJECT=OFF \
    -DHB_HAVE_ICU=OFF \
    -DHB_HAVE_CORETEXT=OFF
  cmake --build build --parallel "$JOBS"
  cmake --install build
)

tar -xf "$SOURCE_CACHE/$LIBASS_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$LIBASS_SOURCE_DIR"
  ./configure \
    --prefix="$PREFIX" \
    --disable-shared \
    --enable-static \
    --disable-fontconfig \
    --enable-coretext \
    --disable-libunibreak
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$X264_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$X264_SOURCE_DIR"
  ./configure \
    --prefix="$PREFIX" \
    --host=aarch64-apple-darwin \
    --enable-static \
    --enable-pic \
    --disable-cli \
    --disable-opencl \
    --disable-avs \
    --disable-swscale \
    --disable-lavf \
    --disable-ffms \
    --disable-gpac \
    --disable-lsmash
  make -j "$JOBS"
  make install-lib-static
)

tar -xf "$SOURCE_CACHE/$LIBVPX_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$LIBVPX_SOURCE_DIR"
  ./configure \
    --prefix="$PREFIX" \
    --target=arm64-darwin-gcc \
    --disable-shared \
    --enable-static \
    --enable-pic \
    --disable-examples \
    --disable-tools \
    --disable-docs \
    --disable-unit-tests \
    --enable-vp8 \
    --enable-vp9 \
    --enable-vp9-highbitdepth
  make -j "$JOBS"
  make install
)

tar -xf "$SOURCE_CACHE/$FFMPEG_ARCHIVE" -C "$WORK_DIR"
(
  cd "$WORK_DIR/$FFMPEG_SOURCE_DIR"
  ./configure \
    --prefix=/usr/local \
    --arch=arm64 \
    --target-os=darwin \
    --cc=clang \
    --disable-autodetect \
    --disable-debug \
    --disable-doc \
    --disable-ffplay \
    --enable-ffprobe \
    --disable-shared \
    --enable-static \
    --enable-gpl \
    --enable-libass \
    --enable-libmp3lame \
    --enable-libopus \
    --enable-libvpx \
    --enable-libx264 \
    --enable-pthreads \
    --enable-securetransport \
    --enable-zlib \
    --enable-videotoolbox \
    --pkg-config-flags=--static \
    --extra-cflags="$COMMON_CFLAGS" \
    --extra-ldflags="$COMMON_LDFLAGS" \
    --extra-libs=-lc++
  make -j "$JOBS" ffmpeg ffprobe
  cp ffmpeg "$BINARY_CACHE/ffmpeg"
  cp ffprobe "$BINARY_CACHE/ffprobe"
)

chmod +x "$BINARY_CACHE/ffmpeg" "$BINARY_CACHE/ffprobe"
strip "$BINARY_CACHE/ffmpeg" "$BINARY_CACHE/ffprobe"
validate_binary "$BINARY_CACHE/ffmpeg"
validate_binary "$BINARY_CACHE/ffprobe" ffprobe
cp "$BINARY_CACHE/ffmpeg" "$OUTPUT_PATH"
cp "$BINARY_CACHE/ffprobe" "$PROBE_OUTPUT_PATH"
chmod +x "$OUTPUT_PATH" "$PROBE_OUTPUT_PATH"

echo "Built FFmpeg ${FFMPEG_VERSION} for macOS ARM64 with hard-subtitle support."
