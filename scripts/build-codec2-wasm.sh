#!/usr/bin/env bash
#
# Build codec2.wasm for use with VoiceAI's AudioWorklet codec2-worker.js
#
# Prerequisites:
#   - Emscripten SDK (emsdk) installed and activated
#   - CMake installed
#
# Usage:
#   ./scripts/build-codec2-wasm.sh
#
# Output:
#   public/codec2.wasm
#   public/codec2-glue.js (Emscripten JS glue)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/.codec2-build"
OUTPUT_DIR="$PROJECT_DIR/public"
CODEC2_VERSION="1.2.0"
CODEC2_REPO="https://github.com/drowe67/codec2.git"

echo "==> Checking for Emscripten..."
if ! command -v emcc &>/dev/null; then
  echo "ERROR: emcc not found. Install and activate emsdk first:"
  echo "  git clone https://github.com/emscripten-core/emsdk.git"
  echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
  echo "  source emsdk_env.sh"
  exit 1
fi

echo "==> Cloning codec2 v${CODEC2_VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
git clone --depth 1 --branch "v${CODEC2_VERSION}" "$CODEC2_REPO" codec2

echo "==> Configuring with Emscripten CMake..."
mkdir -p codec2/build_wasm
cd codec2/build_wasm

emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DUNITTEST=OFF \
  -DGENERATE_CODEBOOK=OFF \
  -DLPCNET=OFF

echo "==> Building codec2 library..."
emmake make codec2 -j"$(nproc 2>/dev/null || echo 4)"

echo "==> Compiling WASM with exported API..."
# Build a minimal WASM that exports only the functions we need:
#   codec2_create(mode) → codec2_ptr
#   codec2_destroy(codec2_ptr)
#   codec2_encode(codec2_ptr, bits_out, speech_in)
#   codec2_decode(codec2_ptr, speech_out, bits_in)
#   codec2_samples_per_frame(codec2_ptr)
#   codec2_bytes_per_frame(codec2_ptr)
emcc \
  -O3 \
  -s WASM=1 \
  -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS='["_codec2_create","_codec2_destroy","_codec2_encode","_codec2_decode","_codec2_samples_per_frame","_codec2_bytes_per_frame","_malloc","_free"]' \
  -s TOTAL_MEMORY=1048576 \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s FILESYSTEM=0 \
  -s ASSERTIONS=0 \
  --no-entry \
  -I../src \
  src/libcodec2.a \
  -o codec2.wasm

echo "==> Copying to public/..."
cp codec2.wasm "$OUTPUT_DIR/codec2.wasm"

WASM_SIZE=$(wc -c < "$OUTPUT_DIR/codec2.wasm" | tr -d ' ')
echo "==> Done! codec2.wasm (${WASM_SIZE} bytes) → $OUTPUT_DIR/codec2.wasm"
echo ""
echo "To enable Codec2 mode, add to your environment or app-config:"
echo '  window.APP_CONFIG.enableCodec2 = true'

# Cleanup
cd "$PROJECT_DIR"
rm -rf "$BUILD_DIR"
