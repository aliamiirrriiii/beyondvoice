#!/usr/bin/env bash
#
# Prepare the neural relay executable path for VoiceAI.
# This script supports two modes:
#   1. bootstrap-js  -> installs the repo-local wrapper and JS stdio worker
#   2. native-opus   -> builds a vendored libopus + native relay executable
#
# Usage:
#   ./scripts/build-neural-relay.sh
#   ./scripts/build-neural-relay.sh --mode bootstrap-js
#   ./scripts/build-neural-relay.sh --mode native-opus

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NATIVE_DIR="$PROJECT_DIR/native/fargan-relay"
BIN_DIR="$NATIVE_DIR/bin"
WRAPPER_BIN="$BIN_DIR/fargan-relay-worker"
NATIVE_BIN="$BIN_DIR/fargan-relay-worker-native"
STDIO_WORKER="$NATIVE_DIR/stdio-worker.js"
NATIVE_SRC="$NATIVE_DIR/src/fargan_relay_main.cpp"
BUILD_DIR="$NATIVE_DIR/build"
OPUS_BUILD_DIR="$BUILD_DIR/opus"
OPUS_INSTALL_DIR="$BUILD_DIR/opus-install"
CODEC2_BUILD_DIR="$BUILD_DIR/codec2"
MODE="bootstrap-js"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

if [[ -x "/tmp/cmake-3.31.6-macos-universal/CMake.app/Contents/bin/cmake" ]]; then
  CMAKE_BIN="/tmp/cmake-3.31.6-macos-universal/CMake.app/Contents/bin/cmake"
else
  CMAKE_BIN="$(command -v cmake)"
fi

ensure_bootstrap_files() {
  if [[ ! -f "$WRAPPER_BIN" ]]; then
    echo "ERROR: wrapper executable not found at $WRAPPER_BIN" >&2
    exit 1
  fi

  if [[ ! -f "$STDIO_WORKER" ]]; then
    echo "ERROR: stdio worker not found at $STDIO_WORKER" >&2
    exit 1
  fi

  chmod +x "$WRAPPER_BIN"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$BIN_DIR"

if [[ "$MODE" == "bootstrap-js" ]]; then
  ensure_bootstrap_files
  echo "Neural relay bootstrap executable is ready:"
  echo "  $WRAPPER_BIN"
  exit 0
fi

if [[ "$MODE" == "native-opus" ]]; then
  if [[ ! -d "$PROJECT_DIR/vendor/opus" ]]; then
    echo "ERROR: vendor/opus is missing." >&2
    echo "Add a pinned Opus source tree under vendor/opus before running native-opus mode." >&2
    exit 1
  fi

  if [[ ! -d "$PROJECT_DIR/vendor/codec2" ]]; then
    echo "ERROR: vendor/codec2 is missing." >&2
    echo "Add a pinned Codec2 source tree under vendor/codec2 before running native-opus mode." >&2
    exit 1
  fi

  ensure_bootstrap_files

  if [[ ! -x "$PROJECT_DIR/vendor/opus/configure" ]]; then
    echo "ERROR: vendor/opus/configure is missing or not executable." >&2
    exit 1
  fi

  if [[ ! -f "$NATIVE_SRC" ]]; then
    echo "ERROR: native relay source is missing at $NATIVE_SRC" >&2
    exit 1
  fi

  mkdir -p "$BUILD_DIR" "$OPUS_BUILD_DIR"

  if [[ ! -f "$OPUS_INSTALL_DIR/lib/libopus.a" ]]; then
    rm -rf "$OPUS_BUILD_DIR" "$OPUS_INSTALL_DIR"
    mkdir -p "$OPUS_BUILD_DIR" "$OPUS_INSTALL_DIR"
    # Mark autotools-generated artifacts as fresher than their sources so make
    # does not try to regenerate them with a (possibly missing) aclocal/automake.
    find "$PROJECT_DIR/vendor/opus" -type f \
      \( -name 'configure.ac' -o -name 'Makefile.am' -o -name '*.m4' \) \
      -exec touch -d '2000-01-01' {} +
    touch "$PROJECT_DIR/vendor/opus/aclocal.m4" \
          "$PROJECT_DIR/vendor/opus/configure" \
          "$PROJECT_DIR/vendor/opus/Makefile.in" \
          "$PROJECT_DIR/vendor/opus/doc/Makefile.in" \
          "$PROJECT_DIR/vendor/opus/config.h.in"
    (
      cd "$OPUS_BUILD_DIR"
      "$PROJECT_DIR/vendor/opus/configure" \
        --prefix="$OPUS_INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-doc \
        --disable-extra-programs \
        --disable-asm \
        --disable-intrinsics \
        --disable-rtcd \
        --enable-deep-plc \
        --enable-dred
      make -j"$JOBS"
      make install
    )
  fi

  if [[ ! -f "$CODEC2_BUILD_DIR/src/libcodec2.a" ]]; then
    rm -rf "$CODEC2_BUILD_DIR"
    mkdir -p "$CODEC2_BUILD_DIR"
    (
      cd "$CODEC2_BUILD_DIR"
      "$CMAKE_BIN" "$PROJECT_DIR/vendor/codec2" \
        -DUNITTEST=OFF \
        -DBUILD_SHARED_LIBS=OFF
      make codec2 -j"$JOBS"
    )
  fi

  if [[ ! -f "$OPUS_INSTALL_DIR/lib/libopus.a" ]]; then
    echo "ERROR: libopus.a was not produced by the vendored build." >&2
    exit 1
  fi

  if [[ ! -f "$CODEC2_BUILD_DIR/src/libcodec2.a" ]]; then
    echo "ERROR: libcodec2.a was not produced by the vendored build." >&2
    exit 1
  fi

  c++ -std=c++17 -O2 -Wall -Wextra \
    -I"$OPUS_INSTALL_DIR/include/opus" \
    -I"$PROJECT_DIR/vendor/opus/dnn" \
    -I"$CODEC2_BUILD_DIR" \
    -I"$PROJECT_DIR/vendor/codec2/src" \
    "$NATIVE_SRC" \
    "$OPUS_INSTALL_DIR/lib/libopus.a" \
    "$CODEC2_BUILD_DIR/src/libcodec2.a" \
    -lm \
    -o "$NATIVE_BIN"

  chmod +x "$NATIVE_BIN"
  echo "Neural relay native executable is ready:"
  echo "  $NATIVE_BIN"
  exit 0
fi

echo "ERROR: unsupported mode '$MODE'" >&2
exit 1
