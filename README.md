# VoiceAI

Two-person browser voice calling with:

- WebRTC audio transport
- aggressive Opus compression tuning
- optional Codec2 extreme mode with compact RTP packetization, header compression, adaptive jitter buffering, and PLC hooks
- server-side relay media path for Codec2 extreme mode over `/media` WebSocket
- WebSocket signaling and static serving
- Redis-backed shared room state
- coturn relay service with ephemeral credentials
- optional browser-native HTTP Basic auth gate
- Docker Compose deployment support for Traefik

## Production status

This repository is now ready to deploy as a single-container service behind Traefik.

Included hardening:

- containerized runtime with `Dockerfile`
- `compose.yaml` service with Traefik labels
- Redis service for shared signaling state
- coturn service for direct internet TURN relay
- health and readiness endpoints: `/health`, `/ready`
- graceful shutdown for Docker restarts
- idle room cleanup and WebSocket ping/pong liveness
- basic in-memory rate limiting using `X-Forwarded-For`
- browser security headers and CSP
- optional HTTP Basic auth on static assets, API routes, and WebSocket signaling
- non-root container runtime

## Current architecture

- browser clients join over HTTP, then switch to WebSocket signaling
- room state is stored in Redis
- events are distributed across instances through Redis pub/sub
- Traefik terminates TLS and forwards HTTP/WebSocket traffic to the app

This is now suitable for running more than one app container **if** every replica shares the same Redis instance.

## Local run

```bash
npm start
```

Open `http://localhost:3000`.

## Docker run

```bash
docker build -t voiceai .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e STUN_URLS=stun:stun.l.google.com:19302 \
  voiceai
```

## Deploy with Docker Compose and Traefik

The repo includes [compose.yaml](/Users/aliamiri/Documents/Programming/voiceai/compose.yaml) with:

- a `voiceai` service
- a `redis` service
- a `coturn` service
- Traefik router and service labels
- HTTPS entrypoint configuration
- healthcheck
- hardened container settings

### Required values

Set these in your shell or deployment system before running `docker compose up -d --build`:

```bash
export VOICEAI_HOST=voice.example.com
export TRAEFIK_NETWORK=traefik-public
export TRAEFIK_CERTRESOLVER=letsencrypt
export ALLOWED_ORIGIN=https://voice.example.com
export AUTH_USERNAME=voiceadmin
export AUTH_PASSWORD=replace-with-a-strong-password
export REDIS_URL=redis://redis:6379
export TURN_REALM=turn.example.com
export TURN_EXTERNAL_IP=YOUR_SERVER_PUBLIC_IP
export TURN_AUTH_SECRET=$(openssl rand -hex 32)
export TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
```

Then deploy:

```bash
docker compose up -d --build
```

If `AUTH_USERNAME` and `AUTH_PASSWORD` are set, browsers will require that username and password before the app can load and before WebSocket signaling is allowed.

## TURN is required for real production

If you only configure STUN, many users on mobile networks, carrier NAT, hotel Wi-Fi, or restrictive enterprise networks will fail to connect.

This repository now includes a coturn service in [compose.yaml](/Users/aliamiri/Documents/Programming/voiceai/compose.yaml).

The app generates short-lived TURN credentials from:

- `TURN_AUTH_SECRET`
- `TURN_REALM`
- `TURN_CREDENTIAL_TTL_SECONDS`

For a production VoIP deployment, provide:

- a real public `TURN_EXTERNAL_IP`
- a DNS name for TURN such as `turn.example.com`
- UDP TURN first
- TCP TURN fallback
- a strong `TURN_AUTH_SECRET`

### Generate the TURN auth secret

```bash
openssl rand -hex 32
```

### Important TURN deployment note

TURN is **not** routed through Traefik in this setup. The coturn container exposes its own public ports directly:

- `3478/tcp`
- `3478/udp`
- relay UDP port range from `TURN_MIN_PORT` to `TURN_MAX_PORT`

You must open those ports in your server firewall.

### Current TURN mode in this repo

The included coturn service is configured for authenticated TURN over:

- `turn:...:3478?transport=udp`
- `turn:...:3478?transport=tcp`

That is enough for many deployments. If you also want `turns:` on `5349`, add cert/key mounting to coturn and extend the service command accordingly.

## Environment variables

Application runtime:

- `HOST`
- `PORT`
- `AUTH_USERNAME`
- `AUTH_PASSWORD`
- `REDIS_URL`
- `REDIS_PREFIX`
- `STUN_URLS`
- `TURN_URLS`
- `TURN_AUTH_SECRET`
- `TURN_REALM`
- `TURN_CREDENTIAL_TTL_SECONDS`
- `TURN_EXTERNAL_IP`
- `TURN_MIN_PORT`
- `TURN_MAX_PORT`
- `TURN_USER_QUOTA`
- `TURN_TOTAL_QUOTA`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`
- `ALLOWED_ORIGIN`
- `ENABLE_MEDIA_RELAY`
- `NEURAL_RELAY_MODE`
- `NEURAL_RELAY_BACKEND`

Operational tuning:

- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `POLL_TIMEOUT_MS`
- `ROOM_IDLE_MS`
- `PARTICIPANT_IDLE_MS`
- `SHUTDOWN_GRACE_MS`
- `MAX_EVENTS_PER_PARTICIPANT`
- `WS_PING_INTERVAL_MS`

Local HTTPS only:

- `TLS_KEY_PATH`
- `TLS_CERT_PATH`

When deploying behind Traefik, do **not** set `TLS_KEY_PATH` or `TLS_CERT_PATH`. Let Traefik terminate TLS and forward plain HTTP to the app container.

## Traefik notes

The Compose file assumes:

- Traefik is already running
- Traefik exposes a `websecure` entrypoint
- your external Docker network is `${TRAEFIK_NETWORK}`
- your certificate resolver name is `${TRAEFIK_CERTRESOLVER}`

If your Traefik setup uses different entrypoints, middleware names, or network naming, adjust the labels in [compose.yaml](/Users/aliamiri/Documents/Programming/voiceai/compose.yaml).

## Health endpoints

- `/health` returns basic liveness
- `/ready` returns readiness and flips to `503` during shutdown

## Remaining production work

The service is deployable now, but these are still the next high-value improvements:

1. add room authorization beyond a single shared username/password
2. persist Redis if you want signaling state to survive Redis restarts
3. add metrics/log aggregation and alerting
4. add TLS-enabled `turns:` on `5349` if your target networks require it
5. use managed or geographically distributed TURN infrastructure if you need global reach

## Extreme mode roadmap status

The repository now includes an internal "extreme transport" path for the optional Codec2 data-channel mode:

- RTP-like packet sequencing and timestamps for Codec2 frames
- compact ROHC-style header compression for the packet headers
- adaptive jitter buffering driven by live WebRTC network metrics
- packet-loss concealment hooks that can replay or synthesize short fallback frames
- a neural vocoder adapter boundary for swapping the plain Codec2 decoder with LPCNet or another model later
- a server-side relay path that accepts compact Codec2 frames over `/media`, reorders them, applies PLC centrally, and forwards repaired frames to the recipient

This is intentionally a migration layer, not a claim of full standards-compliant ROHC or a shipped LPCNet integration inside the browser today.

What is still required for the full target stack described in the roadmap:

1. replace the passthrough `NeuralVocoderAdapter` with a real LPCNet/LSPNet runtime
2. optionally export native Codec2 parameters such as LSPs/pitch directly from the codec build instead of deriving neural features from relay-side decoded PCM
3. move the transport to a native/mobile UDP path if you want real ROHC over IP/UDP/RTP instead of the current browser/WebSocket approximation

## Relay architecture

The new relay path is built for the browser-first version of this project:

1. the sender browser encodes mic audio into Codec2 frames
2. the browser packetizes and compresses those frames, then sends them to `/media`
3. `server.js` authenticates the media socket and hands frames to [media-relay.js](/Users/aliamiri/Documents/Programming/voiceai/media-relay.js)
4. the relay performs server-side jitter buffering and PLC
5. in `NEURAL_RELAY_MODE=fargan`, the relay decodes Codec2 natively, synthesizes 8 kHz PCM with FARGAN/LPCNet state, and forwards PCM frames to the recipient browser for direct playback
6. in other modes, repaired frames are forwarded to the recipient browser, which decodes them for playback

This keeps the heaviest transport repair logic off the recipient device without rewriting the whole product into a native mobile stack yet.

## Neural relay modes

The relay now exposes a pluggable neural-processing stage behind a stable interface. It is opt-in: set `ENABLE_MEDIA_RELAY=true` when you explicitly want the Codec2 relay transport.

- `NEURAL_RELAY_MODE=off`
  Plain relay pass-through. Jitter buffering and transport repair stay enabled.
- `NEURAL_RELAY_MODE=deep-plc`
  Relay-side concealment shaping path intended for a future Opus Deep PLC bridge.
- `NEURAL_RELAY_MODE=fargan`
  Relay-side native FARGAN synthesis path. The relay decodes incoming Codec2 700C packets, computes LPCNet features from the decoded speech, synthesizes PCM with FARGAN, and uses LPCNet PLC for concealed frames before sending PCM payloads back to the browser.

`fargan` requires the native relay executable. If that executable is unavailable, the server degrades to `deep-plc` instead of running the JS scaffold and misreporting it as real FARGAN. The Docker image now builds a Linux-native relay binary during `docker build`, so container deployments do not depend on a host-built macOS binary.

Backends:

- `NEURAL_RELAY_BACKEND=in-process`
  Runs the JS fallback engine inside the Node process.
- `NEURAL_RELAY_BACKEND=child-process`
  Runs the JS fallback engine in a dedicated worker process.
- `NEURAL_RELAY_BACKEND=native-exec`
  Runs the stable relay wrapper at `native/fargan-relay/bin/fargan-relay-worker`. That wrapper prefers a compiled `fargan-relay-worker-native` binary when present and falls back to the repo-local JS stdio worker otherwise. If the wrapper itself is missing, the server falls back to `in-process`.

Build helpers:

- `npm run build:neural-relay`
  Prepares the wrapper and JS stdio fallback path.
- `npm run build:neural-relay:native`
  Builds pinned vendored `libopus.a` and `libcodec2.a`, then compiles the native relay executable used by the wrapper.

The native worker is linked against vendored Opus 1.5.2 and Codec2 1.2.0. In `fargan` mode it returns synthesized PCM payloads after a short bootstrap window, and concealed frames are generated through LPCNet PLC rather than replaying the original Codec2 packet.
