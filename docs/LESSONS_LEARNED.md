# Lessons Learned

### [2026-04-06] Preserve element IDs when redesigning HTML
**Problem**: The frontend JS (`app.js`) queries all DOM elements by ID at module load. A UI redesign that changes or removes IDs silently breaks the app with no errors.
**Root Cause**: `document.querySelector("#id")` returns `null` if the element is missing, and subsequent `.textContent` / `.disabled` writes throw at runtime.
**Solution**: Before rewriting `index.html`, grep `app.js` for every `querySelector("#...")` call and verify every ID exists in the new markup.
**Prevention**: Always audit `app.js` ID references before any HTML restructure. Keep a checklist.

### [2026-04-06] app.js dynamically sets mic-badge className
**Problem**: `app.js` line 167 sets `micBadge.className = "mic-badge mic-badge-${kind}"` — the CSS must define all variant classes.
**Root Cause**: The class names are constructed at runtime, so a CSS-only search won't find them.
**Solution**: Ensure `mic-badge-pending`, `mic-badge-ready`, `mic-badge-warning`, `mic-badge-blocked` all exist in `styles.css`.
**Prevention**: When redesigning CSS, search `app.js` for `className` and `classList` assignments to find dynamically-applied classes.

### [2026-04-06] CSP blocks inline scripts — never use them
**Problem**: `server.js` sets `Content-Security-Policy: script-src 'self'`, but `index.html` had an inline `<script>` block. The script was silently blocked in production — no console error unless devtools is open.
**Root Cause**: CSP `script-src 'self'` forbids inline scripts. The inline block was added during a UI redesign without checking CSP headers.
**Solution**: Moved all inline JS into `app.js` (which is loaded as `src="/app.js"` and passes CSP).
**Prevention**: Never add inline `<script>` blocks. Always append to `app.js` or create a new external `.js` file. Check `securityHeaders()` in `server.js` before adding any script tag.

### [2026-04-06] Profile switch renegotiation causes signaling storms on bad networks
**Problem**: `adaptAudioCompression()` called `createAndSendOffer()` on every profile switch, generating a full SDP offer→answer exchange (~3KB round trip). On flaky connections, profiles oscillated every second, flooding the signaling channel.
**Root Cause**: `setParameters()` already applies the bitrate change at the RTP layer — the SDP renegotiation was redundant for bitrate-only changes.
**Solution**: Removed the `createAndSendOffer()` call from `adaptAudioCompression()`. Added a 5-second cooldown between profile switches to prevent oscillation.
**Prevention**: Only trigger SDP renegotiation when the codec or media tracks change, never for bitrate-only adjustments. Always debounce adaptive logic.

### [2026-04-06] Opus RED requires SDP reordering, not just enabling
**Problem**: Chrome supports `audio/red` (RFC 2198) natively but won't use it unless RED is the preferred codec in the SDP m= line.
**Root Cause**: The browser's default SDP puts Opus first. RED wrapping Opus exists as an option but is deprioritized.
**Solution**: Reorder the m=audio payload types to put the RED payload type before Opus. The browser then automatically wraps each Opus frame in RED with the previous frame included.
**Prevention**: When enabling any secondary codec, always check if SDP reordering is needed — browsers respect m= line ordering.

### [2026-04-06] SDP compression must preserve essential fields
**Problem**: Aggressive SDP stripping can break ICE or DTLS negotiation if critical lines are removed.
**Root Cause**: Some `a=` lines look redundant but are needed (e.g., `a=fingerprint`, `a=ice-ufrag`, `a=setup`).
**Solution**: Only strip known-safe lines: `a=extmap:`, `a=rtcp-fb:`, `a=extmap-allow-mixed`, `a=msid-semantic`, `a=group:BUNDLE`, `a=ssrc-group:`, `a=rtcp:`. These are reconstructed by the browser from other fields.
**Prevention**: Maintain an explicit allowlist of strippable prefixes. Never use a blocklist (keeping only certain lines) as new essential fields may appear in browser updates.
