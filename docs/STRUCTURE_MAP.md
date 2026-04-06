# Structure Map

## Top-level

```
voiceai/
├── server.js          # Node.js signaling server (HTTP/HTTPS, WebRTC signaling API)
├── package.json       # Project metadata, no external deps
├── README.md          # Project overview
├── certs/             # TLS certificates for local HTTPS
├── docs/              # Project documentation
│   ├── STRUCTURE_MAP.md
│   └── LESSONS_LEARNED.md
└── public/            # Static frontend served by server.js
    ├── index.html     # Single-page UI (Google Meet-style layout)
    ├── styles.css     # All styling, no external deps, system fonts only
    ├── app.js         # WebRTC client logic, signaling, audio management
    ├── sw.js          # Service worker for offline asset caching
    └── codec2-worker.js # AudioWorklet for Codec2 1.2kbps encode/decode
├── scripts/
│   └── build-codec2-wasm.sh # Builds codec2.wasm from source (requires emsdk)
```

## Key files

- **server.js** — HTTP(S) server with brotli/gzip compression, WebSocket signaling with per-message deflate, REST API for room join/leave/signaling, optional Redis pub/sub for multi-instance, TURN credential generation, rate limiting, CSP security headers.
- **public/index.html** — Pre-call overlay (join form, mic permission panel) + in-call view (participant tiles, control bar, toggleable info panel). All element IDs are consumed by `app.js`.
- **public/styles.css** — Dark theme, CSS custom properties, fully responsive. System fonts only, no external deps. ~4KB.
- **public/app.js** — WebRTC peer connection, ICE handling, 4-tier adaptive audio profiles (lean/tight/ultra/extreme with 5s hysteresis), VBR Opus with DTX+FEC+RED, SDP compression, ICE candidate batching, compact heartbeats, optional Codec2 1.2kbps DataChannel transport. Queries DOM by ID.
- **public/codec2-worker.js** — AudioWorklet processors for Codec2 encode/decode. Requires a `codec2.wasm` binary in `/public/` to activate. Enabled by setting `APP_CONFIG.enableCodec2 = true`.
