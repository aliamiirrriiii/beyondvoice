# Vendor Sources

This directory contains pinned third-party native sources used by the relay.

Current layout:

- `vendor/opus/`
  Pinned Opus 1.5.2 source tree. The native relay build compiles this into a local static `libopus.a` with Deep PLC and DRED enabled.
- `vendor/codec2/`
  Pinned Codec2 1.2.0 source tree. The native relay build compiles this into a local static `libcodec2.a` so the relay can decode incoming Codec2 packets before FARGAN synthesis.

Pinned source artifact:

- Upstream release: `opus-1.5.2.tar.gz`
- SHA-256: `65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1`
- Upstream release: `codec2-1.2.0.tar.gz`
- SHA-256: `cbccae52b2c2ecc5d2757e407da567eb681241ff8dadce39d779a7219dbcf449`

Current neural relay execution paths:

- `in-process` mode for direct Node execution
- `child-process` mode for a Node worker
- `native-exec` mode for the stable wrapper at `native/fargan-relay/bin/fargan-relay-worker`
  - wrapper fallback: JS stdio worker
  - preferred path after `npm run build:neural-relay:native`: compiled vendored-Opus executable
