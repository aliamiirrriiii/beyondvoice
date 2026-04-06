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
#   public/codec2.wasm (standalone WASM, ~170KB)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/.codec2-build"
OUTPUT_DIR="$PROJECT_DIR/public"
CODEC2_VERSION="1.2.0"
CODEC2_REPO="https://github.com/drowe67/codec2.git"
NPROC=$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)

echo "==> Checking for Emscripten..."
if ! command -v emcc &>/dev/null; then
  echo "ERROR: emcc not found. Install and activate emsdk first:"
  echo "  git clone https://github.com/emscripten-core/emsdk.git ~/.emsdk"
  echo "  cd ~/.emsdk && ./emsdk install latest && ./emsdk activate latest"
  echo "  source ~/.emsdk/emsdk_env.sh"
  exit 1
fi

if ! command -v cmake &>/dev/null; then
  echo "ERROR: cmake not found. Install cmake first."
  exit 1
fi

echo "==> Cloning codec2 ${CODEC2_VERSION}..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
git clone --depth 1 --branch "${CODEC2_VERSION}" "$CODEC2_REPO" codec2

# Step 1: Build native generate_codebook tool (needed for cross-compilation)
echo "==> Building native codebook generator..."
mkdir -p codec2/build_native
cd codec2/build_native
cmake .. -DCMAKE_BUILD_TYPE=MinSizeRel -DUNITTEST=OFF -DLPCNET=OFF
make generate_codebook -j"$NPROC"
NATIVE_GEN="$(pwd)/src/generate_codebook"
cd ../..

# Step 2: Patch CMakeLists.txt to use the native generate_codebook
# instead of trying to cross-compile one under Emscripten
echo "==> Patching for cross-compilation..."
cd codec2
sed -i.bak '/^if(CMAKE_CROSSCOMPILING)/,/^endif(CMAKE_CROSSCOMPILING)/c\
add_executable(generate_codebook IMPORTED)\
set_target_properties(generate_codebook PROPERTIES IMPORTED_LOCATION '"$NATIVE_GEN"')' src/CMakeLists.txt

# Step 3: Cross-compile with Emscripten
echo "==> Configuring with Emscripten CMake..."
mkdir -p build_wasm
cd build_wasm

emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DUNITTEST=OFF \
  -DLPCNET=OFF

echo "==> Building codec2 library..."
emmake make codec2 -j"$NPROC"

echo "==> Linking standalone WASM..."
emcc \
  -Os \
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
echo "==> Done! codec2.wasm (${WASM_SIZE} bytes) -> $OUTPUT_DIR/codec2.wasm"
echo ""
echo "To enable Codec2 mode, set APP_CONFIG.enableCodec2 = true"

# Cleanup
cd "$PROJECT_DIR"
rm -rf "$BUILD_DIR"
