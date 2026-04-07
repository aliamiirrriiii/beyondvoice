# Structure Map

## Top-level

```
voiceai/
├── server.js          # Node.js signaling server (HTTP/HTTPS, WebRTC signaling API)
├── media-relay.js     # Server-side relay controller and packet repair pipeline
├── neural-relay.js    # Neural relay mode wrapper and worker-process bridge
├── package.json       # Project metadata, no external deps
├── README.md          # Project overview
├── certs/             # TLS certificates for local HTTPS
├── docs/              # Project documentation
│   ├── STRUCTURE_MAP.md
│   └── LESSONS_LEARNED.md
├── native/
│   └── fargan-relay/
│       ├── bin/
│       │   ├── fargan-relay-worker # Stable wrapper that prefers the native executable
│       │   └── fargan-relay-worker-native # Built vendored Opus + Codec2 worker binary
│       ├── build/ # Local native build output (created by build-neural-relay.sh)
│       ├── engine.js  # JS fallback engine for in-process and child-process relay modes
│       ├── src/
│       │   └── fargan_relay_main.cpp # Native relay worker linked against vendored libopus + libcodec2
│       ├── stdio-worker.js # JS stdio fallback used by the wrapper when native is absent
│       └── worker.js  # Child-process worker entrypoint for the neural relay
├── vendor/
│   ├── opus/          # Pinned Opus 1.5.2 source tree for Deep PLC/FARGAN components
│   └── codec2/        # Pinned Codec2 1.2.0 source tree for relay-side native decode
├── public/            # Static frontend served by server.js
│   ├── index.html     # Single-page UI (Google Meet-style layout)
│   ├── styles.css     # All styling, no external deps, system fonts only
│   ├── app.js         # WebRTC client logic, signaling, audio management
│   ├── sw.js          # Service worker for offline asset caching
│   └── (browser assets are Opus-only)
├── tests/
│   ├── extreme-stack.test.js # Node smoke tests for transport primitives
│   ├── neural-relay.test.js # Node tests for the neural relay interface and worker mode
│   └── media-relay.test.js # Node tests for server-side relay forwarding
├── scripts/
│   └── build-neural-relay.sh # Prepares the wrapper path or builds the vendored native relay worker
```

## Key files

- **server.js** — HTTP(S) server with brotli/gzip compression, WebSocket signaling with per-message deflate, REST API for room join/leave/signaling, optional Redis pub/sub for multi-instance, TURN credential generation, rate limiting, CSP security headers.
- **media-relay.js** — Server-side media relay controller used by the native relay tests and backend experiments.
- **neural-relay.js** — Selects the neural relay mode (`off`, `deep-plc`, `fargan`) and backend (`in-process`, `child-process`, `native-exec`). In native-exec mode it discovers whether the wrapper resolved to the compiled relay binary or the JS stdio fallback.
- **public/index.html** — Pre-call overlay (join form, mic permission panel) + in-call view (participant tiles, control bar, toggleable info panel). All element IDs are consumed by `app.js`.
- **public/styles.css** — Dark theme, CSS custom properties, fully responsive. System fonts only, no external deps. ~4KB.
- **public/app.js** — WebRTC peer connection, ICE handling, adaptive Opus tuning (lean/tight/ultra/extreme profiles), SDP compression, ICE candidate batching, and browser-side diagnostics.
- **tests/extreme-stack.test.js** — Verifies header compression round-trips, packet reordering, and packet-loss concealment behavior.
- **tests/neural-relay.test.js** — Verifies the new neural relay interface in both in-process and worker-process modes.
- **tests/media-relay.test.js** — Verifies server-side relay delivery from uplink compressed packets to downlink compressed packets.
